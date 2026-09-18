import importlib.util
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

import pytest

from tests.conftest_sm import plugin_api, write_auth, write_env


@pytest.mark.parametrize(
    "balance,today,seven,thirty",
    [
        (12.34, 5.5, 40.25, 120.75),
        (0.01, 9999.0, 9999.0, 9999.0),
        (0.0, 0.0, 0.0, 0.0),
    ],
)
def test_spend_and_balance_tones_are_neutral_not_computed(monkeypatch, balance, today, seven, thirty):
    """消费/余额数值必须与官方接口数据一致，且四个 Tone 一律为 None（不再着色）。"""
    now = 1_800_000_000.0
    today_start = plugin_api._local_day_start_epoch(now, plugin_api.DEEPSEEK_TZ_SECONDS)
    seven_start = today_start - 6 * 86400
    thirty_start = today_start - 29 * 86400

    def fake_json_get(url, _token):
        if url.startswith(plugin_api.DEEPSEEK_COST_URL):
            return {
                "data": {
                    "biz_code": 0,
                    "biz_data": {
                        "bucket": 86400,
                        "data": [{
                            "currency": "CNY",
                            "series": [{"buckets": [
                                {"time": today_start + 3600, "cost": today},
                                {"time": seven_start + 3600, "cost": 0.0 if seven == today else seven - today},
                                {"time": thirty_start + 3600, "cost": 0.0 if thirty == seven else thirty - seven},
                            ]}],
                        }],
                    },
                }
            }
        if url == plugin_api.DEEPSEEK_BALANCE_URL:
            return {
                "is_available": True,
                "balance_infos": [{"total_balance": str(balance), "currency": "CNY"}],
            }
        raise AssertionError(f"unexpected url: {url}")

    monkeypatch.setattr(plugin_api, "_platform_token", lambda: "platform-token")
    monkeypatch.setattr(plugin_api, "_json_get", fake_json_get)

    row = plugin_api._fetch_deepseek(now)

    assert row.error is None
    assert row.balance == balance
    assert row.currency == "CNY"
    assert row.todaySpend == round(today, 2)
    assert row.sevenDaySpend == round(seven, 2)
    assert row.thirtyDaySpend == round(thirty, 2)
    assert row.todayTone is None
    assert row.sevenDayTone is None
    assert row.thirtyDayTone is None
    assert row.balanceTone is None


def test_discovered_providers_follow_settings_contract():
    """通用契约：设置页条目来自凭据发现（非死名单）；id 小写、kind 只允许
    quota/balance、可取数条目必须有注册适配器、默认全 enabled。不冻结具体清单。"""
    write_env({"KIMI_API_KEY": "sk-kimi-fixture", "GLM_API_KEY": "glm-fixture"})
    write_auth({"xai-oauth": {"tokens": {"access_token": "fixture"}}})
    payload = plugin_api.get_provider_settings()

    fetchable = {spec.id for spec in plugin_api.FETCHER_SPECS if spec.fetch}
    assert len(payload.providers) >= 1
    for item in payload.providers:
        assert item.id == item.id.lower()
        assert item.kind in ("quota", "balance")
        assert item.status in ("no_fetcher", "unrecognized") or item.id in fetchable
    assert all(item.enabled for item in payload.providers)


def test_provider_settings_apply_saved_visibility(monkeypatch):
    write_env({"KIMI_API_KEY": "sk-kimi-fixture"})
    write_auth({"xai-oauth": {"tokens": {"access_token": "fixture"}}})
    monkeypatch.setattr(
        plugin_api,
        "_read_plugin_settings",
        lambda: {"visibility": {"grok": False}},
    )

    payload = plugin_api.get_provider_settings()
    enabled = {item.id: item.enabled for item in payload.providers}

    assert enabled["grok"] is False
    assert enabled["kimi"] is True


def test_set_provider_visibility_preserves_other_plugin_settings(monkeypatch):
    write_auth({"xai-oauth": {"tokens": {"access_token": "fixture"}}})
    monkeypatch.setattr(
        plugin_api,
        "_read_plugin_settings",
        lambda: {"refresh_seconds": 60, "visibility": {"kimi": False}},
    )
    writes = []
    monkeypatch.setattr(plugin_api, "_write_plugin_settings", writes.append)

    plugin_api.set_provider_visibility("grok", False)

    assert writes == [
        {
            "visibility": {"grok": False},
        }
    ]


def test_build_payload_does_not_fetch_disabled_providers(monkeypatch):
    """可见性闸门：被关的 provider 不取数、不出行（凭据用 fixture 注入发现层）。"""
    write_env({"KIMI_API_KEY": "sk-kimi-fixture", "GLM_API_KEY": "glm-fixture"})
    plugin_api._cache.update(at=0.0, payload=None, identity_overrides={})
    fetched = []

    def fake_fetch(provider_id, label):
        def fetch(_now, secret=""):
            fetched.append(provider_id)
            return [plugin_api._row(provider_id, label, providerId=provider_id, usedPercent=1.0)]

        return fetch

    monkeypatch.setattr(plugin_api, "_fetch_kimi", fake_fetch("kimi", "KIMI"))
    monkeypatch.setattr(plugin_api, "_fetch_glm", fake_fetch("glm", "GLM"))
    monkeypatch.setattr(
        plugin_api,
        "_read_plugin_settings",
        lambda: {"visibility": {"kimi": False}},
    )

    payload = plugin_api.build_payload()

    assert [row.id for row in payload.rows] == ["glm"]
    assert fetched == ["glm"]


def test_settings_routes_round_trip_provider_visibility(monkeypatch):
    write_env({"KIMI_API_KEY": "sk-kimi-fixture"})
    write_auth({"xai-oauth": {"tokens": {"access_token": "fixture"}}})
    state = {}

    def read_settings():
        return dict(state)

    def write_settings(settings):
        state.clear()
        state.update(settings)

    monkeypatch.setattr(plugin_api, "_read_plugin_settings", read_settings)
    monkeypatch.setattr(plugin_api, "_write_plugin_settings", write_settings)
    app = FastAPI()
    app.include_router(plugin_api.router)
    client = TestClient(app)

    before = client.get("/settings")
    changed = client.put("/settings/grok", json={"enabled": False})

    assert before.status_code == 200
    assert changed.status_code == 200
    providers = {item["id"]: item for item in changed.json()["providers"]}
    assert providers["grok"]["enabled"] is False
    assert providers["kimi"]["enabled"] is True


def test_codex_consumes_native_account_usage_windows(monkeypatch):
    snapshot = SimpleNamespace(
        windows=(
            SimpleNamespace(
                label="Session",
                used_percent=25.0,
                reset_at=datetime(2026, 9, 3, 1, 0, tzinfo=timezone.utc),
            ),
            SimpleNamespace(
                label="Weekly",
                used_percent=40.0,
                reset_at=datetime(2026, 9, 8, 1, 0, tzinfo=timezone.utc),
            ),
        ),
        unavailable_reason=None,
    )
    monkeypatch.setattr(
        plugin_api,
        "_fetch_native_account_usage",
        lambda provider: snapshot if provider == "openai-codex" else None,
    )

    rows = plugin_api._fetch_codex(0.0)

    assert [row.windowLabel for row in rows] == ["Session", "Weekly"]
    assert [row.windowSeconds for row in rows] == [5 * 3600, 7 * 86400]
    assert [row.usedPercent for row in rows] == [25.0, 40.0]
    assert all(row.providerId == "codex" for row in rows)


def test_grok_consumes_native_account_usage_and_skips_codexbar(monkeypatch):
    snapshot = SimpleNamespace(
        windows=(
            SimpleNamespace(
                label="SuperGrok weekly credits",
                used_percent=18.0,
                reset_at=datetime(2026, 7, 20, 14, 45, tzinfo=timezone.utc),
            ),
        ),
        unavailable_reason=None,
    )
    monkeypatch.setattr(
        plugin_api,
        "_fetch_native_account_usage",
        lambda provider: snapshot if provider == "xai-oauth" else None,
    )
    monkeypatch.setattr(
        plugin_api,
        "_run_codexbar",
        lambda provider: (_ for _ in ()).throw(AssertionError("codexbar")),
    )

    rows = plugin_api._fetch_grok(0.0)
    if not isinstance(rows, list):
        rows = [rows]

    assert [row.windowLabel for row in rows] == ["SuperGrok weekly credits"]
    assert rows[0].usedPercent == 18.0
    assert rows[0].windowSeconds == 7 * 86400
    assert rows[0].providerId == "grok"


def test_grok_falls_back_to_official_billing_when_native_missing(monkeypatch):
    monkeypatch.setattr(plugin_api, "_fetch_native_account_usage", lambda provider: None)
    monkeypatch.setattr(
        plugin_api,
        "_run_codexbar",
        lambda provider: (_ for _ in ()).throw(AssertionError("codexbar")),
    )
    monkeypatch.setattr(plugin_api, "_grok_oauth_token", lambda: "oauth-token")

    class FakeResponse:
        def read(self):
            return (
                b'{"config":{"creditUsagePercent":18,'
                b'"currentPeriod":{"end":"2026-07-20T14:45:00Z"}}}'
            )

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    def fake_urlopen(request, timeout=15):
        assert "cli-chat-proxy.grok.com/v1/billing" in request.full_url
        assert request.get_header("Authorization") == "Bearer oauth-token"
        return FakeResponse()

    monkeypatch.setattr(plugin_api.urllib.request, "urlopen", fake_urlopen)

    rows = plugin_api._fetch_grok(0.0)

    assert [row.windowLabel for row in rows] == ["SuperGrok weekly credits"]
    assert rows[0].usedPercent == 18.0
    assert rows[0].windowSeconds == 7 * 86400


def test_grok_billing_skips_duplicate_product_windows():
    snapshot = plugin_api._grok_snapshot_from_billing(
        {
            "config": {
                "creditUsagePercent": 72,
                "currentPeriod": {"end": "2026-07-20T14:45:00Z"},
                "productUsage": [
                    {"product": "GrokBuild", "usagePercent": 72},
                    {"product": "Api", "usagePercent": 2},
                ],
            }
        }
    )

    assert [window.label for window in snapshot.windows] == ["SuperGrok weekly credits"]
    assert snapshot.windows[0].used_percent == 72.0


def test_grok_billing_unified_billing_without_percent_shows_fresh_week():
    # 统一计费账户的实际响应：无 creditUsagePercent，onDemand 为 0/0，带本周周期
    snapshot = plugin_api._grok_snapshot_from_billing(
        {
            "config": {
                "currentPeriod": {
                    "type": "USAGE_PERIOD_TYPE_WEEKLY",
                    "start": "2026-09-07T06:28:53.093172+00:00",
                    "end": "2026-09-14T06:28:53.093172+00:00",
                },
                "onDemandCap": {"val": 0},
                "onDemandUsed": {"val": 0},
                "isUnifiedBillingUser": True,
            }
        }
    )

    assert snapshot is not None
    assert snapshot.windows[0].used_percent == 0.0
    assert snapshot.windows[0].reset_at == datetime(2026, 9, 14, 6, 28, 53, 93172, tzinfo=timezone.utc)


def test_grok_billing_derives_percent_from_on_demand():
    snapshot = plugin_api._grok_snapshot_from_billing(
        {
            "config": {
                "currentPeriod": {"end": "2026-09-14T06:28:53Z"},
                "onDemandCap": {"val": 50},
                "onDemandUsed": {"val": 10},
            }
        }
    )

    assert snapshot is not None
    assert snapshot.windows[0].used_percent == 20.0


def test_grok_billing_no_period_no_percent_returns_none():
    assert plugin_api._grok_snapshot_from_billing({"config": {}}) is None


def test_xai_missing_management_credentials_skips_codexbar(monkeypatch):
    monkeypatch.setattr(
        plugin_api,
        "_run_codexbar",
        lambda provider: (_ for _ in ()).throw(AssertionError("codexbar")),
    )
    monkeypatch.setattr(plugin_api, "_read_env_key", lambda name: "")

    row = plugin_api._fetch_xai(0.0)

    assert row.kind == "balance"
    assert row.providerId == "xai"
    assert row.error
    # 固定安全文案契约：错误存在且已脱敏（原始缺失凭据文本不再透传）
    assert "[redacted]" in row.error


def test_xai_parses_prepaid_ledger_cents(monkeypatch):
    monkeypatch.setattr(
        plugin_api,
        "_read_env_key",
        lambda name: {"XAI_MANAGEMENT_API_KEY": "mgmt", "XAI_TEAM_ID": "team-1"}.get(name, ""),
    )
    monkeypatch.setattr(
        plugin_api,
        "_json_get",
        lambda url, token: {"total": {"val": "-1000"}} if url.endswith("/prepaid/balance") else {},
    )

    row = plugin_api._fetch_xai(0.0)

    assert row.error is None
    assert row.kind == "balance"
    assert row.balance == 10.0
    assert row.currency == "USD"


def test_xai_parses_usage_series_daily_sums(monkeypatch):
    """usage 端点成功时：按 dataPoints 时间戳归入今天/7天/30天窗口求和。"""
    monkeypatch.setattr(
        plugin_api,
        "_read_env_key",
        lambda name: {"XAI_MANAGEMENT_API_KEY": "mgmt", "XAI_TEAM_ID": "team-1"}.get(name, ""),
    )
    import datetime as _dt

    tz = _dt.timezone(_dt.timedelta(hours=8))
    now = _dt.datetime(2026, 9, 12, 10, 0, tzinfo=tz)
    epoch_now = now.timestamp()

    def mkpoint(days_ago, val):
        ts = now - _dt.timedelta(days=days_ago)
        return {"timestamp": ts.astimezone(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "values": [val]}

    usage_payload = {"timeSeries": [{"dataPoints": [
        mkpoint(0, 0.5), mkpoint(3, 0.25), mkpoint(10, 1.0),
    ]}]}

    def fake_json_get(url, token, data=None):
        if url.endswith("/prepaid/balance"):
            return {"total": {"val": "-1000"}}
        if url.endswith("/usage"):
            return usage_payload
        raise AssertionError(url)

    monkeypatch.setattr(plugin_api, "_json_get", fake_json_get)

    row = plugin_api._fetch_xai(epoch_now)

    assert row.error is None
    assert row.todaySpend == 0.5
    assert row.sevenDaySpend == 0.75
    assert row.thirtyDaySpend == 1.75

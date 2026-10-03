"""OPENROUTER (prepaid balance + per-key usage) behavior tests.

Scope: only the openrouter provider. Existing providers/behavior are untouched.
网络层全部替换为假 urlopen —— 真实出网请求被 conftest.block_network 拦截；
凭据一律通过隔离 profile 的 .env（write_env）注入，不读真实凭据。
余额走 /credits、消费三列走 /key，假响应按 URL 分派。
"""

import json
import urllib.error

import pytest

from tests.conftest_sm import plugin_api, write_env


class _FakeResponse:
    def __init__(self, payload: bytes):
        self._payload = payload

    def read(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


def _credits_payload(total_credits=10.0, total_usage=2.5):
    return {"data": {"total_credits": total_credits, "total_usage": total_usage}}


def _key_payload(daily=1.0, weekly=3.0, monthly=5.0):
    return {"data": {"usage": 9.0, "usage_daily": daily, "usage_weekly": weekly, "usage_monthly": monthly}}


def _router_urlopen(credits=None, key=None, key_status=None, credits_status=None, captured=None):
    """按端点分派假响应。credits=None → /credits 500；*_status 给数字 → 该端点抛 HTTPError。"""

    def fake(request, timeout=15):
        url = request.full_url
        if captured is not None:
            captured.setdefault("urls", []).append(url)
            captured.setdefault("auth", {})[url] = request.get_header("Authorization")
        if "credits" in url:
            if credits_status is not None:
                raise urllib.error.HTTPError(url, credits_status, "err", {}, None)
            if credits is None:
                raise urllib.error.HTTPError(url, 500, "boom", {}, None)
            return _FakeResponse(json.dumps(credits).encode("utf-8"))
        if key_status is not None:
            raise urllib.error.HTTPError(url, key_status, "err", {}, None)
        if key is None:
            raise urllib.error.HTTPError(url, 500, "boom", {}, None)
        return _FakeResponse(json.dumps(key).encode("utf-8"))

    return fake


def test_openrouter_discovered_as_balance_with_fetcher():
    """OPENROUTER_API_KEY 被读到 → openrouter 条目的类型是余额、凭据说法在设置页，且不再是 no_fetcher。"""
    write_env({"OPENROUTER_API_KEY": "sk-or-v1-fixture"})
    payload = plugin_api.get_provider_settings()
    entry = next(item for item in payload.providers if item.id == "openrouter")
    assert entry.label == "OPENROUTER"
    assert entry.kind == "balance"
    assert entry.status != "no_fetcher"
    assert entry.credentials.get("requires") == "OPENROUTER_API_KEY"


def test_openrouter_fetches_balance_and_natural_window_spend(monkeypatch):
    """两个端点都成功 → 余额 = total_credits − total_usage；三列 = 自然窗口（本日/本周/本月）。"""
    write_env({"OPENROUTER_API_KEY": "sk-or-v1-fixture"})
    captured = {}
    monkeypatch.setattr(
        plugin_api.urllib.request, "urlopen",
        _router_urlopen(credits=_credits_payload(), key=_key_payload(), captured=captured),
    )

    row = plugin_api._fetch_openrouter(0.0)

    assert row.error is None
    assert row.kind == "balance"
    assert row.providerId == "openrouter"
    assert row.balance == 7.5
    assert row.currency == "USD"
    assert row.status == "ok"
    assert (row.todaySpend, row.sevenDaySpend, row.thirtyDaySpend) == (1.0, 3.0, 5.0)
    assert set(captured["urls"]) == {
        "https://openrouter.ai/api/v1/credits",
        "https://openrouter.ai/api/v1/key",
    }
    assert set(captured["auth"].values()) == {"Bearer sk-or-v1-fixture"}


def test_openrouter_spend_unavailable_keeps_balance(monkeypatch):
    """消费端点被拒 → 余额照常、三列不画、状态 partial（消费是可选项，不拖累余额）。"""
    write_env({"OPENROUTER_API_KEY": "sk-or-v1-fixture"})
    monkeypatch.setattr(
        plugin_api.urllib.request, "urlopen",
        _router_urlopen(credits=_credits_payload(), key_status=403),
    )

    row = plugin_api._fetch_openrouter(0.0)

    assert row.error is None
    assert row.balance == 7.5
    assert row.status == "partial"
    assert row.todaySpend is None and row.sevenDaySpend is None and row.thirtyDaySpend is None


def test_openrouter_zero_usage_keeps_full_balance_and_zero_columns(monkeypatch):
    """0 是真实值不是缺失：完全没用过 → 余额 = 充值总额，三列都画 0（不是空）。"""
    write_env({"OPENROUTER_API_KEY": "sk-or-v1-fixture"})
    monkeypatch.setattr(
        plugin_api.urllib.request, "urlopen",
        _router_urlopen(credits=_credits_payload(total_usage=0), key=_key_payload(0, 0, 0)),
    )

    row = plugin_api._fetch_openrouter(0.0)

    assert row.error is None
    assert row.balance == 10.0
    assert (row.todaySpend, row.sevenDaySpend, row.thirtyDaySpend) == (0.0, 0.0, 0.0)
    assert row.status == "ok"


def test_openrouter_bad_spend_shape_is_partial_not_ok(monkeypatch):
    """消费字段坏形态 → 不编造、退 partial；余额仍是真值。"""
    write_env({"OPENROUTER_API_KEY": "sk-or-v1-fixture"})
    monkeypatch.setattr(
        plugin_api.urllib.request, "urlopen",
        _router_urlopen(credits=_credits_payload(),
                        key={"data": {"usage_daily": "abc", "usage_weekly": 1, "usage_monthly": 2}}),
    )

    row = plugin_api._fetch_openrouter(0.0)

    assert row.balance == 7.5
    assert row.status == "partial"
    assert row.todaySpend is None and row.sevenDaySpend is None and row.thirtyDaySpend is None


@pytest.mark.parametrize(
    "payload",
    [
        {"data": {}},                                              # 缺两个字段
        {"data": {"total_credits": "abc", "total_usage": 1}},      # 非数字
        {},                                                        # 没有 data
    ],
)
def test_openrouter_bad_credits_payload_value_error(monkeypatch, payload):
    """余额端点形态不对 → 显式错误行（余额是主信息，坏了不能退成 partial 假绿）。"""
    write_env({"OPENROUTER_API_KEY": "sk-or-v1-fixture"})
    monkeypatch.setattr(plugin_api.urllib.request, "urlopen", _router_urlopen(credits=payload))

    row = plugin_api._fetch_openrouter(0.0)

    assert row.error is not None
    assert row.balance is None


def test_openrouter_missing_credential_readable(monkeypatch):
    """隔离 profile .env 没有 key → unconfigured + 指引文案，不崩也不猜。"""
    row = plugin_api._fetch_openrouter(0.0)

    assert row.status == "unconfigured"
    assert row.balance is None
    assert "OPENROUTER_API_KEY" in row.actionHint


@pytest.mark.parametrize("status", [401, 403])
def test_openrouter_http_401_403_is_auth_error(monkeypatch, status):
    """key 被拒（401/403）→ auth_error，且错误串绝不携带 key 值。"""
    write_env({"OPENROUTER_API_KEY": "sk-or-v1-wrong"})
    monkeypatch.setattr(
        plugin_api.urllib.request, "urlopen",
        _router_urlopen(credits_status=status),
    )

    row = plugin_api._fetch_openrouter(0.0)

    assert row.error is not None
    assert row.status == "auth_error"
    assert "sk-or" not in row.error


def test_openrouter_build_payload_binds_fetcher(monkeypatch):
    """FETCH_BY_ID 绑定成立：build_payload 走真 fetch，而不是 no_fetcher 占位行。"""
    write_env({"OPENROUTER_API_KEY": "sk-or-v1-fixture"})
    monkeypatch.setattr(
        plugin_api.urllib.request, "urlopen",
        _router_urlopen(credits=_credits_payload(), key=_key_payload()),
    )
    plugin_api._cache.update(at=0.0, payload=None, identity_overrides={})

    payload = plugin_api.build_payload()

    row = next(item for item in payload.rows if item.providerId == "openrouter")
    assert row.balance == 7.5
    assert row.todaySpend == 1.0
    assert row.gap is None
    assert row.status != "no_fetcher"

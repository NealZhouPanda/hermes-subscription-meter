"""OPENROUTER (prepaid credit balance) behavior tests — written BEFORE implementation (TDD RED).

Scope: only the new openrouter provider. Existing providers/behavior are untouched.
网络层全部替换为假 urlopen —— 真实出网请求被 conftest.block_network 拦截；
凭据一律通过隔离 profile 的 .env（write_env）注入，不读真实凭据。
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


def _credits_response(total_credits, total_usage):
    return json.dumps({"data": {"total_credits": total_credits, "total_usage": total_usage}}).encode("utf-8")


def _fake_urlopen(captured=None):
    def fake(request, timeout=15):
        if captured is not None:
            captured["url"] = request.full_url
            captured["auth"] = request.get_header("Authorization")
        return _FakeResponse(_credits_response(10.0, 2.5))

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


def test_openrouter_fetch_parses_credits_balance(monkeypatch):
    """官方 /credits 响应 → 余额 = total_credits − total_usage，美元，纯余额行（无消费列）。"""
    write_env({"OPENROUTER_API_KEY": "sk-or-v1-fixture"})
    captured = {}
    monkeypatch.setattr(plugin_api.urllib.request, "urlopen", _fake_urlopen(captured))

    row = plugin_api._fetch_openrouter(0.0)

    assert row.error is None
    assert row.kind == "balance"
    assert row.providerId == "openrouter"
    assert row.balance == 7.5
    assert row.currency == "USD"
    assert row.status == "ok"
    assert row.todaySpend is None and row.sevenDaySpend is None and row.thirtyDaySpend is None
    assert captured["url"] == "https://openrouter.ai/api/v1/credits"
    assert captured["auth"] == "Bearer sk-or-v1-fixture"


def test_openrouter_zero_usage_keeps_full_balance(monkeypatch):
    """0 是真实值不是缺失：完全没用过 → 余额 = 充值总额。"""
    write_env({"OPENROUTER_API_KEY": "sk-or-v1-fixture"})

    def fake_urlopen(request, timeout=15):
        return _FakeResponse(_credits_response(10.0, 0))

    monkeypatch.setattr(plugin_api.urllib.request, "urlopen", fake_urlopen)

    row = plugin_api._fetch_openrouter(0.0)

    assert row.error is None
    assert row.balance == 10.0


@pytest.mark.parametrize(
    "payload",
    [
        b'{"data": {}}',                                              # 缺两个字段
        b'{"data": {"total_credits": "abc", "total_usage": 1}}',      # 非数字
        b'{}',                                                        # 没有 data
    ],
)
def test_openrouter_bad_payload_value_error(monkeypatch, payload):
    """形态不对 → 显式 ValueError 错误行，不编造余额。"""
    write_env({"OPENROUTER_API_KEY": "sk-or-v1-fixture"})

    def fake_urlopen(request, timeout=15):
        return _FakeResponse(payload)

    monkeypatch.setattr(plugin_api.urllib.request, "urlopen", fake_urlopen)

    row = plugin_api._fetch_openrouter(0.0)

    assert row.error is not None
    assert row.balance is None


def test_openrouter_missing_credential_readable(monkeypatch):
    """隔离 profile .env 没有 key → unconfigured + 指引文案，不崩也不猜。"""
    row = plugin_api._fetch_openrouter(0.0)

    assert row.status == "unconfigured"
    assert row.balance is None
    assert "OPENROUTER_API_KEY" in row.actionHint


def test_openrouter_http_401_is_auth_error(monkeypatch):
    """key 被拒（401）→ auth_error，且错误串绝不携带 key 值。"""
    write_env({"OPENROUTER_API_KEY": "sk-or-v1-wrong"})

    def fake_urlopen(request, timeout=15):
        raise urllib.error.HTTPError(request.full_url, 401, "Unauthorized", {}, None)

    monkeypatch.setattr(plugin_api.urllib.request, "urlopen", fake_urlopen)

    row = plugin_api._fetch_openrouter(0.0)

    assert row.error is not None
    assert row.status == "auth_error"
    assert "sk-or" not in row.error


def test_openrouter_build_payload_binds_fetcher(monkeypatch):
    """FETCH_BY_ID 绑定成立：build_payload 走真 fetch，而不是 no_fetcher 占位行。"""
    write_env({"OPENROUTER_API_KEY": "sk-or-v1-fixture"})
    monkeypatch.setattr(plugin_api.urllib.request, "urlopen", _fake_urlopen())
    plugin_api._cache.update(at=0.0, payload=None, identity_overrides={})

    payload = plugin_api.build_payload()

    row = next(item for item in payload.rows if item.providerId == "openrouter")
    assert row.balance == 7.5
    assert row.gap is None
    assert row.status != "no_fetcher"
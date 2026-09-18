"""第一包数据可信度：未知值保持 null、真实零保持零、错误信息脱敏。

每条测试只针对一个行为，先于实现编写（TDD RED）。
"""

import urllib.error

from tests.conftest_sm import plugin_api  # noqa: F401  (module fixture import side effect free)


def test_xai_success_keeps_unknown_spend_fields_unset(monkeypatch):
    """余额成功但 usage 查询失败时：今日/7日/30日消费不可知，必须是 None 而不是 0。"""
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
    assert row.balance == 10.0
    assert row.currency == "USD"
    assert row.todaySpend is None
    assert row.sevenDaySpend is None
    assert row.thirtyDaySpend is None
    assert row.todayTone is None
    assert row.sevenDayTone is None
    assert row.thirtyDayTone is None
    # Tones are no longer computed from budgets or days-remaining.
    assert row.balanceTone is None


def test_nous_balance_row_keeps_unknown_spend_fields_unset():
    """NOUS 余额行同样不得伪造消费数据。"""
    row = plugin_api._nous_balance_row(4.11)

    assert row.balance == 4.11
    assert row.todaySpend is None
    assert row.sevenDaySpend is None
    assert row.thirtyDaySpend is None
    assert row.todayTone is None
    assert row.sevenDayTone is None
    assert row.thirtyDayTone is None
    assert row.balanceTone is None


def test_deepseek_real_zero_spend_stays_zero(monkeypatch):
    """真实零（有数据、数值为 0）必须保持 0.0 并按预算分类，不变成未知。"""

    def fake_json_get(url, _token):
        if url.startswith(plugin_api.DEEPSEEK_COST_URL):
            return {"data": {"biz_code": 0, "biz_data": {"bucket": 86400, "data": []}}}
        if url == plugin_api.DEEPSEEK_BALANCE_URL:
            return {
                "is_available": True,
                "balance_infos": [{"total_balance": "12.34", "currency": "CNY"}],
            }
        raise AssertionError(f"unexpected url: {url}")

    monkeypatch.setattr(plugin_api, "_platform_token", lambda: "platform-token")
    monkeypatch.setattr(plugin_api, "_json_get", fake_json_get)

    row = plugin_api._fetch_deepseek(1_800_000_000.0)

    assert row.error is None
    assert row.todaySpend == 0.0
    assert row.sevenDaySpend == 0.0
    assert row.thirtyDaySpend == 0.0
    assert row.todayTone is None
    assert row.balanceTone is None
    assert row.balance == 12.34


def test_row_error_is_sanitized_of_secret_fragments():
    """行级错误不得原样携带疑似密钥的片段。"""
    text = plugin_api._sanitize_error(
        ValueError("auth failed for Bearer sk-live-abcdef123456 at https://api.example.com/v1/x?token=zzz")
    )

    assert "sk-live-abcdef123456" not in text
    assert "zzz" not in text
    assert "[redacted]" in text


def test_xai_error_row_hides_credential_and_keeps_balance_unset(monkeypatch):
    monkeypatch.setattr(
        plugin_api,
        "_read_env_key",
        lambda name: {"XAI_MANAGEMENT_API_KEY": "mgmt", "XAI_TEAM_ID": "team-1"}.get(name, ""),
    )

    def boom(url, token):
        raise urllib.error.HTTPError(url, 401, "Unauthorized for Bearer sk-secret-abc123", None, None)

    monkeypatch.setattr(plugin_api, "_json_get", boom)

    row = plugin_api._fetch_xai(0.0)

    assert row.error
    assert "sk-secret-abc123" not in row.error
    assert row.balance is None
    assert row.todaySpend is None


def test_sanitize_error_emits_fixed_safe_message_only():
    """任何原始消息（含合成秘密标记）、URL、未知类名都不得进入错误字段。"""

    class SyntheticSecretError(Exception):
        pass

    for exc in (
        ValueError("password=SYNTHETIC_PRIVATE_VALUE_123"),
        RuntimeError("api_key=SYNTHETIC_PRIVATE_VALUE_123"),
        SyntheticSecretError("token SYNTHETIC_PRIVATE_VALUE_123 https://api.example.com/v1?token=x"),
        OSError("secret SYNTHETIC_PRIVATE_VALUE_123"),
    ):
        text = plugin_api._sanitize_error(exc)

        assert "SYNTHETIC_PRIVATE_VALUE_123" not in text
        assert "api.example.com" not in text
        assert "SyntheticSecretError" not in text
        assert "[redacted]" in text


def test_sanitize_error_keeps_only_whitelisted_kind_names():
    assert plugin_api._sanitize_error(ValueError("x")).startswith("ValueError:")
    assert plugin_api._sanitize_error(RuntimeError("x")).startswith("RuntimeError:")
    assert plugin_api._sanitize_error(TimeoutError("x")).startswith("TimeoutError:")

    class TotallyUnknownError(Exception):
        pass

    assert plugin_api._sanitize_error(TotallyUnknownError("x")).startswith("ProviderError:")


def test_error_rows_from_build_payload_carry_only_fixed_text(monkeypatch):
    """端到端：错误行进入 payload 后也只含固定安全文案。"""
    from tests.conftest_sm import write_auth

    write_auth({"xai-oauth": {"tokens": {"access_token": "fixture"}}})
    plugin_api._cache.update(at=0.0, payload=None, identity_overrides={})
    monkeypatch.setattr(plugin_api, "_read_plugin_settings", lambda: {})
    monkeypatch.setattr(
        plugin_api,
        "_fetch_grok",
        lambda now, secret="": plugin_api._row(
            "grok", "GROK", error=RuntimeError("password=SYNTHETIC_PRIVATE_VALUE_123"), providerId="grok"
        ),
    )

    payload = plugin_api.build_payload()
    grok = next(row for row in payload.rows if row.id == "grok")

    assert grok.error
    assert "SYNTHETIC_PRIVATE_VALUE_123" not in grok.error
    assert "[redacted]" in grok.error

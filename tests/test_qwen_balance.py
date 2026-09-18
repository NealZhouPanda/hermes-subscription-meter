"""QWEN (Aliyun BSS cash balance) behavior tests — written BEFORE implementation (TDD RED).

Scope: only the new qwen provider. Existing providers/behavior are untouched.
网络层全部替换为假 urlopen —— 真实出网请求被 conftest.block_network 拦截；
凭据一律通过专用 reader `_read_aliyun_env_key` 的 monkeypatch 注入，不读真实凭据。
"""

import json
import os
import urllib.error
import urllib.parse

import pytest

from tests.conftest_sm import plugin_api, write_env


def _qwen_env(monkeypatch):
    monkeypatch.setattr(
        plugin_api,
        "_read_aliyun_env_key",
        lambda name: {
            "ALIBABA_CLOUD_ACCESS_KEY_ID": "test-key-id",
            "ALIBABA_CLOUD_ACCESS_KEY_SECRET": "test-secret",
            "ALIBABA_CLOUD_SECURITY_TOKEN": "",
        }.get(name, ""),
    )


class _FakeResponse:
    def __init__(self, payload: bytes):
        self._payload = payload

    def read(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


def _resign(parsed: dict, secret: str) -> str:
    """独立 verifier：从 query 参数重新按 ACS 1.0 RPC 规则签名并返回 base64 签名。"""
    import base64
    import hashlib
    import hmac

    def penc(v):
        return urllib.parse.quote(str(v), safe="-_.~")

    items = {k: v for k, v in parsed.items() if k != "Signature"}
    canonical = "&".join(f"{penc(k)}={penc(v)}" for k, v in sorted(items.items()))
    sts = "GET&" + penc("/") + "&" + penc(canonical)
    digest = hmac.new(f"{secret}&".encode(), sts.encode(), hashlib.sha1).digest()
    return base64.b64encode(digest).decode()


def test_qwen_discovered_with_balance_kind():
    """阿里云 AccessKey（账本键）被发现后，qwen 条目以 balance 出现在设置页。"""
    write_env({
        "ALIBABA_CLOUD_ACCESS_KEY_ID": "LTAI-fixture",
        "ALIBABA_CLOUD_ACCESS_KEY_SECRET": "fixture-secret",
    })
    payload = plugin_api.get_provider_settings()
    qwen = next(item for item in payload.providers if item.id == "qwen")
    assert qwen.label == "QWEN"
    assert qwen.kind == "balance"
    assert qwen.enabled is True


def test_qwen_build_payload_visibility_gate(monkeypatch):
    """可见性闸门：qwen 关掉后不取数不出行；默认（无 visibility 条目）出行。"""
    write_env({
        "KIMI_API_KEY": "sk-kimi-fixture",
        "ALIBABA_CLOUD_ACCESS_KEY_ID": "LTAI-fixture",
        "ALIBABA_CLOUD_ACCESS_KEY_SECRET": "fixture-secret",
    })
    fetched = []

    def fake_fetch(provider_id, label, kind):
        def fetch(_now, secret=""):
            fetched.append(provider_id)
            if kind == "quota":
                return [plugin_api._row(provider_id, label, kind=kind, providerId=provider_id, usedPercent=1.0)]
            return [plugin_api._row(provider_id, label, kind=kind, providerId=provider_id, balance=1.0, currency="CNY")]

        return fetch

    monkeypatch.setattr(plugin_api, "_fetch_kimi", fake_fetch("kimi", "KIMI", "quota"))
    monkeypatch.setattr(plugin_api, "_fetch_qwen", fake_fetch("qwen", "QWEN", "balance"))

    monkeypatch.setattr(
        plugin_api,
        "_read_plugin_settings",
        lambda: {"visibility": {"qwen": False}},
    )
    plugin_api._cache.update(at=0.0, payload=None, identity_overrides={})
    payload = plugin_api.build_payload()
    assert all(row.providerId != "qwen" for row in payload.rows)
    assert "qwen" not in fetched

    # default (no visibility entry) must include the qwen row
    monkeypatch.setattr(plugin_api, "_read_plugin_settings", lambda: {})
    plugin_api._cache.update(at=0.0, payload=None, identity_overrides={})
    payload = plugin_api.build_payload()
    assert any(row.providerId == "qwen" for row in payload.rows)
    assert set(fetched) == {"kimi", "qwen"}


def test_qwen_missing_credentials_reports_readable_error(monkeypatch):
    monkeypatch.setattr(plugin_api, "_read_aliyun_env_key", lambda name: "")

    row = plugin_api._fetch_qwen(0.0)

    assert row.kind == "balance"
    assert row.providerId == "qwen"
    assert row.error, "missing credentials must surface a readable error"
    assert "ALIBABA_CLOUD_ACCESS_KEY_ID" in row.error
    assert "ALIBABA_CLOUD_ACCESS_KEY_SECRET" in row.error
    assert "DASHSCOPE_API_KEY is not an AccessKey" in row.error
    assert "sk-ws-" not in row.error  # never carries any key VALUE
    assert row.balance is None
    assert row.todaySpend is None
    assert row.sevenDaySpend is None
    assert row.thirtyDaySpend is None


def test_aliyun_reader_prefers_current_hermes_home_file(tmp_path, monkeypatch):
    """专用 reader：当前 HERMES_HOME/.env 优先；空配置时不回退到任何全局/其他 profile 文件。"""
    hermes_home = tmp_path / "home"
    hermes_home.mkdir()
    (hermes_home / ".env").write_text('ALIBABA_CLOUD_ACCESS_KEY_ID="file-key"\n', encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    monkeypatch.delenv("ALIBABA_CLOUD_ACCESS_KEY_ID", raising=False)
    assert plugin_api._read_aliyun_env_key("ALIBABA_CLOUD_ACCESS_KEY_ID") == "file-key"

    # 空配置：HERMES_HOME 下无 .env 且进程 env 无值 → 空（不读 Path.home()/.hermes/.env）
    empty_home = tmp_path / "empty-home"
    empty_home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(empty_home))
    assert plugin_api._read_aliyun_env_key("ALIBABA_CLOUD_ACCESS_KEY_ID") == ""
    # 进程 env 兜底仍有效
    monkeypatch.setenv("ALIBABA_CLOUD_ACCESS_KEY_ID", "env-key")
    assert plugin_api._read_aliyun_env_key("ALIBABA_CLOUD_ACCESS_KEY_ID") == "env-key"


def test_qwen_parses_official_cash_balance_and_currency(monkeypatch):
    _qwen_env(monkeypatch)
    captured = {}

    def fake_urlopen(request, timeout=15):
        captured["url"] = request.full_url
        captured["auth_header"] = request.get_header("Authorization")
        return _FakeResponse(
            json.dumps(
                {
                    "RequestId": "req-1",
                    "Success": True,
                    "Code": "Success",
                    "Data": {"AvailableCashAmount": "88.66", "Currency": "CNY", "AvailableAmount": "188.66"},
                }
            ).encode("utf-8")
        )

    monkeypatch.setattr(plugin_api.urllib.request, "urlopen", fake_urlopen)

    row = plugin_api._fetch_qwen(0.0)

    assert row.error is None
    assert row.kind == "balance"
    assert row.balance == 88.66  # cash only, NOT AvailableAmount
    assert row.currency == "CNY"
    assert row.todaySpend is None
    assert row.sevenDaySpend is None
    assert row.thirtyDaySpend is None
    assert row.balanceTone is None
    # BssOpenApi is an RPC-style GET signed via query string: no bearer header.
    assert captured["auth_header"] is None
    assert "Signature=" in captured["url"]
    assert "AccessKeyId=test-key-id" in captured["url"]
    assert "Timestamp=" in captured["url"]
    assert "SignatureNonce=" in captured["url"]
    parsed = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(captured["url"]).query))
    assert parsed["Signature"] == _resign(parsed, "test-secret")


def test_qwen_sts_token_reaches_request_and_signature(monkeypatch):
    """fake .env → _fetch_qwen → request.full_url 实际携带 SecurityToken 且签名可复算。"""
    monkeypatch.setattr(
        plugin_api,
        "_read_aliyun_env_key",
        lambda name: {
            "ALIBABA_CLOUD_ACCESS_KEY_ID": "sts-key-id",
            "ALIBABA_CLOUD_ACCESS_KEY_SECRET": "sts-secret",
            "ALIBABA_CLOUD_SECURITY_TOKEN": "sts-token-xyz",
        }.get(name, ""),
    )
    captured = {}

    def fake_urlopen(request, timeout=15):
        captured["url"] = request.full_url
        return _FakeResponse(
            json.dumps({"Success": True, "Data": {"AvailableCashAmount": "1.5", "Currency": "CNY"}}).encode("utf-8")
        )

    monkeypatch.setattr(plugin_api.urllib.request, "urlopen", fake_urlopen)

    row = plugin_api._fetch_qwen(0.0)

    assert row.error is None and row.balance == 1.5
    parsed = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(captured["url"]).query))
    assert parsed.get("SecurityToken") == "sts-token-xyz"  # 真实请求携带，非 helper-only
    assert parsed["Signature"] == _resign(parsed, "sts-secret")  # token 参与了 canonical 签名


def test_qwen_request_without_token_has_no_securitytoken_field(monkeypatch):
    _qwen_env(monkeypatch)
    captured = {}

    def fake_urlopen(request, timeout=15):
        captured["url"] = request.full_url
        return _FakeResponse(
            json.dumps({"Success": True, "Data": {"AvailableCashAmount": "1.5", "Currency": "CNY"}}).encode("utf-8")
        )

    monkeypatch.setattr(plugin_api.urllib.request, "urlopen", fake_urlopen)

    plugin_api._fetch_qwen(0.0)

    assert "SecurityToken" not in urllib.parse.parse_qsl(urllib.parse.urlparse(captured["url"]).query)


def test_qwen_signed_url_matches_fixed_regression_vector(monkeypatch):
    """固定回归向量：固定参数 → 固定签名值；独立 verifier 从 parse_qsl 重签比对。"""
    monkeypatch.setattr(plugin_api.time, "strftime", lambda fmt, *a, **k: "2026-09-06T00:00:00Z")
    monkeypatch.setattr(plugin_api.time, "gmtime", lambda *a, **k: None)
    monkeypatch.setattr(plugin_api.time, "time_ns", lambda: 1111111111111111111)

    url = plugin_api._aliyun_rpc_signed_url("test-key-id", "test-secret")

    assert url.startswith(plugin_api.ALIYUN_BSS_ENDPOINT + "?")
    assert url.endswith("Signature=l6prZDKjWKiWeVLV2Z7Z0LUnaig%3D")
    parsed = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(url).query))
    assert parsed["Signature"] == _resign(parsed, "test-secret")
    assert parsed["Timestamp"] == "2026-09-06T00:00:00Z"
    assert parsed["SignatureNonce"] == "1111111111111111111"


def test_qwen_error_is_sanitized_never_carries_secret_or_signed_url(monkeypatch):
    _qwen_env(monkeypatch)

    def fake_urlopen(request, timeout=15):
        # Simulate a raw error that would embed the signed URL / credentials.
        raise urllib.error.HTTPError(request.full_url, 403, "Forbidden", None, None)

    monkeypatch.setattr(plugin_api.urllib.request, "urlopen", fake_urlopen)

    row = plugin_api._fetch_qwen(0.0)

    assert row.error
    assert "test-key-id" not in row.error
    assert "test-secret" not in row.error
    assert "Signature" not in row.error
    assert "https://" not in row.error
    assert "http://" not in row.error


def test_sanitize_missing_credential_error_never_carries_exc_text():
    """MissingCredentialError 的任何 exc 文本（含哨兵）都不得进入 sanitize 结果。"""
    sentinel = plugin_api.MissingCredentialError("secret-sentinel-SYNTHETIC")

    text = plugin_api._sanitize_error(sentinel)

    assert "secret-sentinel-SYNTHETIC" not in text
    assert text == "MissingCredential: " + plugin_api._MISSING_CREDENTIAL_MESSAGES["qwen"]
    assert "ALIBABA_CLOUD_ACCESS_KEY_ID" in text


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("0.00", 0.0),   # real zero stays zero
        ("-3.5", -3.5),  # negative stays negative (no clamping)
        (88.66, 88.66),  # numeric payload accepted as-is
        (" 12.5 ", 12.5),  # whitespace-padded numeric string
    ],
)
def test_qwen_balance_values_keep_truth(monkeypatch, raw, expected):
    _qwen_env(monkeypatch)

    def fake_urlopen(request, timeout=15):
        return _FakeResponse(
            json.dumps({"Success": True, "Data": {"AvailableCashAmount": raw, "Currency": "CNY"}}).encode("utf-8")
        )

    monkeypatch.setattr(plugin_api.urllib.request, "urlopen", fake_urlopen)

    row = plugin_api._fetch_qwen(0.0)

    assert row.error is None
    assert row.balance == expected


@pytest.mark.parametrize(
    "raw",
    [
        float("nan"),
        float("inf"),
        float("-inf"),
        "   ",           # whitespace-only string
        [],              # list
        {"n": 1},        # object
    ],
)
def test_qwen_invalid_amount_inputs_error_not_zero(monkeypatch, raw):
    _qwen_env(monkeypatch)

    def fake_urlopen(request, timeout=15):
        return _FakeResponse(
            json.dumps({"Success": True, "Data": {"AvailableCashAmount": raw, "Currency": "CNY"}}).encode("utf-8")
        )

    monkeypatch.setattr(plugin_api.urllib.request, "urlopen", fake_urlopen)

    row = plugin_api._fetch_qwen(0.0)

    assert row.error
    assert row.balance is None


@pytest.mark.parametrize(
    "payload",
    [
        {"Success": True, "Data": None},                                   # null data
        {"Success": True, "Data": {}},                                     # missing cash field
        {"Success": True, "Data": {"AvailableCashAmount": None}},          # null value
        {"Success": True, "Data": {"AvailableCashAmount": True}},          # bool
        {"Success": True, "Data": {"AvailableCashAmount": "abc"}},         # non-numeric
        {"Success": False, "Code": "InvalidAccessKeyId.NotFound"},         # API-level failure
    ],
)
def test_qwen_invalid_payloads_error_without_fabricated_zero(monkeypatch, payload):
    _qwen_env(monkeypatch)

    def fake_urlopen(request, timeout=15):
        return _FakeResponse(json.dumps(payload).encode("utf-8"))

    monkeypatch.setattr(plugin_api.urllib.request, "urlopen", fake_urlopen)

    row = plugin_api._fetch_qwen(0.0)

    assert row.error, f"payload must not silently become a balance: {payload}"
    assert row.balance is None


@pytest.mark.parametrize(
    "currency",
    [None, "", "EUR", "cny", "  ", True, {"code": "CNY"}, ["CNY"]],
)
def test_qwen_unknown_or_missing_currency_is_rejected_not_defaulted(monkeypatch, currency):
    """官方仅支持 CNY/USD/JPY；缺失/未知/bool/对象币种必须报固定错误，不得默认 CNY。"""
    _qwen_env(monkeypatch)

    def fake_urlopen(request, timeout=15):
        return _FakeResponse(
            json.dumps({"Success": True, "Data": {"AvailableCashAmount": "5.0", "Currency": currency}}).encode("utf-8")
        )

    monkeypatch.setattr(plugin_api.urllib.request, "urlopen", fake_urlopen)

    row = plugin_api._fetch_qwen(0.0)

    assert row.error
    assert row.balance is None
    assert row.currency is None
    assert "Currency" in row.error or "[redacted]" in row.error


@pytest.mark.parametrize("currency", ["CNY", "USD", "JPY"])
def test_qwen_official_currencies_pass_through(monkeypatch, currency):
    _qwen_env(monkeypatch)

    def fake_urlopen(request, timeout=15):
        return _FakeResponse(
            json.dumps({"Success": True, "Data": {"AvailableCashAmount": "7.7", "Currency": currency}}).encode("utf-8")
        )

    monkeypatch.setattr(plugin_api.urllib.request, "urlopen", fake_urlopen)

    row = plugin_api._fetch_qwen(0.0)

    assert row.error is None
    assert row.balance == 7.7
    assert row.currency == currency

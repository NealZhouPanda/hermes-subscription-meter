"""发现-识别流水线测试（TDD RED，先于实现）。

契约：设置页/看板不再由 `_PROVIDER_CATALOG` 死名单驱动；条目来自
Hermes 供应方登记（PROVIDER_REGISTRY env 槽位 + auth.json OAuth 登录态 + 账本键）。
识别顺序：规则表（key 前缀 / auth.json provider id）→ 槽位猜测 →
规则取数明显失败回退猜测 → unrecognized；无取数适配器 → no_fetcher。
"""

from urllib.error import HTTPError

import pytest

from tests.conftest_sm import plugin_api, write_auth, write_env


def _ok_row(provider_id, label):
    return plugin_api._row(provider_id, label, kind="quota", providerId=provider_id, usedPercent=1.0)


def _reset_cache():
    plugin_api._cache.update(at=0.0, payload=None, identity_overrides={})


def test_empty_profile_yields_no_providers():
    """空 profile（无任何凭据）→ 设置页为空，不再吐出 8 家死名单。"""
    payload = plugin_api.get_provider_settings()
    assert payload.providers == []
    _reset_cache()
    assert plugin_api.build_payload().rows == []


def test_rule_identifies_kimi_key_in_kimi_slot():
    write_env({"KIMI_API_KEY": "sk-kimi-fixture-0001"})
    providers = {p.id: p for p in plugin_api.get_provider_settings().providers}
    assert "kimi" in providers
    assert providers["kimi"].kind == "quota"


def test_rule_overrides_env_slot_prior():
    """GLM_API_KEY 槽位里装 sk-kimi- key：规则压过槽位，识别为 kimi 而非 glm。"""
    write_env({"GLM_API_KEY": "sk-kimi-fixture-0002"})
    providers = {p.id: p for p in plugin_api.get_provider_settings().providers}
    assert "kimi" in providers
    assert "glm" not in providers


def test_registry_slot_with_unknown_key_shape_is_no_fetcher():
    """OPENAI_API_KEY 在 Hermes 登记里能认出是哪家，即使 key 形态陌生 → no_fetcher，不是 unrecognized。"""
    write_env({"OPENAI_API_KEY": "zz-mystery-fixture"})
    _reset_cache()
    providers = {p.id: p for p in plugin_api.get_provider_settings().providers}
    assert len(providers) == 1
    entry = next(iter(providers.values()))
    assert entry.status == "no_fetcher"
    assert plugin_api.build_payload().rows == []


def test_known_hermes_slot_without_fetcher_is_no_fetcher():
    """Hermes 登记槽位能认出是哪家，只是没有取数适配器 → no_fetcher，不是 unrecognized。"""
    write_env({"ANTHROPIC_API_KEY": "fixture-anthropic-key"})
    providers = {p.id: p for p in plugin_api.get_provider_settings().providers}
    assert len(providers) == 1
    entry = next(iter(providers.values()))
    assert entry.id == "anthropic"
    assert entry.status == "no_fetcher"
    _reset_cache()
    assert plugin_api.build_payload().rows == []


def test_unrecognized_and_no_fetcher_labels_present_in_desktop_frontend():
    """Frontend CONNECTION_LABELS must carry the unrecognized / no_fetcher copy."""
    from pathlib import Path

    js = Path(plugin_api.__file__).resolve().parents[1] / "desktop" / "plugin.js"
    text = js.read_text(encoding="utf-8")
    assert "unrecognized" in text and "API key not recognized" in text
    assert "no_fetcher" in text and "No fetcher available" in text


def test_rule_hit_auth_failure_falls_back_to_slot_guess(monkeypatch):
    """规则认成 kimi 但取数 401（明显不对）→ 丢掉规则身份，用槽位 glm 适配器再试。"""
    write_env({"GLM_API_KEY": "sk-kimi-fixture-0003"})
    _reset_cache()
    monkeypatch.setattr(
        plugin_api,
        "_fetch_kimi",
        lambda now, secret="": [
            plugin_api._row("kimi", "KIMI", providerId="kimi",
                            error=HTTPError("https://fixture.invalid", 401, "fixture", {}, None))
        ],
    )
    monkeypatch.setattr(
        plugin_api,
        "_fetch_glm",
        lambda now, secret="": [_ok_row("glm", "GLM")],
    )
    payload = plugin_api.build_payload()
    assert [row.providerId for row in payload.rows] == ["glm"]


def test_rule_hit_network_failure_keeps_error_rows(monkeypatch):
    """规则身份 + 网络类失败（非鉴权/形态）→ 不降级 unrecognized，保留错误行。"""
    write_env({"KIMI_API_KEY": "sk-kimi-fixture-0006"})
    _reset_cache()
    monkeypatch.setattr(
        plugin_api,
        "_fetch_kimi",
        lambda now, secret="": [
            plugin_api._row("kimi", "KIMI", providerId="kimi", error=TimeoutError("fixture"))
        ],
    )
    payload = plugin_api.build_payload()
    assert [row.providerId for row in payload.rows] == ["kimi"]
    assert payload.rows[0].status == "request_error"


def test_visibility_false_stays_in_settings_but_not_in_data(monkeypatch):
    write_env({"KIMI_API_KEY": "sk-kimi-fixture-0004"})
    monkeypatch.setattr(plugin_api, "_read_plugin_settings", lambda: {"visibility": {"kimi": False}})
    _reset_cache()
    called = []
    monkeypatch.setattr(
        plugin_api,
        "_fetch_kimi",
        lambda now, secret="": called.append(1) or [_ok_row("kimi", "KIMI")],
    )
    providers = {p.id: p for p in plugin_api.get_provider_settings().providers}
    assert providers["kimi"].enabled is False
    assert providers["kimi"].status == "disabled"
    payload = plugin_api.build_payload()
    assert payload.rows == []
    assert called == []


def test_credential_without_fetcher_is_no_fetcher():
    """xAI 推理 key（xai- 前缀）可识别但无账本适配器 → no_fetcher，看板不占行。"""
    write_env({"XAI_API_KEY": "xai-fixture-0005"})
    providers = {p.id: p for p in plugin_api.get_provider_settings().providers}
    entry = providers["xai-inference"]
    assert entry.status == "no_fetcher"
    _reset_cache()
    assert plugin_api.build_payload().rows == []


def test_oauth_providers_discovered_from_auth_json():
    write_auth({
        "openai-codex": {"tokens": {"access_token": "fixture-codex"}},
        "xai-oauth": {"tokens": {"access_token": "fixture-grok"}},
        "nous": {"access_token": "fixture-nous"},
    })
    providers = {p.id: p for p in plugin_api.get_provider_settings().providers}
    assert providers["codex"].kind == "quota"
    assert providers["grok"].kind == "quota"
    assert providers["nous"].kind == "balance"


def test_oauth_without_token_is_not_discovered():
    write_auth({"xai-oauth": {"tokens": {}}})
    assert plugin_api.get_provider_settings().providers == []


def test_oauth_known_provider_without_fetcher_is_no_fetcher():
    """已登录但无取数适配器的 OAuth 供应方 → no_fetcher。"""
    write_auth({"qwen-oauth": {"tokens": {"access_token": "fixture"}}})
    providers = {p.id: p for p in plugin_api.get_provider_settings().providers}
    assert providers["qwen-oauth"].status == "no_fetcher"


def test_ledger_keys_discovered_with_known_identity():
    """账本键（xAI Management / 阿里云 AccessKey）直接识别，不靠 key 前缀猜。"""
    write_env({
        "XAI_MANAGEMENT_API_KEY": "mgmt-fixture",
        "XAI_TEAM_ID": "team-fixture",
        "ALIBABA_CLOUD_ACCESS_KEY_ID": "LTAI-fixture",
        "ALIBABA_CLOUD_ACCESS_KEY_SECRET": "sec-fixture",
    })
    providers = {p.id: p for p in plugin_api.get_provider_settings().providers}
    assert providers["xai"].kind == "balance"
    assert providers["qwen"].kind == "balance"


def test_secrets_never_appear_in_settings_payload():
    write_env({"KIMI_API_KEY": "sk-kimi-SECRETENVFIXTURE"})
    write_auth({"xai-oauth": {"tokens": {"access_token": "SECRETOAUTHFIXTURE"}}})
    text = plugin_api.get_provider_settings().model_dump_json()
    assert "SECRETENVFIXTURE" not in text
    assert "SECRETOAUTHFIXTURE" not in text


def test_set_provider_visibility_rejects_undiscovered_id():
    """未被发现的 id 仍然拒绝（404 语义），只有已发现条目可开关。"""
    with pytest.raises(ValueError):
        plugin_api.set_provider_visibility("not-discovered", False)

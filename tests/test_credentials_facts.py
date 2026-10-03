"""设置页的凭据说明（2026-10-03 Neal 定）。

需求原话：需要额外填一条 API 的家，都要在设置里表明。落地口径：

- `requires`：必须填什么。identity.yaml 没手写就由 matchers 推导——槽位（env_slots）
  按定义是弱先验，列了几把是「任选其一」，用 `or`；ledger_env（账本键）与 OAuth
  登录态必须一起具备，用 `+` 串。
- `optional`：补哪一把能多看什么。只在 identity.yaml 手写，今天只有 DeepSeek 有
  （余额一把够，消费明细要网页登录态的 userToken）。
- 文案由后端拼好下发（和 actionHint 同一套做法），前端只画字、不认供应商名。

这里钉的是「哪家说了什么」这件事本身：XAI / QWEN 要的不是用户手上那把推理 key，
DeepSeek 要多一把可选的 token——这三条正是当初没人说清、用户看不到东西的原因。
"""

from tests.conftest_sm import plugin_api
from tests.conftest_sm import write_env


def _facts(provider_id):
    return plugin_api._credentials_facts(plugin_api._SPEC_BY_ID[provider_id])


def test_deepseek_advertises_the_optional_spend_token():
    facts = _facts("deepseek")
    assert facts["requires"] == "DEEPSEEK_API_KEY"
    assert "DEEPSEEK_PLATFORM_TOKEN" in facts["optional"]
    assert "spend" in facts["optional"]


def test_xai_and_qwen_name_the_credential_they_actually_need():
    # 两家都是「填了手上的 key 也没用」：XAI 要 Management API 的 key + team，
    # QWEN 余额要阿里云 AccessKey，都不是推理 key。
    assert _facts("xai")["requires"] == "XAI_MANAGEMENT_API_KEY + XAI_TEAM_ID"
    assert _facts("qwen")["requires"] == (
        "ALIBABA_CLOUD_ACCESS_KEY_ID + ALIBABA_CLOUD_ACCESS_KEY_SECRET"
    )


def test_slot_providers_list_alternatives_with_or():
    assert _facts("glm")["requires"] == "GLM_API_KEY or ZAI_API_KEY or Z_AI_API_KEY"
    assert "or" in _facts("kimi")["requires"]
    assert _facts("deepseek")["requires"] == "DEEPSEEK_API_KEY"


def test_oauth_providers_ask_for_a_login_not_a_key():
    assert _facts("codex")["requires"] == "Hermes login openai-codex"
    assert _facts("grok")["requires"] == "Hermes login xai-oauth"
    assert _facts("nous")["requires"] == "Hermes login nous"


def test_every_provider_with_a_fetcher_says_what_it_needs():
    for spec in plugin_api.FETCHER_SPECS:
        if not spec.fetch:
            continue
        assert plugin_api._credentials_facts(spec).get("requires"), spec.id


def test_optional_is_only_claimed_where_it_exists():
    with_optional = {
        spec.id for spec in plugin_api.FETCHER_SPECS
        if plugin_api._credentials_facts(spec).get("optional")
    }
    assert with_optional == {"deepseek"}


def test_settings_payload_carries_the_facts_for_a_discovered_provider():
    write_env({"DEEPSEEK_API_KEY": "sk-fixture"})
    plugin_api._cache.update(at=0.0, payload=None, identity_overrides={})
    providers = {p.id: p for p in plugin_api.get_provider_settings().providers}
    assert providers["deepseek"].credentials["requires"] == "DEEPSEEK_API_KEY"
    assert "DEEPSEEK_PLATFORM_TOKEN" in providers["deepseek"].credentials["optional"]


def test_a_credentialless_provider_reports_no_credentials():
    # 认不出的家没有 spec，也不该凭空编一句 "Needs:"。
    assert plugin_api._credentials_for({"id": "nope", "fetcher_id": None}) == {}

"""共享数据源映射（shared_sources）：源没绑 → 消费端不出这一行（2026-09-30）。

契约：`shared_sources` 映射的语义是「借用源 profile 的凭据」。因此

- 源 profile 根本**没绑**这家时，映射是死的 —— 源自己不显示这一行，消费端也不该
  凭空多出一行（旧行为会留下一行抓不到的幽灵行，且解绑源那侧也清不掉）。
- 源**有绑定但本次抓取失败**时，仍然下发真实错误行（fail-visible 行为不变，不静默吞行）。

映射本身是宿主机配置（真源 `~/.hermes/config.yaml`），这里直接注入 settings——与
`test_settings_persistence` 的既有做法一致——好让测试不依赖宿主配置读取器在当前 venv
里是否可导入。`_shared_source_home` 也指到临时目录，绝不碰真实 profiles。
"""

import json
from pathlib import Path

from tests.conftest_sm import plugin_api

SRC_NAME = "src"


def _reset_cache() -> None:
    plugin_api._cache.update(at=0.0, payload=None, identity_overrides={})


def _map_source(monkeypatch, src_home: Path, settings: dict) -> None:
    monkeypatch.setattr(plugin_api, "_read_plugin_settings", lambda: settings)
    monkeypatch.setattr(plugin_api, "_shared_source_home", lambda source: src_home)


def _make_source(tmp_path: Path, providers: dict | None) -> Path:
    """源 profile 目录；providers=None → 目录在、auth.json 不存在（从未绑过）。"""
    src = tmp_path / SRC_NAME
    src.mkdir()
    if providers is not None:
        (src / "auth.json").write_text(
            json.dumps({"providers": providers}), encoding="utf-8"
        )
    return src


def _grok_oauth() -> dict:
    return {"xai-oauth": {"tokens": {"access_token": "fixture"}}}


def test_dead_shared_mapping_is_not_injected(tmp_path, monkeypatch):
    """源 profile 存在但没有该家凭据 → 映射视为死的：不注入共享身份、不出行。"""
    src = _make_source(tmp_path, providers=None)
    _map_source(monkeypatch, src, {"shared_sources": {"grok": SRC_NAME}})
    _reset_cache()

    assert plugin_api._shared_source_map() == {}
    assert "grok" not in {identity["id"] for identity in plugin_api._identify_all()}
    assert [row for row in plugin_api.build_payload().rows if row.providerId == "grok"] == []


def test_live_shared_mapping_is_injected(tmp_path, monkeypatch):
    """源 profile 真的绑了这家 → 映射生效，消费端拿到 shared 身份（沿用取数路径）。"""
    src = _make_source(tmp_path, providers=_grok_oauth())
    _map_source(monkeypatch, src, {"shared_sources": {"grok": SRC_NAME}})
    _reset_cache()

    assert plugin_api._shared_source_map() == {"grok": SRC_NAME}
    identity = {item["id"]: item for item in plugin_api._identify_all()}["grok"]
    assert identity["via"] == "shared"
    assert identity["key"] == f"shared:{SRC_NAME}"


def test_unbinding_source_removes_the_shared_row(tmp_path, monkeypatch):
    """源侧解绑（auth.json 里的 token 没了）→ 消费端共享行随之消失，不留幽灵行。"""
    src = _make_source(tmp_path, providers=_grok_oauth())
    _map_source(monkeypatch, src, {"shared_sources": {"grok": SRC_NAME}})
    _reset_cache()
    assert "grok" in {identity["id"] for identity in plugin_api._identify_all()}

    # 源那一侧解绑：auth.json 里不再有 xai-oauth 的 token。
    (src / "auth.json").write_text(json.dumps({"providers": {}}), encoding="utf-8")
    _reset_cache()

    assert plugin_api._shared_source_map() == {}
    assert "grok" not in {identity["id"] for identity in plugin_api._identify_all()}


def test_source_with_binding_but_fetch_failure_keeps_error_row(tmp_path, monkeypatch):
    """源有绑定但取数失败 → 仍下发真实错误行（fail-visible 不变，不静默吞行）。"""
    src = _make_source(tmp_path, providers=_grok_oauth())
    _map_source(monkeypatch, src, {"shared_sources": {"grok": SRC_NAME}})

    def _failing_fetch(now, secret=""):
        return [plugin_api._row("grok", "GROK", error=RuntimeError("boom"), providerId="grok")]

    monkeypatch.setattr(plugin_api, "_fetch_grok", _failing_fetch)
    _reset_cache()

    rows = [row for row in plugin_api.build_payload().rows if row.providerId == "grok"]
    assert len(rows) == 1
    assert rows[0].status != "ok"


def test_shared_mapping_to_self_is_ignored(tmp_path, monkeypatch):
    """映射到当前 profile 自身 → 跳过（旧行为，不因新增 gating 而变）。"""
    monkeypatch.setattr(plugin_api, "_read_plugin_settings",
                        lambda: {"shared_sources": {"grok": "default"}})
    monkeypatch.setattr(plugin_api, "_shared_source_home",
                        lambda source: plugin_api.get_hermes_home())
    _reset_cache()

    assert plugin_api._shared_source_map() == {}

"""Persistence tests for the real provider-settings save path (no mocks).

Exercises the real ``PluginContext.set_config(key, value)`` host write layer
against a temp ``HERMES_HOME``: PUT persists visibility, GET reflects it, a
fresh process re-reads the same config.yaml, and sibling settings survive.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from tests.conftest_sm import plugin_api

HERMES_PYTHON = sys.executable


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(plugin_api.router)
    return TestClient(app)


def test_put_settings_persists_to_real_config_yaml(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    (tmp_path / "home").mkdir()
    (tmp_path / "home" / ".env").write_text("KIMI_API_KEY=sk-kimi-fixture\n", encoding="utf-8")
    (tmp_path / "home" / "auth.json").write_text(
        json.dumps({"providers": {"xai-oauth": {"tokens": {"access_token": "fixture"}}}}),
        encoding="utf-8",
    )
    client = _client()

    resp = client.put("/settings/grok", json={"enabled": False})
    assert resp.status_code == 200, resp.text
    providers = {item["id"]: item for item in resp.json()["providers"]}
    assert providers["grok"]["enabled"] is False
    assert providers["kimi"]["enabled"] is True

    # Real file on disk holds the setting under plugins.entries.subscription-meter.settings.
    import yaml
    raw = yaml.safe_load((tmp_path / "home" / "config.yaml").read_text(encoding="utf-8"))
    settings = raw["plugins"]["entries"]["subscription-meter"]["settings"]
    assert settings["visibility"] == {"grok": False}

    # Same process re-read (GET) reflects the persisted state.
    got = client.get("/settings").json()["providers"]
    assert {p["id"]: p["enabled"] for p in got}["grok"] is False


def test_new_process_rereads_persisted_config(tmp_path, monkeypatch):
    home = tmp_path / "home"
    monkeypatch.setenv("HERMES_HOME", str(home))
    home.mkdir()
    (home / ".env").write_text("KIMI_API_KEY=sk-kimi-fixture\n", encoding="utf-8")
    client = _client()
    resp = client.put("/settings/kimi", json={"enabled": False})
    assert resp.status_code == 200, resp.text

    # Fresh interpreter, same HERMES_HOME: the saved visibility must be visible.
    reader = (
        "import json, os\n"
        "from fastapi import FastAPI\n"
        "from fastapi.testclient import TestClient\n"
        "import importlib.util, sys\n"
        "p = os.environ['PLUGIN_API_PATH']\n"
        "spec = importlib.util.spec_from_file_location('plugin_api_rt', p)\n"
        "mod = importlib.util.module_from_spec(spec)\n"
        "sys.modules[spec.name] = mod\n"
        "spec.loader.exec_module(mod)\n"
        "app = FastAPI()\n"
        "app.include_router(mod.router)\n"
        "data = TestClient(app).get('/settings').json()['providers']\n"
        "print(json.dumps({d['id']: d['enabled'] for d in data}))\n"
    )
    env = dict(os.environ, HERMES_HOME=str(home), PLUGIN_API_PATH=str(
        Path(plugin_api.__file__).resolve()))
    proc = subprocess.run(
        [HERMES_PYTHON, "-c", reader], env=env, capture_output=True, text=True, timeout=120,
    )
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout.strip().splitlines()[-1])["kimi"] is False


def test_visibility_save_preserves_sibling_settings(tmp_path, monkeypatch):
    home = tmp_path / "home"
    monkeypatch.setenv("HERMES_HOME", str(home))
    home.mkdir()
    (home / ".env").write_text("GLM_API_KEY=glm-fixture\n", encoding="utf-8")
    (home / "auth.json").write_text(
        json.dumps({"providers": {"xai-oauth": {"tokens": {"access_token": "fixture"}}}}),
        encoding="utf-8",
    )
    import yaml
    config = home / "config.yaml"
    config.write_text(yaml.safe_dump({
        "plugins": {"entries": {"subscription-meter": {"settings": {
            "visibility": {"glm": False},
            "custom_note": "keep-me",
        }}}},
        "other_section": {"stay": True},
    }), encoding="utf-8")
    client = _client()

    resp = client.put("/settings/grok", json={"enabled": False})
    assert resp.status_code == 200, resp.text

    raw = yaml.safe_load(config.read_text(encoding="utf-8"))
    entry = raw["plugins"]["entries"]["subscription-meter"]
    assert entry["settings"]["visibility"] == {"glm": False, "grok": False}
    assert entry["settings"]["custom_note"] == "keep-me"
    assert raw["other_section"] == {"stay": True}


def test_visibility_write_does_not_reapply_a_stale_sibling_snapshot(tmp_path, monkeypatch):
    import yaml
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    (home / ".env").write_text("GLM_API_KEY=glm-fixture\n", encoding="utf-8")
    (home / "auth.json").write_text(
        json.dumps({"providers": {"xai-oauth": {"tokens": {"access_token": "fixture"}}}}))
    config = home / "config.yaml"
    config.write_text(yaml.safe_dump({"plugins":{"entries":{"subscription-meter":{"settings":{"visibility":{"glm":False}}}}}}))
    monkeypatch.setattr(plugin_api, "_read_plugin_settings", lambda: {"visibility":{"glm":True}})
    plugin_api.set_provider_visibility("grok", False)
    settings = yaml.safe_load(config.read_text())["plugins"]["entries"]["subscription-meter"]["settings"]
    assert settings["visibility"] == {"glm":False,"grok":False}


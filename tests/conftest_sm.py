"""Shared module loader for subscription-meter backend tests.

Loads ``dashboard/plugin_api.py`` as a standalone module (no package import)
so tests exercise the real file. Exposes the loaded ``plugin_api`` for
``from tests.conftest_sm import plugin_api``. Test isolation (temp
HERMES_HOME, outbound-socket guard) lives in ``conftest.py``.
"""

import importlib.util
import json
import os
import sys
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "dashboard" / "plugin_api.py"
SPEC = importlib.util.spec_from_file_location("subscription_meter_plugin_api", MODULE_PATH)
plugin_api = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = plugin_api
SPEC.loader.exec_module(plugin_api)


def write_env(values: dict) -> None:
    """把 KEY=VALUE 写进测试 profile 的 .env（HERMES_HOME 已由 conftest 隔离）。"""
    env_path = Path(os.environ["HERMES_HOME"]) / ".env"
    env_path.write_text("".join(f"{key}={value}\n" for key, value in values.items()), encoding="utf-8")


def write_auth(providers: dict) -> None:
    """把 providers 段写进测试 profile 的 auth.json（模拟 OAuth 登录态）。"""
    (Path(os.environ["HERMES_HOME"]) / "auth.json").write_text(
        json.dumps({"providers": providers}), encoding="utf-8")

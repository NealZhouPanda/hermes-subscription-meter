"""Subscription-meter backend — provider-neutral quota rows for the desktop meter.

Display visibility lives in plugins.entries.subscription-meter.settings.
Quota providers emit one 84-cell row per usage window; balance providers emit
an account row. Native Hermes account_usage is preferred when available.

条目不再由死名单驱动：发现层从 Hermes 供应方登记（PROVIDER_REGISTRY 的
api_key_env_vars）、当前 profile 的 auth.json（已登录 OAuth）与账本键收集
候选凭据；识别顺序 = FetcherSpec 规则组（key 前缀 / OAuth provider id）→
env 槽位弱先验猜测 → 规则取数明显失败回退猜测 → unrecognized；已识别但
无取数适配器 → no_fetcher。secret 只留在内存，绝不进入 API 响应/日志/错误串。

Credential sources:
- KIMI   : api.kimi.com/coding/v1/usages
- GLM    : open.bigmodel.cn .../quota/limit
- CODEX  : Hermes account_usage (openai-codex), fallback chatgpt.com usage
- GROK   : Hermes account_usage (xai-oauth), fallback cli-chat-proxy billing
- DEEPSEEK: api.deepseek.com balance + platform cost
- XAI    : xAI Management API prepaid balance (not the inference API key)
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import subprocess
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

CACHE_TTL_SECONDS = 120
from hermes_constants import get_hermes_home
CODEX_AUTH = Path.home() / ".codex" / "auth.json"
TOKEN_HELPER = Path(__file__).resolve().parent / "scripts" / "deepseek_platform_token.js"
NODE_BIN_CANDIDATES = ("/opt/homebrew/bin/node", "/usr/local/bin/node", "node")

KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages"
GLM_QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit"
CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits"
DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance"
DEEPSEEK_COST_URL = "https://platform.deepseek.com/api/v0/usage/by_api_key/cost"
# MiniMax Token Plan（订阅套餐）用量：只有套餐 Key 能查的开放平台端点，CN/全球
# base 共用同一路径（2026-09-12 实测：CN 真 key → status_code=0 带 model_remains；
# 全球 base 无效 key → 1004 cookie is missing，即路径有效、只是鉴权失败）。
MINIMAX_CN_BASE = "https://api.minimaxi.com"
MINIMAX_GLOBAL_BASE = "https://api.minimax.io"
MINIMAX_PLAN_REMAINS_PATH = "/v1/api/openplatform/coding_plan/remains"
ALIYUN_BSS_ENDPOINT = "https://business.aliyuncs.com/"
ALIYUN_BSS_VERSION = "2017-12-14"  # BssOpenApi QueryAccountBalance
DEEPSEEK_TZ_SECONDS = 8 * 60 * 60
WEEKLY_SECONDS = 7 * 86400
FIVE_HOUR_SECONDS = 5 * 3600
# MiniMax Token Plan：5h 窗额度 = 周额度 × 1/10（2026-09-12 定，与旧前端表
# SHORT_WINDOW_RATIO 的 MINIMAX 值同源）。端点不返回可用绝对值（*_total_count 恒 0），
# 所以由吐出这两行的 fetcher 在周期行上声明；前端 M0 起只认行上的 burstShare。
MINIMAX_BURST_SHARE = 0.1
# 短窗（5h）额度占主窗（周）的份额（2026-09-16 M2-StepA）：原先这三行在前端
# SHORT_WINDOW_RATIO 名表里，现在由吐出这两行的 fetcher 在周期行上声明——只有它
# 们知道自家口径，前端不该按供应商名猜比例。
KIMI_BURST_SHARE = 0.2
GLM_BURST_SHARE = 0.2
CODEX_BURST_SHARE = 0.15

# KIMI payload 里 window.timeUnit 的秒换算表（2026-09-09 实测口径）。
KIMI_TIME_UNIT_SECONDS = {
    "TIME_UNIT_MINUTE": 60,
    "TIME_UNIT_HOUR": 3600,
    "TIME_UNIT_DAY": 86400,
}

router = APIRouter()


class MeterRow(BaseModel):
    id: str
    providerId: str = ""
    accountId: str = "default"
    label: str
    kind: str = "quota"
    windowLabel: Optional[str] = None
    windowSeconds: Optional[int] = None
    # 行契约（2026-09-15 M1 起）：role=cycle 主窗 / burst 短窗（burst 不单独成行）；
    # burstShare 为短窗额度占主窗的比例，只写在 cycle 行上，缺则前端不画锁定段。
    role: Optional[str] = None
    burstShare: Optional[float] = None
    # 供应商事实（M2-StepA 起由 FetcherSpec.meta 在 build_payload 里抄进行）：accent=品牌色，
    # peakHours={timezone, daily, windows}。前端只读行上这两条，不按供应商名查表。
    accent: Optional[str] = None
    peakHours: Optional[dict] = None
    usedPercent: float = 0.0
    resetAt: Optional[float] = None
    balanceTone: Optional[str] = None
    todayTone: Optional[str] = None
    sevenDayTone: Optional[str] = None
    thirtyDayTone: Optional[str] = None
    currency: Optional[str] = None
    balance: Optional[float] = None
    todaySpend: Optional[float] = None
    sevenDaySpend: Optional[float] = None
    thirtyDaySpend: Optional[float] = None
    error: Optional[str] = None
    status: str = "unknown"
    actionHint: str = ""
    checkedAt: Optional[float] = None


class MeterPayload(BaseModel):
    rows: list[MeterRow] = Field(default_factory=list)
    generatedAt: float = 0.0


class ProviderSetting(BaseModel):
    id: str
    label: str
    kind: str
    enabled: bool = True
    status: str = "unknown"
    actionHint: str = ""
    checkedAt: Optional[float] = None


class ProviderSettingsPayload(BaseModel):
    providers: list[ProviderSetting] = Field(default_factory=list)


class ProviderVisibilityUpdate(BaseModel):
    enabled: bool


# --- A/B/C. 发现 + 识别（FetcherSpec，非显示名单） ----------------------------------
#
# 原七张登记表（key 前缀 / OAuth host / 账本键 / env 槽位先验 / 取数注册 /
# label-kind / 供应商 meta）已于 2026-09-16 M3 收编为 FetcherSpec（id / fetch(可空) /
# shareable / matchers / meta，方案见 release-prep/refactor-20260915/design/round2-grok-final.md §2）。
# 取数函数体一律原地保留，这里只登记引用；fetch 存模块内函数名，调用时经 globals()
# 解析，保留 monkeypatch 接缝。
#
# 声明序即 detect 全局排队序。选序理由（non-obvious）：ledger / env_slot 的派生序必须
# 与旧表逐项同序——候选加入顺序是「先发现者优先」去重和设置页/看板行序的输入；
# 前缀规则按长度竞争，旧表书写序不参与胜负，但派生序仍与旧表保持同序以便核对。
@dataclass(frozen=True)
class FetcherSpec:
    """单家供应方的身份 + 取数登记（M3 收编，替代七张散表）。

    matchers 是本 id 的规则组：prefixes（① 前缀，长度竞争）、oauth（② auth.json
    host id）、env_slots（③ env 槽位弱先验）、ledger_env（④ 账本键，env 名即身份）、
    label_kind（旧行为元组 (label, kind)）。meta 是抄进行内的供应商事实
    （accent / peakHours）。fetch=None = 有身份无取数。
    """

    id: str
    fetch: Optional[str]  # 模块内函数名；None=有身份无取数
    shareable: bool
    matchers: dict[str, Any]
    meta: dict[str, Any]


FETCHER_SPECS = (
    FetcherSpec("anthropic", None, False,
                {"prefixes": (("sk-ant-oat", "quota", "ANTHROPIC"),
                              ("sk-ant-", "quota", "ANTHROPIC")),
                 "oauth": (), "env_slots": (), "ledger_env": (),
                 "label_kind": ("ANTHROPIC", "quota")}, {}),
    FetcherSpec("openrouter", None, False,
                {"prefixes": (("sk-or-", "balance", "OPENROUTER"),),
                 "oauth": (), "env_slots": (), "ledger_env": (),
                 "label_kind": ("OPENROUTER", "balance")}, {}),
    FetcherSpec("kimi", "_fetch_kimi", False,
                {"prefixes": (("sk-kimi-", "quota", "KIMI"),),
                 "oauth": (),
                 "env_slots": ("KIMI_API_KEY", "KIMI_CODING_API_KEY", "KIMI_CN_API_KEY"),
                 "ledger_env": (), "label_kind": ("KIMI", "quota")},
                {"accent": "#14AE68"}),
    FetcherSpec("qwen-dashscope", None, False,
                {"prefixes": (("sk-ws-", "quota", "QWEN DASHSCOPE"),),
                 "oauth": (), "env_slots": (), "ledger_env": (),
                 "label_kind": ("QWEN DASHSCOPE", "quota")}, {}),
    FetcherSpec("xai-inference", None, False,
                {"prefixes": (("xai-", "quota", "XAI API"),),
                 "oauth": (), "env_slots": (), "ledger_env": (),
                 "label_kind": ("XAI API", "quota")}, {}),
    FetcherSpec("xai", "_fetch_xai", False,
                {"prefixes": (), "oauth": (), "env_slots": (),
                 "ledger_env": ("XAI_MANAGEMENT_API_KEY",),
                 "label_kind": ("XAI", "balance")}, {}),
    FetcherSpec("qwen", "_fetch_qwen", False,
                {"prefixes": (("LTAI", "balance", "QWEN"),),
                 "oauth": (), "env_slots": (),
                 "ledger_env": ("ALIBABA_CLOUD_ACCESS_KEY_ID",),
                 "label_kind": ("QWEN", "balance")}, {}),
    FetcherSpec("glm", "_fetch_glm", False,
                {"prefixes": (), "oauth": (),
                 "env_slots": ("GLM_API_KEY", "ZAI_API_KEY", "Z_AI_API_KEY"),
                 "ledger_env": (), "label_kind": ("GLM", "quota")},
                {"accent": "#F39800",
                 "peakHours": {"timezone": "+08:00", "daily": False,
                               "windows": [[840, 1080]]}}),
    FetcherSpec("deepseek", "_fetch_deepseek", False,
                {"prefixes": (), "oauth": (), "env_slots": ("DEEPSEEK_API_KEY",),
                 "ledger_env": (), "label_kind": ("DEEPSEEK", "balance")},
                {"peakHours": {"timezone": "+08:00", "daily": False,
                               "windows": [[540, 720], [840, 1080]]}}),
    FetcherSpec("minimax-cn", "_fetch_minimax_cn", False,
                {"prefixes": (), "oauth": (), "env_slots": ("MINIMAX_CN_API_KEY",),
                 "ledger_env": (), "label_kind": ("MINIMAX", "quota")}, {}),
    FetcherSpec("minimax", "_fetch_minimax_global", False,
                {"prefixes": (), "oauth": (), "env_slots": ("MINIMAX_API_KEY",),
                 "ledger_env": (), "label_kind": ("MINIMAX", "quota")}, {}),
    FetcherSpec("codex", "_fetch_codex", True,
                {"prefixes": (), "oauth": ("openai-codex",), "env_slots": (),
                 "ledger_env": (), "label_kind": ("CODEX", "quota")},
                {"accent": "#28A7E0"}),
    FetcherSpec("grok", "_fetch_grok", True,
                {"prefixes": (), "oauth": ("xai-oauth",), "env_slots": (),
                 "ledger_env": (), "label_kind": ("GROK", "quota")},
                {"accent": "#1DA1F2"}),
    FetcherSpec("nous", "_fetch_nous", False,
                {"prefixes": (), "oauth": ("nous",), "env_slots": (),
                 "ledger_env": (), "label_kind": ("NOUS", "balance")},
                {"accent": "#6366F1"}),
)

_SPEC_BY_ID = {spec.id: spec for spec in FETCHER_SPECS}

# 长度竞争需要全局前缀池：按声明序展开，胜负只看前缀长度（_match_key_rule）。
_PREFIX_RULE_POOL = tuple(
    (prefix, (spec.id, kind, label))
    for spec in FETCHER_SPECS
    for prefix, kind, label in spec.matchers["prefixes"]
)


def _oauth_match(auth_provider: str) -> Optional[str]:
    return next((s.id for s in FETCHER_SPECS if auth_provider in s.matchers["oauth"]), None)


def _slot_match_id(env_name: str) -> Optional[str]:
    return next((s.id for s in FETCHER_SPECS if env_name in s.matchers["env_slots"]), None)


def _ledger_match(env_name: str) -> Optional[tuple[str, str, str]]:
    spec = next((s for s in FETCHER_SPECS if env_name in s.matchers["ledger_env"]), None)
    return _identity_triple(spec.id) if spec else None


def _has_fetcher(spec_id: str) -> bool:
    spec = _SPEC_BY_ID.get(spec_id)
    return bool(spec and spec.fetch)


def _label_kind(spec_id: str) -> tuple[str, str]:
    return _SPEC_BY_ID[spec_id].matchers["label_kind"]


def _identity_triple(spec_id: str) -> tuple[str, str, str]:
    """(provider_id, kind, label)，与旧表值的存放顺序一致（label_kind 存的是
    (label, kind)，这里负责换序，调用方解包顺序不碎）。"""
    label, kind = _label_kind(spec_id)
    return (spec_id, kind, label)


def _provider_meta(spec_id: str) -> dict[str, Any]:
    spec = _SPEC_BY_ID.get(spec_id)
    return spec.meta if spec else {}

# hermes_cli 不可导入时的兜底槽位清单（仍是固定已知键，不扫全部 .env）。
_FALLBACK_ENV_SLOTS = (
    "KIMI_API_KEY", "KIMI_CODING_API_KEY", "GLM_API_KEY", "ZAI_API_KEY",
    "DEEPSEEK_API_KEY", "XAI_API_KEY", "DASHSCOPE_API_KEY",
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
)

_UNRECOGNIZED_HINT = "无法识别该 API key 对应的供应方；请检查当前 profile 的 .env 配置。"
_NO_FETCHER_HINT = "已识别供应方，但暂无取数适配器；条目可开关，看板不占行。"


def _registry_env_vars() -> dict[str, tuple[str, str]]:
    """env 槽位名 → (registry provider id, 显示名)，来自 Hermes 供应方登记。"""
    try:
        from hermes_cli.auth import PROVIDER_REGISTRY
    except Exception:
        return {name: ("", "") for name in _FALLBACK_ENV_SLOTS}
    result: dict[str, tuple[str, str]] = {}
    for provider in PROVIDER_REGISTRY.values():
        for env_name in getattr(provider, "api_key_env_vars", ()) or ():
            result.setdefault(env_name, (provider.id, provider.name))
    return result


def _logged_in_oauth_providers() -> list[str]:
    """当前 profile auth.json 里有 token 的 provider id 列表（有 token 才算登录）。"""
    try:
        store = json.loads((get_hermes_home() / "auth.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    providers = store.get("providers") if isinstance(store, dict) else None
    if not isinstance(providers, dict):
        return []
    logged = []
    for provider_id, entry in providers.items():
        if not isinstance(entry, dict):
            continue
        tokens = entry.get("tokens") if isinstance(entry.get("tokens"), dict) else {}
        if any(
            str(entry.get(field) or tokens.get(field) or "").strip()
            for field in ("access_token", "refresh_token", "agent_key")
        ):
            logged.append(provider_id)
    return logged


def _discover_credentials() -> list[dict[str, Any]]:
    """A. 收集候选凭据。secret 只留在内存，不进 API 响应/日志/错误串。"""
    candidates: list[dict[str, Any]] = []
    seen_env: set[str] = set()
    for env_name, (registry_id, registry_name) in _registry_env_vars().items():
        if env_name in seen_env:
            continue
        seen_env.add(env_name)
        secret = _read_env_key(env_name)
        if secret:
            candidates.append({
                "source": "env", "env_name": env_name, "secret": secret,
                "registry_id": registry_id, "registry_name": registry_name,
            })
    for spec in FETCHER_SPECS:
        for env_name in spec.matchers["ledger_env"]:
            if env_name in seen_env:
                continue
            seen_env.add(env_name)
            secret = _read_env_key(env_name)
            if secret:
                candidates.append({"source": "ledger", "env_name": env_name, "secret": secret})
    for provider_id in _logged_in_oauth_providers():
        candidates.append({"source": "oauth", "auth_provider": provider_id, "secret": ""})
    return candidates


def _match_key_rule(secret: str) -> tuple[str, str, str] | None:
    """B. Spec 前缀规则组匹配，更具体的前缀优先。返回 (provider_id, kind, label)。"""
    best: tuple[int, str, str, str] | None = None
    for prefix, (provider_id, kind, label) in _PREFIX_RULE_POOL:
        if secret.startswith(prefix) and (best is None or len(prefix) > best[0]):
            best = (len(prefix), provider_id, kind, label)
    return best[1:] if best else None


def _identity(
    provider_id: str, label: str, kind: str, fetcher_id: Optional[str],
    via: Optional[str], key: str, env_name: Optional[str], secret: str,
) -> dict[str, Any]:
    if fetcher_id is None:
        status = "unrecognized" if via is None else "no_fetcher"
    else:
        status = "unknown"
    return {
        "id": provider_id, "label": label, "kind": kind, "fetcher_id": fetcher_id,
        "via": via, "key": key, "env_name": env_name, "secret": secret, "status": status,
    }


def _classify_candidate(candidate: dict[str, Any]) -> dict[str, Any]:
    """识别流水线的静态部分（步骤 1/2，不发网络请求）：
    OAuth 按 auth.json provider id；env 先前缀规则组、再槽位弱先验。"""
    source = candidate["source"]
    if source == "oauth":
        auth_provider = candidate["auth_provider"]
        matched_id = _oauth_match(auth_provider)
        if matched_id:
            provider_id, kind, label = _identity_triple(matched_id)
        else:
            provider_id, kind, label = auth_provider, "quota", auth_provider.upper()
        fetcher_id = provider_id if _has_fetcher(provider_id) else None
        return _identity(provider_id, label, kind, fetcher_id, "oauth",
                         f"oauth:{auth_provider}", None, "")
    if source == "ledger":
        provider_id, kind, label = _ledger_match(candidate["env_name"])
        fetcher_id = provider_id if _has_fetcher(provider_id) else None
        return _identity(provider_id, label, kind, fetcher_id, "ledger",
                         f"env:{candidate['env_name']}", candidate["env_name"], candidate["secret"])
    # env 候选：规则表优先（槽位不是身份）。
    rule = _match_key_rule(candidate["secret"])
    if rule:
        provider_id, kind, label = rule
        fetcher_id = provider_id if _has_fetcher(provider_id) else None
        return _identity(provider_id, label, kind, fetcher_id, "rule",
                         f"env:{candidate['env_name']}", candidate["env_name"], candidate["secret"])
    # 步骤 2：槽位弱先验猜测（取数形态校验在 build_payload 的探测里做）。
    fetcher_id = _slot_match_id(candidate["env_name"])
    if fetcher_id:
        label, kind = _label_kind(fetcher_id)
        return _identity(fetcher_id, label, kind, fetcher_id, "slot",
                         f"env:{candidate['env_name']}", candidate["env_name"], candidate["secret"])
    # Hermes 登记槽位已经能认出是哪家：没有取数适配器 → no_fetcher，不是 unrecognized。
    registry_id = str(candidate.get("registry_id") or "").strip()
    if registry_id:
        fetcher_id = registry_id if _has_fetcher(registry_id) else None
        if fetcher_id:
            label, kind = _label_kind(fetcher_id)
            provider_id = fetcher_id
        else:
            provider_id = registry_id
            label = candidate.get("registry_name") or registry_id
            kind = "quota"
        return _identity(
            provider_id, label, kind, fetcher_id, "slot",
            f"env:{candidate['env_name']}", candidate["env_name"], candidate["secret"])
    return _identity(
        candidate["env_name"].lower(),
        candidate["env_name"],
        "quota", None, None,
        f"env:{candidate['env_name']}", candidate["env_name"], candidate["secret"])
def _shared_source_home(source: str) -> Path:
    if source == "default":
        return Path.home() / ".hermes"
    return Path.home() / ".hermes" / "profiles" / source


def _shared_source_map() -> dict[str, str]:
    """当前 profile 插件设置里的显式数据源映射 provider id → 源 profile 名。

    无映射 → 空 dict（行为与之前完全一致）；仅 Spec 上 shareable=True 的 provider
    生效（唯一真源在 FETCHER_SPECS，M6 收编原白名单语义）；
    源目录不存在或映射到自身时跳过，不做模糊猜测。
    """
    raw = _read_plugin_settings().get("shared_sources")
    if not isinstance(raw, dict):
        return {}
    result: dict[str, str] = {}
    for provider_id, source in raw.items():
        spec = _SPEC_BY_ID.get(provider_id)
        if not (spec and spec.shareable):
            continue
        if not isinstance(source, str) or not source.strip():
            continue
        home = _shared_source_home(source.strip())
        if not home.is_dir() or home.resolve() == get_hermes_home().resolve():
            continue
        result[provider_id] = source.strip()
    return result


def _identify_all() -> list[dict[str, Any]]:
    """发现 + 静态识别，按 provider id 去重（先发现者优先）。

    shared_sources 显式映射优先于本 profile 本地候选（冲突时以映射为准），
    并为映射 provider 注入 shared 身份，使发现门控与取数来源一致。
    """
    shared = _shared_source_map()
    identities: list[dict[str, Any]] = []
    seen: set[str] = set(shared)
    for candidate in _discover_credentials():
        identity = _classify_candidate(candidate)
        if identity["id"] in seen:
            continue
        seen.add(identity["id"])
        identities.append(identity)
    for provider_id, source in shared.items():
        label, kind = _label_kind(provider_id)
        identities.append(
            _identity(provider_id, label, kind, provider_id, "shared",
                      f"shared:{source}", None, "")
        )
    return identities


def _resolve_fetcher(fetcher_id: str):
    spec = _SPEC_BY_ID.get(fetcher_id)
    return globals().get(spec.fetch) if spec and spec.fetch else None


def _read_plugin_settings() -> dict[str, Any]:
    try:
        from hermes_cli.config import read_user_config_raw

        config = read_user_config_raw()
    except Exception:
        return {}
    plugins = config.get("plugins") if isinstance(config, dict) else None
    entries = plugins.get("entries") if isinstance(plugins, dict) else None
    entry = entries.get("subscription-meter") if isinstance(entries, dict) else None
    settings = entry.get("settings") if isinstance(entry, dict) else None
    return dict(settings) if isinstance(settings, dict) else {}


def _write_plugin_settings(settings: dict[str, Any]) -> None:
    from hermes_cli.plugins import PluginContext, PluginManifest

    context = PluginContext(
        PluginManifest(name="subscription-meter", key="subscription-meter"),
        manager=None,
    )
    for key, value in settings.items():
        if key == "visibility":
            # Patch the leaf under the host lock, never an old sibling snapshot.
            for provider_id, enabled in value.items():
                context.set_config(f"visibility.{provider_id}", enabled)
        else:
            context.set_config(key, value)


def set_provider_visibility(provider_id: str, enabled: bool) -> None:
    known_ids = {identity["id"] for identity in _identify_all()}
    if provider_id not in known_ids:
        raise ValueError(f"unknown provider: {provider_id}")
    _write_plugin_settings({"visibility": {provider_id: enabled}})
    _cache.update(at=0.0, payload=None, identity_overrides={})


def _identity_status(identity: dict[str, Any], enabled: bool) -> dict[str, Any]:
    hint = _ACTION_HINTS.get(identity["id"], "检查当前 profile 的账户配置并刷新。")
    if not enabled:
        return {"status": "disabled", "actionHint": hint}
    if identity["status"] == "no_fetcher":
        return {"status": "no_fetcher", "actionHint": _NO_FETCHER_HINT}
    overrides = _cache.get("identity_overrides") or {}
    if identity["status"] == "unrecognized" or overrides.get(identity["key"]) == "unrecognized":
        return {"status": "unrecognized", "actionHint": _UNRECOGNIZED_HINT}
    cached = _cache.get("payload")
    rows = [row for row in cached.rows if row.providerId == identity["id"]] if cached else []
    if rows:
        row = next((row for row in rows if row.status != "ok"), rows[0])
        return {"status": row.status, "actionHint": row.actionHint, "checkedAt": row.checkedAt}
    return {"status": "unknown", "actionHint": hint}


def get_provider_settings() -> ProviderSettingsPayload:
    """设置页只列发现到的条目（含 unrecognized / no_fetcher / disabled）；
    没凭据的家不占位。"""
    settings = _read_plugin_settings()
    visibility = settings.get("visibility")
    visibility = visibility if isinstance(visibility, dict) else {}
    providers = []
    for identity in _identify_all():
        raw = visibility.get(identity["id"], True)
        enabled = raw if isinstance(raw, bool) else True
        providers.append(
            ProviderSetting(
                id=identity["id"],
                label=identity["label"],
                kind=identity["kind"],
                enabled=enabled,
                **_identity_status(identity, enabled),
            )
        )
    return ProviderSettingsPayload(providers=providers)


_cache: dict[str, Any] = {"at": 0.0, "payload": None, "identity_overrides": {}}


# --- shared helpers -----------------------------------------------------------


def _read_env_key(name: str) -> str:
    try:
        for line in (get_hermes_home() / ".env").read_text(encoding="utf-8").splitlines():
            if line.startswith(f"{name}="):
                return line.split("=", 1)[1].strip().strip("\"'")
    except OSError:
        pass
    # Named profiles must not inherit credentials from the hosting process.
    if get_hermes_home().resolve() != (Path.home() / ".hermes").resolve():
        return ""
    return os.environ.get(name, "")


def _json_get(url: str, token: str, data: Optional[dict] = None) -> Any:
    if not token:
        raise MissingCredentialError("missing bearer credential")
    body = None
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0",
    }
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def _to_epoch(value: Any) -> Optional[float]:
    """Accept ISO-8601 strings, epoch seconds, or epoch milliseconds."""
    if isinstance(value, (int, float)) and value > 0:
        return float(value) / (1000.0 if value > 10_000_000_000 else 1.0)
    if isinstance(value, str):
        try:
            text = value.strip()
            if text.isdigit():
                num = int(text)
                return float(num) / (1000.0 if num > 10_000_000_000 else 1.0)
            return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


_ERROR_KIND_WHITELIST = {
    "ValueError": "invalid provider response",
    "RuntimeError": "provider request failed",
    "TimeoutError": "provider request timed out",
    "OSError": "provider connection failed",
    "URLError": "provider connection failed",
    "HTTPError": "provider request rejected",
    "JSONDecodeError": "invalid provider response",
    "KeyError": "unexpected provider payload",
}


class MissingCredentialError(RuntimeError):
    """Credential missing for a provider. Carries a FIXED, value-free text so
    the sanitized error whitelist can pass the readable constant through."""


_MISSING_CREDENTIAL_MESSAGES: dict[str, str] = {
    "qwen": (
        "missing Aliyun AccessKey for the account cash balance: set "
        "ALIBABA_CLOUD_ACCESS_KEY_ID and ALIBABA_CLOUD_ACCESS_KEY_SECRET "
        "(RAM permission bss:DescribeAcccount) in this profile's .env; "
        "DASHSCOPE_API_KEY is not an AccessKey"
    ),
}


def _sanitize_error(exc: BaseException | str) -> str:
    """Return a FIXED safe message. Raw error text never reaches the UI.

    Only a whitelisted exception kind name plus a constant phrase is emitted;
    str(exc) (which may embed credentials, tokens, or URLs) is discarded
    entirely, and unknown exception kinds collapse to a generic label.
    """
    kind = type(exc).__name__
    if isinstance(exc, MissingCredentialError):
        # Never surface any exc text; return the fixed value-free constant.
        return "MissingCredential: " + _MISSING_CREDENTIAL_MESSAGES["qwen"]
    detail = _ERROR_KIND_WHITELIST.get(kind)
    if detail is None:
        return f"ProviderError: [redacted]"
    return f"{kind}: [redacted] ({detail})"


_ACTION_HINTS = {
    "kimi": "在当前 profile 的 .env 配置 KIMI_API_KEY（Coding Plan），保存后刷新。",
    "glm": "在当前 profile 的 .env 配置 GLM_API_KEY（Coding Plan），保存后刷新。",
    "deepseek": "在当前 profile 的 .env 配置 DEEPSEEK_API_KEY；消费明细另需可选 DEEPSEEK_PLATFORM_TOKEN。",
    "codex": "在当前 profile 运行 hermes auth，检查或重新登录 openai-codex；保存后刷新。",
    "grok": "在当前 profile 运行 hermes auth，检查或重新登录 xai-oauth；不适用于推理 API 余额。",
    "xai": "在当前 profile 的 .env 配置 XAI_MANAGEMENT_API_KEY 和 XAI_TEAM_ID；推理 API key 不适用。",
    "nous": "在当前 profile 运行 hermes auth，检查 Nous Portal 登录及账户权限。",
    "qwen": "在当前 profile 的 .env 配置 ALIBABA_CLOUD_ACCESS_KEY_ID 和 ALIBABA_CLOUD_ACCESS_KEY_SECRET，检查 BSS 查询权限。",
    "minimax-cn": "在当前 profile 的 .env 配置 MINIMAX_CN_API_KEY（Token Plan 订阅 Key）；按量计费 Key 不适用。",
    "minimax": "在当前 profile 的 .env 配置 MINIMAX_API_KEY（Token Plan 订阅 Key）；按量计费 Key 不适用。",
    "anthropic": "已识别 Anthropic 凭据；暂无取数适配器。",
    "openrouter": "已识别 OpenRouter 凭据；暂无取数适配器。",
    "xai-inference": "xAI 推理 key 不等于 Management 余额；暂无取数适配器。",
    "qwen-dashscope": "DashScope 推理 key 不等于阿里云 AccessKey 余额；暂无取数适配器。",
}


def _row(row_id: str, label: str, error: Exception | None = None, **fields: Any) -> MeterRow:
    row = MeterRow(
        id=row_id,
        providerId=str(fields.pop("providerId", row_id.split(":", 1)[0])),
        label=label,
    )
    row.status = "ok"
    row.checkedAt = time.time()
    row.actionHint = _ACTION_HINTS.get(row.providerId, "检查当前 profile 的账户配置并刷新。")
    if error is not None:
        row.error = _sanitize_error(error)
        row.status = "request_error"
        if isinstance(error, MissingCredentialError):
            row.status = "unconfigured"
            if row.providerId != "qwen":
                row.error = "MissingCredential: configure this provider in the current profile"
        elif getattr(error, "code", None) in (401, 403):
            row.status = "auth_error"
    for key, value in fields.items():
        setattr(row, key, value)
    return row


def _roll_forward(reset_at: float | None, period: float, now: float) -> float | None:
    # 2026-09-09：GLM/KIMI 的 5h 窗重置后，API 返回的 reset 时间戳可能停在过期
    # 时刻不推进（实测 GLM usage 归零但 nextResetTime 仍是过去）。过期 resetAt 会让
    # 前端 rowPriority 判 −∞ 沉底，并经 min() 连累周行排最后。5h 窗是连续块，
    # 过期就按周期前滚到未来。
    if reset_at is None:
        return None
    if reset_at > now:
        return reset_at
    import math
    periods = math.floor((now - reset_at) / period) + 1
    return reset_at + periods * period


# --- per-provider fetchers ----------------------------------------------------


def _fetch_kimi(now: float, secret: str = "") -> list[MeterRow]:
    # 2026-09-09：返回值改为 list[MeterRow]（跟随 _fetch_grok/_fetch_codex 的
    # 调用方约定，build_payload 对 list 与单行均兼容），在周窗行之外额外吐出
    # 5 小时窗行：data.limits[] 里 window.duration=300 / timeUnit=TIME_UNIT_MINUTE
    # 即 5h 窗；百分比由 used/limit 计算，resetTime 为 ISO8601。
    try:
        data = _json_get(KIMI_USAGE_URL, secret or _read_env_key("KIMI_API_KEY"))
        usage = data.get("usage") or {}
        limit = float(usage.get("limit") or 0)
        used = float(usage.get("used") or 0)
        reset_at = _to_epoch(usage.get("resetTime"))
        if limit <= 0:
            # Top-level usage can be sparse; fall back to the 7-day entry in limits[].
            for item in data.get("limits") or []:
                window = item.get("window") or {}
                seconds = float(window.get("duration") or 0)
                unit = str(window.get("timeUnit") or "")
                factor = KIMI_TIME_UNIT_SECONDS.get(unit, 0)
                detail = item.get("detail") or {}
                if seconds * factor >= WEEKLY_SECONDS and detail:
                    limit = float(detail.get("limit") or 0)
                    used = float(detail.get("used") or 0)
                    reset_at = _to_epoch(detail.get("resetTime")) or reset_at
                    break
        if limit <= 0:
            raise ValueError("no weekly usage window in payload")
        weekly_row = _row(
            "kimi",
            "KIMI",
            providerId="kimi",
            kind="quota",
            windowLabel="Weekly",
            windowSeconds=WEEKLY_SECONDS,
            role="cycle",
            burstShare=KIMI_BURST_SHARE,
            usedPercent=round(used * 100.0 / limit, 1),
            resetAt=reset_at,
        )
        rows = [weekly_row]
        # 5 小时窗：取 limits[] 里第一个换算后恰好等于 5h 的条目；找不到就
        # 不发明数据（宁缺毋假），周窗行照常返回。
        for item in data.get("limits") or []:
            window = item.get("window") or {}
            try:
                seconds = float(window.get("duration") or 0) * KIMI_TIME_UNIT_SECONDS.get(
                    str(window.get("timeUnit") or ""), 0
                )
            except (TypeError, ValueError):
                continue
            if seconds != FIVE_HOUR_SECONDS:
                continue
            detail = item.get("detail") or {}
            try:
                win_limit = float(detail.get("limit") or 0)
                win_used = float(detail.get("used") or 0)
            except (TypeError, ValueError):
                continue
            if win_limit <= 0:
                continue
            rows.append(
                _row(
                    "kimi:5h",
                    "KIMI",
                    providerId="kimi",
                    kind="quota",
                    windowLabel="5H",
                    windowSeconds=FIVE_HOUR_SECONDS,
                    role="burst",
                    usedPercent=round(win_used * 100.0 / win_limit, 1),
                    resetAt=_roll_forward(_to_epoch(detail.get("resetTime")), FIVE_HOUR_SECONDS, now),
                )
            )
            break
        return rows
    except Exception as exc:
        return [_row("kimi", "KIMI", error=exc, providerId="kimi")]


def _fetch_glm(now: float, secret: str = "") -> list[MeterRow]:
    # 2026-09-09：返回值改为 list[MeterRow]（跟随 _fetch_grok/_fetch_codex 的
    # 调用方约定，build_payload 对 list 与单行均兼容），在周窗行之外额外吐出
    # 5 小时窗行：limits[] 里 type=CREDIT_LIMIT / unit=3 的条目是 5h 窗
    # （unit=6 是周窗）；percentage 已是已用百分比，nextResetTime 为毫秒 epoch。
    try:
        data = _json_get(GLM_QUOTA_URL, secret or _read_env_key("GLM_API_KEY"))
        limits = ((data.get("data") or {}).get("limits")) or []
        weekly = next(
            (item for item in limits
             if isinstance(item, dict) and item.get("unit") == 6),
            None,
        )
        if not weekly:
            raise ValueError("no weekly (unit=6) limit in payload")
        weekly_row = _row(
            "glm",
            "GLM",
            providerId="glm",
            kind="quota",
            windowLabel="Weekly",
            windowSeconds=WEEKLY_SECONDS,
            role="cycle",
            burstShare=GLM_BURST_SHARE,
            usedPercent=float(weekly.get("percentage") or 0),
            resetAt=(int(weekly["nextResetTime"]) / 1000.0) if weekly.get("nextResetTime") else None,
        )
        rows = [weekly_row]
        # 5 小时窗：unit=3（小时）× number=5 的条目；找不到就不发明数据，
        # 周窗行照常返回。
        five_hour = next(
            (item for item in limits
             if isinstance(item, dict)
             and item.get("unit") == 3 and item.get("number") == 5),
            None,
        )
        if five_hour:
            try:
                raw_reset = (
                    int(five_hour["nextResetTime"]) / 1000.0
                    if five_hour.get("nextResetTime")
                    else None
                )
                # GLM 未消耗的 5h 窗干脆不返回 nextResetTime（2026-09-09 实测）：
                # 视为此刻起算的新窗，否则 resetAt=None → 前端判 -inf 沉底连累周行。
                reset_at_5h = (
                    _roll_forward(raw_reset, FIVE_HOUR_SECONDS, now)
                    if raw_reset
                    else now + FIVE_HOUR_SECONDS
                )
                rows.append(
                    _row(
                        "glm:5h",
                        "GLM",
                        providerId="glm",
                        kind="quota",
                        windowLabel="5H",
                        windowSeconds=FIVE_HOUR_SECONDS,
                        role="burst",
                        usedPercent=float(five_hour.get("percentage") or 0),
                        resetAt=reset_at_5h,
                    )
                )
            except (TypeError, ValueError):
                pass  # 5h 条目字段异常时不吐该行，避免伪造数值
        return rows
    except Exception as exc:
        return [_row("glm", "GLM", error=exc, providerId="glm")]


def _minimax_plan_rows(
    now: float, secret: str, base_url: str, provider_id: str
) -> list[MeterRow]:
    """MiniMax Token Plan 周额度行（语言模型 general 窗口）。

    类型判断来自 API 本身（Neal 2026-09-12 定）：套餐 Key 才拿得到
    model_remains（base_resp.status_code=0）；按量计费 Key 返回非 0 状态
    → 抛 ValueError，交给识别流水线按「形态对不上」处理，不硬造额度。

    只取 general 的 *_remaining_percent：count 字段实测恒为 0，不能当额度。
    两窗都出：current_weekly_* = 周窗、current_interval_* = 5h 窗（同一条目内）。
    """
    payload = _json_get(base_url + MINIMAX_PLAN_REMAINS_PATH, secret)
    if not isinstance(payload, dict):
        raise ValueError("unexpected payload shape")
    resp = payload.get("base_resp") or {}
    if resp.get("status_code") != 0:
        raise ValueError(f"MiniMax plan endpoint rejected key (status {resp.get('status_code')})")
    entry = next(
        (
            item
            for item in payload.get("model_remains") or []
            if isinstance(item, dict) and item.get("model_name") == "general"
        ),
        None,
    )
    if entry is None:
        raise ValueError("no general model window in payload")
    try:
        used = 100.0 - float(entry.get("current_weekly_remaining_percent"))
    except (TypeError, ValueError) as exc:
        raise ValueError("no weekly remaining percent in payload") from exc
    rows = [
        _row(
            provider_id,
            "MINIMAX",
            providerId=provider_id,
            kind="quota",
            windowLabel="Weekly",
            windowSeconds=WEEKLY_SECONDS,
            role="cycle",
            burstShare=MINIMAX_BURST_SHARE,
            usedPercent=round(min(100.0, max(0.0, used)), 1),
            resetAt=_to_epoch(entry.get("weekly_end_time")),
        )
    ]
    # 5h 窗（2026-09-12 接，Neal 指出 MiniMax 也有 5 小时额度）：同一 general 条目里的
    # current_interval_* 就是 5h 窗，end_time 为其重置时刻。份额由上面那行的
    # burstShare 声明（5h:周 = 1:10），前端据此画锁定段，与 GLM/KIMI 同构。
    try:
        interval_used = 100.0 - float(entry.get("current_interval_remaining_percent"))
    except (TypeError, ValueError):
        return rows
    rows.append(
        _row(
            f"{provider_id}:5h",
            "MINIMAX",
            providerId=provider_id,
            kind="quota",
            windowLabel="5H",
            windowSeconds=FIVE_HOUR_SECONDS,
            role="burst",
            usedPercent=round(min(100.0, max(0.0, interval_used)), 1),
            resetAt=_to_epoch(entry.get("end_time")),
        )
    )
    return rows


# MiniMax CN/Global 共用同一个 fetcher 入口（M4）：两家差异只剩 env 槽位、
# base 和 provider id（label 同为 "MINIMAX"），没有可分叉的规范化行为。
_MINIMAX_VARIANTS = {
    "minimax-cn": ("MINIMAX_CN_API_KEY", MINIMAX_CN_BASE),
    "minimax": ("MINIMAX_API_KEY", MINIMAX_GLOBAL_BASE),
}


def _fetch_minimax_plan(now: float, secret: str, provider_id: str) -> list[MeterRow]:
    """MiniMax CN/Global 取数 + 规范化的单点实现，按 provider_id 查差异表。"""
    env_name, base_url = _MINIMAX_VARIANTS[provider_id]
    try:
        return _minimax_plan_rows(
            now, secret or _read_env_key(env_name), base_url, provider_id
        )
    except Exception as exc:
        return [_row(provider_id, "MINIMAX", error=exc, providerId=provider_id)]


def _fetch_minimax_cn(now: float, secret: str = "") -> list[MeterRow]:
    return _fetch_minimax_plan(now, secret, "minimax-cn")


def _fetch_minimax_global(now: float, secret: str = "") -> list[MeterRow]:
    return _fetch_minimax_plan(now, secret, "minimax")


def _codex_auth_tokens() -> tuple[str, str]:
    auth = json.loads(CODEX_AUTH.read_text(encoding="utf-8"))
    tokens = auth.get("tokens") or {}
    access, account = tokens.get("access_token") or "", tokens.get("account_id") or ""
    if not access or not account:
        raise ValueError("~/.codex/auth.json missing tokens")
    return access, account


def _run_codexbar(provider: str) -> dict:
    raise RuntimeError("CodexBar is no longer used by subscription-meter")


def _sum_chart_spend(chart_points: list[dict], now: float, days: int) -> float:
    cutoff = now - days * 86400
    total = 0.0
    for point in chart_points:
        try:
            label = point.get("label", "")
            stamp = datetime.strptime(label, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()
            if stamp >= cutoff:
                total += float(point.get("value") or 0)
        except (ValueError, TypeError):
            continue
    return round(total, 2)


def _parse_money(value: Any) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.replace("$", "").replace(",", "").replace("¥", "").strip()
        try:
            return float(text)
        except ValueError:
            return 0.0
    return 0.0


def _fetch_native_account_usage(provider: str) -> Any:
    try:
        from agent.account_usage import fetch_account_usage

        return fetch_account_usage(provider)
    except Exception:
        return None


def _quota_window_seconds(label: str) -> int:
    normalized = label.strip().lower()
    if "week" in normalized:
        return WEEKLY_SECONDS
    if "session" in normalized or "5h" in normalized or "5 h" in normalized:
        return 5 * 3600
    return WEEKLY_SECONDS


def _window_id(provider_id: str, label: str, index: int) -> str:
    slug = "-".join(
        part for part in "".join(
            char.lower() if char.isalnum() else " " for char in label
        ).split()
        if part
    )
    return f"{provider_id}:{slug or index}"


def _is_meter_window(window: Any) -> bool:
    # 2026-09-09：周窗 + 5h/session 短窗都进 84 格矩阵（Neal 双窗口方案：
    # 短窗用于排序取 min 与周条锁定段半透明）。此前只留周窗，Codex 的
    # Session 窗被丢弃，test_codex_consumes_native_account_usage_windows 一直红。
    label = str(getattr(window, "label", "") or "").strip().lower()
    return "week" in label or "session" in label or "5h" in label or "5 h" in label


def _quota_rows_from_snapshot(
    provider_id: str,
    label: str,
    snapshot: Any,
    burst_share: float | None = None,
) -> list[MeterRow]:
    """account_usage 快照 → 额度行。

    role 由窗口本身判定（5h 窗 = burst、其余 = cycle），不按供应商名猜；burst_share
    只在调用方知道自己短窗口径时传入（CODEX），写在 cycle 行上，缺则不画锁定段。
    """
    if snapshot is None:
        raise ValueError(f"Hermes account_usage returned no {label} account")
    reason = getattr(snapshot, "unavailable_reason", None)
    if reason:
        raise ValueError(str(reason))
    windows = tuple(getattr(snapshot, "windows", ()) or ())
    meter_windows = [w for w in windows if _is_meter_window(w)]
    if not meter_windows:
        raise ValueError(f"Hermes account_usage returned no weekly {label} quota window")
    rows: list[MeterRow] = []
    for index, window in enumerate(meter_windows):
        used = getattr(window, "used_percent", None)
        if used is None:
            continue
        reset_at_raw = getattr(window, "reset_at", None)
        reset_at = (
            reset_at_raw.timestamp()
            if hasattr(reset_at_raw, "timestamp")
            else _to_epoch(reset_at_raw)
        )
        window_label = str(getattr(window, "label", "") or "Quota")
        row_id = (
            _window_id(provider_id, window_label, index)
            if len(meter_windows) > 1
            else provider_id
        )
        window_seconds = _quota_window_seconds(window_label)
        is_burst = window_seconds == FIVE_HOUR_SECONDS
        rows.append(
            _row(
                row_id,
                label,
                providerId=provider_id,
                kind="quota",
                windowLabel=window_label,
                windowSeconds=window_seconds,
                role="burst" if is_burst else "cycle",
                burstShare=None if is_burst else burst_share,
                usedPercent=float(used),
                resetAt=reset_at,
            )
        )
    if not rows:
        raise ValueError(f"Hermes account_usage returned no {label} quota windows")
    return rows


def _fetch_codex(now: float, secret: str = "") -> list[MeterRow]:
    try:
        snapshot = _fetch_native_account_usage("openai-codex")
        if snapshot is None:
            raise RuntimeError("Hermes account_usage returned no Codex snapshot; network or credentials may be unavailable")
        # 5h 短窗 = 周额度的 15%（2026-09-16 M2-StepA：原先在前端 SHORT_WINDOW_RATIO 表里）。
        return _quota_rows_from_snapshot("codex", "CODEX", snapshot, burst_share=CODEX_BURST_SHARE)
    except Exception as exc:
        return [_row("codex", "CODEX", error=exc, providerId="codex")]


# Keep the HTTP fallback implementation in reserve, but do not call it
# automatically: chatgpt.com frequently fails with SSL errors on this network,
# and the native account_usage path is the supported source of truth.
def _fetch_codex_http(now: float) -> MeterRow:
    access, account = _codex_auth_tokens()
    request = urllib.request.Request(
        CODEX_USAGE_URL,
        headers={
            "Authorization": f"Bearer {access}",
            "ChatGPT-Account-Id": account,
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0",
        },
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        data = json.load(response)
    windows = (data.get("rate_limit") or {})
    weekly = next(
        (
            window
            for window in (windows.get("secondary_window"), windows.get("primary_window"))
            if isinstance(window, dict)
            and float(window.get("limit_window_seconds") or 0) >= WEEKLY_SECONDS - 60
        ),
        None,
    )
    if not weekly:
        raise ValueError("no weekly window in payload")
    return _row(
        "codex",
        "CODEX",
        providerId="codex",
        kind="quota",
        windowLabel="Weekly",
        windowSeconds=WEEKLY_SECONDS,
        usedPercent=float(weekly.get("used_percent") or 0),
        resetAt=_to_epoch(weekly.get("reset_at")),
    )


def _grok_oauth_token() -> str:
    try:
        from tools.xai_http import resolve_xai_http_credentials

        runtime = resolve_xai_http_credentials() or {}
        if runtime.get("provider") == "xai-oauth":
            token = str(runtime.get("api_key") or "").strip()
            if token:
                return token
    except Exception:
        pass
    try:
        from hermes_cli.auth import resolve_xai_oauth_runtime_credentials

        creds = resolve_xai_oauth_runtime_credentials() or {}
        return str(creds.get("access_token") or creds.get("api_key") or "").strip()
    except Exception:
        return ""


def _grok_snapshot_from_billing(payload: dict[str, Any]) -> Any:
    config = payload.get("config") if isinstance(payload, dict) else None
    if not isinstance(config, dict):
        return None
    period = config.get("currentPeriod")
    reset_at = None
    if isinstance(period, dict):
        reset_raw = _to_epoch(period.get("end"))
        if reset_raw:
            reset_at = datetime.fromtimestamp(reset_raw, tz=timezone.utc)
    if reset_at is None:
        reset_raw = _to_epoch(config.get("billingPeriodEnd"))
        if reset_raw:
            reset_at = datetime.fromtimestamp(reset_raw, tz=timezone.utc)
    windows: list[Any] = []
    try:
        used = float(config.get("creditUsagePercent"))
    except (TypeError, ValueError):
        used = None
    if used is None:
        # 统一计费账户不返回 creditUsagePercent，退用按需额度占比
        try:
            cap = float((config.get("onDemandCap") or {}).get("val"))
            on_demand_used = float((config.get("onDemandUsed") or {}).get("val"))
        except (TypeError, ValueError, AttributeError):
            cap, on_demand_used = 0.0, None
        if cap > 0 and on_demand_used is not None:
            used = min(100.0, max(0.0, on_demand_used / cap * 100.0))
    if used is None and reset_at is not None:
        # 周期存在但无用量字段 = 周期刚开始，按 0% 展示
        used = 0.0
    if used is not None:
        windows.append(
            SimpleNamespace(
                label="SuperGrok weekly credits",
                used_percent=used,
                reset_at=reset_at,
            )
        )
    if not windows:
        return None
    return SimpleNamespace(windows=tuple(windows), unavailable_reason=None)


def _fetch_grok_billing_snapshot() -> Any:
    token = _grok_oauth_token()
    if not token:
        return None
    request = urllib.request.Request(
        GROK_BILLING_URL,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "X-XAI-Token-Auth": "xai-grok-cli",
            "User-Agent": "Mozilla/5.0",
        },
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return _grok_snapshot_from_billing(payload if isinstance(payload, dict) else {})


def _fetch_grok(now: float, secret: str = "") -> list[MeterRow]:
    try:
        snapshot = _fetch_native_account_usage("xai-oauth")
        if snapshot is None:
            snapshot = _fetch_grok_billing_snapshot()
        return _quota_rows_from_snapshot("grok", "GROK", snapshot)
    except Exception as exc:
        return [_row("grok", "GROK", error=exc, providerId="grok")]


def _xai_management_credentials() -> tuple[str, str]:
    key = _read_env_key("XAI_MANAGEMENT_API_KEY")
    team = _read_env_key("XAI_TEAM_ID")
    if not key or not team:
        raise ValueError(
            "xAI prepaid balance needs XAI_MANAGEMENT_API_KEY and XAI_TEAM_ID; "
            "inference API keys are not accepted by the Management API"
        )
    if "/" in team or team in {".", ".."}:
        raise ValueError("invalid xAI team ID")
    return key, team


XAI_USAGE_URL = "https://management-api.x.ai/v1/billing/teams/{team_id}/usage"
XAI_LOCAL_TZ = timezone(timedelta(hours=8))


def _xai_usage_windows(now: float, payload: Any) -> tuple[float, float, float] | None:
    """Sum usd dataPoints into (today, 7d, 30d) windows, Asia/Shanghai day boundaries."""
    try:
        series = (payload or {}).get("timeSeries") or []
        points = series[0].get("dataPoints") or []
    except (AttributeError, IndexError, TypeError):
        return None
    tz_now = datetime.fromtimestamp(now, XAI_LOCAL_TZ)
    today_start = tz_now.replace(hour=0, minute=0, second=0, microsecond=0)
    totals = [0.0, 0.0, 0.0]
    seen = False
    for point in points:
        try:
            stamp = datetime.strptime(str(point["timestamp"]), "%Y-%m-%dT%H:%M:%SZ").replace(
                tzinfo=timezone.utc
            ).astimezone(XAI_LOCAL_TZ)
            cost = max(0.0, float(point["values"][0]))
        except (KeyError, TypeError, ValueError, IndexError):
            continue
        seen = True
        totals[2] += cost
        if stamp >= today_start - timedelta(days=6):
            totals[1] += cost
        if stamp >= today_start:
            totals[0] += cost
    if not seen:
        return None
    return round(totals[0], 2), round(totals[1], 2), round(totals[2], 2)


def _fetch_xai(now: float, secret: str = "") -> MeterRow:
    try:
        key, team = _xai_management_credentials()
        balance_payload = _json_get(
            f"https://management-api.x.ai/v1/billing/teams/{team}/prepaid/balance",
            key,
        )
        raw = ((balance_payload.get("total") or {}) if isinstance(balance_payload, dict) else {}).get("val")
        if not isinstance(raw, str):
            raise ValueError("Could not parse xAI prepaid balance")
        balance = -float(raw) / 100.0

        # 可选消费明细：usage 查询失败不得连累已到手的余额（与 DEEPSEEK 同契约）。
        today = seven = thirty = None
        partial = True
        try:
            tz_now = datetime.fromtimestamp(now, XAI_LOCAL_TZ)
            body = {
                "analyticsRequest": {
                    "timeRange": {
                        "startTime": (tz_now - timedelta(days=31)).strftime("%Y-%m-%d 00:00:00"),
                        "endTime": tz_now.strftime("%Y-%m-%d 23:59:59"),
                        "timezone": "Asia/Shanghai",
                    },
                    "timeUnit": "TIME_UNIT_DAY",
                    "values": [{"name": "usd", "aggregation": "AGGREGATION_SUM"}],
                    "groupBy": [],
                    "filters": [],
                }
            }
            usage_payload = _json_get(XAI_USAGE_URL.format(team_id=team), key, data=body)
            windowed = _xai_usage_windows(now, usage_payload)
            if windowed is not None:
                today, seven, thirty = windowed
                partial = False
        except Exception:
            pass

        return _row(
            "xai",
            "XAI",
            kind="balance",
            providerId="xai",
            balance=balance,
            currency="USD",
            status="partial" if partial else "ok",
            actionHint=(
                "余额可用；消费明细未获取，请检查 XAI_MANAGEMENT_API_KEY 权限或稍后刷新。"
                if partial
                else _ACTION_HINTS["xai"]
            ),
            todaySpend=today,
            sevenDaySpend=seven,
            thirtyDaySpend=thirty,
            todayTone=None,
            sevenDayTone=None,
            thirtyDayTone=None,
            balanceTone=None,
        )
    except Exception as exc:
        return _row("xai", "XAI", kind="balance", error=exc, providerId="xai")


def _parse_nous_detail(details: tuple[str, ...], prefix: str) -> float:
    for line in details:
        if line.startswith(prefix):
            try:
                return float(line.split(":", 1)[1].strip().replace("$", "").replace(",", ""))
            except (ValueError, IndexError):
                return 0.0
    return 0.0


def _coerce_float(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _nous_balance_row(balance: float) -> MeterRow:
    return _row(
        "nous",
        "NOUS",
        kind="balance",
        providerId="nous",
        balance=balance,
        currency="USD",
        balanceTone=None,
    )


def _fetch_nous(now: float, secret: str = "") -> MeterRow:
    try:
        from agent.account_usage import build_nous_credits_snapshot
        from hermes_cli.nous_account import get_nous_portal_account_info, nous_portal_topup_url

        account = get_nous_portal_account_info(force_fresh=True)
        if account is None or not getattr(account, "logged_in", False):
            raise RuntimeError("not logged in to Nous Portal")

        # Prefer the normalized snapshot when the portal returns full account info.
        snapshot = build_nous_credits_snapshot(account)
        if snapshot is not None:
            details = snapshot.details or ()
            balance = _parse_nous_detail(details, "Total usable")
            if balance > 0:
                return _nous_balance_row(balance)

        # Fallback: parse the raw account payload directly, since /api/oauth/account
        # sometimes returns billing fields without the normalized structures.
        raw = getattr(account, "raw_account", None) or {}
        if not isinstance(raw, dict):
            raw = {}
        subscription = raw.get("subscription") or {}
        paid_access = raw.get("paid_service_access") or {}

        sub_remaining = _coerce_float(subscription.get("credits_remaining"))
        purchased = _coerce_float(raw.get("purchased_credits_remaining"))
        total_usable = _coerce_float(paid_access.get("total_usable_credits"))
        if total_usable is None:
            total_usable = _coerce_float(raw.get("total_usable_credits"))
        if total_usable is None and sub_remaining is not None and purchased is not None:
            total_usable = max(0.0, sub_remaining) + max(0.0, purchased)
        if total_usable is None:
            raise RuntimeError("Nous portal returned no usable credit fields")

        return _nous_balance_row(total_usable)
    except Exception as exc:
        return _row("nous", "NOUS", kind="balance", error=exc, providerId="nous")


# QWEN balance comes from the Aliyun account that hosts the Bailian
# (DashScope) workspace — it is the shared account cash balance, NOT a
# Qwen-specific wallet. Requires an Aliyun AccessKey (RAM permission
# `bss:DescribeAcccount`, exactly three c's per the official policy name);
# a DashScope API key (DASHSCOPE_API_KEY) is not an AccessKey.


def _aliyun_rpc_signed_url(
    access_key_id: str,
    access_key_secret: str,
    security_token: str = "",
) -> str:
    """ACS 1.0 RPC-style GET signature (HMAC-SHA1).

    StringToSign = HTTPMethod + "&" + percentEncode("/") + "&" +
    percentEncode(canonicalizedQueryString), with RFC3986 unreserved-only
    percent-encoding (safe="-_.~") applied to keys, values, and the paths.
    An STS security token, when present, becomes a SecurityToken query
    parameter and participates in the canonicalized query string.
    """
    params = {
        "Format": "JSON",
        "Version": ALIYUN_BSS_VERSION,
        "AccessKeyId": access_key_id,
        "SignatureMethod": "HMAC-SHA1",
        "SignatureVersion": "1.0",
        "SignatureNonce": f"{time.time_ns()}",
        "Timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "Action": "QueryAccountBalance",
    }
    if security_token:
        params["SecurityToken"] = security_token
    encoded = {
        urllib.parse.quote(str(key), safe="-_.~"): urllib.parse.quote(str(value), safe="-_.~")
        for key, value in params.items()
    }
    canonical = "&".join(f"{key}={encoded[key]}" for key in sorted(encoded))
    string_to_sign = "GET&" + urllib.parse.quote("/", safe="-_.~") + "&" + urllib.parse.quote(canonical, safe="-_.~")
    digest = hmac.new(
        f"{access_key_secret}&".encode("utf-8"),
        string_to_sign.encode("utf-8"),
        hashlib.sha1,
    ).digest()
    signature = base64.b64encode(digest).decode("utf-8")
    # Keys/values are already RFC3986-encoded exactly once; concatenate by
    # hand (urlencode would percent-encode a second time, e.g. %3A → %253A).
    query = "&".join(f"{key}={encoded[key]}" for key in sorted(encoded))
    return f"{ALIYUN_BSS_ENDPOINT}?{query}&Signature={urllib.parse.quote(signature, safe='-_.~')}"


def _read_aliyun_env_key(name: str) -> str:
    """QWEN-only credential reader: CURRENT profile's .env (get_hermes_home())
    first, then the current process env. No cross-profile fallback; other
    providers keep using _read_env_key untouched."""
    try:
        from hermes_constants import get_hermes_home

        env_path = get_hermes_home() / ".env"
        for line in env_path.read_text(encoding="utf-8").splitlines():
            if line.startswith(f"{name}="):
                return line.split("=", 1)[1].strip().strip("\"'")
    except OSError:
        pass
    return os.environ.get(name, "")


def _aliyun_access_credentials() -> tuple[str, str, str]:
    """Aliyun credentials for the QWEN row ONLY (other providers keep their
    own _read_env_key semantics). Reads the CURRENT profile's .env via
    get_hermes_home() first, then the current process env — no cross-profile
    fallback, never the hardcoded global ~/.hermes/.env."""
    key_id = _read_aliyun_env_key("ALIBABA_CLOUD_ACCESS_KEY_ID")
    key_secret = _read_aliyun_env_key("ALIBABA_CLOUD_ACCESS_KEY_SECRET")
    security_token = _read_aliyun_env_key("ALIBABA_CLOUD_SECURITY_TOKEN")
    if not key_id or not key_secret:
        raise MissingCredentialError(_MISSING_CREDENTIAL_MESSAGES["qwen"])
    return key_id, key_secret, security_token


def _parse_aliyun_cash_balance(payload: Any) -> tuple[float, str]:
    if not isinstance(payload, dict) or payload.get("Success") is not True:
        raise ValueError("invalid Aliyun BSS response (Success is not true)")
    data = payload.get("Data")
    if not isinstance(data, dict):
        raise ValueError("invalid Aliyun BSS response (no Data object)")
    raw_cash = data.get("AvailableCashAmount")
    if isinstance(raw_cash, bool) or not isinstance(raw_cash, (int, float, str)):
        raise ValueError("invalid Aliyun BSS response (AvailableCashAmount missing)")
    try:
        cash = float(str(raw_cash).strip())
    except ValueError as exc:
        raise ValueError("invalid Aliyun BSS response (AvailableCashAmount not numeric)") from exc
    if cash != cash or cash in (float("inf"), float("-inf")):
        raise ValueError("invalid Aliyun BSS response (AvailableCashAmount not finite)")
    currency = str(data.get("Currency") or "").strip()
    if currency not in ("CNY", "USD", "JPY"):
        # Official response Currency codes; an unknown/missing code must not
        # silently pass as CNY.
        raise ValueError("invalid Aliyun BSS response (unknown Currency)")
    return cash, currency


def _fetch_qwen(now: float, secret: str = "") -> MeterRow:
    # Not a qwen-oauth free-tier counter: the Aliyun account CASH balance
    # (AvailableCashAmount) only. AvailableAmount (cash + credit grants) is
    # deliberately NOT used. todaySpend/sevenDaySpend/thirtyDaySpend have no
    # official source here and stay None (never fabricated to 0).
    try:
        key_id, key_secret, security_token = _aliyun_access_credentials()
        url = _aliyun_rpc_signed_url(key_id, key_secret, security_token)
        request = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(request, timeout=15) as response:
            payload = json.loads(response.read().decode("utf-8"))
        cash, currency = _parse_aliyun_cash_balance(payload)
        return _row(
            "qwen",
            "QWEN",
            kind="balance",
            providerId="qwen",
            balance=cash,
            currency=currency,
            balanceTone=None,
        )
    except Exception as exc:
        return _row("qwen", "QWEN", kind="balance", error=exc, providerId="qwen")


def _local_day_start_epoch(now: float, tz_seconds: int) -> int:
    shifted = int(now) + tz_seconds
    return shifted // 86400 * 86400 - tz_seconds


def _summarize_daily_cost(payload: dict, *, now: float) -> tuple[float, float, float]:
    data = payload.get("data") if isinstance(payload, dict) else None
    biz = data.get("biz_data") if isinstance(data, dict) else None
    if not isinstance(biz, dict) or data.get("biz_code") != 0:
        raise ValueError("invalid DeepSeek cost response")
    if int(biz.get("bucket", 0) or 0) != 86400:
        raise ValueError("DeepSeek cost response is not daily")

    today_start = _local_day_start_epoch(now, DEEPSEEK_TZ_SECONDS)
    seven_start = today_start - 6 * 86400
    thirty_start = today_start - 29 * 86400
    window_end = today_start + 86400

    totals = [0.0, 0.0, 0.0]
    for group in biz.get("data") or []:
        if not isinstance(group, dict) or group.get("currency") != "CNY":
            continue
        for series in group.get("series") or []:
            for bucket in (series.get("buckets") or []) if isinstance(series, dict) else []:
                try:
                    stamp = int(bucket["time"])
                    cost = max(0.0, float(bucket["cost"]))
                except (KeyError, TypeError, ValueError):
                    continue
                if stamp < thirty_start or stamp >= window_end:
                    continue
                totals[2] += cost
                if stamp >= seven_start:
                    totals[1] += cost
                if stamp >= today_start:
                    totals[0] += cost
    return tuple(round(v, 2) for v in totals)


def _platform_token() -> str:
    # Browser storage access is never implicit; detailed spend is opt-in.
    return _read_env_key("DEEPSEEK_PLATFORM_TOKEN")


def _fetch_deepseek(now: float, secret: str = "") -> MeterRow:
    try:
        today = seven = thirty = None
        partial = True
        platform_token = _platform_token()
        if platform_token:
            try:
                start = _local_day_start_epoch(now, DEEPSEEK_TZ_SECONDS)
                query = f"start={start - 29 * 86400}&end={start + 86400}&tz={DEEPSEEK_TZ_SECONDS}"
                cost_payload = _json_get(f"{DEEPSEEK_COST_URL}?{query}", platform_token)
                today, seven, thirty = _summarize_daily_cost(cost_payload, now=now)
                partial = False
            except Exception:
                # Optional spend failure must not hide an independently available balance.
                pass

        balance_payload = _json_get(DEEPSEEK_BALANCE_URL, secret or _read_env_key("DEEPSEEK_API_KEY"))
        infos = balance_payload.get("balance_infos") or []
        if not balance_payload.get("is_available", True) or not infos:
            raise ValueError("balance unavailable")
        balance = float(infos[0].get("total_balance", 0.0))
        currency = str(infos[0].get("currency") or "CNY")

        return _row(
            "deepseek", "DEEPSEEK", kind="balance", balance=balance, currency=currency,
            status="partial" if partial else "ok",
            actionHint=("余额可用；消费明细未获取，请配置或更新当前 profile 的 DEEPSEEK_PLATFORM_TOKEN。" if partial else _ACTION_HINTS["deepseek"]),
            todaySpend=today,
            sevenDaySpend=seven,
            thirtyDaySpend=thirty,
            todayTone=None,
            sevenDayTone=None,
            thirtyDayTone=None,
            balanceTone=None,
        )
    except Exception as exc:
        return _row("deepseek", "DEEPSEEK", kind="balance", error=exc)


def _is_identity_mismatch(rows: list[MeterRow]) -> bool:
    """取数「明显不对」= 鉴权错(401/403) 或形态对不上(ValueError)；
    网络类错误（超时/连接）不算认错身份。"""
    for row in rows:
        if row.status == "auth_error":
            return True
        if row.error and row.error.startswith("ValueError:"):
            return True
    return False


def _fetch_shared_identity_rows(identity: dict[str, Any], now: float) -> list[MeterRow]:
    """从映射源 profile 取数：用 hermes_constants 的 context-local home override
    （不碰 os.environ，无跨 profile 竞态），fetcher 内部凭据解析全部走 override。
    源不可用/报错时返回真实错误行，不造零值或假周窗。"""
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    source = str(identity.get("key") or "").split(":", 1)[1]
    fetcher = _resolve_fetcher(identity["fetcher_id"])
    token = set_hermes_home_override(_shared_source_home(source))
    try:
        fetched = fetcher(now, "")
    except Exception as exc:
        return [_row(identity["id"], identity["label"], error=exc, providerId=identity["id"])]
    finally:
        reset_hermes_home_override(token)
    return list(fetched) if isinstance(fetched, (list, tuple)) else [fetched]


def _fetch_identity_rows(
    identity: dict[str, Any], now: float, overrides: dict[str, str]
) -> list[MeterRow]:
    """步骤 3/4：规则身份取数明显失败 → 丢掉规则身份，用槽位适配器再试；
    仍不行 → 记 unrecognized，本轮不占行。OAuth/账本身份高置信，保留错误行。"""
    if identity["via"] == "shared":
        return _fetch_shared_identity_rows(identity, now)
    fetcher = _resolve_fetcher(identity["fetcher_id"])
    fetched = fetcher(now, identity["secret"])
    rows = list(fetched) if isinstance(fetched, (list, tuple)) else [fetched]
    if any(row.status in ("ok", "partial") for row in rows):
        return rows
    if identity["via"] in ("rule", "slot") and (
        identity["via"] == "slot" or _is_identity_mismatch(rows)
    ):
        alternate_id = _slot_match_id(identity["env_name"] or "")
        if alternate_id and alternate_id != identity["fetcher_id"]:
            alternate = _resolve_fetcher(alternate_id)
            alt_fetched = alternate(now, identity["secret"])
            alt_rows = list(alt_fetched) if isinstance(alt_fetched, (list, tuple)) else [alt_fetched]
            if any(row.status in ("ok", "partial") for row in alt_rows):
                return alt_rows
        overrides[identity["key"]] = "unrecognized"
        return []
    return rows


def _apply_provider_meta(rows: list[MeterRow]) -> list[MeterRow]:
    """把供应商事实（accent / peakHours）抄进每一行（2026-09-16 M2-StepA）。

    真源在 FetcherSpec.meta，但出口必须是行上字段：前端只认行，不认供应商名。
    已由 fetcher 声明的行不覆盖；表里没有的供应商留空（前端有自己的中性兜底）。
    """
    for row in rows:
        meta = _provider_meta(row.providerId)
        if not meta:
            continue
        accent = meta.get("accent")
        if accent and not row.accent:
            row.accent = accent
        peak = meta.get("peakHours")
        if peak and not row.peakHours:
            # 逐行重建嵌套结构，避免多行共享同一份 windows 列表。
            row.peakHours = {
                "timezone": peak["timezone"],
                "daily": bool(peak["daily"]),
                "windows": [[int(start), int(end)] for start, end in peak["windows"]],
            }
    return rows


def build_payload() -> MeterPayload:
    """只对 visibility 开启、识别成功、且有适配器的条目取数。"""
    now = time.time()
    cached = _cache["payload"]
    if cached is not None and now - _cache["at"] < CACHE_TTL_SECONDS:
        return cached

    settings = _read_plugin_settings()
    visibility = settings.get("visibility")
    visibility = visibility if isinstance(visibility, dict) else {}
    overrides: dict[str, str] = {}
    rows: list[MeterRow] = []
    for identity in _identify_all():
        if visibility.get(identity["id"], True) is False:
            continue
        if identity["status"] in ("no_fetcher", "unrecognized") or not identity["fetcher_id"]:
            continue
        rows.extend(_fetch_identity_rows(identity, now, overrides))

    payload = MeterPayload(rows=_apply_provider_meta(rows), generatedAt=now)
    _cache["at"] = now
    _cache["payload"] = payload
    _cache["identity_overrides"] = overrides
    return payload


@router.get("/settings")
async def provider_settings() -> dict:
    payload = get_provider_settings()
    return json.loads(payload.model_dump_json())


@router.put("/settings/{provider_id}")
async def update_provider_settings(
    provider_id: str,
    update: ProviderVisibilityUpdate,
) -> dict:
    try:
        await run_in_threadpool(
            set_provider_visibility,
            provider_id,
            update.enabled,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    payload = get_provider_settings()
    return json.loads(payload.model_dump_json())


@router.get("/data")
async def data(refresh: bool = False) -> dict:
    if refresh:
        _cache.update(at=0.0, payload=None, identity_overrides={})
    try:
        payload = await run_in_threadpool(build_payload)
        return json.loads(payload.model_dump_json())
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Subscription data unavailable") from exc


@router.get("/health")
async def health() -> dict:
    return {"ok": True}

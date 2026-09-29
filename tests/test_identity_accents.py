"""identity.yaml accent 钉与 xiaomi 占位识别钉（2026-09-29 全量补色 + 分主题两套）。

四件事：
1. 每家 provider 的 meta 必须同时有 accent（亮主题）与 accentDark（暗主题），都是 #RRGGBB；
   判据 a：**本主题底色上读得清** —— accent 对白卡 #FFFFFF、accentDark 对深卡 #0E1217
   都要 ≥4.5:1（小字门槛，3:1 只够图形可辨）；判据 b（任意两家不同色，同家族允许同色，
   两套调色板各自比）也要过。
   注：供应商 accent 是装饰/品牌识别，**不承担功能区分**（2026-09-29 Neal 明确：
   不需要区分度、不需要过色盲模拟），所以这里没有两两 ΔE 断言。
2. xiaomi 以 XIAOMI_API_KEY 槽位被 _classify_candidate 识别为 no_fetcher
   （槽位分支对「认得出但没适配器」的家不再把 None 交给取数器）。
3. build_payload 对 xiaomi 下发占位行，且行上带 identity.yaml 里的 accent
   （前端不认供应商名，颜色必须走行字段）。
"""

import re
import sys
import types

import pytest

from tests.conftest_sm import plugin_api, write_env


_HEX_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")

# 允许共用同一 accent 的家族（identity.yaml 声明同色）：qwen 阿里橙 / xai 同门 /
# minimax 同门。不在同一家族的两家不得共色。
_ACCENT_FAMILIES = [
    {"qwen", "qwen-dashscope"},
    {"minimax", "minimax-cn"},
]


def _relative_luminance(hex_color: str) -> float:
    def channel(index: int) -> float:
        value = int(hex_color.lstrip("#")[index:index + 2], 16) / 255
        return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4

    r, g, b = (channel(i) for i in (0, 2, 4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _contrast(a: str, b: str) -> float:
    hi, lo = sorted((_relative_luminance(a), _relative_luminance(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def _palette_key(palette: str) -> str:
    return "accent" if palette == "light" else "accentDark"


def _palette_card(palette: str) -> str:
    return "#FFFFFF" if palette == "light" else "#0E1217"


def test_every_provider_carries_two_valid_accents():
    """每家都要有两套品牌色：accent（亮主题）+ accentDark（暗主题），且都是合法 #RRGGBB。"""
    for spec in plugin_api.FETCHER_SPECS:
        for palette in ("light", "dark"):
            key = _palette_key(palette)
            color = spec.meta.get(key)
            assert color, f"{spec.id}: meta.{key} 必须存在（2026-09-29 分主题两套）"
            assert _HEX_RE.match(color), f"{spec.id}: {key} {color!r} 不是 #RRGGBB"


MIN_ACCENT_CONTRAST = 4.5


def test_each_accent_reads_on_its_own_theme_card():
    """判据 a（2026-09-29 分主题后重定）：每只色在本主题底色上 ≥4.5:1。

    4.5 而不是 3.0：余额金额与供应商名都是 10px 量级的小字，3:1 只够图形可辨，
    小字要 AA 正文门槛才真的看得清 —— 暗色主题下「金额看不见」就是这个漏的。
    """
    for spec in plugin_api.FETCHER_SPECS:
        for palette in ("light", "dark"):
            key = _palette_key(palette)
            color = spec.meta[key]
            ratio = _contrast(color, _palette_card(palette))
            assert ratio >= MIN_ACCENT_CONTRAST, (
                f"{spec.id}: {key} {color} 在本主题底色上只有 {ratio:.2f}:1"
                f"（要求 ≥{MIN_ACCENT_CONTRAST}）")


def test_accent_colors_do_not_collide_across_families():
    """判据 b（结构部分）：家族内必须同色一致；家族外不得共色。"""
    meta = {s.id: s.meta for s in plugin_api.FETCHER_SPECS}

    # 两套调色板各自比。注意：这里只管「谁和谁共用同一个色值」，不设色差门槛
    # —— 装饰色不需要区分度（2026-09-29 Neal）。
    for palette in ("light", "dark"):
        key = _palette_key(palette)

        # 家族内一致性：声明同色的家族必须真的同色（声明即承诺）。
        for family in _ACCENT_FAMILIES:
            present = family & set(meta)
            colors = {meta[pid][key].upper() for pid in present}
            assert len(colors) == 1, f"{palette} 家族 {sorted(family)} 的 {key} 不一致: {sorted(colors)}"

        # 家族外不共色：同色 ids 必须整体落在一个家族里。
        by_color: dict[str, set[str]] = {}
        for pid, m in meta.items():
            by_color.setdefault(m[key].upper(), set()).add(pid)
        for color, ids in by_color.items():
            assert any(ids <= family for family in _ACCENT_FAMILIES) or len(ids) == 1, (
                f"{palette} 调色板里 {color} 被 {sorted(ids)} 共用，但不在同一声明家族")


def _xiaomi_candidate() -> dict:
    return {
        "source": "env", "env_name": "XIAOMI_API_KEY", "secret": "xiaomi-fixture",
        "registry_id": "xiaomi", "registry_name": "MiMo",
    }


def test_xiaomi_slot_classifies_as_no_fetcher():
    """XIAOMI_API_KEY 槽位 → 识别为 xiaomi、no_fetcher（识别成功即可，无 fetcher）。"""
    identity = plugin_api._classify_candidate(_xiaomi_candidate())

    assert identity["id"] == "xiaomi"
    assert identity["status"] == "no_fetcher"
    assert identity["fetcher_id"] is None, "没有适配器的家不得把 None 交给取数器"
    assert identity["label"] == plugin_api._label_kind("xiaomi")[0]
    assert identity["kind"] == "balance"


def test_build_payload_ships_xiaomi_placeholder_with_accents(monkeypatch):
    """build_payload 对 xiaomi 下发占位行：gap=no_fetcher、无数值，且行上带两套 accent。"""
    registry = types.ModuleType("hermes_cli.auth")
    registry.PROVIDER_REGISTRY = {
        "xiaomi": types.SimpleNamespace(id="xiaomi", name="MiMo",
                                        api_key_env_vars=("XIAOMI_API_KEY",))
    }
    monkeypatch.setitem(sys.modules, "hermes_cli.auth", registry)
    monkeypatch.setattr(plugin_api, "_registry_env_vars",
                        lambda: {"XIAOMI_API_KEY": ("xiaomi", "MiMo")})
    write_env({"XIAOMI_API_KEY": "xiaomi-fixture"})
    plugin_api._cache.update(at=0.0, payload=None, identity_overrides={})

    payload = plugin_api.build_payload()
    rows = [row for row in payload.rows if row.providerId == "xiaomi"]

    assert len(rows) == 1, "xiaomi 识别成功必须有一行（占位），不许静默消失"
    row = rows[0]
    assert row.gap == "no_fetcher"
    assert row.status == "no_fetcher"
    assert row.kind == "balance", "MiMo 只有余额无订阅，占位行落余额区（2026-09-29 Neal 定）"
    assert row.usedPercent is None and row.balance is None and row.resetAt is None
    meta = plugin_api._provider_meta("xiaomi")
    assert row.accent == meta["accent"], "占位行也要带自家的 accent（前端只认行字段）"
    assert row.accentDark == meta["accentDark"], "暗主题那只同样要走行字段"

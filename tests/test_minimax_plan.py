"""MiniMax Token Plan（订阅套餐）适配器测试。

2026-09-12 新增：Neal 的 MINIMAX_CN_API_KEY 是 Token Plan 订阅 Key，开放平台
端点 /v1/api/openplatform/coding_plan/remains 实测可查。mock payload 的结构与
数值取自当日他账户的真实响应（remaining_percent 79/91、weekly_end_time
1789315200000），不编造。

契约：套餐 Key → general（语言模型）窗口一行周额度；按量计费 Key 端点回非 0
状态 → 错误行，绝不把「没有套餐」显示成 0% 额度。
"""

from tests.conftest_sm import plugin_api, write_env


def _general_entry(**overrides):
    entry = {
        "model_name": "general",
        "current_interval_remaining_percent": 79,
        "current_weekly_remaining_percent": 91,
        "current_interval_total_count": 0,
        "current_weekly_total_count": 0,
        "current_interval_usage_count": 0,
        "current_weekly_usage_count": 0,
        "start_time": 1789178400000,
        "end_time": 1789196400000,
        "weekly_start_time": 1788710400000,
        "weekly_end_time": 1789315200000,
        "current_interval_status": 1,
        "current_weekly_status": 1,
    }
    entry.update(overrides)
    return entry


def _plan_payload(*entries):
    return {
        "base_resp": {"status_code": 0, "status_msg": "success"},
        "model_remains": list(entries) or [_general_entry()],
    }


def _reset_cache():
    plugin_api._cache.update(at=0.0, payload=None, identity_overrides={})


def test_minimax_cn_plan_key_emits_weekly_and_five_hour_rows(monkeypatch):
    """周窗 + 5h 窗各一行：剩余百分比换算成已用；重置取各自 end_time（毫秒 → 秒）。"""
    seen = {}

    def fake_json_get(url, token):
        seen["url"] = url
        seen["token"] = token
        return _plan_payload()

    monkeypatch.setattr(plugin_api, "_json_get", fake_json_get)

    rows = plugin_api._fetch_minimax_cn(0.0, "fixture-plan-key")

    assert seen["url"] == plugin_api.MINIMAX_CN_BASE + plugin_api.MINIMAX_PLAN_REMAINS_PATH
    assert seen["token"] == "fixture-plan-key"
    assert [row.windowLabel for row in rows] == ["Weekly", "5H"]
    row = rows[0]
    assert row.id == "minimax-cn"
    assert row.providerId == "minimax-cn"
    assert row.kind == "quota"
    assert row.windowLabel == "Weekly"
    assert row.windowSeconds == 7 * 86400
    assert row.usedPercent == 9.0  # 100 − 91
    assert row.resetAt == 1789315200000 / 1000.0
    five = rows[1]
    assert five.id == "minimax-cn:5h"
    assert five.providerId == "minimax-cn"
    assert five.windowSeconds == 18000
    assert five.usedPercent == 21.0  # 100 − 79
    assert five.resetAt == 1789196400000 / 1000.0
    assert all(row.error is None for row in rows)


def test_minimax_rows_declare_role_and_burst_share_for_the_frontend(monkeypatch):
    """行契约（2026-09-15 M1）：周期行声明 role=cycle + 份额，短窗行声明 role=burst。

    前端 M0 起按行上这两条事实配对并算锁定段，不再查供应商名表——旧表缺 MINIMAX
    键时锁定段会静默消失，这一条就是那个坑的回归位。
    """
    monkeypatch.setattr(plugin_api, "_json_get", lambda url, token: _plan_payload())

    rows = plugin_api._fetch_minimax_cn(0.0, "fixture-plan-key")

    weekly, five = rows
    assert weekly.role == "cycle"
    assert weekly.burstShare == plugin_api.MINIMAX_BURST_SHARE == 0.1
    assert five.role == "burst"
    assert five.burstShare is None, "份额只写在周期行，避免两行各说一套"


def test_minimax_global_slot_uses_global_base(monkeypatch):
    """全球槽位查全球 base，providerId 不串到 CN。"""
    seen = {}
    monkeypatch.setattr(
        plugin_api, "_json_get",
        lambda url, token: seen.update(url=url) or _plan_payload(),
    )

    rows = plugin_api._fetch_minimax_global(0.0, "fixture-plan-key")

    assert seen["url"] == plugin_api.MINIMAX_GLOBAL_BASE + plugin_api.MINIMAX_PLAN_REMAINS_PATH
    assert rows[0].id == "minimax"
    assert rows[0].providerId == "minimax"
    assert rows[1].id == "minimax:5h"


def test_general_window_wins_over_other_models(monkeypatch):
    """payload 同时带 video（100%）与 general → 只取 general，不把 100% 当额度。"""
    monkeypatch.setattr(
        plugin_api, "_json_get",
        lambda url, token: _plan_payload(
            _general_entry(model_name="video", current_weekly_remaining_percent=100),
            _general_entry(),
        ),
    )

    rows = plugin_api._fetch_minimax_cn(0.0, "fixture-plan-key")

    assert rows[0].usedPercent == 9.0


def test_non_plan_key_reports_error_instead_of_zero_quota(monkeypatch):
    """按量计费 Key：端点回非 0 状态 → 错误行，不吐假额度。"""
    monkeypatch.setattr(
        plugin_api, "_json_get",
        lambda url, token: {"base_resp": {"status_code": 1004, "status_msg": "cookie is missing"}},
    )

    rows = plugin_api._fetch_minimax_cn(0.0, "fixture-payg-key")

    assert len(rows) == 1
    assert rows[0].error is not None
    assert rows[0].status != "ok"


def test_pipeline_shows_plan_key_row_and_drops_payg_key(monkeypatch):
    """端到端：套餐 Key → 看板占一行 MINIMAX 周额度；按量 Key → 形态对不上，不占行。"""
    write_env({"MINIMAX_CN_API_KEY": "fixture-plan-key"})
    monkeypatch.setattr(plugin_api, "_json_get", lambda url, token: _plan_payload())
    _reset_cache()
    rows = plugin_api.build_payload().rows
    assert [row.providerId for row in rows] == ["minimax-cn", "minimax-cn"]
    assert [row.windowLabel for row in rows] == ["Weekly", "5H"]
    assert rows[0].usedPercent == 9.0

    _reset_cache()
    monkeypatch.setattr(
        plugin_api, "_json_get",
        lambda url, token: {"base_resp": {"status_code": 1004, "status_msg": "cookie is missing"}},
    )
    assert plugin_api.build_payload().rows == []

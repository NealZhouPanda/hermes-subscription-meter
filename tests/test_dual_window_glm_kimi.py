"""GLM / KIMI 双窗口行（周窗 + 5 小时窗）测试。

2026-09-09 新增：后端改为每家 quota 供应商吐出周窗 + 5h 窗两条
MeterRow（与 Codex 双窗口行同构）。mock payload 采用 2026-09-09 从
Neal 账户实测的真实结构，数值不编造。
"""

from tests.conftest_sm import plugin_api


def test_glm_emits_weekly_and_five_hour_rows(monkeypatch):
    """GLM：unit=6 周窗 + unit=3×number=5 的 5h 窗各吐一行，字段取自 payload。"""

    def fake_json_get(url, _token):
        assert url == plugin_api.GLM_QUOTA_URL
        return {
            "data": {
                "limits": [
                    {
                        "type": "CREDIT_LIMIT",
                        "unit": 3,
                        "number": 5,
                        "usage": 2000,
                        "currentValue": 2003,
                        "remaining": 0,
                        "percentage": 100,
                        "nextResetTime": 1788948753603,
                    },
                    {
                        "unit": 6,
                        "number": 1,
                        "usage": 10000,
                        "currentValue": 3690,
                        "remaining": 6309,
                        "percentage": 36,
                        "nextResetTime": 1789180421994,
                    },
                ]
            }
        }

    monkeypatch.setattr(plugin_api, "_json_get", fake_json_get)

    rows = plugin_api._fetch_glm(0.0)

    assert [row.windowLabel for row in rows] == ["Weekly", "5H"]
    weekly, five_hour = rows
    assert weekly.id == "glm"
    assert weekly.providerId == "glm"
    assert weekly.windowSeconds == 7 * 86400
    assert weekly.usedPercent == 36.0
    assert weekly.resetAt == 1789180421994 / 1000.0
    assert five_hour.id == "glm:5h"
    assert five_hour.providerId == "glm"
    assert five_hour.windowSeconds == 18000
    assert five_hour.usedPercent == 100.0
    assert five_hour.resetAt == 1788948753603 / 1000.0
    assert all(row.error is None for row in rows)


def test_kimi_emits_weekly_and_five_hour_rows(monkeypatch):
    """KIMI：顶层 usage 周窗 + limits[] 300 分钟条目 5h 窗各吐一行。"""

    def fake_json_get(url, _token):
        assert url == plugin_api.KIMI_USAGE_URL
        # 真实响应：usage 与 limits 在顶层（现有代码即按顶层读取）。
        return {
            "usage": {"limit": "100", "used": "9", "resetTime": "2026-09-15T00:00:00Z"},
            "limits": [
                {
                    "window": {"duration": 300, "timeUnit": "TIME_UNIT_MINUTE"},
                    "detail": {
                        "limit": "100",
                        "used": "22",
                        "remaining": "78",
                        "resetTime": "2026-09-09T18:00:00Z",
                    },
                }
            ],
        }

    monkeypatch.setattr(plugin_api, "_json_get", fake_json_get)

    rows = plugin_api._fetch_kimi(0.0)

    assert [row.windowLabel for row in rows] == ["Weekly", "5H"]
    weekly, five_hour = rows
    assert weekly.id == "kimi"
    assert weekly.providerId == "kimi"
    assert weekly.windowSeconds == 7 * 86400
    assert weekly.usedPercent == 9.0
    assert weekly.resetAt == plugin_api._to_epoch("2026-09-15T00:00:00Z")
    assert five_hour.id == "kimi:5h"
    assert five_hour.providerId == "kimi"
    assert five_hour.windowSeconds == 18000
    assert five_hour.usedPercent == 22.0
    assert five_hour.resetAt == plugin_api._to_epoch("2026-09-09T18:00:00Z")
    assert all(row.error is None for row in rows)


def test_kimi_missing_five_hour_entry_still_emits_weekly(monkeypatch):
    """KIMI payload 无 5h 条目时不伪造，只返回周窗行（宁缺毋假）。"""
    monkeypatch.setattr(
        plugin_api,
        "_json_get",
        lambda url, _token: {"usage": {"limit": "100", "used": "9"}, "limits": []},
    )

    rows = plugin_api._fetch_kimi(0.0)

    assert [row.windowLabel for row in rows] == ["Weekly"]


def test_glm_missing_five_hour_entry_still_emits_weekly(monkeypatch):
    """GLM payload 无 unit=3×5 条目时不伪造，只返回周窗行。"""
    monkeypatch.setattr(
        plugin_api,
        "_json_get",
        lambda url, _token: {"data": {"limits": [
            {"unit": 6, "number": 1, "percentage": 36, "nextResetTime": 1789180421994}
        ]}},
    )

    rows = plugin_api._fetch_glm(0.0)

    assert [row.windowLabel for row in rows] == ["Weekly"]


def test_glm_stale_five_hour_reset_rolls_forward(monkeypatch):
    """2026-09-09 实测：GLM 5h 窗重置后 nextResetTime 停在过期时刻（usage 归零），
    过期 resetAt 会让前端 rowPriority 判 -inf 并经 min() 把 GLM 周行拖到最后。
    过期时间戳应按 5h 周期前滚到未来。"""
    import time as _time
    now = _time.time()
    stale_reset_ms = int((now - 3600) * 1000)  # 1 小时前已过期

    def fake_json_get(url, _token):
        return {"data": {"limits": [
            {"type": "CREDIT_LIMIT", "unit": 3, "number": 5, "usage": 2000,
             "currentValue": 0, "remaining": 2000, "percentage": 0,
             "nextResetTime": stale_reset_ms},
            {"type": "CREDIT_LIMIT", "unit": 6, "number": 1, "usage": 10000,
             "currentValue": 3690, "remaining": 6309, "percentage": 36,
             "nextResetTime": int((now + 86400) * 1000)},
        ]}}

    monkeypatch.setattr(plugin_api, "_json_get", fake_json_get)
    rows = plugin_api._fetch_glm(now)
    five_h = next(r for r in rows if r.windowLabel == "5H")
    assert five_h.resetAt > now, "过期 5h resetAt 必须前滚到未来"
    # 前滚后仍对齐 5h 网格
    assert (five_h.resetAt - stale_reset_ms / 1000.0) % (5 * 3600) == 0


def test_glm_fresh_five_hour_window_without_reset_time(monkeypatch):
    """GLM 未消耗的 5h 窗不返回 nextResetTime（2026-09-09 实测 payload）：
    应视为此刻起算的新窗（resetAt 在未来），不得 None → 前端 -inf 沉底。"""
    import time as _time
    now = _time.time()

    def fake_json_get(url, _token):
        return {"data": {"limits": [
            {"type": "CREDIT_LIMIT", "unit": 3, "number": 5, "usage": 2000,
             "currentValue": 0, "remaining": 2000, "percentage": 0},
            {"type": "CREDIT_LIMIT", "unit": 6, "number": 1, "usage": 10000,
             "currentValue": 3690, "remaining": 6309, "percentage": 36,
             "nextResetTime": int((now + 86400) * 1000)},
        ]}}

    monkeypatch.setattr(plugin_api, "_json_get", fake_json_get)
    rows = plugin_api._fetch_glm(now)
    five_h = next(r for r in rows if r.windowLabel == "5H")
    assert five_h.resetAt is not None and five_h.resetAt > now

"""Command Code 双窗口行（周窗 + 5 小时窗）+ 月度格子测试。

2026-09-21 新增；2026-09-22 月行改为「按账单周期」。mock payload 采用当日从真实账户实测的
``GET https://api.commandcode.ai/alpha/billing/credits`` 结构，数值不编造：

    windowLimits.fiveHour / windowLimits.weekly = {used, cap, exceeded, resetAt}
    credits.monthlyCredits                      = 套餐月度额度剩余

两个 cap（本例 Max 10x 套餐：5h=45、周=90）由 API 给出，因此 burst 份额必须
从 cap 推导（45/90 = 0.5），不能在 fetcher 里写死常量。resetAt 为毫秒 epoch。

月额度：总量恒定，走 8 小时格子（不是余额行）。总量按官方周 cap→月 cap 对照表认；
**重置时刻与窗长来自套餐账单周期**（同一把 key 的 ``/alpha/billing/subscriptions``，官方口径
「monthly credits reset at the start of your next billing period」），不是日历月——拿不到周期
就不吐月行（宁缺毋假）。另买额度先不进格子。
"""

from datetime import datetime, timezone

import pytest

from tests.conftest_sm import plugin_api

FIVE_HOUR = plugin_api.FIVE_HOUR_SECONDS
WEEKLY = plugin_api.WEEKLY_SECONDS
DAY = 86400
# 2026-09-22 本地正午（只作 5h 窗前滚的锚点）。
NOW = datetime(2026, 9, 22, 12, 0, 0).timestamp()

# 真实订阅周期（2026-09-22 实测 /alpha/billing/subscriptions：Go 档，周期 30 天）。
PERIOD_START = "2026-09-22T08:58:10.000Z"
PERIOD_END = "2026-10-22T08:58:10.000Z"
PERIOD_SECONDS = 30 * DAY
PERIOD_RESET = datetime.fromisoformat(PERIOD_END.replace("Z", "+00:00")).timestamp()

_BILLING = plugin_api.COMMANDCODE_BILLING_URL
_SUBSCRIPTION = plugin_api.COMMANDCODE_SUBSCRIPTION_URL
assert _BILLING != _SUBSCRIPTION


def _payload(weekly_used=23.84567484, weekly_cap=90, five_hour_used=0.308763204,
             five_hour_cap=45, monthly=1.742346421):
    return {
        "credits": {
            "belowThreshold": False,
            "creditThreshold": 0,
            "monthlyCredits": monthly,
            "purchasedCredits": 0,
            "freeCredits": 0,
        },
        "windowLimits": {
            "limited": True,
            "exceeded": None,
            "fiveHour": {
                "used": five_hour_used,
                "cap": five_hour_cap,
                "exceeded": False,
                "resetAt": 1790023291291,
            },
            "weekly": {
                "used": weekly_used,
                "cap": weekly_cap,
                "exceeded": False,
                "resetAt": 1790309221433,
            },
        },
    }


def _subscription_record(start=PERIOD_START, end=PERIOD_END):
    return {
        "success": True,
        "data": {
            "id": "sub_fixture",
            "status": "active",
            "planId": "individual-go",
            "currentPeriodStart": start,
            "currentPeriodEnd": end,
        },
    }


def install(monkeypatch, credits=None, subscription=None, subscription_error=None):
    """两个 /alpha 端点都换成假件：月行现在需要 credits + subscriptions 两处。"""
    credits_payload = _payload() if credits is None else credits

    def fake_json_get(url, _token):
        if url == _BILLING:
            return credits_payload
        if url == _SUBSCRIPTION:
            if subscription_error is not None:
                raise subscription_error
            return _subscription_record() if subscription is None else subscription
        raise AssertionError(f"unexpected url {url}")

    monkeypatch.setattr(plugin_api, "_json_get", fake_json_get)


def test_commandcode_emits_weekly_five_hour_and_monthly_rows(monkeypatch):
    """周窗（cycle）+ 5h 窗（burst）+ 月度 8h 格子各一行。"""

    install(monkeypatch)

    rows = plugin_api._fetch_commandcode(NOW)

    assert [row.id for row in rows] == ["commandcode", "commandcode:5h", "commandcode:monthly"]
    weekly, five_hour, monthly = rows

    assert weekly.providerId == "commandcode"
    assert weekly.label == "COMMANDCODE"
    assert weekly.kind == "quota"
    assert weekly.windowLabel == "Weekly"
    assert weekly.windowSeconds == WEEKLY
    assert weekly.role == "cycle"
    assert weekly.usedPercent == pytest.approx(23.84567484 / 90 * 100)
    assert weekly.resetAt == 1790309221433 / 1000.0
    # Cap 由 API 给出，burst 份额按 cap 推导，不写死常量。
    assert weekly.burstShare == pytest.approx(0.5)

    assert five_hour.providerId == "commandcode"
    assert five_hour.windowLabel == "5H"
    assert five_hour.windowSeconds == FIVE_HOUR
    assert five_hour.role == "burst"
    assert five_hour.usedPercent == pytest.approx(0.308763204 / 45 * 100)
    assert five_hour.resetAt == plugin_api._roll_forward(
        1790023291291 / 1000.0, FIVE_HOUR, NOW
    )

    assert monthly.providerId == "commandcode"
    assert monthly.kind == "quota"
    assert monthly.windowLabel == "Monthly"
    # 月窗 = 账单周期（9/22 → 10/22），重置时刻 = 周期结束，不是日历月 1 号。
    assert monthly.windowSeconds == PERIOD_SECONDS
    assert monthly.role == "cycle"
    # Max 10×：周 cap 90 → 月总量 150；剩余 1.742… → 已用比例。
    assert monthly.usedPercent == pytest.approx((150 - 1.742346421) / 150 * 100)
    assert monthly.resetAt == PERIOD_RESET
    assert monthly.balance is None
    assert plugin_api.monthly_cell_count(monthly.windowSeconds) == 90


def test_monthly_row_follows_billing_period_not_the_calendar_month(monkeypatch):
    """月行跟着账单周期走：换一个周期（10/22 → 11/22，31 天）就跟着变。"""

    install(
        monkeypatch,
        subscription=_subscription_record(
            start="2026-10-22T08:58:10.000Z", end="2026-11-22T08:58:10.000Z"
        ),
    )

    monthly = next(
        row for row in plugin_api._fetch_commandcode(NOW) if row.id == "commandcode:monthly"
    )

    assert monthly.windowSeconds == 31 * DAY
    assert monthly.resetAt == datetime.fromisoformat(
        "2026-11-22T08:58:10+00:00"
    ).timestamp()
    # 日历月 1 号的重置绝不能再出现。
    assert monthly.resetAt != datetime(2026, 11, 1, tzinfo=timezone.utc).timestamp()


def test_missing_subscription_record_skips_monthly_row_without_breaking_weekly(monkeypatch):
    """订阅端点失败 → 不吐月行，但周窗/5h 行照常（不能连累整行报错）。"""

    install(monkeypatch, subscription_error=RuntimeError("subscriptions endpoint down"))

    rows = plugin_api._fetch_commandcode(NOW)

    assert [row.id for row in rows] == ["commandcode", "commandcode:5h"]
    assert all(row.status == "ok" for row in rows)


def test_non_monthly_billing_period_is_not_a_month_window(monkeypatch):
    """年度订阅（365 天）不是月窗 → 不吐月行，不占月区。"""

    install(
        monkeypatch,
        subscription=_subscription_record(
            start="2026-09-22T08:58:10.000Z", end="2027-09-22T08:58:10.000Z"
        ),
    )

    assert [row.id for row in plugin_api._fetch_commandcode(NOW)] == [
        "commandcode", "commandcode:5h",
    ]


def test_subscription_without_period_fields_is_not_a_month_window(monkeypatch):
    """订阅记录缺周期字段 → 不吐月行（不拿日历月兜底，也不发明窗长）。"""

    install(monkeypatch, subscription={"success": True, "data": {"planId": "individual-go"}})

    assert [row.id for row in plugin_api._fetch_commandcode(NOW)] == [
        "commandcode", "commandcode:5h",
    ]


def test_commandcode_burst_share_follows_plan_caps(monkeypatch):
    """换套餐只改 cap：份额随 cap 走（Pro: 16/40 = 0.4），不需要改代码。"""

    install(monkeypatch, credits=_payload(weekly_cap=40, five_hour_cap=16))

    rows = plugin_api._fetch_commandcode(0.0)

    assert rows[0].burstShare == pytest.approx(0.4)
    assert rows[0].usedPercent == pytest.approx(23.84567484 / 40 * 100)


def test_commandcode_exhausted_window_reports_over_100_percent(monkeypatch):
    """窗口打满时按实际比例报，不裁剪：exceeded=true 的窗口仍能看出超了多少。"""

    install(monkeypatch, credits=_payload(weekly_used=96.0, weekly_cap=90))

    rows = plugin_api._fetch_commandcode(0.0)

    assert rows[0].usedPercent == pytest.approx(96.0 / 90 * 100)


def test_commandcode_missing_weekly_window_returns_error_row(monkeypatch):
    """形态对不上就报错，不硬造额度（跟随 GLM「找不到周窗就抛」的约定）。"""

    payload = _payload()
    payload["windowLimits"].pop("weekly")
    install(monkeypatch, credits=payload)

    rows = plugin_api._fetch_commandcode(0.0)

    assert len(rows) == 1
    assert rows[0].id == "commandcode"
    assert rows[0].status == "request_error"


def test_commandcode_missing_credential_is_unconfigured(monkeypatch):
    """没有 COMMANDCODE_API_KEY 时按缺凭据处理（隔离环境里 .env 为空）。"""

    rows = plugin_api._fetch_commandcode(0.0)

    assert len(rows) == 1
    assert rows[0].status == "unconfigured"


def test_commandcode_auth_error_is_reported(monkeypatch):
    """401 走 auth_error 状态，错误串里不带密钥。"""

    class _AuthError(Exception):
        code = 401

    def fake_json_get(url, token):
        raise _AuthError("Unauthorized")

    monkeypatch.setattr(plugin_api, "_json_get", fake_json_get)

    rows = plugin_api._fetch_commandcode(0.0)

    assert rows[0].status == "auth_error"


def test_commandcode_go_plan_monthly_is_full_when_unused(monkeypatch):
    """Go（官方表：$1/月、月额度 $10、5h $3、周 $6）：还剩 10 → 已用 0%，30 天 90 格。"""

    install(
        monkeypatch,
        credits=_payload(weekly_used=0, weekly_cap=6, five_hour_used=0, five_hour_cap=3, monthly=10),
    )

    rows = plugin_api._fetch_commandcode(NOW)
    monthly = next(row for row in rows if row.id == "commandcode:monthly")

    assert monthly.kind == "quota"
    assert monthly.windowSeconds == PERIOD_SECONDS
    assert monthly.usedPercent == pytest.approx(0.0)
    assert monthly.resetAt == PERIOD_RESET
    assert plugin_api.monthly_cell_count(monthly.windowSeconds) == 90


def test_commandcode_unknown_weekly_cap_skips_monthly_row(monkeypatch):
    """周 cap 对不上官方表就不造月格子，也不退回余额行（因此也不必查订阅端点）。"""

    calls = []

    def fake_json_get(url, _token):
        calls.append(url)
        return _payload(weekly_cap=99, five_hour_cap=1, monthly=10)

    monkeypatch.setattr(plugin_api, "_json_get", fake_json_get)

    rows = plugin_api._fetch_commandcode(NOW)

    assert [row.id for row in rows] == ["commandcode", "commandcode:5h"]
    assert _SUBSCRIPTION not in calls


def test_monthly_row_never_reports_more_credits_left_than_the_plan_grants(monkeypatch):
    """服务端 remaining(12) > 官方表推的 cap(10)：加量包 / 官方调价 / 档位错配都会这样。

    分子分母来自两个来源，不做归一就会算出负的已用百分比，面板那一格随即印出
    「120% left」这种假数字。归一到 0% 已用（= 满额）是这里唯一诚实的档位。
    """

    install(
        monkeypatch,
        credits=_payload(weekly_used=0, weekly_cap=6, five_hour_used=0, five_hour_cap=3, monthly=12),
    )

    rows = plugin_api._fetch_commandcode(NOW)
    monthly = next(row for row in rows if row.id == "commandcode:monthly")

    assert monthly.usedPercent == pytest.approx(0.0)


def test_monthly_row_clamps_over_consumed_credits_at_full(monkeypatch):
    """remaining 为负（额度透支）→ 已用封顶 100%，不出现「-20% left」。"""

    install(
        monkeypatch,
        credits=_payload(weekly_used=0, weekly_cap=6, five_hour_used=0, five_hour_cap=3, monthly=-2),
    )

    rows = plugin_api._fetch_commandcode(NOW)
    monthly = next(row for row in rows if row.id == "commandcode:monthly")

    assert monthly.usedPercent == pytest.approx(100.0)

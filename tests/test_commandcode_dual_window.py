"""Command Code 双窗口行（周窗 + 5 小时窗）+ 月度积分余额测试。

2026-09-21 新增。mock payload 采用当日从真实账户实测的
``GET https://api.commandcode.ai/alpha/billing/credits`` 结构，数值不编造：

    windowLimits.fiveHour / windowLimits.weekly = {used, cap, exceeded, resetAt}
    credits.monthlyCredits                      = 套餐月度额度余额

两个 cap（本例 Max 10x 套餐：5h=45、周=90）由 API 给出，因此 burst 份额必须
从 cap 推导（45/90 = 0.5），不能在 fetcher 里写死常量。resetAt 为毫秒 epoch。
"""

import pytest

from tests.conftest_sm import plugin_api

FIVE_HOUR = plugin_api.FIVE_HOUR_SECONDS
WEEKLY = plugin_api.WEEKLY_SECONDS


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


def test_commandcode_emits_weekly_five_hour_and_monthly_rows(monkeypatch):
    """周窗（cycle）+ 5h 窗（burst）+ 月度余额各一行，字段取自 payload。"""

    def fake_json_get(url, _token):
        assert url == plugin_api.COMMANDCODE_BILLING_URL
        return _payload()

    monkeypatch.setattr(plugin_api, "_json_get", fake_json_get)

    rows = plugin_api._fetch_commandcode(0.0)

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
    assert five_hour.resetAt == 1790023291291 / 1000.0

    assert monthly.providerId == "commandcode"
    assert monthly.kind == "balance"
    assert monthly.balance == pytest.approx(1.742346421)
    assert monthly.currency == "USD"


def test_commandcode_burst_share_follows_plan_caps(monkeypatch):
    """换套餐只改 cap：份额随 cap 走（Pro: 16/40 = 0.4），不需要改代码。"""

    monkeypatch.setattr(
        plugin_api, "_json_get",
        lambda url, _token: _payload(weekly_cap=40, five_hour_cap=16),
    )

    rows = plugin_api._fetch_commandcode(0.0)

    assert rows[0].burstShare == pytest.approx(0.4)
    assert rows[0].usedPercent == pytest.approx(23.84567484 / 40 * 100)


def test_commandcode_exhausted_window_reports_over_100_percent(monkeypatch):
    """窗口打满时按实际比例报，不裁剪：exceeded=true 的窗口仍能看出超了多少。"""

    monkeypatch.setattr(
        plugin_api, "_json_get",
        lambda url, _token: _payload(weekly_used=96.0, weekly_cap=90),
    )

    rows = plugin_api._fetch_commandcode(0.0)

    assert rows[0].usedPercent == pytest.approx(96.0 / 90 * 100)


def test_commandcode_missing_weekly_window_returns_error_row(monkeypatch):
    """形态对不上就报错，不硬造额度（跟随 GLM「找不到周窗就抛」的约定）。"""

    payload = _payload()
    payload["windowLimits"].pop("weekly")
    monkeypatch.setattr(plugin_api, "_json_get", lambda url, _token: payload)

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

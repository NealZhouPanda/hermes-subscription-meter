"""Monthly quota is a calendar-month usage window, not money.

28/29/30/31-day windows → 3 cells/day (8 hours each). The board hides
those rows unless monthlyVisibility[providerId] is True (default off).
"""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from tests.conftest_sm import plugin_api, write_auth, write_env

DAY = 86400
WEEK = 7 * DAY
FIVE_H = 5 * 3600


def _quota(**kwargs):
    defaults = dict(
        id="zeta:weekly",
        providerId="zeta",
        label="ZETA",
        kind="quota",
        role="cycle",
        windowSeconds=WEEK,
        usedPercent=10.0,
    )
    defaults.update(kwargs)
    return plugin_api.MeterRow(**defaults)


def test_only_calendar_month_lengths_count_as_monthly():
    assert plugin_api.monthly_days(28 * DAY) == 28
    assert plugin_api.monthly_days(29 * DAY) == 29
    assert plugin_api.monthly_days(30 * DAY) == 30
    assert plugin_api.monthly_days(31 * DAY) == 31
    assert plugin_api.monthly_days(WEEK) is None
    assert plugin_api.monthly_days(10 * DAY) is None
    assert plugin_api.monthly_days(FIVE_H) is None
    assert plugin_api.monthly_days(None) is None
    assert plugin_api.monthly_days(0) is None
    assert plugin_api.monthly_days(30 * DAY + 1) is None


def test_monthly_cell_count_is_three_per_day():
    assert plugin_api.monthly_cell_count(28 * DAY) == 84
    assert plugin_api.monthly_cell_count(29 * DAY) == 87
    assert plugin_api.monthly_cell_count(30 * DAY) == 90
    assert plugin_api.monthly_cell_count(31 * DAY) == 93
    assert plugin_api.monthly_cell_count(WEEK) is None


def test_board_hides_monthly_rows_by_default():
    weekly = _quota()
    monthly = _quota(id="zeta:monthly", windowSeconds=30 * DAY, windowLabel="Monthly")
    burst = _quota(id="zeta:5h", windowSeconds=FIVE_H, role="burst", windowLabel="5H")
    balance = plugin_api.MeterRow(
        id="deepseek", providerId="deepseek", label="DEEPSEEK", kind="balance", balance=1.0,
    )
    visible = plugin_api.filter_board_rows(
        [weekly, burst, monthly, balance], monthly_visibility={},
    )
    assert [row.id for row in visible] == ["zeta:weekly", "zeta:5h", "deepseek"]


def test_board_shows_monthly_row_when_switch_on():
    monthly = _quota(id="zeta:monthly", windowSeconds=30 * DAY)
    weekly = _quota()
    visible = plugin_api.filter_board_rows(
        [weekly, monthly], monthly_visibility={"zeta": True},
    )
    assert [row.id for row in visible] == ["zeta:weekly", "zeta:monthly"]


def test_settings_monthly_switch_defaults_off_and_appears_only_with_month_window(monkeypatch):
    write_env({"KIMI_API_KEY": "kimi-fixture"})
    write_auth({})
    monthly = _quota(id="kimi:monthly", providerId="kimi", label="KIMI", windowSeconds=30 * DAY)
    weekly = _quota(id="kimi", providerId="kimi", label="KIMI")
    monkeypatch.setattr(
        plugin_api,
        "_cache",
        {"at": 1.0, "payload": plugin_api.MeterPayload(rows=[weekly, monthly], generatedAt=1.0),
         "identity_overrides": {}},
    )
    payload = plugin_api.get_provider_settings()
    kimi = next(item for item in payload.providers if item.id == "kimi")
    assert kimi.hasMonthly is True
    assert kimi.monthlyEnabled is False


def test_put_monthly_enabled_persists_without_changing_main_switch(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    (tmp_path / "home").mkdir()
    (tmp_path / "home" / ".env").write_text("KIMI_API_KEY=kimi-fixture\n", encoding="utf-8")
    app = FastAPI()
    app.include_router(plugin_api.router)
    client = TestClient(app)

    resp = client.put("/settings/kimi", json={"monthlyEnabled": True})
    assert resp.status_code == 200, resp.text
    kimi = next(item for item in resp.json()["providers"] if item["id"] == "kimi")
    assert kimi["enabled"] is True
    assert kimi["monthlyEnabled"] is True

    import yaml
    settings = yaml.safe_load((tmp_path / "home" / "config.yaml").read_text(encoding="utf-8"))
    stored = settings["plugins"]["entries"]["subscription-meter"]["settings"]
    assert stored["monthlyVisibility"] == {"kimi": True}
    assert stored.get("visibility", {}) == {}

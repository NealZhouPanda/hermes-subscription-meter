"""行契约 M2-StepA：份额 / 配色 / 高峰由后端在行上声明，前端不再查供应商名表。

份额与高峰的旧真源在前端三张表（SHORT_WINDOW_RATIO / PEAK_RULES / ACCENTS），Step B
会删掉它们；删表后锁定段、配色、高峰判定只能从行上读。这里钉「行上有」这个契约，
断言的是行与它自己声明的常量/事实之间的关系，不冻结某家的当前数值。
"""

from types import SimpleNamespace

from tests.conftest_sm import plugin_api, write_env


def _kimi_payload():
    # 结构同 2026-09-09 实测响应：顶层 usage 周窗 + limits[] 300 分钟 5h 窗。
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


def _glm_payload():
    return {
        "data": {
            "limits": [
                {"type": "CREDIT_LIMIT", "unit": 3, "number": 5, "percentage": 100,
                 "nextResetTime": 1788948753603},
                {"type": "CREDIT_LIMIT", "unit": 6, "number": 1, "percentage": 36,
                 "nextResetTime": 1789180421994},
            ]
        }
    }


def _snapshot(*windows):
    """account_usage 快照最小形状：只带取数用得到的字段。"""
    return SimpleNamespace(
        unavailable_reason=None,
        windows=tuple(
            SimpleNamespace(label=label, used_percent=used, reset_at=None)
            for label, used in windows
        ),
    )


def _reset_cache():
    plugin_api._cache.update(at=0.0, payload=None, identity_overrides={})


def test_kimi_declares_cycle_share_and_burst_role(monkeypatch):
    """KIMI 周窗行声明 role=cycle + 份额，5h 行只声明 role=burst（份额不两处各说一套）。"""
    monkeypatch.setattr(plugin_api, "_json_get", lambda url, token: _kimi_payload())

    weekly, five_hour = plugin_api._fetch_kimi(0.0)

    assert weekly.role == "cycle"
    assert weekly.burstShare == plugin_api.KIMI_BURST_SHARE == 0.2
    assert five_hour.role == "burst"
    assert five_hour.burstShare is None


def test_glm_declares_cycle_share_and_burst_role(monkeypatch):
    """GLM 同构：份额与 role 由自家 fetcher 写在周期行/短窗行上。"""
    monkeypatch.setattr(plugin_api, "_json_get", lambda url, token: _glm_payload())

    weekly, five_hour = plugin_api._fetch_glm(0.0)

    assert weekly.role == "cycle"
    assert weekly.burstShare == plugin_api.GLM_BURST_SHARE == 0.2
    assert five_hour.role == "burst"
    assert five_hour.burstShare is None


def test_snapshot_rows_take_role_from_window_not_provider_name():
    """CODEX 走快照：role 按窗口秒数判定，份额写在 cycle 行上。"""
    rows = plugin_api._quota_rows_from_snapshot(
        "codex", "CODEX", _snapshot(("Weekly", 37.0), ("Session", 3.0)),
        burst_share=plugin_api.CODEX_BURST_SHARE,
    )

    by_role = {row.role: row for row in rows}
    assert set(by_role) == {"cycle", "burst"}
    assert by_role["cycle"].windowSeconds == plugin_api.WEEKLY_SECONDS
    assert by_role["cycle"].burstShare == plugin_api.CODEX_BURST_SHARE == 0.15
    assert by_role["burst"].windowSeconds == plugin_api.FIVE_HOUR_SECONDS
    assert by_role["burst"].burstShare is None


def test_snapshot_without_declared_share_invents_none():
    """没声明份额的调用方（GROK 无短窗口径）：role 照窗口判，但绝不瞎填比例。"""
    rows = plugin_api._quota_rows_from_snapshot(
        "grok", "GROK", _snapshot(("SuperGrok weekly credits", 4.0)),
    )

    assert [row.role for row in rows] == ["cycle"]
    assert all(row.burstShare is None for row in rows)


def test_fetch_codex_carries_the_share_through_the_fetcher(monkeypatch):
    """份额由 _fetch_codex 传给快照层——不靠前端按供应商名查表。"""
    monkeypatch.setattr(
        plugin_api, "_fetch_native_account_usage",
        lambda provider: _snapshot(("Weekly", 37.0), ("Session", 3.0)),
    )

    rows = plugin_api._fetch_codex(0.0)

    cycle = next(row for row in rows if row.role == "cycle")
    assert cycle.burstShare == plugin_api.CODEX_BURST_SHARE


def test_provider_meta_is_copied_onto_rows():
    """accent / peakHours 由后端抄进行；Spec 里没有的供应商留空，不猜。"""
    rows = [
        plugin_api._row("glm", "GLM", providerId="glm"),
        plugin_api._row("deepseek", "DEEPSEEK", providerId="deepseek"),
        plugin_api._row("zeta", "ZETA", providerId="zeta"),
    ]

    plugin_api._apply_provider_meta(rows)

    glm, deepseek, zeta = rows
    assert glm.accent == plugin_api._provider_meta("glm")["accent"]
    assert glm.peakHours["windows"] == [
        [int(start), int(end)]
        for start, end in plugin_api._provider_meta("glm")["peakHours"]["windows"]
    ]
    assert deepseek.accent is None and deepseek.peakHours["windows"]
    assert zeta.accent is None and zeta.peakHours is None


def test_every_peak_rule_carries_a_timezone():
    """tz 必带：缺时区前端一律判「无高峰」（宁可不说，也不按本机时区猜）。"""
    for provider_id, meta in {s.id: s.meta for s in plugin_api.FETCHER_SPECS}.items():
        peak = meta.get("peakHours")
        if peak is None:
            continue
        assert peak.get("timezone"), provider_id
        assert peak.get("windows"), provider_id


def test_build_payload_ships_provider_facts_on_served_rows(monkeypatch):
    """端到端：看板拿到的行自带 accent / peakHours（前端不回头查名表）。"""
    write_env({"GLM_API_KEY": "fixture-glm-key"})
    monkeypatch.setattr(plugin_api, "_json_get", lambda url, token: _glm_payload())
    _reset_cache()

    rows = [row for row in plugin_api.build_payload().rows if row.providerId == "glm"]

    assert rows, "GLM 未出账"
    assert all(row.accent == plugin_api._provider_meta("glm")["accent"] for row in rows)
    assert all(row.peakHours["timezone"] == "+08:00" for row in rows)
    assert all(row.peakHours["windows"] for row in rows)

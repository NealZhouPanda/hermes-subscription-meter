"""Token activity heatmap aggregation (settings-page header, 2026-10-22).

Covers _build_usage_heatmap / _heatmap_db_paths / _heatmap_provider_label:
cross-profile aggregation over every state.db in the install root, provider
label merging, read-only access, cache behaviour, and output shape.
"""

from __future__ import annotations

import json
import sqlite3
import time
from datetime import datetime
from pathlib import Path

import pytest

from dashboard.plugin_api import (
    _build_usage_heatmap,
    _heatmap_cache,
    _heatmap_db_paths,
    _heatmap_provider_label,
    usage_heatmap,
)

DAY_MS = 86400


def _make_ledger(db_path: Path, rows: list[tuple[float, str, int, int, int, int]], model: str = "test-model") -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(db_path)
    db.execute(
        "CREATE TABLE IF NOT EXISTS session_model_usage ("
        "session_id TEXT, model TEXT, billing_provider TEXT, billing_base_url TEXT, "
        "billing_mode TEXT, task TEXT, api_call_count INTEGER, input_tokens INTEGER, "
        "output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, "
        "reasoning_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL, "
        "cost_status TEXT, cost_source TEXT, first_seen REAL, last_seen REAL)"
    )
    db.executemany(
        "INSERT INTO session_model_usage (model, billing_provider, input_tokens, output_tokens, "
        "cache_read_tokens, cache_write_tokens, first_seen, last_seen) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (model, provider, in_tok, out_tok, cr, cw, ts, ts)
            for (ts, provider, in_tok, out_tok, cr, cw) in rows
        ],
    )
    db.commit()
    db.close()


def _epoch_for(day: str) -> float:
    return datetime.strptime(day, "%Y-%m-%d").timestamp() + 3600  # 01:00 local


@pytest.fixture()
def fake_install(tmp_path, monkeypatch):
    """A Hermes install root with a default profile and two named profiles."""
    root = tmp_path / "hermes"
    root.mkdir()
    monkeypatch.setattr("dashboard.plugin_api.get_hermes_home", lambda: root)
    return root


def test_labels_merge_provider_families():
    assert _heatmap_provider_label("kimi") == "Kimi"
    assert _heatmap_provider_label("kimi-coding") == "Kimi"
    assert _heatmap_provider_label("xai") == "Grok (xAI)"
    assert _heatmap_provider_label("xai-oauth") == "Grok (xAI)"
    assert _heatmap_provider_label("minimax") == _heatmap_provider_label("minimax-cn")
    assert _heatmap_provider_label(None) == "Local / custom"
    assert _heatmap_provider_label("custom:ollama-gemma-fast") == "Local / custom"
    # Unknown but real providers keep their raw id (fail-visible, not silently local).
    assert _heatmap_provider_label("brand-new-provider") == "brand-new-provider"


def test_db_paths_cover_current_and_siblings(fake_install):
    root = fake_install
    _make_ledger(root / "state.db", [])
    _make_ledger(root / "profiles" / "houkun" / "state.db", [])
    _make_ledger(root / "profiles" / "qingwu" / "state.db", [])
    (root / "profiles" / "empty" / "state.db").parent.mkdir(parents=True)  # no db

    paths = _heatmap_db_paths(root)
    assert root / "state.db" in paths
    assert root / "profiles" / "houkun" / "state.db" in paths
    assert root / "profiles" / "qingwu" / "state.db" in paths
    assert len(paths) == 3  # 'empty' has no state.db, default not duplicated


def test_db_paths_named_profile_includes_default(fake_install):
    root = fake_install
    _make_ledger(root / "state.db", [])
    _make_ledger(root / "profiles" / "houkun" / "state.db", [])
    paths = _heatmap_db_paths(root / "profiles" / "houkun")
    assert root / "profiles" / "houkun" / "state.db" in paths
    assert root / "state.db" in paths


def test_aggregation_sums_across_profiles(fake_install):
    root = fake_install
    ts = _epoch_for("2026-07-07")
    _make_ledger(root / "state.db", [(ts, "kimi-coding", 100, 10, 500, 20)])
    _make_ledger(
        root / "profiles" / "qingwu" / "state.db",
        [(ts + 60, "kimi", 30, 5, 70, 0), (ts + 120, "deepseek", 8, 2, 0, 0)],
    )
    payload = _build_usage_heatmap(root)

    assert len(payload["days"]) == 1
    day = payload["days"][0]
    assert day["d"] == "2026-07-07"
    # kimi + kimi-coding merge; total = (100+10+520) + (30+5+70) + (8+2+0)
    assert day["t"] == 630 + 105 + 10
    assert day["p"]["Kimi"]["in"] == 130
    assert payload["total"] == day["t"]
    assert payload["activeDays"] == 1
    assert payload["firstLedger"] == "2026-07-07"
    # Rank is descending by tokens.
    tokens = [row["tokens"] for row in payload["rank"]]
    assert tokens == sorted(tokens, reverse=True)
    assert payload["rank"][0]["provider"] == "Kimi"


def test_days_are_sorted_and_gaps_omitted(fake_install):
    root = fake_install
    _make_ledger(root / "state.db", [
        (_epoch_for("2026-07-02"), "zai", 1, 1, 0, 0),
        (_epoch_for("2026-07-05"), "zai", 1, 1, 0, 0),
    ])
    payload = _build_usage_heatmap(root)
    assert [d["d"] for d in payload["days"]] == ["2026-07-02", "2026-07-05"]


def test_corrupt_side_ledger_is_skipped_not_fatal(fake_install):
    root = fake_install
    _make_ledger(root / "state.db", [(_epoch_for("2026-07-07"), "zai", 5, 1, 0, 0)])
    corrupt = root / "profiles" / "houkun" / "state.db"
    corrupt.parent.mkdir(parents=True, exist_ok=True)
    corrupt.write_bytes(b"not a sqlite database at all")
    payload = _build_usage_heatmap(root)
    assert payload["total"] == 6
    skipped = [s for s in payload["sources"] if not s["ok"]]
    assert len(skipped) == 1


def test_readonly_open_cannot_mutate_ledger(fake_install):
    root = fake_install
    db_path = root / "state.db"
    _make_ledger(db_path, [(_epoch_for("2026-07-07"), "zai", 5, 1, 0, 0)])
    before = db_path.read_bytes()
    _build_usage_heatmap(root)
    assert db_path.read_bytes() == before


def test_cache_ttl_roundtrip(fake_install):
    root = fake_install
    _make_ledger(root / "state.db", [(_epoch_for("2026-07-07"), "zai", 5, 1, 0, 0)])
    _heatmap_cache["at"] = 0.0
    _heatmap_cache["payload"] = None

    # Drive the coroutine directly.
    import asyncio

    first = asyncio.run(usage_heatmap())
    assert first["total"] == 6
    # Second call within TTL hits the cache: mutate the ledger, result must not move.
    _make_ledger(root / "state.db", [(_epoch_for("2026-07-08"), "zai", 9, 1, 0, 0)])
    second = asyncio.run(usage_heatmap())
    assert second["total"] == 6
    assert second is first
    # refresh=True bypasses the cache.
    third = asyncio.run(usage_heatmap(refresh=True))
    assert third["total"] == 16
    # TTL expiry also bypasses.
    _heatmap_cache["at"] = time.time() - 999
    fourth = asyncio.run(usage_heatmap())
    assert fourth["total"] == 16


def test_top_model_across_profiles(fake_install):
    root = fake_install
    ts = _epoch_for("2026-07-07")
    _make_ledger(root / "state.db", [(ts, "deepseek", 100, 10, 0, 0)], model="deepseek-chat")
    _make_ledger(
        root / "profiles" / "qingwu" / "state.db",
        [(ts + 60, "kimi", 900, 0, 0, 0)],
        model="kimi-k2",
    )
    payload = _build_usage_heatmap(root)
    assert payload["topModel"] == {"model": "kimi-k2", "tokens": 900}


def test_payload_is_json_serialisable(fake_install):
    root = fake_install
    _make_ledger(root / "state.db", [(_epoch_for("2026-07-07"), "zai", 5, 1, 0, 0)])
    payload = _build_usage_heatmap(root)
    encoded = json.dumps(payload)
    assert '"days"' in encoded
    assert '"sources"' in encoded


def test_empty_install_yields_empty_shape(fake_install, tmp_path):
    payload = _build_usage_heatmap(fake_install)
    assert payload["days"] == []
    assert payload["total"] == 0
    assert payload["activeDays"] == 0
    assert payload["firstLedger"] is None
    assert payload["rank"] == []

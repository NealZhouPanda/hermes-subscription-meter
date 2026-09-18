"""Step A 重启前预检（进程内）：跑整条 build_payload，逐行核对新声明的事实在行上。

不写任何配置、不改可见性；只做只读取数（各 fetcher 直连各家端点）+ 断言。
"""
import json
import sys

DASHBOARD_DIR = sys.argv[1] if len(sys.argv) > 1 else "/tmp/sm-m2a/plugins/subscription-meter/dashboard"
sys.path.insert(0, DASHBOARD_DIR)
import plugin_api as api  # noqa: E402

print("预检目标：", api.__file__)

api._cache.update(at=0.0, payload=None, identity_overrides={})
payload = api.build_payload()

keep = ("id", "providerId", "label", "kind", "windowLabel", "windowSeconds",
        "role", "burstShare", "accent", "peakHours", "usedPercent", "status", "error")
print("--- 行（实时取数） ---")
for row in payload.rows:
    data = {k: v for k, v in row.model_dump().items() if k in keep}
    print(json.dumps(data, ensure_ascii=False))

expected_share = {
    "kimi": api.KIMI_BURST_SHARE,
    "glm": api.GLM_BURST_SHARE,
    "codex": api.CODEX_BURST_SHARE,
    "minimax-cn": api.MINIMAX_BURST_SHARE,
}

failures = []
served = [row for row in payload.rows if row.status in ("ok", "partial")]

for row in served:
    meta = api.PROVIDER_META.get(row.providerId, {})
    if meta.get("accent") and row.accent != meta["accent"]:
        failures.append(f"{row.id}: accent 未抄进行（{row.accent!r}）")
    if meta.get("peakHours"):
        peak = row.peakHours or {}
        if not peak.get("timezone") or not peak.get("windows"):
            failures.append(f"{row.id}: peakHours 缺 tz 或 windows（{peak!r}）")

by_provider = {}
for row in served:
    by_provider.setdefault(row.providerId, []).append(row)

for provider_id, rows in by_provider.items():
    cycles = [r for r in rows if r.role == "cycle"]
    bursts = [r for r in rows if r.role == "burst"]
    unlabeled = [r for r in rows if r.role is None and r.kind == "quota" and r.windowSeconds]
    if unlabeled:
        failures.append(f"{provider_id}: 时间行缺 role（{[r.id for r in unlabeled]}）")
    if len(cycles) > 1 or len(bursts) > 1:
        failures.append(f"{provider_id}: cycle/burst 不是至多各一行")
    for row in bursts:
        if row.windowSeconds != api.FIVE_HOUR_SECONDS:
            failures.append(f"{row.id}: role=burst 但 windowSeconds={row.windowSeconds}")
        if row.burstShare is not None:
            failures.append(f"{row.id}: 份额只应写在 cycle 行")
    share = expected_share.get(provider_id)
    if share is None:
        if any(r.burstShare for r in rows):
            failures.append(f"{provider_id}: 未声明口径却出现 burstShare")
    elif cycles:
        if cycles[0].burstShare != share:
            failures.append(f"{provider_id}: cycle 行份额 {cycles[0].burstShare!r} ≠ 声明 {share}")

print("\n--- 逐家配对 ---")
for provider_id, rows in sorted(by_provider.items()):
    summary = [
        f"{r.id}[role={r.role}, ws={r.windowSeconds}, share={r.burstShare}, "
        f"accent={r.accent}, peak={'有' if r.peakHours else '无'}]"
        for r in rows
    ]
    print(provider_id, "->", "; ".join(summary))

print("\n--- 结论 ---")
if failures:
    print("FAIL")
    for item in failures:
        print(" -", item)
    sys.exit(1)
print(f"PASS：{len(served)} 行全部带上行级事实；错误行 "
      f"{[r.id for r in payload.rows if r.status not in ('ok', 'partial')]}")

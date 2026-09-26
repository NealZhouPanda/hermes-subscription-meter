// 可用性闸门回归（2026-09-26 Neal 定）。
//
// 起因实况：Codex 5h 窗 100% 用满（服务端 allowed=false）+ 周窗 97% 用满，
// 但周窗只剩 2.8% 时间、P=(已流逝−已用)÷未流逝 的小分母把 0.2% 的微弱富余放大成
// 0.074，于是「一点也调不动」的行排在剩 98% 的 GLM 前面。
//
// 契约（两件事分开）：
//   ① 5h 不作排序维度 —— 不拿 5h 的 P 比大小（2026-09-10 定，本文件不回归它，
//      five-hour-lock.test.mjs 已有钉）。
//   ② 「现在能不能用」= 门槛：主窗还有剩 **且** 短窗还有剩；不满足 → 沉到所有可用行之后，
//      组内按解封时刻近者在前。份额 burstShare 只决定锁定段画多长，与能不能用无关。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const pluginSource = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

function loadFns() {
  const names = [
    'orderRowsForDisplay', 'rowPriority', 'availabilityOf', 'findFiveHourSibling',
    'burstShareOf', 'normalizeBurstShare', 'numericOrNull', 'activePeakRule',
    'localClockAt', 'peakRuleHit', 'collapseDuplicateQuotaRows', 'quotaCycleMs',
    'clamp', 'toEpochMillis'
  ]
  const snippets = names.map(name => {
    const match = pluginSource.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))
    assert.ok(match, `function ${name} must exist in plugin.js`)
    return match[0]
  })
  const constants = ['CELL_COUNT'].map(name => {
    const match = pluginSource.match(new RegExp(`^const ${name} = [^\\n]*\\n`, 'm'))
    assert.ok(match, `constant ${name} must exist in plugin.js`)
    return match[0]
  })
  return new Function(`${[...constants, ...snippets].join('\n\n')}; return { orderRowsForDisplay, availabilityOf, rowPriority }`)()
}

const fns = loadFns()
// 实况时刻：2026-09-26 11:46 CST（payload generatedAt = 1790394410）。
const NOW = 1790394410593
const HOUR = 3600000
const WEEK_SECONDS = 604800
const FIVE_HOUR_SECONDS = 18000

function cycleRow(providerId, label, usedPercent, hoursUntilReset, burstShare) {
  return {
    kind: 'quota',
    providerId,
    label,
    role: 'cycle',
    usedPercent,
    windowSeconds: WEEK_SECONDS,
    resetAt: NOW + hoursUntilReset * HOUR,
    ...(burstShare === undefined ? {} : { burstShare })
  }
}

function burstRow(providerId, label, usedPercent, hoursUntilReset) {
  return {
    kind: 'quota',
    providerId,
    label,
    role: 'burst',
    usedPercent,
    windowSeconds: FIVE_HOUR_SECONDS,
    resetAt: NOW + hoursUntilReset * HOUR
  }
}

const orderOf = rows => fns.orderRowsForDisplay(rows, NOW).map(row => row.label)

// 2026-09-26 11:46 实况数据（真实接口取回：周剩余 / 5h 剩余 / 距重置 / 份额）。
function liveRows() {
  return [
    cycleRow('kimi', 'KIMI', 41, 97.22, 0.2),
    burstRow('kimi', 'KIMI 5H', 7, 4.22),
    cycleRow('glm', 'GLM', 2, 166.78, 0.2),
    burstRow('glm', 'GLM 5H', 10, 3.78),
    cycleRow('codex', 'CODEX', 97, 4.69, 0.15),
    burstRow('codex', 'CODEX 5H', 100, 3.71),
    cycleRow('grok', 'GROK', 75, 50.7)
  ]
}

test('Codex 实况：5h 用满的周行沉到所有可用行之后（不再占第一位）', () => {
  const order = orderOf(liveRows())
  const cycleOrder = order.filter(label => !label.endsWith('5H'))
  assert.deepEqual(cycleOrder, ['KIMI', 'GLM', 'GROK', 'CODEX'])
  // 关键：它连 P 为负、还剩 25% 的 GROK 都要让位——「用不了」优先于「富余少」。
  assert.ok(order.indexOf('CODEX') > order.indexOf('GROK'))
})

test('主窗用尽（无 5h 兄弟行）同样沉底，不被抬到重置近的行前面', () => {
  const rows = [
    cycleRow('grok', 'GROK', 100, 47),
    cycleRow('glm', 'GLM', 2, 163),
    cycleRow('kimi', 'KIMI', 61, 68)
  ]
  assert.deepEqual(orderOf(rows), ['GLM', 'KIMI', 'GROK'])
})

test('短窗没满就不算用不了：锁定段再大也不沉底（GLM 实况）', () => {
  const rows = [
    cycleRow('glm', 'GLM', 2, 166.78, 0.2),
    burstRow('glm', 'GLM 5H', 10, 3.78),
    cycleRow('codex', 'CODEX', 97, 4.69, 0.15),
    burstRow('codex', 'CODEX 5H', 100, 3.71)
  ]
  const order = orderOf(rows)
  assert.ok(order.indexOf('GLM') < order.indexOf('CODEX'), 'GLM 还剩 98% 周额度 → 必须在 CODE 之前')
  assert.ok(order.indexOf('GLM 5H') < order.indexOf('CODEX'), 'GLM 的 5h 行也不该被牵连')
})

test('可用性判据不看份额：5h 用满时即使行上没有 burstShare 也判用不了', () => {
  const weekly = cycleRow('x', 'X', 80, 50) // 剩 20%，行上没有份额
  const five = burstRow('x', 'X 5H', 100, 1) // 5h 用满
  assert.deepEqual(fns.availabilityOf(weekly, five), { available: false, unlockAt: NOW + 1 * HOUR })
  assert.equal(fns.availabilityOf(weekly, null).available, true, '没有短窗兄弟时只看主窗')
  assert.equal(fns.availabilityOf(cycleRow('x', 'X', 100, 50), five).available, false, '主窗用尽也是用不了')
})

test('解封时刻：被短窗卡住看短窗重置，主窗用尽看主窗重置', () => {
  const weekly = cycleRow('codex', 'CODEX', 97, 4.69, 0.15)
  const five = burstRow('codex', 'CODEX 5H', 100, 3.71)
  assert.equal(fns.availabilityOf(weekly, five).unlockAt, NOW + 3.71 * HOUR)
  assert.equal(fns.availabilityOf(cycleRow('grok', 'GROK', 100, 47), null).unlockAt, NOW + 47 * HOUR)
})

test('用不了的行之间：解封早的在前；解封后回到可用组按 P 排', () => {
  const rows = [
    cycleRow('a', 'A', 100, 10), // 主窗用尽 → 10h 后解封
    cycleRow('b', 'B', 97, 4.69, 0.15), // 主窗还有剩，被 5h 卡住
    burstRow('b', 'B 5H', 100, 1) // 1h 后解封
  ]
  assert.deepEqual(orderOf(rows), ['B 5H', 'B', 'A'])

  // 同一个 B：短窗一重置（还剩额度）就回到可用组，按自身 P 排在 A 前面。
  const unblocked = [
    cycleRow('a', 'A', 100, 10),
    cycleRow('b', 'B', 97, 4.69, 0.15),
    burstRow('b', 'B 5H', 0, 3.6)
  ]
  assert.deepEqual(orderOf(unblocked), ['B 5H', 'B', 'A'])
  // 看板只画主窗行（短窗行不单独占行），可见行的次序是 B 回到 A 前面。
  assert.deepEqual(orderOf(unblocked).filter(label => !label.endsWith('5H')), ['B', 'A'])
})

test('数据缺失的行（无 resetAt）仍排在用不了的行之后，余额行恒在最后', () => {
  const rows = [
    cycleRow('codex', 'CODEX', 97, 4.69, 0.15),
    burstRow('codex', 'CODEX 5H', 100, 3.71),
    { kind: 'quota', providerId: 'nova', label: 'NOVA', role: 'cycle', usedPercent: 20, windowSeconds: WEEK_SECONDS, resetAt: null },
    { kind: 'balance', providerId: 'deepseek', label: 'DEEPSEEK' }
  ]
  assert.deepEqual(orderOf(rows), ['CODEX 5H', 'CODEX', 'NOVA', 'DEEPSEEK'])
})

test('gate 不动 P 公式：可用行之间的次序与旧规则一致（同分按重置近者在前）', () => {
  const rows = [
    cycleRow('kimi', 'KIMI', 61, 68),
    cycleRow('glm', 'GLM', 2, 163),
    cycleRow('grok', 'GROK', 100, 47) // 用满（= 沉底，与 2026-09-12 实况钉一致）
  ]
  assert.deepEqual(orderOf(rows), ['GLM', 'KIMI', 'GROK'])
  // P 只由主窗决定：加一个 5h 兄弟行不改变周行的 P 值。
  const weekly = cycleRow('glm', 'GLM', 2, 163, 0.2)
  const withSibling = fns.rowPriority(weekly, NOW)
  const withoutSibling = fns.rowPriority(cycleRow('glm', 'GLM', 2, 163), NOW)
  assert.equal(withSibling, withoutSibling)
})

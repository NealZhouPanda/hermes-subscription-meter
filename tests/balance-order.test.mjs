// 余额行组内排序回归（2026-09-29 Neal 定）。
//
// 契约：余额行永远在队尾（既有规矩，见 availability-gate.test.mjs），但**组内**要按余额
// 从多到少排；没有余额（0 / 缺失 / 非数）的自动沉到余额行里的最后。
// 只做数值大小直接比较：各家余额是自家计量单位（¥ / $），不折算汇率、不折算购买力。
// 同值时保持后端给的原始顺序（稳定），免得面板每轮轮询都重排、看着在跳。
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
  return new Function(`${[...constants, ...snippets].join('\n\n')}; return { orderRowsForDisplay }`)()
}

const { orderRowsForDisplay } = loadFns()
const NOW = 1790394410593

const balanceRow = (label, balance) => ({ id: label, label, kind: 'balance', balance })
const quotaRow = (label, used, resetAt) => ({
  id: label, label, kind: 'quota', role: 'cycle', usedPercent: used,
  resetAt, windowSeconds: 7 * 86400
})

const orderOf = rows => orderRowsForDisplay(rows, NOW).map(row => row.label)

test('余额多的排在前面（大的在上）', () => {
  const rows = [balanceRow('XAI', 12.74), balanceRow('NOUS', 3.78), balanceRow('DEEPSEEK', 21.36)]
  assert.deepEqual(orderOf(rows), ['DEEPSEEK', 'XAI', 'NOUS'])
})

test('没有余额的沉到余额行的最后：0 / null / 缺失 / 非数一视同仁', () => {
  const rows = [
    balanceRow('ZERO', 0),
    balanceRow('SMALL', 0.5),
    balanceRow('MISSING', undefined),
    balanceRow('NULL', null),
    balanceRow('NAN', 'abc'),
    balanceRow('BIG', 98)
  ]
  assert.deepEqual(orderOf(rows), ['BIG', 'SMALL', 'ZERO', 'MISSING', 'NULL', 'NAN'])
})

test('余额相同 / 都没余额 → 保持后端原始顺序（稳定，不来回跳）', () => {
  const tied = [balanceRow('A', 5), balanceRow('B', 5), balanceRow('C', 5)]
  assert.deepEqual(orderOf(tied), ['A', 'B', 'C'])

  const none = [balanceRow('P', 0), balanceRow('Q', null), balanceRow('R', undefined)]
  assert.deepEqual(orderOf(none), ['P', 'Q', 'R'])
})

test('余额行整体仍在所有 quota 行之后（余额排序不得把余额抬到配额前面）', () => {
  const rows = [
    balanceRow('RICH', 999),
    quotaRow('GLM', 10, (NOW / 1000) + 86400),
    quotaRow('KIMI', 40, (NOW / 1000) + 86400)
  ]
  const ordered = orderOf(rows)
  // quota 组内按 P（盈余÷未流逝）大小：用得少的 GLM 在前；余额行（无论多大）恒在最后。
  assert.deepEqual(ordered, ['GLM', 'KIMI', 'RICH'])
})

test('数值型余额按数值比（字符串数字也认），不是按字符串字典序', () => {
  const rows = [balanceRow('NINE', '9'), balanceRow('TEN', 10), balanceRow('HUNDRED', 100)]
  assert.deepEqual(orderOf(rows), ['HUNDRED', 'TEN', 'NINE'])
})

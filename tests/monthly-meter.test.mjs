// Monthly quota zone: 8 hours/cell, 3 cells/day, no gaps, split from weekly.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const pluginSource = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')

function buildSandbox() {
  const sandbox = { console }
  const source = pluginSource
    .replace(/^import\s.*$/gm, '')
    .replace('export default', 'globalThis.__pluginDefault =')
    + `\n;globalThis.__grid = gridTemplateColumns
globalThis.__isMonthly = isMonthlyWindow
globalThis.__meterCells = meterCellCount
globalThis.__cellDur = cellDurationSeconds
globalThis.__dayInt = dayCellIntervalOf
globalThis.__split = splitBoardRows
globalThis.__countGaps = dayGapColumns\n`
  vm.runInNewContext(`${source}\n`, sandbox, { filename: 'plugin.js' })
  return sandbox
}

const sandbox = buildSandbox()
const DAY = 86400
const countCellColumns = tpl => (tpl.match(/minmax\(0px, 0\.75rem\)/g) || []).length
const countGapColumns = tpl => tpl.split('0.35rem').length - 1

test('calendar month windows are monthly; week/10d/5h are not', () => {
  assert.equal(sandbox.__isMonthly({ windowSeconds: 30 * DAY }), true)
  assert.equal(sandbox.__isMonthly({ windowSeconds: 28 * DAY }), true)
  assert.equal(sandbox.__isMonthly({ windowSeconds: 31 * DAY }), true)
  assert.equal(sandbox.__isMonthly({ windowSeconds: 29 * DAY }), true)
  assert.equal(sandbox.__isMonthly({ windowSeconds: 7 * DAY }), false)
  assert.equal(sandbox.__isMonthly({ windowSeconds: 10 * DAY }), false)
  assert.equal(sandbox.__isMonthly({ windowSeconds: 5 * 3600 }), false)
  assert.equal(sandbox.__isMonthly({}), false)
})

test('monthly cell count is 3 per day; weekly stays 84', () => {
  assert.equal(sandbox.__meterCells({ windowSeconds: 30 * DAY }), 90)
  assert.equal(sandbox.__meterCells({ windowSeconds: 28 * DAY }), 84)
  assert.equal(sandbox.__meterCells({ windowSeconds: 31 * DAY }), 93)
  assert.equal(sandbox.__meterCells({ windowSeconds: 7 * DAY }), 84)
  assert.equal(sandbox.__meterCells({ windowSeconds: 10 * DAY }), 84)
})

test('30-day month: 8 hours/cell, 90 packed cells, no day gaps', () => {
  const month = { windowSeconds: 30 * DAY }
  assert.equal(sandbox.__cellDur(month), 8 * 3600)
  assert.equal(sandbox.__dayInt(month), null)
  const tpl = sandbox.__grid(month)
  assert.equal(countCellColumns(tpl), 90)
  assert.equal(countGapColumns(tpl), 0)
})

test('weekly 7-day window still 84 cells with day gaps', () => {
  const week = { windowSeconds: 7 * DAY }
  assert.equal(sandbox.__cellDur(week), 2 * 3600)
  assert.equal(sandbox.__dayInt(week), 12)
  const tpl = sandbox.__grid(week)
  assert.equal(countCellColumns(tpl), 84)
  assert.ok(countGapColumns(tpl) > 0)
})

test('board splits weekly / monthly / balance zones', () => {
  const rows = [
    { id: 'kimi', kind: 'quota', role: 'cycle', windowSeconds: 7 * DAY },
    { id: 'kimi:5h', kind: 'quota', role: 'burst', windowSeconds: 5 * 3600 },
    { id: 'kimi:monthly', kind: 'quota', role: 'cycle', windowSeconds: 30 * DAY },
    { id: 'deepseek', kind: 'balance' }
  ]
  const zones = sandbox.__split(rows)
  assert.deepEqual(zones.weekly.map(r => r.id), ['kimi'])
  assert.deepEqual(zones.monthly.map(r => r.id), ['kimi:monthly'])
  assert.deepEqual(zones.balance.map(r => r.id), ['deepseek'])
})

test('settings UI grows a monthly switch only when hasMonthly is true', () => {
  assert.match(pluginSource, /hasMonthly/)
  assert.match(pluginSource, /monthlyEnabled/)
  assert.match(pluginSource, /Show monthly quota/)
})

test('meter body renders weekly then monthly then balance with zone dividers', () => {
  const body = pluginSource.match(/function SubscriptionMeterBody[\s\S]*?\nfunction SubscriptionMeterPage/)?.[0] || ''
  assert.match(body, /splitBoardRows/)
  assert.match(body, /'data-zone': 'weekly'/)
  assert.match(body, /'data-zone': 'monthly'/)
  assert.match(body, /'data-zone': 'balance'/)
  assert.match(body, /'data-zone-divider'/)
})

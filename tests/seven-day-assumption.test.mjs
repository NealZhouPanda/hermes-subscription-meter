// M5 回归（2026-09-18）：去「7 天假设」+ 删 HOURS_PER_CELL + compactWindowLabel 整词化。
// 依据 release-prep/refactor-20260915/design/round2-grok-final.md：
//   §1 字段表：`windowSeconds`「格时值=ws/N（N=84 恒定）；缺→不画轴，行内响」；
//   §1 语义必改：「禁止缺省当 7 天」「禁止用 18000 认兄弟」；标签「禁止啃英文窗词」；
//   §1 零特例段：「日线：仅 windowSeconds%86400===0 时每 86400/格时值 格一条；HOURS_PER_CELL=2 删除」；
//   §3 验收：「月窗 84 格有日线；非整日无；burst 不成行」「ZETA 10d … 前端零名表」。
// 用假供应商名（ZETA / OMEGA / SIGMA），不新增任何按名取数的路径。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const pluginSource = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')

// 与 five-hour-lock/readability-render 同款：vm 跑全量源码（import 摘除、
// export default 换赋值），沙箱里直接取真实函数——避免脆弱的源码正则提取。
function buildSandbox() {
  const sandbox = { console }
  const source = pluginSource
    .replace(/^import\s.*$/gm, '')
    .replace('export default', 'globalThis.__pluginDefault =')
    // const 声明不会挂到沙箱全局，显式导出箭头函数常量供断言用。
    + '\n;globalThis.__grid = gridTemplateColumns; globalThis.__dayGapColumns = dayGapColumns\n'
  vm.runInNewContext(`${source}\n`, sandbox, { filename: 'plugin.js' })
  sandbox.gridTemplateColumns = sandbox.__grid
  sandbox.dayGapColumns = sandbox.__dayGapColumns
  return sandbox
}
const sandbox = buildSandbox()

const DAY = 86400

// ---------------------------------------------------------------------------
// 1) 去 7 天假设：windowSeconds 缺失 → 无窗，绝不默认 7 天
// ---------------------------------------------------------------------------
test('missing windowSeconds → no cycle, no cells, no axis, no day lines (never 7 days)', () => {
  assert.equal(sandbox.quotaCycleMs({}), null)
  assert.equal(sandbox.cellDurationSeconds({}), null)
  assert.equal(sandbox.dayCellIntervalOf({}), null)
  assert.equal(sandbox.gridTemplateColumns({}), Array.from({ length: 84 }, () => 'minmax(0px, 0.75rem)').join(' '))
  assert.equal(sandbox.isDayDivider(12, null), false)
  assert.equal(sandbox.isDayDivider(12, undefined), false)
})

test('windowless ZETA render row must drop the meter entirely (no axis, no fake window)', () => {
  assert.ok(typeof sandbox.WeeklyMeter === 'function' && typeof sandbox.WeeklyQuotaRow === 'function')
  const meterBody = pluginSource.match(/function WeeklyMeter\([\s\S]*?\n\}/)?.[0]
  assert.ok(meterBody && meterBody.includes('dayCellIntervalOf'),
    'WeeklyMeter must derive the day-cell interval per row')
  // windowless 行 normalizeRow 后 windowSeconds=null：WeeklyQuotaRow 直接不画矩阵
  // （比 unknown 判定更早的一层闸），日虚线/日间隙自然也不存在（上一条用例已钉退化）。
  const rowBody = pluginSource.match(/function WeeklyQuotaRow\([\s\S]*?\n\}/)?.[0]
  assert.ok(rowBody && rowBody.includes('!subscription.windowSeconds ? null'),
    'windowless rows must not render the matrix')
})

// ---------------------------------------------------------------------------
// 2) HOURS_PER_CELL 已删：源码里不得再有该名，格时值一律从 windowSeconds 推导
// ---------------------------------------------------------------------------
test('HOURS_PER_CELL is gone from source; cell duration derives from windowSeconds per row', () => {
  assert.ok(!/HOURS_PER_CELL|DAY_CELL_COUNT|GRID_TEMPLATE_COLUMNS|CYCLE_MS/.test(pluginSource),
    'deleted names must not remain in plugin.js')
  assert.equal(pluginSource.includes('const HOURS_PER_CELL'), false)
  // 84 格恒定（round1：「84 格是对齐用的视觉语法」）。
  assert.equal(pluginSource.includes('const CELL_COUNT = 84'), true)

  // ZETA 10 天窗：格时值 = 864000/84 = 2h52m30s。
  const zeta = { windowSeconds: 10 * DAY }
  assert.equal(sandbox.cellDurationSeconds(zeta), (10 * DAY) / 84)
  // OMEGA 30 天窗：格时值 = 720h/84 ≈ 8.57h。
  const omega = { windowSeconds: 30 * DAY }
  assert.equal(sandbox.cellDurationSeconds(omega), (30 * DAY) / 84)
  // SIGMA 5h 短窗：格时值 = 18000/84 ≈ 214s。
  const sigma = { windowSeconds: 5 * 3600 }
  assert.equal(sandbox.cellDurationSeconds(sigma), (5 * 3600) / 84)
  // 7 天窗仍正确 = 2h（由 windowSeconds 推导，而不是常量）。
  assert.equal(sandbox.cellDurationSeconds({ windowSeconds: 7 * DAY }), 2 * 3600)
})

test('cell duration labels: 7d→2 hours, 30d→8.6 hours, 10d→2.9 hours, 5h burst→4 minutes', () => {
  assert.equal(sandbox.formatCellDurationLabel(2 * 3600), '2 hours')
  assert.equal(sandbox.formatCellDurationLabel((30 * DAY) / 84), '8.6 hours')
  assert.equal(sandbox.formatCellDurationLabel((10 * DAY) / 84), '2.9 hours')
  assert.equal(sandbox.formatCellDurationLabel((5 * 3600) / 84), '4 minutes')
  assert.equal(sandbox.formatCellDurationLabel(DAY), '1 day')
})

// ---------------------------------------------------------------------------
// 3) 日线只在整日倍数窗口画（定稿公式：每 86400/格时值 格一条）
// ---------------------------------------------------------------------------
test('day-cell interval: 7d→12, 30d→3 (2.8 rounds), 10d→8 (8.4 rounds), 3d→28, burst 5h→none', () => {
  assert.equal(sandbox.dayCellIntervalOf({ windowSeconds: 7 * DAY }), 12)
  assert.equal(sandbox.dayCellIntervalOf({ windowSeconds: 30 * DAY }), 3)
  assert.equal(sandbox.dayCellIntervalOf({ windowSeconds: 10 * DAY }), 8)
  assert.equal(sandbox.dayCellIntervalOf({ windowSeconds: 3 * DAY }), 28)
  assert.equal(sandbox.dayCellIntervalOf({ windowSeconds: 12 * DAY }), 7)
  assert.equal(sandbox.dayCellIntervalOf({ windowSeconds: 5 * 3600 }), null)
  assert.equal(sandbox.dayCellIntervalOf({ windowSeconds: 90000 }), null) // 25h：非整日倍数
})

const countCellColumns = tpl => (tpl.match(/minmax\(0px, 0\.75rem\)/g) || []).length
const countGapColumns = tpl => tpl.split('0.35rem').length - 1

test('ZETA 10-day window renders 84 cells with day gaps; SIGMA 25h window renders none', () => {
  const zeta10d = sandbox.gridTemplateColumns({ windowSeconds: 10 * DAY })
  assert.equal(countCellColumns(zeta10d), 84, '10d window: still exactly 84 cells')
  assert.equal(countGapColumns(zeta10d), 10,
    '10d window: 10 day-gap columns = floor((84-1)/8), the frozen 7d formula (m2b DAY_GAP_COUNT) generalized')
  const gapCells = [8, 16, 24, 32, 40, 48, 56, 64, 72]
  for (const i of gapCells) {
    assert.equal(sandbox.isDayDivider(i, 8), true, `cell ${i} is a day boundary under a 10d window`)
  }
  for (const i of [7, 9, 12, 79]) {
    assert.equal(sandbox.isDayDivider(i, 8), false)
  }

  const sigma25h = sandbox.gridTemplateColumns({ windowSeconds: 25 * 3600 })
  assert.equal(countCellColumns(sigma25h), 84, '25h window: exactly 84 columns, no day gaps')
  assert.equal(countGapColumns(sigma25h), 0, 'no day-gap column may appear')

  // 无窗行：列数恒 84、无间隙（已有用例钉了 null 输入，这里补一个显式 windowSeconds 的坏值）。
  const bad = sandbox.gridTemplateColumns({ windowSeconds: 0 })
  assert.equal(countCellColumns(bad), 84)
  assert.equal(countGapColumns(bad), 0)
})

// ---------------------------------------------------------------------------
// 4) compactWindowLabel：整词抠窗词；数字+单位缩写保留成大写；其余英文不啃
// ---------------------------------------------------------------------------
test('compactWindowLabel: window words are stripped whole-word, never gnawed into English bits', () => {
  assert.equal(sandbox.compactWindowLabel('weekly'), '')                       // 整词匹配 → 无后缀
  assert.equal(sandbox.compactWindowLabel('Weekly'), '')
  assert.equal(sandbox.compactWindowLabel(''), '')
  assert.equal(sandbox.compactWindowLabel(null), '')
  assert.equal(sandbox.compactWindowLabel('supergrok weekly'), '')             // supergrok 特例保留
  assert.equal(sandbox.compactWindowLabel('5h'), '5H')                         // 纯数字+单位缩写
  assert.equal(sandbox.compactWindowLabel('session 5h'), '5H')                 // session 整词抠掉，剩 5h
  assert.equal(sandbox.compactWindowLabel('5h session'), '5H')
  assert.equal(sandbox.compactWindowLabel('build session'), '')                // 只剩窗型词 → 无后缀
  assert.equal(sandbox.compactWindowLabel('api weekly'), '')                   // api weekly 特例收编为 ''
  assert.equal(sandbox.compactWindowLabel('session'), '')                      // 窗型词整词 → ''
  assert.equal(sandbox.compactWindowLabel('build'), '')
  assert.equal(sandbox.compactWindowLabel('10 days'), '10D')                   // 数字+单位（新窗长）
  assert.equal(sandbox.compactWindowLabel('5 hours'), '5H')
  assert.equal(sandbox.compactWindowLabel('2 weeks'), '2W')
  assert.equal(sandbox.compactWindowLabel('10d'), '10D')                       // 数字+单位缩写
  assert.equal(sandbox.compactWindowLabel('10 day plan'), '')                  // 含英文词 day plan → 不啃
})

test('ZETA/OMEGA/SIGMA labels never gain provider-name boost via windowLabel', () => {
  // 防名表复活：任何含 provider 名的 windowLabel 都不得绕过「啃词即拒绝」规则。
  assert.equal(sandbox.compactWindowLabel('ZETA 10d'), '')   // 含英文词 ZETA → 不啃 → ''
  assert.equal(sandbox.compactWindowLabel('OMEGA 30d'), '')
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const pluginSource = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
const functionSource = pluginSource.match(/function formatRemaining\(resetAt, now\) \{[\s\S]*?\n\}/)?.[0]
assert.ok(functionSource, 'formatRemaining must exist in plugin.js')
const formatRemaining = vm.runInNewContext(`${functionSource}\nformatRemaining`)
const cycleSource = pluginSource.match(/function quotaCycleMs\(subscription\) \{[\s\S]*?\n\}/)?.[0]
assert.ok(cycleSource, 'quotaCycleMs must exist in plugin.js')
// M5 起 quotaCycleMs 不再依赖 CYCLE_MS（7 天默认已删，定稿「禁止缺省当 7 天」）。
const quotaCycleMs = vm.runInNewContext(`${cycleSource}\nquotaCycleMs`)

test('quota cycle follows each provider window duration', () => {
  assert.equal(quotaCycleMs({ windowSeconds: 5 * 60 * 60 }), 5 * 60 * 60 * 1000)
  assert.equal(quotaCycleMs({ windowSeconds: 7 * 24 * 60 * 60 }), 7 * 24 * 60 * 60 * 1000)
  assert.equal(quotaCycleMs({ windowSeconds: 30 * 24 * 60 * 60 }), 30 * 24 * 60 * 60 * 1000)
})

// M5（2026-09-18）：去 7 天假设——windowSeconds 缺失/非法必须返回 null（无窗），
// 绝不能回退到内置 7 天（定稿 round2-grok-final §1「windowSeconds 禁止缺省当 7 天」）。
test('missing windowSeconds yields no cycle (null), never a built-in 7-day default', () => {
  assert.equal(quotaCycleMs({}), null)
  assert.equal(quotaCycleMs({ windowSeconds: 0 }), null)
  assert.equal(quotaCycleMs({ windowSeconds: -1 }), null)
  assert.equal(quotaCycleMs(undefined), null)
  assert.equal(quotaCycleMs(null), null)
})

test('countdown includes whole minutes after days and hours', () => {
  const now = 1_000_000
  const remaining = (((1 * 24 + 2) * 60 + 3) * 60 + 4) * 1000
  assert.equal(formatRemaining(now + remaining, now), '1d 2h 3m')
})

// 列宽相关源码由 plugin.js 里的成对标记括起来：内部结构随便改，测试只认标记，
// 不再对字符串常量做正则匹配（写过死列宽的教训）。
const sliceBetween = (open, close) => {
  const block = pluginSource.match(new RegExp(`${open}[\\s\\S]*?${close}`))?.[0]
  assert.ok(block, `plugin.js 必须有标记对 ${open} … ${close}`)
  return block
}
const nameDepsSource = sliceBetween('// >>> display-name', '// <<< display-name <<<')
const gridSource = sliceBetween('// >>> grid-budget', '// <<< grid-budget <<<')
const grid = vm.runInNewContext(
  `${nameDepsSource}\n${gridSource}\n;({ QUOTA_GRID_COLUMNS, QUOTA_GRID_COLUMNS_NARROW,`
    + ' NARROW_ROW_BREAKPOINT_PX, DEFAULT_NAME_TRACK_PX, NAME_TRACK_MIN_PX, NAME_TRACK_STEP_PX,'
    + ' wideGridTemplate, narrowGridTemplate, narrowBreakpointPx, nameTrackPxFrom, quotaRowLayout })',
  { console }
)
const gridTracks = columns => columns.match(/minmax\([^)]*\)|[^\s]+/g)

test('reset metadata column keeps the fixed-track shape (meta 宽度由量测预算管)', () => {
  // 只有矩阵轨道伸缩，前三条是固定轨道（跨行对齐靠它）；名字轨道现在由数据量出来，
  // 只有兜底值在这里看形状。meta 轨道要多宽由 tests/reset-column-fit.test.mjs 按实测断言。
  assert.match(grid.QUOTA_GRID_COLUMNS, /^[\d.]+rem 3\.75rem 11\.5rem minmax\(6rem, 1fr\)$/)
})

// 名字列宽预算（2026-09-26 Neal：模型名与余量之间的空隙太大 → 按显示出来的最长名字定宽）。
// 现在是面板每次拿到数据量一遍（名字格同款字模 0.65rem/600/tracking .08em + 圆点 6px + gap 8px），
// 所有行共用一个值。这里钉：兜底值够用、量出来的值不多留空隙、长名字自动变宽、高峰徽标有位子。
// DEEPSEEK（8 字符）与 COMMANDCODE（11 字符）只当**字宽样例**用，代码里不认任何 provider 名。
// 实测值来自 headless 探针（~/.hermes/cache/scratch/sm-name-width-20260926/probe2.html），
// 再用和倒计时同一把尺的折算系数换回仓库尺。
const RULER = 1.0847
const MEASURED_NAME_TEXT_PX = {
  GLM: 26.0, KIMI: 26.41, CODEX: 41.34, GROK: 34.34, NOUS: 33.59, XAI: 19.62,
  DEEPSEEK: 62.52, MINIMAX: 52.59, ANTHROPIC: 69.7, OPENROUTER: 81.7, COMMANDCODE: 96.61
}
const PEAK_BADGE_PX = 31.27 // PEAK 胶囊：px-1.5 + 0.5rem mono 600
const fakeMeasure = (text, kind) =>
  (kind === 'badge' ? PEAK_BADGE_PX : MEASURED_NAME_TEXT_PX[text] || text.length * 7) * RULER
const nameCellPx = text => 6 + 8 + MEASURED_NAME_TEXT_PX[text] * RULER

test('兜底列宽（量不到时的默认值）覆盖 8 字符大写名字，也不多留空隙', () => {
  const track = grid.DEFAULT_NAME_TRACK_PX
  const needed = nameCellPx('DEEPSEEK')
  assert.ok(track >= needed, `兜底名字格 ${track}px 装不下 8 字符名字（实测需 ${needed.toFixed(2)}px）`)
  assert.ok(track - needed < grid.NAME_TRACK_STEP_PX,
    `兜底名字格比 8 字符名字宽 ${(track - needed).toFixed(2)}px，超出一档粒度（${grid.NAME_TRACK_STEP_PX}px）`)
})

test('名字列宽按当前数据自适应：短名字收窄、长名字变宽、只有真出现徽标才让位', () => {
  const shortOnly = grid.nameTrackPxFrom([{ label: 'GLM' }, { label: 'KIMI' }], fakeMeasure)
  assert.equal(shortOnly, grid.NAME_TRACK_MIN_PX, '全是两字名字时收到下限，不允许更窄')

  const withDeepseek = grid.nameTrackPxFrom([{ label: 'GLM' }, { label: 'DEEPSEEK' }], fakeMeasure)
  assert.ok(withDeepseek >= nameCellPx('DEEPSEEK'), '量出来的列宽必须装得下最长的名字')
  assert.ok(withDeepseek - nameCellPx('DEEPSEEK') < grid.NAME_TRACK_STEP_PX,
    '量出来的列宽不该比最长的名字宽出一档以上（不然又留空隙了）')
  assert.equal(withDeepseek, grid.DEFAULT_NAME_TRACK_PX, '8 字符大写名字正好落在兜底值上（兜底值就是按它定的）')

  // 比兜底更长的名字（未来加了长名 provider）：列宽自己变宽，不靠省略号掩盖。
  const withLonger = grid.nameTrackPxFrom([{ label: 'COMMANDCODE' }], fakeMeasure)
  assert.ok(withLonger > grid.DEFAULT_NAME_TRACK_PX, '更长的名字要把列撑宽，而不是被截')
  assert.ok(withLonger >= nameCellPx('COMMANDCODE'), '撑宽后必须真的装得下')

  // 高峰徽标是 shrink-0，但**只有真在高峰时刻**才给它留位（2026-09-26 Neal：
  // 不是所有用户都有 GLM/DeepSeek，没显示徽标就不该替他们留空）。
  const glmLimited = [{ label: 'GLM', peakHours: { ranges: [[14, 18]] } }]
  const offPeak = grid.nameTrackPxFrom(glmLimited, fakeMeasure)
  const inPeak = grid.nameTrackPxFrom(glmLimited, fakeMeasure, () => true)
  assert.equal(offPeak, grid.nameTrackPxFrom([{ label: 'GLM' }], fakeMeasure),
    '不在高峰时刻：列宽只由名字决定，不给徽标留空')
  assert.ok(inPeak > offPeak, '高峰时刻徽标出现，列宽跟着变宽')
  assert.ok(inPeak >= nameCellPx('GLM') + 8 + PEAK_BADGE_PX * RULER, '让位后要真的装得下名字 + 徽标')

  // 量出来的值一律落在 0.5rem 网格上（渲染不抖）。
  for (const track of [shortOnly, withDeepseek, withLonger, offPeak, inPeak]) {
    assert.equal(track % grid.NAME_TRACK_STEP_PX, 0, `列宽 ${track}px 不在 0.5rem 网格上`)
  }

  assert.equal(grid.nameTrackPxFrom([], fakeMeasure), grid.NAME_TRACK_MIN_PX, '没有行时用下限')
})

test('narrow two-line template pins text columns and lets the matrix take the rest', () => {
  const wide = gridTracks(grid.QUOTA_GRID_COLUMNS)
  const narrow = gridTracks(grid.QUOTA_GRID_COLUMNS_NARROW)
  // 名字格与余量格在两种布局里同宽（跨行对齐 + 名字只在一处定宽）；矩阵吃掉剩余。
  assert.equal(narrow[0], wide[0])
  assert.equal(narrow[1], wide[1])
  assert.equal(narrow[2], 'minmax(0, 1fr)')
})

test('断点由固定轨道之和推出：列宽一变，断点跟着变', () => {
  const fixedSum = nameTrackPx =>
    nameTrackPx + 3.75 * 16 + 11.5 * 16 + 6 * 16 + 3 * 8 + 2 * 6 // 轨道 + 矩阵最小 + 3 gap + px-1.5
  assert.equal(grid.NARROW_ROW_BREAKPOINT_PX, grid.narrowBreakpointPx(grid.DEFAULT_NAME_TRACK_PX),
    '兜底断点必须等于按兜底列宽算出来的值（不变量在 reset-column-fit.test.mjs 里再核一次）')
  for (const track of [grid.NAME_TRACK_MIN_PX, grid.DEFAULT_NAME_TRACK_PX, 128]) {
    assert.ok(grid.narrowBreakpointPx(track) >= fixedSum(track),
      `列宽 ${track}px 时断点小于宽排最小需求`)
  }
  assert.ok(grid.narrowBreakpointPx(128) > grid.narrowBreakpointPx(grid.DEFAULT_NAME_TRACK_PX),
    '列宽变大时断点要跟着变大')
})

test('rows switch to the two-line layout only below the single-line fit width', () => {
  const breakpoint = grid.NARROW_ROW_BREAKPOINT_PX
  assert.equal(grid.quotaRowLayout(320), 'narrow')
  assert.equal(grid.quotaRowLayout(breakpoint - 1), 'narrow')
  assert.equal(grid.quotaRowLayout(breakpoint), 'wide')
  assert.equal(grid.quotaRowLayout(900), 'wide')
  // Width 0 means "not measured yet" — never collapse into narrow on missing data.
  assert.equal(grid.quotaRowLayout(0), 'wide')
  // 传进量出来的列宽时，用对应断点判断（窄面板 + 长名字会提前换两行）。
  assert.equal(grid.quotaRowLayout(500, grid.narrowBreakpointPx(128)), 'narrow')
  assert.equal(grid.quotaRowLayout(500, grid.narrowBreakpointPx(grid.NAME_TRACK_MIN_PX)), 'wide')
})

test('countdown floors partial minutes', () => {
  const now = 1_000_000
  assert.equal(formatRemaining(now + (59 * 60 + 59) * 1000, now), '59m')
})

// 面板被隐藏（dock 收起、路由还没挂载完）时元素量出来是 0 宽。0 不是「文字很窄」，
// 是「量不到」——照它定宽会把名字列压到下限，用户一展开就看见省略号。
const fakeDocument = width => ({
  body: { appendChild: () => {} },
  createElement: () => ({
    className: '', textContent: '', style: { cssText: '' },
    appendChild: () => {}, setAttribute: () => {}, remove: () => {},
    getBoundingClientRect: () => ({ width })
  })
})
const domTextMeasureWith = width => vm.runInNewContext(
  `${nameDepsSource}\n${gridSource}\n;domTextMeasure`,
  { console, document: fakeDocument(width) }
)

test('量出 0 宽（面板被隐藏）时返回 null，交给调用方保留当前列宽', () => {
  assert.equal(domTextMeasureWith(0)(), null, '0 宽必须当成量不到，不能拿去定宽')
})

test('量得到宽度时才给得出测量函数，且量完能摘掉探针', () => {
  const measure = domTextMeasureWith(31.27)()
  assert.ok(measure, '有真实宽度时必须能测量')
  assert.equal(measure('GLM', 'name'), 31.27)
  assert.equal(measure('PEAK', 'badge'), 31.27)
  assert.equal(typeof measure.dispose, 'function', '量完要能把探针从 DOM 摘掉')
})

test('expired countdown clamps every unit to zero', () => {
  assert.equal(formatRemaining(1_000, 2_000), '0m')
})

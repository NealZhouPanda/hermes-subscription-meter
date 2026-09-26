// Reset 列宽度预算（2026-09-22：Neal 报「有的 reset 显示不全」，问能不能自适应）。
//
// 实测（headless chrome 按 app 默认字模量真实渲染，探针在
// ~/.hermes/cache/scratch/sm-reset-width/{probe.html,measure.mjs}）：
// meta 轨道 9.5rem = 152px，而日常就出现的「Reset 6d 23h 59m」(89.22px)
// + gap 6px + 「+19.1 cells」(59.34px) = 154.56px —— 差 2.6px，
// 于是倒计时被截成「Reset 5d 15h 4…」（复现过：clockScroll 89 > clockClient 87）。
//
// 2026-09-26 文案改「<窗口> Reset <剩余>」（Neal：用单词 Reset，不用 ↻；窗口词放前面，
// 没有 5h 限制的行也写自己的窗口），最坏串是「7D Reset 6d 23h 59m」= 105.31px，
// 轨道 10.5rem → 11.5rem（184px）。新串宽度用同一个探针头量、再按 11 个老串的比值
// 中位数折算回这张表的老尺子（探针 ~/.hermes/cache/scratch/sm-reset-wording-20260926/）；
// 表里的数必须同尺，否则预算比较没有意义。
//
// 两条契约：
// 1) meta 轨道必须装得下最坏组合（最长倒计时 + 最长余数后缀）且留余量；宽度表按
//    formatRemaining / formatSurplus 的真实输出登记 —— 格式一变长（比如加上秒），
//    这里就红，逼人重新量宽度而不是让文字再被截。
// 2) Reset 是这列的主信息：正常行永不收缩/截断，装不下时先牺牲余数后缀；
//    失败行的 error 摘要仍保留省略号（全文在行的 title 里）。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const pluginSource = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

// 与 reset-at-validity 同款：vm 跑全量源码，拿真实函数 / 真实渲染树 / 真实常量。
function buildSandbox() {
  const sandbox = {
    console,
    window: { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true, innerWidth: 0, innerHeight: 0 },
    host: { notify: () => {}, navigate: () => {}, state: { profile: { get: () => 'default' } } },
    Switch: () => null,
    PALETTE_AREA: 'palette', ROUTES_AREA: 'routes', SIDEBAR_NAV_AREA: 'sidebarNav',
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
    setInterval: () => 0,
    clearInterval: () => {},
    useMemo: fn => fn(),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useCallback: fn => fn,
    useValue: atom => (atom && typeof atom.get === 'function' ? atom.get() : null),
    useRef: initial => ({ current: initial }),
    Date
  }
  const source = pluginSource
    .replace(/^import\s.*$/gm, '')
    .replace('export default', 'globalThis.__pluginDefault =')
    // const 声明不挂沙箱全局：显式导出这块断言要用的常量。
    + '\n;globalThis.__grid = { wide: QUOTA_GRID_COLUMNS, narrow: QUOTA_GRID_COLUMNS_NARROW, breakpoint: NARROW_ROW_BREAKPOINT_PX, resetClockLabel,'
    + ' DEFAULT_NAME_TRACK_PX, nameTrackPxFrom, domTextMeasure, wideGridTemplate, narrowGridTemplate, narrowBreakpointPx }\n'
  vm.runInNewContext(`${source}\n`, sandbox, { filename: 'plugin.js' })
  return sandbox
}

const sandbox = buildSandbox()
const GRID = sandbox.__grid

// 探针实测宽度（CSS px；clock = sans 10px + tabular-nums，surplus = mono 8.96px）。
// 数字是等宽的（tabular-nums / mono），所以同结构的串同宽；表里按真实输出登记。
// 2026-09-26 文案 =「<窗口> Reset <剩余>」（窗口词来自行上 windowSeconds，
// 行上没有 windowSeconds 时就没有窗口词）。窗口只登记该窗真能出现的剩余值：
// 5H ≤ 5h、7D ≤ 7d、月窗 ≤ 31d；未登记的串 = 没量过 = 这里会红，先跑探针重量。
const MEASURED_CLOCK_PX = {
  '5H Reset 0m': 62.97,
  '5H Reset 59m': 68.99,
  '5H Reset 4h 59m': 84.05,
  '5H Reset 5h 0m': 78.03,
  '5H Reset —': 58.56,
  '7D Reset 0m': 62.79,
  '7D Reset 59m': 68.81,
  '7D Reset 4h 59m': 83.84,
  '7D Reset 5h 0m': 77.82,
  '7D Reset 3d 0h 12m': 99.3,
  '7D Reset 6d 23h 59m': 105.31,
  '7D Reset 7d 0h 0m': 93.28,
  '7D Reset —': 58.35,
  '28D Reset 0m': 68.81,
  '28D Reset 4h 59m': 89.86,
  '28D Reset 27d 0h 0m': 105.31,
  '28D Reset 28d 0h 0m': 105.31,
  '29D Reset 0m': 68.81,
  '29D Reset 4h 59m': 89.86,
  '29D Reset 28d 0h 0m': 105.31,
  '29D Reset 29d 0h 0m': 105.31,
  '30D Reset 0m': 68.81,
  '30D Reset 4h 59m': 89.86,
  '30D Reset 29d 0h 0m': 105.31,
  '30D Reset 30d 0h 0m': 105.31,
  '30D Reset —': 64.38,
  '31D Reset 0m': 68.81,
  '31D Reset 4h 59m': 89.86,
  '31D Reset 30d 0h 0m': 105.31,
  '31D Reset 31d 0h 0m': 105.31,
  // 无窗口词的行（行上没有 windowSeconds）沿用 2026-09-22 那批实测值，只补上 59m。
  'Reset 0m': 45.44,
  'Reset 5h 0m': 60.78,
  'Reset 4h 59m': 67.2,
  'Reset 59m': 52.15,
  'Reset 7d 0h 0m': 76.39,
  'Reset 6d 23h 59m': 89.22,
  'Reset 3d 0h 12m': 82.81,
  'Reset 28d 0h 0m': 82.81,
  'Reset 29d 0h 0m': 82.81,
  'Reset 30d 0h 0m': 82.81,
  'Reset 31d 0h 0m': 82.81,
  'Reset —': 39.06
}
const MEASURED_SURPLUS_PX = {
  '+0.0 cells': 53.95,
  '+9.9 cells': 53.95,
  '+19.1 cells': 59.34,
  '−9.9 cells': 53.95,
  '−19.1 cells': 59.34,
  '+84.0 cells': 59.34,
  '−84.0 cells': 59.34,
  '+90.0 cells': 59.34,
  '−90.0 cells': 59.34,
  '+93.0 cells': 59.34,
  '−93.0 cells': 59.34
}
const GAP_PX = 6 // gap-1.5 两段之间
const MARGIN_PX = 8 // 留给字体渲染差异与四舍五入
const REM_PX = 16
const NOW = 1790085600000
const DAY_MS = 86400 * 1000
const HOUR_MS = 3600 * 1000
const MIN_MS = 60 * 1000

function gridTracks(columns) {
  return columns.match(/minmax\([^)]*\)|[^\s]+/g)
}

function metaTrackPx() {
  return Number.parseFloat(gridTracks(GRID.wide)[2]) * REM_PX
}

test('meta 轨道装得下最坏组合（最长倒计时 + 最长余数后缀）并留余量', () => {
  const worstClock = Math.max(...Object.values(MEASURED_CLOCK_PX))
  const worstSurplus = Math.max(...Object.values(MEASURED_SURPLUS_PX))
  const required = worstClock + GAP_PX + worstSurplus
  const track = metaTrackPx()
  assert.ok(track >= required + MARGIN_PX,
    `meta 轨道 ${track}px 装不下最坏组合 ${required.toFixed(2)}px + ${MARGIN_PX}px 余量；` +
    '宽度改小前先跑 measure.mjs 重量')
})

// 每个窗口词配它真能出现的剩余值（5H ≤ 5h、7D ≤ 7d、月窗 ≤ 31d），null = 行上
// 没有 windowSeconds 的无窗口词形态。
const CLOCK_KEYS = [
  ['5H', ['0m', '59m', '4h 59m', '5h 0m']],
  ['7D', ['0m', '59m', '4h 59m', '5h 0m', '3d 0h 12m', '6d 23h 59m', '7d 0h 0m']],
  ['28D', ['0m', '4h 59m', '27d 0h 0m', '28d 0h 0m']],
  ['29D', ['0m', '4h 59m', '28d 0h 0m', '29d 0h 0m']],
  ['30D', ['0m', '4h 59m', '29d 0h 0m', '30d 0h 0m']],
  ['31D', ['0m', '4h 59m', '30d 0h 0m', '31d 0h 0m']],
  [null, ['0m', '59m', '4h 59m', '6d 23h 59m']]
]

test('倒计时/余数的真实输出都量过宽度（格式加长必须先重量再改列宽）', () => {
  for (const [key, tails] of CLOCK_KEYS) {
    for (const tail of tails) {
      const text = sandbox.resetClockLabel(key, tail)
      assert.ok(text in MEASURED_CLOCK_PX,
        `倒计时串「${text}」没量过宽度：文案/格式变了先用探针重量，把新串补进表里，再调 QUOTA_GRID_COLUMNS`)
    }
  }
  assert.ok('7D Reset —' in MEASURED_CLOCK_PX, '没有有效重置时刻的「7D Reset —」也要在表里')

  // 剩余时间串本身由 formatRemaining 生成：它一变长，表里就没有对应的串。
  const clockDeltas = [
    0, 59 * 1000, 4 * HOUR_MS + 59 * MIN_MS, 5 * HOUR_MS, 7 * DAY_MS,
    6 * DAY_MS + 23 * HOUR_MS + 59 * MIN_MS, 3 * DAY_MS + 12 * MIN_MS,
    27 * DAY_MS, 28 * DAY_MS, 29 * DAY_MS, 30 * DAY_MS, 31 * DAY_MS
  ]
  const knownTails = new Set(Object.keys(MEASURED_CLOCK_PX)
    .map(text => text.replace(/^(\d+[HD] )?Reset /, '')))
  for (const delta of clockDeltas) {
    const tail = sandbox.formatRemaining(NOW + delta, NOW)
    assert.ok(knownTails.has(tail),
      `剩余时间串「${tail}」没量过宽度：formatRemaining 变了就用探针重量补表`)
  }

  // 余数后缀的极端：格子数 84（周）/ 90（30 天月）/ 93（31 天月），正负都要能画。
  for (const blocks of [0, 9.9, -9.9, 19.1, -19.1, 84, -84, 90, -90, 93, -93]) {
    const text = sandbox.formatSurplus(blocks)
    assert.ok(text in MEASURED_SURPLUS_PX,
      `余数串「${text}」没量过宽度：见 measure.mjs`)
  }
})

test('窄行断点覆盖宽排布局的最小需求（改轨道必须同步断点）', () => {
  const tracks = gridTracks(GRID.wide)
  let fixed = 0
  for (const track of tracks.slice(0, 3)) fixed += Number.parseFloat(track) * REM_PX
  const matrixMin = Number.parseFloat(tracks[3].match(/minmax\(([^,]+),/)[1]) * REM_PX
  const gaps = 3 * 8 // gap-2 × 3
  const padding = 2 * 6 // px-1.5 两侧
  const minWide = fixed + matrixMin + gaps + padding
  assert.ok(GRID.breakpoint >= minWide,
    `窄行断点 ${GRID.breakpoint}px < 宽排最小需求 ${minWide}px（轨道 6.5+3.75+${Number.parseFloat(tracks[2])}rem）：` +
    '断点小于最小需求时，宽度刚好卡在中间会让整行溢出被裁')
})

// ---------------------------------------------------------------------------
// 名字列宽：量出来的值必须真的进到渲染里
// ---------------------------------------------------------------------------
function wideTemplateOf(rowProps) {
  const row = sandbox.WeeklyQuotaRow({ subscription: prepaidRow(), now: NOW, quotaPool: [], ...rowProps })
  return row.props.style.gridTemplateColumns
}

test('行用面板量出来的名字列宽（不是各自算各自的）', () => {
  // 两个不同名字的行传同一个值 → 网格模板完全一致（84 格矩阵靠这个跨行对齐）。
  const shortRow = wideTemplateOf({ nameTrackPx: 120 })
  assert.match(shortRow, /^7\.5rem 3\.75rem 11\.5rem minmax\(6rem, 1fr\)$/,
    '传进来的列宽要变成第一轨道（120px = 7.5rem）')
  const otherRow = sandbox.WeeklyQuotaRow({
    subscription: prepaidRow({ providerId: 'eta', label: 'ETA' }),
    now: NOW,
    quotaPool: [],
    nameTrackPx: 120
  }).props.style.gridTemplateColumns
  assert.equal(otherRow, shortRow, '同一面板里的行走同一个列宽')
  // 不传（单元渲染）时退回兜底值，不会渲染出空轨道。
  assert.equal(Number.parseFloat(wideTemplateOf({}).split(' ')[0]) * 16, GRID.DEFAULT_NAME_TRACK_PX)
})

test('量宽度用的是行上真正显示的名字（含窗口词后缀），PEAK 只在这场高峰里量', () => {
  const rows = [
    { label: 'KIMI', windowLabel: '5 hours' },
    { label: 'GLM', peakHours: { ranges: [[14, 18]] } }
  ]
  const spyOn = () => {
    const seen = []
    const spy = (text, kind) => {
      seen.push(`${kind}:${text}`)
      return text.length * 7
    }
    return { seen, spy }
  }
  const offPeak = spyOn()
  sandbox.nameTrackPxFrom(rows, offPeak.spy)
  assert.ok(offPeak.seen.includes('name:KIMI 5H'), `量到的名字应含窗口词后缀，实际：${offPeak.seen.join(', ')}`)
  assert.ok(offPeak.seen.includes('name:GLM'), '每个名字都要量')
  assert.ok(!offPeak.seen.includes('badge:PEAK'), '不在高峰时刻不该去量徽标（列宽不为它留空）')

  const inPeak = spyOn()
  sandbox.nameTrackPxFrom(rows, inPeak.spy, row => row.label === 'GLM')
  assert.ok(inPeak.seen.includes('badge:PEAK'), '高峰时刻要把 PEAK 徽标算进列宽')
})

test('没有 document（测试/SSR）时量不了，退回兜底列宽', () => {
  assert.equal(GRID.domTextMeasure(), null, '无 document 时必须返回 null 让调用方走兜底')
})

// 面板里不能有条件 hook（2026-09-26 实际炸过：hook 放在 `if (!rows.length) return` 之后，
// 数据到达那次渲染多出一个 hook → React error #310 → 错误边界接管，插件显示“损坏”）。
test('量宽 hook 在任何提前 return 之前，且面板里没有其他后置 hook', () => {
  const body = pluginSource.slice(
    pluginSource.indexOf('function SubscriptionMeterBody'),
    pluginSource.indexOf('function SubscriptionMeterPage')
  )
  assert.ok(body.length > 0, 'plugin.js 里应当有 SubscriptionMeterBody')
  const earlyReturnIndex = body.indexOf('if (!rows.length)')
  const hookIndex = body.indexOf('useMeasuredNameTrack(')
  assert.ok(earlyReturnIndex > 0, '面板应当还有“没数据先返回骨架”的分支')
  assert.ok(hookIndex > 0, '面板应当调用 useMeasuredNameTrack')
  assert.ok(hookIndex < earlyReturnIndex,
    'useMeasuredNameTrack 必须在提前 return 之前调用：放在之后会让数据到达那次渲染多一个 hook（#310）')
  const afterEarlyReturn = body.slice(earlyReturnIndex)
  assert.equal(afterEarlyReturn.match(/\buse[A-Z]\w*\(/g), null,
    `提前 return 之后还有 hook 调用，会触发 React #310：${afterEarlyReturn.match(/\buse[A-Z]\w*\(/g)}`)
})

// ---------------------------------------------------------------------------
// 渲染：Reset 永不截断，后缀先让步
// ---------------------------------------------------------------------------
function collect(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    node.forEach(child => collect(child, predicate, found))
    return found
  }
  if (predicate(node)) found.push(node)
  collect(node.props?.children, predicate, found)
  return found
}

function quotaRow(subscription) {
  return sandbox.WeeklyQuotaRow({ subscription, now: NOW, quotaPool: [subscription] })
}

function clockSpan(subscription) {
  const spans = collect(quotaRow(subscription), node => typeof node.props?.children === 'string'
    && (node.props.children.startsWith('Reset ')
      || /^\d+[HD] Reset /.test(node.props.children)
      || node.props.children.startsWith('Unauthorized')))
  assert.equal(spans.length, 1, 'row must render exactly one clock span')
  return spans[0]
}

function surplusSpan(subscription) {
  const spans = collect(quotaRow(subscription), node => typeof node.props?.children === 'string'
    && node.props.children.endsWith('cells'))
  assert.equal(spans.length, 1, 'row must render exactly one surplus span')
  return spans[0]
}

function prepaidRow(overrides = {}) {
  return {
    kind: 'quota',
    providerId: 'zeta',
    label: 'ZETA',
    role: 'cycle',
    windowSeconds: 604800,
    usedPercent: 20,
    resetAt: NOW + 3 * DAY_MS,
    ...overrides
  }
}

test('正常行：Reset 不缩不截（shrink-0），余数后缀才是让步的那个', () => {
  const row = prepaidRow()

  const clock = clockSpan(row)
  assert.equal(clock.props.className, 'shrink-0',
    'Reset 是这个格子的主信息，必须不收缩——收缩就会被截成「Reset 5d 15h 4…」')
  assert.ok(!/truncate|overflow-hidden/.test(clock.props.className),
    'Reset 不能带截断类')

  const surplus = surplusSpan(row)
  assert.match(surplus.props.className, /min-w-0/, '后缀要能被压到 0 才能让步')
  assert.match(surplus.props.className, /truncate/, '让步时用省略号，别硬裁')
})

test('失败行：error 摘要是长文本，仍然保留省略号（全文在行 title 里）', () => {
  const row = prepaidRow({ error: 'Unauthorized: token expired for this provider', usedPercent: null })

  const clock = clockSpan(row)
  assert.match(clock.props.className, /truncate/, 'error 摘要该被省略号收住')
  assert.match(clock.props.className, /min-w-0/, 'error 摘要要能收缩')

  // 失败行不画余数后缀（拿时间进度算出的盈亏在这里没有意义）。
  const spans = collect(quotaRow(row), node => typeof node.props?.children === 'string'
    && node.props.children.endsWith('cells'))
  assert.equal(spans.length, 0)
})

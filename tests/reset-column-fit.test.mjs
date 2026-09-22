// Reset 列宽度预算（2026-09-22：Neal 报「有的 reset 显示不全」，问能不能自适应）。
//
// 实测（headless chrome 按 app 默认字模量真实渲染，探针在
// ~/.hermes/cache/scratch/sm-reset-width/{probe.html,measure.mjs}）：
// meta 轨道 9.5rem = 152px，而日常就出现的「Reset 6d 23h 59m」(89.22px)
// + gap 6px + 「+19.1 cells」(59.34px) = 154.56px —— 差 2.6px，
// 于是倒计时被截成「Reset 5d 15h 4…」（复现过：clockScroll 89 > clockClient 87）。
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

const pluginSource = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')

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
    + '\n;globalThis.__grid = { wide: QUOTA_GRID_COLUMNS, narrow: QUOTA_GRID_COLUMNS_NARROW, breakpoint: NARROW_ROW_BREAKPOINT_PX }\n'
  vm.runInNewContext(`${source}\n`, sandbox, { filename: 'plugin.js' })
  return sandbox
}

const sandbox = buildSandbox()
const GRID = sandbox.__grid

// 2026-09-22 探针实测宽度（CSS px；clock = sans 10px + tabular-nums，surplus = mono 8.96px）。
// 数字是等宽的（tabular-nums / mono），所以同结构的串同宽；表里按真实输出登记。
const MEASURED_CLOCK_PX = {
  'Reset 0m': 45.44,
  'Reset 5h 0m': 60.78,
  'Reset 4h 59m': 67.2,
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

test('倒计时/余数的真实输出都量过宽度（格式加长必须先重量再改列宽）', () => {
  const clockDeltas = [
    0, 59 * 1000, 4 * HOUR_MS + 59 * MIN_MS, 5 * HOUR_MS, 7 * DAY_MS,
    6 * DAY_MS + 23 * HOUR_MS + 59 * MIN_MS, 3 * DAY_MS + 12 * MIN_MS,
    28 * DAY_MS, 29 * DAY_MS, 30 * DAY_MS, 31 * DAY_MS
  ]
  for (const delta of clockDeltas) {
    const text = `Reset ${sandbox.formatRemaining(NOW + delta, NOW)}`
    assert.ok(text in MEASURED_CLOCK_PX,
      `倒计时串「${text}」没量过宽度：格式变了就跑 measure.mjs 把新串补进表里，再调 QUOTA_GRID_COLUMNS`)
  }
  assert.ok('Reset —' in MEASURED_CLOCK_PX, '无重置时刻的「Reset —」也要在表里')

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
    && (node.props.children.startsWith('Reset ') || node.props.children.startsWith('Unauthorized')))
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

// 时间轴判据回归（2026-09-22）：resetAt 缺失/0/非法 ≠ 1970-01-01。
//
// 实况起因：Command Code 刚订阅、一次没用 → 服务端两个窗口都返回 resetAt=0（= 窗口还
// 没开始计时）。前端 Number(null)===0 被当成有效时刻，整条周条被画成「时间早已过完」：
// 42 格天蓝 + 42 格深蓝（Neal 报「一半浅蓝一半深蓝，看不懂」）。
//
// 契约：resetAt 能不能用只有 toEpochMillis 一个判据；判为 null 时**不画时间流逝**
// （格子全按「未流逝」着色），也不能让别处（排序 / 盈余块）把它当有效时刻。
// 用假供应商 ZETA 覆盖规则本身，另加 Command Code 实况钉。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const pluginSource = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

// 与 five-hour-lock/seven-day-assumption 同款：vm 跑全量源码，取真实函数 / 真实渲染树。
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
    // const 声明不会挂到沙箱全局（与 seven-day-assumption 同款处理）：显式导出断言要用的常量。
    + '\n;globalThis.__colors = COLORS\n'
  vm.runInNewContext(`${source}\n`, sandbox, { filename: 'plugin.js' })
  sandbox.COLORS = sandbox.__colors
  return sandbox
}

const sandbox = buildSandbox()
const COLORS = sandbox.COLORS
const DAY_MS = 86400 * 1000
const WEEK_MS = 7 * DAY_MS
// 2026-09-22 22:30 北京时间，取自动态 payload 的同一时刻量级。
const NOW = 1790085600000

function prepaidRow(overrides = {}) {
  return {
    kind: 'quota',
    providerId: 'zeta',
    label: 'ZETA',
    role: 'cycle',
    windowSeconds: 604800,
    usedPercent: 0,
    resetAt: NOW + 3.5 * DAY_MS,
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// 1) 判据本身
// ---------------------------------------------------------------------------
test('toEpochMillis：缺失/0/负数/非数一律判为「没有重置时刻」', () => {
  for (const invalid of [null, undefined, 0, -1, '', '  ', 'abc', NaN, Infinity, {}, []]) {
    assert.equal(sandbox.toEpochMillis(invalid), null,
      `${JSON.stringify(invalid)} must not be a usable reset moment`)
  }
  // 真实时刻：秒 → 毫秒，毫秒原样（归一化后重复调用是幂等的）。
  assert.equal(sandbox.toEpochMillis(1790087284), 1790087284000)
  assert.equal(sandbox.toEpochMillis(1790087284000), 1790087284000)
  assert.equal(sandbox.toEpochMillis('1790087284'), 1790087284000)
})

// ---------------------------------------------------------------------------
// 2) 格子：没有可用 resetAt → 不画流逝（不出现「已流逝」档的颜色）
// ---------------------------------------------------------------------------
function visibleCellColor(cell) {
  // 渲染语义：格子底色 = goneColor，fill 子元素（宽 fillRatio）盖在上层 = presentColor。
  // fillRatio=1 → 肉眼看到 presentColor；fillRatio=0 → 只剩 goneColor。
  return cell.fillRatio === 0 ? cell.goneColor : cell.fillRatio === 1 ? cell.presentColor : 'mixed'
}

test('每周格子：resetAt 缺失/0/非法 → 整个矩阵按「未流逝」着色（无已流逝的蓝）', () => {
  const row = prepaidRow()
  for (const broken of [null, undefined, 0, '0', NaN]) {
    const subscription = { ...row, resetAt: broken }
    const seen = new Set()
    for (let index = 0; index < 84; index += 1) {
      seen.add(visibleCellColor(sandbox.weeklyCell(NOW, subscription, index, false)))
    }
    assert.deepEqual([...seen], [COLORS.green],
      `resetAt=${JSON.stringify(broken)}：整条格子只能是「剩余」色，不能出现富余蓝`)
  }
})

test('每周格子：缺 windowSeconds（无窗长）+ 有效 resetAt → 同样不画流逝', () => {
  const seen = new Set()
  for (let index = 0; index < 84; index += 1) {
    seen.add(visibleCellColor(sandbox.weeklyCell(NOW, prepaidRow({ windowSeconds: null }), index, false)))
  }
  assert.deepEqual([...seen], [COLORS.green])
})

test('每周格子：有效未来 resetAt 的时间轴照旧工作（防过修）', () => {
  // 周窗过了一半、额度一点没用 → 前 42 格「已流逝未消耗」= 天蓝，后 42 格翠绿。
  const subscription = prepaidRow({ resetAt: NOW + WEEK_MS / 2 })
  assert.equal(visibleCellColor(sandbox.weeklyCell(NOW, subscription, 0, false)), COLORS.blue)
  assert.equal(visibleCellColor(sandbox.weeklyCell(NOW, subscription, 83, false)), COLORS.green)
  // 已消耗区仍压过时间轴：used 50% → 前 42 格是 track。
  const usedRow = prepaidRow({ resetAt: NOW + WEEK_MS / 2, usedPercent: 50 })
  assert.equal(visibleCellColor(sandbox.weeklyCell(NOW, usedRow, 0, false)), COLORS.track)
})

// ---------------------------------------------------------------------------
// 3) 排序与盈余块：同一判据，不得把缺失的 resetAt 当有效时刻
// ---------------------------------------------------------------------------
test('rowPriority：缺失/非法 resetAt 沉底，不参与富余计算', () => {
  for (const broken of [null, undefined, 0, -1, 'abc']) {
    assert.equal(sandbox.rowPriority(prepaidRow({ resetAt: broken }), NOW), -Infinity)
  }
  assert.ok(sandbox.rowPriority(prepaidRow(), NOW) > -Infinity)
})

test('surplusBlocks：缺失/非法 resetAt → 不显示盈亏（宁缺毋假）', () => {
  for (const broken of [null, undefined, 0, 'abc']) {
    assert.equal(sandbox.surplusBlocks(prepaidRow({ resetAt: broken }), NOW), null)
  }
  assert.notEqual(sandbox.surplusBlocks(prepaidRow(), NOW), null)
})

// ---------------------------------------------------------------------------
// 4) Command Code 实况回归钉（2026-09-22）
// ---------------------------------------------------------------------------
// Go 档：周 cap 6、5h cap 3 → 行上 burstShare=0.5；两个窗口 resetAt 都是 0（未开始计时）。
const COMMANDCODE_WEEKLY = prepaidRow({
  providerId: 'commandcode',
  label: 'COMMANDCODE',
  usedPercent: 0,
  resetAt: null,
  burstShare: 0.5
})
const COMMANDCODE_5H = {
  kind: 'quota',
  providerId: 'commandcode',
  label: 'COMMANDCODE',
  role: 'burst',
  windowSeconds: 18000,
  usedPercent: 0,
  resetAt: null
}

function meterCells(subscription, fiveHourSibling) {
  const element = sandbox.WeeklyMeter({ subscription, now: NOW, fiveHourSibling })
  const cells = []
  const walk = node => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    if (node.props?.['data-meter-cell']) cells.push(node.props)
    walk(node.props?.children)
  }
  walk(element)
  assert.equal(cells.length, 84, 'WeeklyMeter must render 84 cells')
  return cells
}

test('实况：Command Code 刚订阅（resetAt=0）→ 周条不再是整条蓝，而是一半翠绿一半深绿', () => {
  const cells = meterCells(COMMANDCODE_WEEKLY, COMMANDCODE_5H)
  const locked = cells.filter(props => props['data-locked'])
  // 5h cap 3 / 周 cap 6 → 此刻只能用掉周额度的一半，尾段 42 格是锁定段。
  assert.equal(locked.length, 42)
  for (const [index, props] of cells.entries()) {
    const fill = props.children
    // 渲染语义：格子底色恒为 goneColor（富余档蓝），肉眼看到的由 fill 决定——
    // fill 盖满 100% 时只剩 presentColor，所以「不画流逝」= 每格 fill 都是满宽。
    assert.equal(fill.props.style.width, '100%',
      `cell ${index} 已经流逝的错觉必须消失（fill 应盖满整格）`)
    const expected = index >= 42 ? COLORS.greenLocked : COLORS.green
    assert.equal(fill.props.style.backgroundColor, expected,
      `cell ${index} 可见色只能是「剩余/剩余受限」，不能是富余蓝`)
  }
})

test('实况：Command Code 有真实 resetAt 后，时间轴恢复（蓝只出现在真有流逝的地方）', () => {
  const cells = meterCells({ ...COMMANDCODE_WEEKLY, resetAt: NOW + WEEK_MS / 2 }, COMMANDCODE_5H)
  // 前半段已流逝未消耗 → 天蓝（fillRatio < 1，露出的底色是蓝）
  assert.ok(cells[0].children.props.style.width !== '100%' || cells[0].style.backgroundColor === COLORS.blue)
  assert.equal(cells[83].children.props.style.width, '100%')
  assert.equal(cells[83].children.props.style.backgroundColor, COLORS.greenLocked)
})

// ---------------------------------------------------------------------------
// 5) Reset 倒计时的取时来源（2026-09-26 改合并规则）：主窗与 5h 各出一候选，
//    默认显示未来较近的有效一个；文案是「<窗口> Reset <剩余>」（单词 Reset，不用 ↻），
//    找不到 5h 短窗的行也照写自己的窗口词（周 7D / 月 30D…）；
//    有效性判据仍是 toEpochMillis（缺失/0/过期一律不算）。
// ---------------------------------------------------------------------------
function clockTextOf(sandboxInstance, subscription, quotaPool) {
  const element = sandboxInstance.WeeklyQuotaRow({ subscription, now: NOW, quotaPool })
  let found = null
  const walk = node => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    const children = node.props?.children
    if (typeof children === 'string'
      && (children.startsWith('Reset ') || /^\d+[HD] Reset /.test(children))) found = children
    walk(children)
  }
  walk(element)
  assert.ok(found, 'row must render a Reset/countdown label')
  return found
}

const HOUR_MS = 3600 * 1000

test('倒计时取时：主窗与 5h 都有效 → 显示未来较近的 5H，带窗口词', () => {
  const weekly = prepaidRow({ providerId: 'zeta', resetAt: NOW + 3 * 24 * HOUR_MS })
  const five = { ...prepaidRow({ providerId: 'zeta', resetAt: NOW + 2 * HOUR_MS }), role: 'burst', windowSeconds: 18000 }
  // 非左侧的 0 保留（格式规则：只去最左侧连着的 0），2h 0m 是对的。
  assert.equal(clockTextOf(sandbox, weekly, [weekly, five]), '5H Reset 2h 0m')
})

test('倒计时取时：短窗在但没有有效重置时刻 → 只剩主窗候选 7D（不可切换）', () => {
  const weekly = prepaidRow({ providerId: 'zeta', resetAt: NOW + 3 * 24 * HOUR_MS })
  const five = { ...prepaidRow({ providerId: 'zeta', resetAt: null }), role: 'burst', windowSeconds: 18000 }
  assert.equal(clockTextOf(sandbox, weekly, [weekly, five]), '7D Reset 3d 0h 0m')
  const zeroed = { ...five, resetAt: 0 }
  assert.equal(clockTextOf(sandbox, weekly, [weekly, zeroed]), '7D Reset 3d 0h 0m')
})

test('倒计时取时：没有 5h 短窗 → 用本行的重置点，窗口词照写（周 7D / 月 30D）', () => {
  const weekly = prepaidRow({ providerId: 'zeta', resetAt: NOW + 3 * 24 * HOUR_MS })
  assert.equal(clockTextOf(sandbox, weekly, [weekly]), '7D Reset 3d 0h 0m')
  // 月行不参与短窗配对（月行没有 5h 兄弟），用自己的重置点。
  const monthly = prepaidRow({ providerId: 'zeta', windowSeconds: 30 * 86400, resetAt: NOW + 10 * 24 * HOUR_MS })
  assert.equal(clockTextOf(sandbox, monthly, [monthly]), '30D Reset 10d 0h 0m')
})

test('倒计时取时：本行也没有重置时刻 → —（缺失不编造）', () => {
  const weekly = prepaidRow({ providerId: 'zeta', resetAt: null })
  assert.equal(clockTextOf(sandbox, weekly, [weekly]), '7D Reset —')
})

// ---------------------------------------------------------------------------
// 6) 统一判据后，排序不再需要各自的气味守卫：missing resetAt 的行恒垫底
// ---------------------------------------------------------------------------
test('orderRowsForDisplay：无 resetAt 的行沉底，不被抬到重置近的行前面', () => {
  const fresh = prepaidRow({ providerId: 'zeta', label: 'ZETA', resetAt: null })
  const soon = prepaidRow({ providerId: 'omega', label: 'OMEGA', usedPercent: 90, resetAt: NOW + 0.5 * DAY_MS })
  const ordered = sandbox.orderRowsForDisplay([fresh, soon], NOW)
  // 跨 vm realm 的数组与本地 Array 原型不同，先摊平成本地数组再比。
  assert.deepEqual([...ordered].map(row => row.providerId), ['omega', 'zeta'])
})

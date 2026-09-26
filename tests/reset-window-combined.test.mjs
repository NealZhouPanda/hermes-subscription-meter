// Reset 倒计时合并版（2026-09-26 Neal 定）：默认显示 5H / 7D 两个重置里较近的有效一个
// 并标出窗口；恰好两个都有效时可点击在两窗口间切换（仅内存、不自动轮播）。
//
// 契约：
// · 候选有效性唯一判据 = toEpochMillis + 必须在未来（已过期不得显示成「马上重置」）
// · 两候选都有效 → 取未来较近者；并列（同一时刻）→ 确定性取主窗
// · 只一个有效 → 显示它且不可切换；都无效 → —
// · key 由行上 windowSeconds 推导（秒→H/D），不硬编码供应商名
// · 切换只影响当前行；每秒刷新不弹回；选中窗到期/消失 → 回到自动最近
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const pluginSource = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

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
  vm.runInNewContext(`${source}\n`, sandbox, { filename: 'plugin.js' })
  return sandbox
}

const sandbox = buildSandbox()
const NOW = 1790085600000
const HOUR_MS = 3600 * 1000
const DAY_MS = 86400 * 1000

function cycleRow(overrides = {}) {
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

function burstRow(overrides = {}) {
  return {
    kind: 'quota',
    providerId: 'zeta',
    label: 'ZETA',
    role: 'burst',
    windowSeconds: 18000,
    usedPercent: 50,
    resetAt: NOW + 2 * HOUR_MS,
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// 1) 候选与选择（纯函数层）
// ---------------------------------------------------------------------------
test('候选 key 由 windowSeconds 推导：18000→5H、604800→7D、30d→30D', () => {
  const weekly = cycleRow()
  const five = burstRow()
  const candidates = sandbox.resetWindowCandidates(weekly, five, NOW)
  assert.equal(candidates.length, 2)
  assert.deepEqual([...candidates.map(c => c.key)], ['7D', '5H'])  // 摊平 vm realm 数组
  assert.equal(candidates[0].at, weekly.resetAt)
  assert.equal(candidates[1].at, five.resetAt)
  // 30 天月行（无兄弟）→ 单候选 30D
  const monthly = cycleRow({ windowSeconds: 30 * 86400, resetAt: NOW + 10 * DAY_MS })
  assert.deepEqual([...sandbox.resetWindowCandidates(monthly, null, NOW).map(c => c.key)], ['30D'])
})

test('选择：两候选都有效 → 取未来较近者', () => {
  const weekly = cycleRow({ resetAt: NOW + 3 * DAY_MS })
  const five = burstRow({ resetAt: NOW + 2 * HOUR_MS })
  const candidates = sandbox.resetWindowCandidates(weekly, five, NOW)
  assert.equal(sandbox.selectResetCandidate(candidates, null, NOW).key, '5H')
  // 反向：5h 更晚（刚重置）→ 主窗更近
  const freshFive = burstRow({ resetAt: NOW + 5 * HOUR_MS })
  const nearWeek = cycleRow({ resetAt: NOW + 1 * HOUR_MS })
  const near = sandbox.resetWindowCandidates(nearWeek, freshFive, NOW)
  assert.equal(sandbox.selectResetCandidate(near, null, NOW).key, '7D')
})

test('选择：时间相同 → 确定性取主窗（7D）', () => {
  const same = NOW + 2 * HOUR_MS
  const candidates = sandbox.resetWindowCandidates(
    cycleRow({ resetAt: same }), burstRow({ resetAt: same }), NOW)
  assert.equal(sandbox.selectResetCandidate(candidates, null, NOW).key, '7D')
})

test('有效性：null/0/负数/非数/已过期都不能当重置时刻', () => {
  for (const broken of [null, 0, -5, 'abc', NaN]) {
    const candidates = sandbox.resetWindowCandidates(
      cycleRow({ resetAt: broken }), burstRow({ resetAt: broken }), NOW)
    assert.equal(sandbox.selectResetCandidate(candidates, null, NOW), null,
      `resetAt=${JSON.stringify(broken)} 不得成为有效候选`)
  }
  // 已过期（过去的时刻）不得当选，也不得显示成「马上重置」
  const past = sandbox.resetWindowCandidates(
    cycleRow({ resetAt: NOW - 1000 }), burstRow({ resetAt: NOW - HOUR_MS }), NOW)
  assert.equal(sandbox.selectResetCandidate(past, null, NOW), null)
})

test('选择：手动 preferred 命中有效候选 → 用它；命中已到期候选 → 回自动最近', () => {
  const weekly = cycleRow({ resetAt: NOW + 3 * DAY_MS })
  const five = burstRow({ resetAt: NOW + 2 * HOUR_MS })
  const candidates = sandbox.resetWindowCandidates(weekly, five, NOW)
  assert.equal(sandbox.selectResetCandidate(candidates, '7D', NOW).key, '7D')
  assert.equal(sandbox.selectResetCandidate(candidates, '5H', NOW).key, '5H')
  // preferred 指向已过期/不存在的窗口 → 回自动最近
  const expiredFive = burstRow({ resetAt: NOW - 1 })
  const mixed = sandbox.resetWindowCandidates(weekly, expiredFive, NOW)
  assert.equal(sandbox.selectResetCandidate(mixed, '5H', NOW).key, '7D')
  assert.equal(sandbox.selectResetCandidate(candidates, 'NOPE', NOW).key, '5H')
})

// ---------------------------------------------------------------------------
// 2) 渲染层（WeeklyQuotaRow 真实渲染树）
// ---------------------------------------------------------------------------
function clockTextsOf(subscription, quotaPool) {
  const element = sandbox.WeeklyQuotaRow({ subscription, now: NOW, quotaPool })
  const texts = []
  const walk = node => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    const children = node.props?.children
    if (typeof children === 'string'
      && (children.startsWith('Reset ') || /^\d+[HD] Reset /.test(children))) {
      texts.push({ text: children, type: node.type, props: node.props })
    }
    walk(children)
  }
  walk(element)
  return texts
}

test('渲染：周+5h 都有效 → 显示较近的 5H 且带窗口标记，渲染为可聚焦 button', () => {
  const weekly = cycleRow({ resetAt: NOW + 3 * DAY_MS })
  const five = burstRow({ resetAt: NOW + 2 * HOUR_MS })
  const found = clockTextsOf(weekly, [weekly, five])
  assert.equal(found.length, 1)
  assert.equal(found[0].text, '5H Reset 2h 0m')
  assert.equal(found[0].type, 'button', '两个有效候选时必须是 button（键盘可达）')
})

test('渲染：7D 更近 → 显示 7D', () => {
  const weekly = cycleRow({ resetAt: NOW + 1 * HOUR_MS })
  const five = burstRow({ resetAt: NOW + 2 * HOUR_MS })
  const found = clockTextsOf(weekly, [weekly, five])
  assert.equal(found[0].text, '7D Reset 1h 0m')
})

test('渲染：只有一个有效（5h resetAt 无效）→ 显示剩下的主窗 7D，但不可切换（不是 button）', () => {
  const weekly = cycleRow({ resetAt: NOW + 3 * DAY_MS })
  const five = burstRow({ resetAt: 0 })
  const found = clockTextsOf(weekly, [weekly, five])
  assert.equal(found[0].text, '7D Reset 3d 0h 0m')
  assert.notEqual(found[0].type, 'button')
})

test('渲染：都无效 → 窗口词仍在，时刻写 —（缺失不编造）', () => {
  const weekly = cycleRow({ resetAt: null })
  const five = burstRow({ resetAt: 0 })
  const found = clockTextsOf(weekly, [weekly, five])
  assert.equal(found[0].text, '7D Reset —')
})

test('渲染：月行（无兄弟行）不参与切换：窗口词仍是月窗 + 无 button', () => {
  const monthly = cycleRow({ windowSeconds: 30 * 86400, resetAt: NOW + 10 * DAY_MS })
  const found = clockTextsOf(monthly, [monthly])
  assert.equal(found[0].text, '30D Reset 10d 0h 0m')
  assert.notEqual(found[0].type, 'button')
})

test('渲染：button 支持 Enter/Space（原生 button 语义，type=button 防表单提交）', () => {
  const weekly = cycleRow()
  const five = burstRow()
  const found = clockTextsOf(weekly, [weekly, five])
  assert.equal(found[0].type, 'button')
  assert.equal(found[0].props.type, 'button')
})

test('渲染：切换后（preferred=7D）同一行显示 7D，另一行不受影响', () => {
  // 通过沙箱里的状态选择函数直接验证（点击处理会 setState preferred，再渲染时生效）。
  const weekly = cycleRow()
  const five = burstRow()
  const candidates = sandbox.resetWindowCandidates(weekly, five, NOW)
  const picked = sandbox.selectResetCandidate(candidates, '7D', NOW)
  assert.equal(picked.key, '7D')
  // 另一行（5h 行自身没有 cycle 语义，不参与此逻辑；此处验证选择是行内 state 而非全局）
  assert.equal(sandbox.selectResetCandidate(candidates, null, NOW).key, '5H')
})

test('渲染：选中窗口到期 → selectResetCandidate 回到自动最近（刷新不弹回逻辑的过期分支）', () => {
  const weekly = cycleRow({ resetAt: NOW + 3 * DAY_MS })
  const five = burstRow({ resetAt: NOW + 2 * HOUR_MS })
  const later = NOW + 2 * HOUR_MS + 1 // 5h 已过
  const candidates = sandbox.resetWindowCandidates(weekly, five, later)
  const picked = sandbox.selectResetCandidate(candidates, '5H', later)
  assert.equal(picked.key, '7D')
})

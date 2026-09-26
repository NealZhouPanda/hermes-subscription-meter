// Readability regression: real render tree (vm executes plugin.js) asserting
// English labels, surplus unit/meaning, no surplus on unknown/failed rows,
// and the whole help text living in the settings panel.
// Reuses the whole-source transform approach of data-credibility.test.mjs;
// network is fully in-memory fakes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const rawSource = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
const FIXED_NOW = Date.parse('2026-09-05T00:00:00Z')

function buildSandbox({ responses }) {
  const sandbox = {
    console,
    window: {
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true
    },
    host: { notify: () => {}, navigate: () => {}, state: { profile: { get: () => 'default' } } },
    Switch: () => null,
    PALETTE_AREA: 'palette', ROUTES_AREA: 'routes', SIDEBAR_NAV_AREA: 'sidebarNav',
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
    setInterval: () => 0,
    clearInterval: () => {},
    // Fixed "current time" so remaining%/surplus assertions are decoupled from
    // the real clock (real Date prototype preserved for formatRemaining).
    Date: class extends Date {
      static now() { return FIXED_NOW }
    },
    __ctxRest: async () => responses[0]()
  }
  const hookCells = []
  let hookIndex = 0
  sandbox.useState = initial => {
    const i = hookIndex++
    if (!(i in hookCells)) hookCells[i] = { value: typeof initial === 'function' ? initial() : initial }
    const cell = hookCells[i]
    return [cell.value, v => { cell.value = typeof v === 'function' ? v(cell.value) : v }]
  }
  const cleanups = []
  const effectDeps = []
  let effectIndex = 0
  sandbox.useEffect = (fn, deps) => {
    const i = effectIndex++
    const prev = effectDeps[i]
    const changed = !prev || !deps || deps.length !== prev.length || deps.some((d, j) => d !== prev[j])
    if (!changed) return
    const cleanup = fn()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
    effectDeps[i] = deps ? [...deps] : undefined
  }
  sandbox.__resetHooksState = () => { hookIndex = 0; effectIndex = 0 }
  sandbox.useMemo = fn => fn()
  sandbox.useRef = initial => ({ current: initial })
  sandbox.useLayoutEffect = () => {}
  sandbox.useCallback = fn => fn
  sandbox.useValue = atom => (atom && typeof atom.get === 'function' ? atom.get() : null)

  const source = rawSource
    .replace(/^import\s.*$/gm, '')
    .replace('export default', 'globalThis.__pluginDefault =')
  vm.runInNewContext(`${source}\n`, sandbox, { filename: 'plugin.js' })
  return sandbox
}

const flush = () => new Promise(resolve => setImmediate(resolve))

// weeklyCell's real fill colors (2026-09-12 Neal 定五色契约，色值=截图逐像素取样)。
const COLORS_OF = {
  green: '#14AE68',       // 翠绿：剩余可用
  greenLocked: '#006935', // 深绿：剩余受限（5h 锁定）
  blue: '#28A7E0',        // 天蓝：富余可用
  blueLocked: '#0A499D',  // 深蓝：富余受限（5h 锁定）
  orange: '#F39800',      // 橙：超额使用
  track: 'var(--ui-bg-quaternary)'
}

function weeklyCellOf(sandbox, now, subscription, index, locked = false) {
  return sandbox.weeklyCell(now, subscription, index, locked)
}

// Walk the real render element tree, expanding function components.
function collect(node, out = [], depth = 0) {
  if (node === null || node === undefined || node === true || node === false) return out
  if (Array.isArray(node)) { for (const child of node) collect(child, out, depth); return out }
  if (typeof node === 'object' && node.type !== undefined) {
    if (typeof node.type === 'function' && depth < 12) {
      collect(node.type(node.props), out, depth + 1)
      return out
    }
    out.push(node)
    collect(node.props.children, out, depth + 1)
  }
  return out
}

function renderBody(sandbox) {
  sandbox.__resetHooksState()
  return sandbox.SubscriptionMeterBody({ rest: sandbox.__ctxRest })
}

const textOf = nodes => {
  const parts = []
  const walk = node => {
    if (node === null || node === undefined || typeof node !== 'object') {
      if (typeof node === 'string' || typeof node === 'number') parts.push(String(node))
      return
    }
    if (Array.isArray(node)) return node.forEach(walk)
    if (node.props) walk(node.props.children)
  }
  nodes.forEach(walk)
  return parts.join(' ')
}

const quotaRowPayload = resetAtSeconds => () => ({
  rows: [
    // M5：windowSeconds 现为后端必填（M4 已上线）——fixture 同步补上，断言不变。
    { id: 'glm', providerId: 'glm', label: 'GLM', kind: 'quota', windowSeconds: 604800, usedPercent: 10, resetAt: resetAtSeconds },
    { id: 'deepseek', providerId: 'deepseek', label: 'DEEPSEEK', kind: 'balance', balance: 12.34, todaySpend: 0, sevenDaySpend: 0, thirtyDaySpend: 0, currency: 'CNY' }
  ]
})

// Fixed now: reset in 6 days → positive surplus; usedPercent=10 → 90% remaining.
const NOW = FIXED_NOW
const WEEK_AHEAD_RESET = Math.floor((NOW + 6 * 24 * 60 * 60 * 1000) / 1000)

test('quota row renders English remaining/reset labels and surplus carries the cell unit', async () => {
  const sandbox = buildSandbox({ responses: [quotaRowPayload(WEEK_AHEAD_RESET)] })
  renderBody(sandbox)
  await flush(); await flush()
  const nodes = collect(renderBody(sandbox))
  const text = textOf(nodes)
  assert.ok(/90% left/.test(text), 'percentage must be labeled as remaining quota')
  assert.ok(/reset/i.test(text), 'reset countdown must be labeled')
  assert.ok(/\+\d+\.\d+ cells/.test(text), 'surplus must be shown in cell units')
  const surplusNode = nodes.find(node => typeof node.props['aria-label'] === 'string' && node.props['aria-label'].includes('cell'))
  assert.ok(surplusNode, 'surplus number needs a title/aria explanation')
  assert.ok(/ahead of schedule|saved/.test(surplusNode.props['aria-label']))
})

test('balance labels are Balance/Today/7d/30d', async () => {
  const sandbox = buildSandbox({ responses: [quotaRowPayload(WEEK_AHEAD_RESET)] })
  renderBody(sandbox)
  await flush(); await flush()
  const text = textOf(collect(renderBody(sandbox)))
  for (const label of ['BALANCE', 'TODAY', '7D', '30D']) {
    assert.ok(text.includes(label), `balance label ${label} must render`)
  }
  assert.ok(!text.includes('余额'), 'no Chinese balance label may remain')
})

test('whole-help legend moved to the settings panel; no hover tooltip on the meter container', async () => {
  const sandbox = buildSandbox({ responses: [quotaRowPayload(WEEK_AHEAD_RESET)] })
  renderBody(sandbox)
  await flush(); await flush()
  const nodes = collect(renderBody(sandbox))
  assert.ok(!nodes.some(node => node.type === 'details'), 'no details/summary legend may remain')
  assert.ok(!nodes.some(node => node.type === 'summary'), 'no summary may remain')

  // 容器不挂整体说明的 pointer 追踪 handlers。
  const body = renderBody(sandbox)
  assert.equal(body.props.onPointerEnter, undefined, 'whole-help hover entry must be gone from the container')
  assert.equal(body.props.onPointerMove, undefined, 'whole-help hover tracking must be gone from the container')
  assert.equal(body.props.onPointerLeave, undefined, 'whole-help hover hide must be gone from the container')
  assert.ok(!nodes.some(node => node.props?.['data-meter-tooltip']), 'tooltip subtree must be gone from the body')
  assert.ok(typeof sandbox.SubscriptionMeterTooltip !== 'function', 'whole-help tooltip component must be gone')
  assert.ok(typeof sandbox.placeTooltipRect !== 'function', 'rect placement helper must be gone')

  // weeklyCell 五色契约 spot checks: usedPercent=50 → first 42 cells quotaGone; 72 cells elapsed
  const sub = { usedPercent: 50, resetAt: WEEK_AHEAD_RESET }
  const gonePast = weeklyCellOf(sandbox, NOW, sub, 20)   // time passed + quota used
  assert.equal(gonePast.goneColor, COLORS_OF.track)
  assert.equal(gonePast.presentColor, COLORS_OF.orange)
  const futureFree = weeklyCellOf(sandbox, NOW, sub, 80) // future + quota unused, not locked
  assert.equal(futureFree.goneColor, COLORS_OF.blue)
  assert.equal(futureFree.presentColor, COLORS_OF.green)
  const pastFree = weeklyCellOf(sandbox, NOW, sub, 50)   // time passed + quota unused (saved)
  assert.equal(pastFree.goneColor, COLORS_OF.blue)
  assert.equal(pastFree.presentColor, COLORS_OF.green)
  // 锁定 future+unused → 剩余受限（深绿底/深绿fill）；锁定 past+unused → 富余受限（深蓝）。
  const lockedFuture = weeklyCellOf(sandbox, NOW, sub, 80, true)
  assert.equal(lockedFuture.goneColor, COLORS_OF.blueLocked)
  assert.equal(lockedFuture.presentColor, COLORS_OF.greenLocked)
  const lockedPast = weeklyCellOf(sandbox, NOW, sub, 50, true)
  assert.equal(lockedPast.goneColor, COLORS_OF.blueLocked)
  assert.equal(lockedPast.presentColor, COLORS_OF.greenLocked)
  // 超额（未流逝+已消耗）不分锁定：锁定位传入也不改橙色。
  const lockedGone = weeklyCellOf(sandbox, NOW, sub, 20, true)
  assert.equal(lockedGone.goneColor, COLORS_OF.track)
  assert.equal(lockedGone.presentColor, COLORS_OF.orange)
})

test('unknown quota keeps no surplus prediction anywhere in the tree', async () => {
  const sandbox = buildSandbox({
    responses: [() => ({ rows: [{ id: 'glm', providerId: 'glm', label: 'GLM', kind: 'quota', usedPercent: null, resetAt: WEEK_AHEAD_RESET }] })]
  })
  renderBody(sandbox)
  await flush(); await flush()
  const text = textOf(collect(renderBody(sandbox)))
  assert.ok(/unknown/i.test(text))
  assert.ok(!/\+\d+\.\d+ cells/.test(text), 'unknown quota must not render a surplus figure')
})

test('failed quota row keeps no surplus prediction', async () => {
  const sandbox = buildSandbox({
    responses: [() => ({ rows: [{ id: 'glm', providerId: 'glm', label: 'GLM', kind: 'quota', usedPercent: 10, resetAt: WEEK_AHEAD_RESET, error: 'raw provider failed' }] })]
  })
  renderBody(sandbox)
  await flush(); await flush()
  const text = textOf(collect(renderBody(sandbox)))
  assert.ok(text.includes('ERR'), 'failed row must visibly render the ERR marker')
  assert.ok(!/\+\d+\.\d+ cells/.test(text), 'failed rows must not render a surplus figure')
  assert.ok(!/−\d+\.\d+ cells/.test(text), 'failed rows must not render a deficit figure')
})

test('spend and balance amounts never change color with magnitude (neutral fixed tones)', async () => {
  const sandbox = buildSandbox({
    responses: [() => ({
      rows: [
        { id: 'deepseek', providerId: 'deepseek', label: 'DEEPSEEK', kind: 'balance', balance: 0.01, todaySpend: 9999, sevenDaySpend: 9999, thirtyDaySpend: 9999, currency: 'CNY' },
        { id: 'xai', providerId: 'xai', label: 'XAI', kind: 'balance', balance: 100000, currency: 'USD' }
      ]
    })]
  })
  renderBody(sandbox)
  await flush(); await flush()
  const nodes = collect(renderBody(sandbox))
  const colored = nodes.filter(node =>
    typeof node.props?.style?.color === 'string' &&
    textOf([node]).match(/^[$¥]/))
  assert.ok(colored.length >= 4, 'all money metrics must render')
  const neutral = 'var(--ui-text-quaternary)'
  for (const node of colored) {
    assert.equal(node.props.style.color, neutral, 'money values must use the fixed neutral theme color regardless of amount')
  }
  const dots = nodes.filter(node => node.props?.className?.includes('rounded-full'))
  for (const dot of dots) {
    assert.equal(dot.props.style.backgroundColor, neutral, 'balance row dots must be fixed neutral')
  }
})

test('settings save failure notifies a fixed safe message, never raw error text', async () => {
  const notifications = []
  const switchCalls = []
  const sandbox = buildSandbox({ responses: [() => ({})] })
  sandbox.host.notify = info => notifications.push(info)
  sandbox.Switch = props => { switchCalls.push(props); return null }
  const stableRest = async (path, options = {}) => (options.method || 'GET') === 'PUT'
    ? (() => { throw new Error('401 Unauthorized for Bearer FAKE_SECRET https://api.example.com') })()
    : { providers: [{ id: 'glm', label: 'GLM', kind: 'quota', enabled: true }] }
  assert.ok(typeof sandbox.ProviderSettingsPanel === 'function',
    'ProviderSettingsPanel must be exported by plugin.js')
  // First render: mounts the panel and triggers the async providers load.
  sandbox.__resetHooksState()
  collect(sandbox.ProviderSettingsPanel({ rest: stableRest }))
  await flush(); await flush()
  // Fresh hook state: the providers have loaded, so the Switch renders.
  sandbox.__resetHooksState()
  collect(sandbox.ProviderSettingsPanel({ rest: stableRest }))
  assert.ok(switchCalls.length, 'toggle switch must be rendered after providers load')
  switchCalls[0].onCheckedChange(false)
  await flush(); await flush()
  assert.ok(notifications.length, 'a failure notification must be emitted')
  const text = notifications.map(n => String(n.message)).join(' ')
  assert.ok(text.includes('[redacted]'), 'notification must use the fixed safe message')
  assert.ok(!text.includes('FAKE_SECRET'), 'raw error secrets must never leak')
  assert.ok(!text.includes('api.example.com'), 'raw error URLs must never leak')
  assert.ok(!text.includes('401 Unauthorized'), 'raw provider text must never leak')
})

test('legend explains cell duration uniformly (84 cells, 2 hours per cell)', async () => {
  // 说明原文在设置窗口「使用说明」分区，不挂 tooltip。
  const sandbox = buildSandbox({ responses: [quotaRowPayload(WEEK_AHEAD_RESET)] })
  sandbox.__resetHooksState()
  const nodes = collect(sandbox.ProviderSettingsPanel({ rest: sandbox.__ctxRest }))
  const panelText = textOf(nodes)
  assert.ok(panelText.includes('84 cells'), 'cell duration must reference the 84-cell matrix')
  assert.ok(panelText.includes('2 hours'), 'each cell must be called out as 2 hours')
  assert.ok(/provider/i.test(panelText), 'provider dot vs matrix color distinction must be present')
  // 原 10 条整体说明原文（与设置窗口「使用说明」分区一致）。
  const WHOLE_HELP_TEXTS = [
    '84 cells align quota with cycle time; each cell = window / 84 (a 7-day window = 2 hours).',
    'Green: remaining available quota',
    'Dark green: remaining quota locked by the 5h window',
    'Sky blue: surplus available quota',
    'Dark blue: surplus quota locked by the 5h window',
    'Orange: over-consumed quota',
    'The dot by a plan name distinguishes providers — not cell colors or balance status.',
    '"N% left" = remaining quota (not used). "Reset" = time until the next cycle.',
    '"Unknown —" = no quota percentage returned, so no surplus is shown.',
    '"ERR" = fixed safe message; "Refresh failed" keeps last good data, marked stale.'
  ]
  // 五色图例：设置说明里每条文字须配真实色值色块，一一对应。
  const SWATCH_CONTRACT = [
    [COLORS_OF.green, 'Green: remaining available quota'],
    [COLORS_OF.greenLocked, 'Dark green: remaining quota locked by the 5h window'],
    [COLORS_OF.blue, 'Sky blue: surplus available quota'],
    [COLORS_OF.blueLocked, 'Dark blue: surplus quota locked by the 5h window'],
    [COLORS_OF.orange, 'Orange: over-consumed quota']
  ]
  for (const [color, text] of SWATCH_CONTRACT) {
    const line = nodes.find(node =>
      node.type === 'span' &&
      textOf([node]).includes(text) &&
      node.props.children?.[0]?.props?.style?.backgroundColor === color)
    assert.ok(line, `help line 「${text}」 must render a swatch with the real color ${color}`)
  }
  // 原 10 条原文必须逐条完整出现。
  for (const line of WHOLE_HELP_TEXTS) {
    assert.ok(panelText.includes(line), `help text must be present verbatim: ${line}`)
  }
  // 说明区可滚动：maxHeight + overflowY auto，不挤坏设置窗口。
  const scrollBox = nodes.find(node =>
    node.type === 'div' && node.props.style?.overflowY === 'auto' && typeof node.props.style?.maxHeight === 'number')
  assert.ok(scrollBox, 'help section must be scrollable (maxHeight + overflowY auto)')
})

// 2026-09-09 Neal 定：5h 短窗行只参与排序取 min 与锁定段计算，不单独成行渲染。
test('5h sibling row feeds computation but never renders as its own row', async () => {
  const sandbox = buildSandbox({
    responses: [() => ({
      rows: [
        { id: 'kimi', providerId: 'kimi', label: 'KIMI', kind: 'quota', windowLabel: 'Weekly', windowSeconds: 7 * 86400, role: 'cycle', usedPercent: 20, resetAt: WEEK_AHEAD_RESET },
        { id: 'kimi:5h', providerId: 'kimi', label: 'KIMI', kind: 'quota', windowLabel: '5H', windowSeconds: 5 * 3600, role: 'burst', usedPercent: 50, resetAt: WEEK_AHEAD_RESET }
      ]
    })]
  })
  renderBody(sandbox)
  await flush(); await flush()
  const text = textOf(collect(renderBody(sandbox)))
  assert.ok(text.includes('KIMI'), 'weekly row must render')
  assert.ok(/80% left/.test(text), 'weekly remaining must render')
  assert.ok(!/\b5H\b/.test(text), '5h window must not render as its own row')
})

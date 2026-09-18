// Readability regression: real render tree (vm executes plugin.js) asserting
// English labels, surplus unit/meaning, no surplus on unknown/failed rows,
// and the mouse-following tooltip subtree replacing the old details legend.
// Reuses the whole-source transform approach of data-credibility.test.mjs;
// network is fully in-memory fakes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const rawSource = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')
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

test('legend is a mouse-following tooltip on the meter container, not a details row', async () => {
  const sandbox = buildSandbox({ responses: [quotaRowPayload(WEEK_AHEAD_RESET)] })
  renderBody(sandbox)
  await flush(); await flush()
  const nodes = collect(renderBody(sandbox))
  assert.ok(!nodes.some(node => node.type === 'details'), 'no details/summary legend may remain')
  assert.ok(!nodes.some(node => node.type === 'summary'), 'no summary may remain')

  // The meter body container must carry the pointer handlers for the tooltip.
  const body = renderBody(sandbox)
  assert.ok(typeof body.props.onPointerEnter === 'function', 'container must react to pointerenter')
  assert.ok(typeof body.props.onPointerMove === 'function', 'container must track pointermove')
  assert.ok(typeof body.props.onPointerLeave === 'function', 'container must hide the tooltip on pointerleave')

  // Tooltip component subtree exists in source and is hidden until hover.
  const tooltip = sandbox.SubscriptionMeterTooltip
  assert.ok(typeof tooltip === 'function', 'an independent tooltip component must exist')
  const hidden = collect(tooltip({ visible: false, x: 0, y: 0 }))
  assert.ok(!textOf(hidden), 'tooltip must render nothing while not visible')
  const shown = collect(tooltip({ visible: true, x: 40, y: 40, viewportWidth: 1000, viewportHeight: 800 }))
  const tipText = textOf(shown)
  assert.ok(tipText.includes('84 cells'), 'tooltip must explain the 84-cell matrix')
  assert.ok(tipText.includes('2 hours'), 'tooltip must state the weekly 2h cell duration')

  // Inline styles only (no runtime-compiled Tailwind) with real background.
  const tipNode = shown.find(node => node.props['data-meter-tooltip'])
  assert.ok(tipNode, 'tooltip root must carry data-meter-tooltip')
  const style = tipNode.props.style
  assert.equal(style.pointerEvents, 'none', 'tooltip must not intercept pointers')
  assert.equal(style.position, 'fixed', 'tooltip must be fixed-positioned')
  // 实底断言（2026-09-10 Neal 定「浮窗不要透明背景」）：--ui-bg-primary 实为
  // accent 16% + transparent 74% 的填充色（透字），App 浮层标准实底是 --ui-bg-elevated。
  assert.equal(style.backgroundColor, 'var(--ui-bg-elevated)', 'tooltip background must be the opaque elevated surface var (inline)')
  assert.ok(style.border && style.padding && style.boxShadow && style.zIndex, 'border/padding/shadow/zIndex must be inline styles')
  assert.ok(!tipNode.props.className, 'tooltip must not rely on new Tailwind classes')

  // 五色图例（2026-09-12 Neal 定）：一条一行，色值=截图取样；
  // 高峰不写进色块图例。
  const legendSwatches = [
    [COLORS_OF.green, 'Green: remaining available quota'],
    [COLORS_OF.greenLocked, 'Dark green: remaining quota locked by the 5h window'],
    [COLORS_OF.blue, 'Sky blue: surplus available quota'],
    [COLORS_OF.blueLocked, 'Dark blue: surplus quota locked by the 5h window'],
    [COLORS_OF.orange, 'Orange: over-consumed quota']
  ]
  for (const [color, text] of legendSwatches) {
    const swatch = shown.find(node =>
      node.props?.style?.backgroundColor === color && node.props['aria-hidden'])
    assert.ok(swatch, `tooltip must render a swatch with the real color ${color}`)
    assert.ok(tipText.includes(text), `tooltip legend must include 「${text}」`)
  }
  assert.ok(!tipText.includes('高峰') && !/peak/i.test(tipText),
    'peak must not appear in the color-block legend')
  assert.ok(/Remaining/i.test(tipText), 'tooltip must explain remaining%')
  assert.ok(/Reset/i.test(tipText), 'tooltip must explain the reset countdown')
  assert.ok(/surplus/i.test(tipText), 'tooltip must explain surplus sign')
  assert.ok(/Unknown/i.test(tipText), 'tooltip must explain the unknown marker')
  assert.ok(tipText.includes('ERR'), 'tooltip must explain the error marker')

  // Rect-based placement: the whole box (not just the pointer) stays inside
  // the viewport, offset +16 from the pointer, flipping left/up at edges.
  const place = sandbox.placeTooltipRect
  assert.ok(typeof place === 'function', 'rect placement helper must exist')

  // Parent agent's browser edge cases: 600/1000/360-wide, 500-tall viewports,
  // pointer near the bottom-right (width-5, 295) → the rect must fit fully.
  for (const [vw, vh, px, py] of [[600, 500, 595, 295], [1000, 500, 995, 295], [360, 500, 355, 295], [360, 500, 10, 10]]) {
    const r = place(px, py, 288, 200, vw, vh)
    assert.ok(r.left >= 12, `left must keep 12px margin (vw=${vw})`)
    assert.ok(r.left + r.maxWidth <= vw - 12, `right edge must fit (vw=${vw})`)
    assert.ok(r.top >= 12, `top must keep 12px margin (vw=${vw})`)
    assert.ok(r.top + r.maxHeight <= vh - 12, `bottom edge must fit (vw=${vw})`)
    assert.ok(r.maxWidth <= Math.min(288, vw - 24), `width must be min(288, viewport-24) (vw=${vw})`)
  }
  // Pointer offset when there is room.
  const open = place(10, 10, 288, 200, 1000, 800)
  assert.equal(open.left, 26, 'tooltip sits 16px right of the pointer when room allows')
  assert.equal(open.top, 26, 'tooltip sits 16px below the pointer when room allows')
  assert.ok(typeof style.maxWidth === 'number', 'tooltip must cap its width for narrow windows')

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
  const sandbox = buildSandbox({
    responses: [() => ({
      rows: [
        { id: 'codex:session', providerId: 'codex', label: 'CODEX', kind: 'quota', windowLabel: 'Session', windowSeconds: 5 * 60 * 60, role: 'burst', usedPercent: 20, resetAt: WEEK_AHEAD_RESET },
        { id: 'glm', providerId: 'glm', label: 'GLM', kind: 'quota', usedPercent: 10, resetAt: WEEK_AHEAD_RESET }
      ]
    })]
  })
  renderBody(sandbox)
  await flush(); await flush()
  const tooltip = sandbox.SubscriptionMeterTooltip
  const tipText = textOf(collect(tooltip({ visible: true, x: 10, y: 10, viewportWidth: 1000, viewportHeight: 800 })))
  assert.ok(tipText.includes('84 cells'), 'cell duration must reference the 84-cell matrix')
  assert.ok(tipText.includes('2 hours'), 'each cell must be called out as 2 hours')
  assert.ok(/provider/i.test(tipText), 'provider dot vs matrix color distinction must be present')
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

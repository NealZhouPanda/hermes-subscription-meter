// 数据可信度行为测试（TDD 先行）：
// 1) null/0 区分：缺失值保持 null（显示 —），真实零保持 0；
// 2) 刷新成功-失败-恢复：旧数据明确标注、错误不泄漏秘密、恢复后清除过期错误；
// 3) 当前 profile 请求失败禁止跨 profile 自动重试（GET/PUT）。
// 通过整体源码变换（去掉 import、export）在 vm 沙箱里执行真实 plugin.js 逻辑，
// 网络/配置完全用内存假件，不触碰真实接口与 profile。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const rawSource = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

function buildSandbox({ responses = [], crossProfileApi = null } = {}) {
  const ctxCalls = []
  const apiCalls = []
  const intervals = new Map()
  let intervalSeq = 0
  let responseIndex = 0

  const nextResponse = () => {
    const spec = responses[Math.min(responseIndex, responses.length - 1)]
    responseIndex += 1
    return spec()
  }

  const sandbox = {
    console,
    // 记录型 window：跨 profile 桥接 spy（若被调用即记录并抛错）
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
    setInterval: (fn, ms) => { const id = ++intervalSeq; intervals.set(id, fn); return id },
    clearInterval: id => { intervals.delete(id) },
    __intervals: intervals,
    __apiCalls: apiCalls,
    __ctxCalls: ctxCalls,
    __ctxRest: async (path, options = {}) => {
      ctxCalls.push({ path, method: options.method || 'GET', body: options.body })
      return nextResponse()
    }
  }
  // React-lite hooks：跨多次渲染共享 state 单元；useEffect 仅在 deps 变化时重跑（与 React 一致）。
  const hookCells = []
  const hookDeps = []
  const cleanups = []
  let hookIndex = 0
  sandbox.useState = initial => {
    const i = hookIndex++
    if (!(i in hookCells)) hookCells[i] = { value: typeof initial === 'function' ? initial() : initial }
    const cell = hookCells[i]
    // 与 React 一致：解构出的 state 是值本身；单元仅由 setter 闭包持有，跨渲染保持状态。
    return [cell.value, v => { cell.value = typeof v === 'function' ? v(cell.value) : v }]
  }
  sandbox.useEffect = (fn, deps) => {
    const i = hookIndex++
    const prev = hookDeps[i]
    const changed = !prev || !deps || deps.length !== prev.length || deps.some((d, j) => d !== prev[j])
    if (!changed) return
    const cleanup = fn()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
    hookDeps[i] = deps ? [...deps] : undefined
  }
  sandbox.useMemo = (fn, deps) => fn()
  sandbox.useLayoutEffect = () => {}
  // useCallback/useRef 与 React 一致：按 hook 序号持久化（否则每次渲染都是新函数/新对象，
  // 会让 [load] 依赖每次都"变化"，effect 被重跑到请求序列错位）。
  const callbackCells = []
  const refCells = []
  sandbox.useCallback = (fn, deps) => {
    const i = hookIndex++
    const cell = callbackCells[i]
    const changed = !cell || !deps || !cell.deps || deps.length !== cell.deps.length || deps.some((d, j) => d !== cell.deps[j])
    if (changed) callbackCells[i] = { deps: deps ? [...deps] : undefined, fn }
    return callbackCells[i].fn
  }
  sandbox.useRef = initial => {
    const i = hookIndex++
    if (!(i in refCells)) refCells[i] = { current: initial }
    return refCells[i]
  }
  // 独立 atom（host.state.profile 的替身）：subscribe 不需要，get 即可。
  sandbox.useValue = atom => (atom && typeof atom.get === 'function' ? atom.get() : null)
  sandbox.__resetHooks = () => { hookIndex = 0 }
  sandbox.__cleanups = cleanups
  sandbox.__cells = hookCells
  if (crossProfileApi) sandbox.window.hermesDesktop = { api: crossProfileApi(apiCalls) }

  const source = rawSource
    .replace(/^import\s.*$/gm, '')
    .replace('export default', 'globalThis.__pluginDefault =')
  vm.runInNewContext(`${source}\n`, sandbox, { filename: 'plugin.js' })
  return { sandbox, ctxCalls, apiCalls, intervals }
}

const flush = () => new Promise(resolve => setImmediate(resolve))

function collectText(node, out = [], depth = 0) {
  if (node === null || node === undefined || node === true || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) collectText(child, out, depth); return out }
  if (typeof node === 'object' && node.props) {
    // 悬浮说明 tooltip 是固定的说明文案（非数据行），数据可信度断言只针对数据区，
    // 跳过 tooltip 子树以免「Refresh failed/Unknown —」等解释词触发数据行误报。
    if (node.props['data-meter-tooltip']) return out
    if (typeof node.type === 'function' && depth < 8) {
      // 同步函数组件：以 props 调用得到渲染结果（如 WeeklyQuotaRow / BalanceSpendRow）
      const text = collectText(node.type(node.props), out, depth + 1)
      if (node.type.name === 'WeeklyQuotaRow' && node.props.subscription) {
        const sub = node.props.subscription
        out.push(sub.usedPercent === null || sub.usedPercent === undefined ? 'Q:unknown' : `Q:${sub.usedPercent}`)
      }
      return out
    }
    collectText(node.props.children, out, depth)
    if (typeof node.props.title === 'string') out.push(node.props.title)
  }
  return out
}

const renderedText = element => collectText(element).join(' ')

// ---------------------------------------------------------------------------
// 1. normalizeRow：缺失值保持 null，真实零保持 0
// ---------------------------------------------------------------------------

function extract(name) {
  const source = rawSource.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0]
  assert.ok(source, `${name} must exist in plugin.js`)
  return source
}

const normalizeList = ['clamp', 'toEpochMillis', 'numericOrNull', 'sanitizeRowError', 'normalizeBurstShare', 'normalizePeakHours', 'normalizeRow']
const normalizeSandbox = {}
vm.runInNewContext(
  `${normalizeList.map(extract).join('\n')}\n` +
  'globalThis.__out = ({ normalizeRow })',
  normalizeSandbox
)
const { normalizeRow } = normalizeSandbox.__out

test('normalizeRow keeps missing spend values as null, not zero', () => {
  const row = normalizeRow({
    id: 'xai', providerId: 'xai', label: 'XAI', kind: 'balance',
    balance: 19.74, currency: 'USD'
  })
  assert.equal(row.balance, 19.74)
  assert.equal(row.todaySpend, null)
  assert.equal(row.sevenDaySpend, null)
  assert.equal(row.thirtyDaySpend, null)
})

test('normalizeRow keeps explicit null spend values as null', () => {
  const row = normalizeRow({
    id: 'nous', providerId: 'nous', label: 'NOUS', kind: 'balance',
    balance: 4.11, todaySpend: null, sevenDaySpend: null, thirtyDaySpend: null
  })
  assert.equal(row.todaySpend, null)
  assert.equal(row.sevenDaySpend, null)
  assert.equal(row.thirtyDaySpend, null)
})

test('provider error rows are marked as errors, never rendered as fresh values', async () => {
  const { sandbox } = buildSandbox({ responses: [failWithSecretRow] })
  const { SubscriptionMeterBody } = sandbox
  const render = () => {
    sandbox.__resetHooks()
    return SubscriptionMeterBody({ rest: sandbox.__ctxRest })
  }
  render()
  await flush(); await flush()
  const text = renderedText(render())
  assert.ok(text.includes('ERR'), 'a provider error row must be marked as an error')
})

test('unknown quota renders a dash, never a fake 100% remaining', async () => {
  const { sandbox } = buildSandbox({
    responses: [() => ({ rows: [{ id: 'glm', providerId: 'glm', label: 'GLM', kind: 'quota', usedPercent: null, resetAt: 1893456000 }] })]
  })
  const { SubscriptionMeterBody } = sandbox
  const render = () => {
    sandbox.__resetHooks()
    return SubscriptionMeterBody({ rest: sandbox.__ctxRest })
  }
  render()
  await flush(); await flush()
  const text = renderedText(render())
  assert.ok(text.includes('—'), 'unknown quota must display a dash')
  assert.ok(!text.includes('%'), 'unknown quota must not render any percentage claim')
})

test('real zero quota still renders its true remaining percentage', async () => {
  const { sandbox } = buildSandbox({
    responses: [() => ({ rows: [{ id: 'glm', providerId: 'glm', label: 'GLM', kind: 'quota', usedPercent: 0, resetAt: 1893456000 }] })]
  })
  const { SubscriptionMeterBody } = sandbox
  const render = () => {
    sandbox.__resetHooks()
    return SubscriptionMeterBody({ rest: sandbox.__ctxRest })
  }
  render()
  await flush(); await flush()
  const text = renderedText(render())
  assert.ok(text.includes('100%'), 'real zero usage still truthfully shows 100% remaining')
})

test('normalizeRow keeps real zeros and no longer computes tone fields', () => {
  const row = normalizeRow({
    id: 'deepseek', providerId: 'deepseek', label: 'DEEPSEEK', kind: 'balance',
    balance: 12.34, todaySpend: 0, sevenDaySpend: 0, thirtyDaySpend: 0
  })
  assert.equal(row.todaySpend, 0)
  assert.equal(row.sevenDaySpend, 0)
  assert.equal(row.thirtyDaySpend, 0)
  assert.equal(row.todayTone, undefined)
  assert.equal(row.balanceTone, undefined)
})

test('normalizeRow keeps usedPercent null when the backend omits it', () => {
  const row = normalizeRow({ id: 'glm', providerId: 'glm', label: 'GLM', kind: 'quota' })
  assert.equal(row.usedPercent, null)
})

test('quotaCellCount still treats real numbers exactly as before', () => {
  const { quotaCellCount } = vm.runInNewContext(
    `const CELL_COUNT = 84\n${extract('clamp')}\n${extract('quotaCellCount')}\n({ quotaCellCount })`, {}
  )
  assert.equal(quotaCellCount(0), 0)
  assert.equal(quotaCellCount(50), 42)
})

// ---------------------------------------------------------------------------
// 2. 刷新成功-失败-恢复（真实 SubscriptionMeterBody + 模拟请求时序）
// ---------------------------------------------------------------------------

const okRows = () => ({
  rows: [
    { id: 'glm', providerId: 'glm', label: 'GLM', kind: 'quota', usedPercent: 10, resetAt: 1893456000 },
    { id: 'deepseek', providerId: 'deepseek', label: 'DEEPSEEK', kind: 'balance', balance: 12.34, todaySpend: 0, sevenDaySpend: 0, thirtyDaySpend: 0, currency: 'CNY' }
  ]
})
const fail = () => { throw new Error('HTTP 502 for Bearer sk-secret-abc123 ?token=zzz') }
const failWithSecretRow = () => ({
  rows: [
    { id: 'glm', providerId: 'glm', label: 'GLM', kind: 'quota', usedPercent: 10, resetAt: 1893456000, error: 'raw provider said Bearer sk-secret-abc123' }
  ]
})

test('refresh failure keeps last good rows, marks stale, hides raw errors; recovery clears the error', async () => {
  const { sandbox } = buildSandbox({ responses: [okRows, fail, fail, okRows] })
  const { SubscriptionMeterBody } = sandbox
  assert.ok(typeof SubscriptionMeterBody === 'function', 'SubscriptionMeterBody must be reachable')
  const render = () => {
    sandbox.__resetHooks()
    return SubscriptionMeterBody({ rest: sandbox.__ctxRest })
  }

  // 渲染 #1：挂载 effect 触发首次成功请求
  render()
  await flush(); await flush()
  const goodEl = render()
  const goodText = renderedText(goodEl)
  assert.ok(!goodText.includes('Refresh failed'), 'fresh data must not be marked stale')
  assert.ok(goodText.includes('DEEPSEEK'))

  // 刷新 #1：失败 → 错误状态 + 旧数据保留 + 过期标注 + 固定安全文案（不透传 error.message）
  sandbox.__intervals.forEach(fn => fn()) // 触发注册的刷新回调（第二次请求 = fail）
  await flush(); await flush()
  const staleText = renderedText(render())
  assert.ok(staleText.includes('DEEPSEEK'), 'last successful rows must remain visible')
  assert.ok(staleText.includes('Refresh failed'), 'first failure must surface an error state')
  assert.ok(staleText.includes('as of'), 'stale banner must state the last success time')
  assert.ok(!staleText.includes('HTTP 502'), 'raw error message must never appear in the banner')
  assert.ok(!staleText.includes('sk-secret-abc123'), 'raw error secrets must not be rendered')
  assert.ok(!staleText.includes('?token=zzz'), 'raw query secrets must not be rendered')

  // 刷新 #2：再次失败 → 依旧过期，不假装新鲜
  sandbox.__intervals.forEach(fn => fn())
  await flush(); await flush()
  const stale2Text = renderedText(render())
  assert.ok(stale2Text.includes('Refresh failed'))

  // 刷新 #3：恢复成功 → 清除失败/过期状态
  sandbox.__intervals.forEach(fn => fn())
  await flush(); await flush()
  const recovered = renderedText(render())
  assert.ok(!recovered.includes('Refresh failed'), 'recovery must clear the stale failure state')
  assert.ok(!recovered.includes('stale'))
})

test('numericOrNull rejects junk that Number() would coerce to zero', () => {
  // false / '' / 空白串 / 数组 一律未知（null），不得塌缩成 0
  const row = normalizeRow({
    id: 'x', providerId: 'x', label: 'X', kind: 'balance',
    balance: false, todaySpend: '', sevenDaySpend: '  ', thirtyDaySpend: [7]
  })
  assert.equal(row.balance, null)
  assert.equal(row.todaySpend, null)
  assert.equal(row.sevenDaySpend, null)
  assert.equal(row.thirtyDaySpend, null)
})

test('numericOrNull keeps numeric strings and real zeros', () => {
  const row = normalizeRow({
    id: 'x', providerId: 'x', label: 'X', kind: 'balance',
    balance: '12.5', todaySpend: '0', sevenDaySpend: 0, thirtyDaySpend: Infinity
  })
  assert.equal(row.balance, 12.5)
  assert.equal(row.todaySpend, 0)
  assert.equal(row.sevenDaySpend, 0)
  assert.equal(row.thirtyDaySpend, null)
})

test('rows with junk numeric fields never render as 0.00', async () => {
  const { sandbox } = buildSandbox({
    responses: [() => ({
      rows: [{
        id: 'deepseek', providerId: 'deepseek', label: 'DEEPSEEK', kind: 'balance',
        balance: 12.34, todaySpend: false, sevenDaySpend: '', thirtyDaySpend: [], currency: 'CNY'
      }]
    })]
  })
  const { SubscriptionMeterBody } = sandbox
  const render = () => {
    sandbox.__resetHooks()
    return SubscriptionMeterBody({ rest: sandbox.__ctxRest })
  }
  render()
  await flush(); await flush()
  const text = renderedText(render())
  assert.ok(text.includes('—'), 'junk values must render as unknown (—)')
  assert.ok(!text.includes('0.00'), 'junk values must never render as zero money')
})

test('provider row errors render a fixed safe message, never the raw text', async () => {
  const { sandbox } = buildSandbox({
    responses: [() => ({
      rows: [{ id: 'glm', providerId: 'glm', label: 'GLM', kind: 'quota', usedPercent: 10, resetAt: 1893456000, error: 'password=SYNTHETIC_PRIVATE_VALUE_123 at https://api.example.com/v1' }]
    })]
  })
  const { SubscriptionMeterBody } = sandbox
  const render = () => {
    sandbox.__resetHooks()
    return SubscriptionMeterBody({ rest: sandbox.__ctxRest })
  }
  render()
  await flush(); await flush()
  const text = renderedText(render())
  assert.ok(text.includes('ERR'), 'error rows keep the ERR marker')
  assert.ok(!text.includes('SYNTHETIC_PRIVATE_VALUE_123'), 'raw secrets must never be rendered')
  assert.ok(!text.includes('api.example.com'), 'raw URLs must never be rendered')
})

test('provider rows carrying an error never leak embedded secrets in rendered text', async () => {
  const { sandbox } = buildSandbox({ responses: [failWithSecretRow] })
  const { SubscriptionMeterBody } = sandbox
  const render = () => {
    sandbox.__resetHooks()
    return SubscriptionMeterBody({ rest: sandbox.__ctxRest })
  }
  render()
  await flush(); await flush()
  const text = renderedText(render())
  assert.ok(!text.includes('sk-secret-abc123'), 'row errors must be sanitized before display')
})

// ---------------------------------------------------------------------------
// 3. 当前 profile 失败 → 禁止跨 profile 自动重试（GET/PUT）
// ---------------------------------------------------------------------------

test('rest wrapper never retries on the default profile after a current-profile failure (GET and PUT)', async () => {
  const { sandbox, apiCalls } = buildSandbox({
    responses: [() => { throw new Error('backend down') }],
    crossProfileApi: calls => opts => {
      calls.push(opts)
      throw new Error('default unreachable')
    }
  })
  const registered = []
  const currentProfileCalls = []
  const fakeCtx = {
    registerMany: entries => { registered.push(...entries); return entries },
    rest: async (path, options = {}) => {
      currentProfileCalls.push({ path, method: options.method || 'GET', body: options.body })
      throw new Error('backend down')
    }
  }
  sandbox.__pluginDefault.register(fakeCtx)

  const pane = registered.find(entry => entry.id === 'bottom')
  const rest = pane.render().props.rest
  assert.equal(typeof rest, 'function', 'pane render must receive the rest wrapper')

  await assert.rejects(rest('/data'), /backend down/)
  await assert.rejects(
    rest('/settings/grok', { method: 'PUT', body: { enabled: false } }),
    /backend down/
  )

  assert.equal(apiCalls.length, 0, 'a failed current-profile request must not fall back to the default profile')
  assert.equal(currentProfileCalls.filter(call => call.method === 'PUT').length, 1, 'a failed PUT must not be retried as anything else')
  assert.equal(currentProfileCalls.filter(call => call.method === 'GET').length, 1, 'a failed GET must not be retried')
})

test('current-profile success path stays on the current profile', async () => {
  const { sandbox, ctxCalls, apiCalls } = buildSandbox({
    responses: [okRows],
    crossProfileApi: calls => opts => { calls.push(opts); throw new Error('must not be used') }
  })
  const registered = []
  const fakeCtx = { registerMany: entries => { registered.push(...entries); return entries }, rest: sandbox.__ctxRest }
  sandbox.__pluginDefault.register(fakeCtx)
  const rest = registered.find(entry => entry.id === 'bottom').render().props.rest

  const payload = await rest('/data')
  assert.ok(Array.isArray(payload.rows))
  assert.equal(ctxCalls.length, 1)
  assert.equal(apiCalls.length, 0)
})

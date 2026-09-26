// 插件整体说明展示在设置窗口（ProviderSettingsPanel）的 "Legend & notes" 分区，
// 原文完整不改写；看板容器不再挂鼠标跟随整体说明。
// 标题必须是英文：CONTRIBUTING 要求面板里每一个用户可见字符串都是英文。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const rawSource = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

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
    Date,
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
  sandbox.useEffect = () => {}
  sandbox.__resetHooksState = () => { hookIndex = 0 }
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

// 整体说明的每一条原文（与 SubscriptionMeterTooltip 中现有文字一一对应，五色图例按条计）。
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

const providersPayload = () => ({
  providers: [{ id: 'glm', label: 'GLM', kind: 'quota', enabled: true }]
})

test('settings panel contains the Legend & notes section with the full original help text', async () => {
  const sandbox = buildSandbox({ responses: [providersPayload] })
  sandbox.__resetHooksState()
  collect(sandbox.ProviderSettingsPanel({ rest: sandbox.__ctxRest }))
  await new Promise(resolve => setImmediate(resolve))
  sandbox.__resetHooksState()
  const text = textOf(collect(sandbox.ProviderSettingsPanel({ rest: sandbox.__ctxRest })))
  assert.ok(text.includes('Legend & notes'), 'settings panel must contain the help section title')
  for (const line of WHOLE_HELP_TEXTS) {
    assert.ok(text.includes(line), `help text must be migrated verbatim: ${line}`)
  }
})

test('面板里没有中文用户可见字符串（CONTRIBUTING：每个可见字符串必须英文）', () => {
  // 注释（含设计说明）允许中文；用户可见字符串不允许。命令别名允许中英并列，
  // 那是搜索用的附加别名，不是界面文案。
  const withoutBlocks = rawSource.replace(/\/\*[\s\S]*?\*\//g, '')
  const withoutComments = withoutBlocks.replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const offenders = withoutComments
    .split('\n')
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(item => /[\u4e00-\u9fff]/.test(item.line))
    .filter(item => !item.line.includes('keywords:'))
  assert.deepEqual(offenders, [], `这些行还有中文界面文案：${JSON.stringify(offenders)}`)
})

test('meter body no longer renders the mouse-following whole-help tooltip', () => {
  const sandbox = buildSandbox({ responses: [providersPayload] })
  // 容器不再挂整体说明的 pointer 追踪 handlers。
  const body = sandbox.SubscriptionMeterBody({ rest: sandbox.__ctxRest })
  assert.equal(body.props.onPointerEnter, undefined, 'whole-help hover entry must be removed')
  assert.equal(body.props.onPointerMove, undefined, 'whole-help hover tracking must be removed')
  assert.equal(body.props.onPointerLeave, undefined, 'whole-help hover hide must be removed')
  // 整体说明不再作为 body 子树渲染。
  const nodes = collect(body)
  assert.ok(!nodes.some(node => node.props?.['data-meter-tooltip']), 'tooltip subtree must be removed from the body')
  assert.ok(typeof sandbox.SubscriptionMeterTooltip !== 'function', 'whole-help tooltip component must be gone')
})

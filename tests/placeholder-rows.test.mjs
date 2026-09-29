// 通用「已识别无适配器」占位机制（2026-09-29 Neal 定）+ 存量需求①②的前端契约。
//
// 改动一：后端对识别成功但没有取数适配器的 provider（如内置 xiaomi/MiMo）下发
// gap=no_fetcher 的占位行——有名字、无数值（金额/百分比一律不造）、落「数据缺失」档。
// 前端不认供应商名，行上缺事实必须带原因码，禁止静默少画。
// 改动二（2026-09-29 当日 Neal 看板实测纠正）：余额行圆点 + BALANCE 金额用该供应方的
// accent（与订阅行圆点同源同色）；BALANCE_VALUE_COLORS 只是无 accent 时的兜底紫。
// 改动三：余额 0 / 触顶 / 主窗用尽 / 短窗用满 → 整行灰（判据 = availabilityOf 唯一真源）。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const pluginSource = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

function extract(name) {
  const fn = pluginSource.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))
  if (fn) return fn[0]
  const constant = pluginSource.match(new RegExp(`^const ${name} = .*\\n`, 'm'))
  assert.ok(constant, `${name} must exist in plugin.js`)
  return constant[0]
}

// 纯函数沙箱：占位判定 / 可用性 / 余额兜底色（不含 React）。
const PURE = [
  'isPlaceholderRow', 'availabilityOf', 'normalizeRow', 'numericOrNull', 'toEpochMillis',
  'clamp', 'sanitizeRowError', 'normalizeBurstShare', 'normalizePeakHours',
  'balanceValueColor', 'isHighContrast'
]
const pureSandbox = new Function(
  [
    "const HIGH_CONTRAST_MODE = 'high-contrast'",
    extract('BALANCE_VALUE_COLORS'),
    extract('UNAVAILABLE_GRAY'),
    ...PURE.map(extract)
  ].join('\n\n') + `; return { ${PURE.join(', ')} }`
)()

const NOW = Date.parse('2026-09-29T12:00:00+08:00')

test('余额兜底色按配色模式取色，两色字节锁死（无 accent 才兜底，唯一入口 balanceValueColor）', () => {
  assert.equal(pureSandbox.balanceValueColor('default'), '#8820e8')
  assert.equal(pureSandbox.balanceValueColor('high-contrast'), '#d75cd7')
  assert.match(pluginSource, /const BALANCE_VALUE_COLORS = \{ default: '#8820e8', \[HIGH_CONTRAST_MODE\]: '#d75cd7' \}/)
  assert.match(pluginSource, /const UNAVAILABLE_GRAY = '#404040'/)
})

test('BalanceSpendRow 的 accent 链：供应方 accent 优先，无 accent 落兜底紫，failed/grayed 不变', () => {
  // 源码断言：紫必须是「该供应方 accent（按当前主题取）」之后的兜底（语义位降级，
  // 不再是无条件主色）；2026-09-29 起取色统一走 accentFor（亮/暗各一套）。
  assert.match(
    pluginSource,
    /grayed \? UNAVAILABLE_GRAY : \(accentFor\(subscription\) \|\| balanceValueColor\(colorMode\)\)/,
    'accent 链必须形如 failed→danger / grayed→灰 / accentFor→balanceValueColor 兜底')
  assert.ok(
    !/grayed \? UNAVAILABLE_GRAY : balanceValueColor\(colorMode\)/.test(pluginSource),
    '旧链（紫当无 Condition 主色）必须删干净')
  // 行为断言：同一渲染路径，有 accent 的可用余额行圆点 = 供应方 accent。
  const dot = renderBalanceRow({ accent: '#6366F1', balance: 5 })
    .find(node => node.props?.className?.includes('rounded-full'))
  assert.equal(dot.props.style.backgroundColor, '#6366F1', '有 accent 的余额行圆点 = 供应方 accent')
})
test('BalanceSpendRow：无 accent 落兜底紫（按配色模式），failed / 灰化优先级不变', () => {
  const dotOf = nodes => nodes.find(node => node.props?.className?.includes('rounded-full'))
  // 无 accent → 兜底紫（default 模式）
  const fallbackDot = dotOf(renderBalanceRow({ balance: 5 }))
  assert.equal(fallbackDot.props.style.backgroundColor, '#8820e8', '无 accent 的余额行圆点落兜底紫')
  // failed 优先：error 行圆点仍红（不因 accent 变化被抢）
  const failedDot = dotOf(renderBalanceRow({ balance: 5, error: 'boom' }))
  assert.equal(failedDot.props.style.backgroundColor, 'var(--ui-danger, #f87171)', 'failed 优先级最高')
  // grayed 优先：余额 0 的行圆点仍不可用灰
  const grayedDot = dotOf(renderBalanceRow({ balance: 0, accent: '#6366F1' }))
  assert.equal(grayedDot.props.style.backgroundColor, '#404040', 'grayed 优先于 accent')
})

test('占位判定只认 kind=quota 且 gap=no_fetcher', () => {
  assert.equal(pureSandbox.isPlaceholderRow({ kind: 'quota', gap: 'no_fetcher' }), true)
  assert.equal(pureSandbox.isPlaceholderRow({ kind: 'quota', gap: 'no_window' }), false)
  assert.equal(pureSandbox.isPlaceholderRow({ kind: 'quota', gap: null }), false)
  assert.equal(pureSandbox.isPlaceholderRow({ kind: 'balance', gap: 'no_fetcher' }), false)
  assert.equal(pureSandbox.isPlaceholderRow(null), false)
})

test('normalizeRow 透传连接态 status；脏值降级为 null', () => {
  assert.equal(pureSandbox.normalizeRow({ id: 'x', label: 'X', status: 'no_fetcher' }).status, 'no_fetcher')
  assert.equal(pureSandbox.normalizeRow({ id: 'x', label: 'X', status: '  ok  ' }).status, 'ok')
  assert.equal(pureSandbox.normalizeRow({ id: 'x', label: 'X', status: '' }).status, null)
  assert.equal(pureSandbox.normalizeRow({ id: 'x', label: 'X' }).status, null)
  assert.equal(pureSandbox.normalizeRow({ id: 'x', label: 'X', status: 42 }).status, null)
})

test('availabilityOf 余额行新臂：余额 0 / 触顶（accent=cap）/ 失败 → 不可用；未知余额不冤枉', () => {
  const balance = extra => ({ kind: 'balance', ...extra })
  assert.equal(pureSandbox.availabilityOf(balance({ balance: 0 }), null).available, false, '余额 0 = 用不了')
  assert.equal(pureSandbox.availabilityOf(balance({ balance: 5 }), null).available, true)
  assert.equal(pureSandbox.availabilityOf(balance({ balance: 5, accent: 'cap' }), null).available, false, '触顶 = 用不了')
  assert.equal(pureSandbox.availabilityOf(balance({ balance: 0.5, accent: 'low' }), null).available, true, '偏低不是不可用')
  assert.equal(pureSandbox.availabilityOf(balance({ balance: null }), null).available, true, '余额未知 ≠ 用不了')
  assert.equal(pureSandbox.availabilityOf(balance({ error: 'x' }), null).available, false, '失败行维持不可用')
})

test('availabilityOf：余额行没有 unlockAt 语义（恒 Infinity，不参与排序时间）', () => {
  assert.equal(pureSandbox.availabilityOf({ kind: 'balance', balance: 0 }, null).unlockAt, Infinity)
})

test('availabilityOf：quota 判据回归不变（主窗用尽 / 短窗用满 → 不可用）', () => {
  const cycle = { kind: 'quota', usedPercent: 50, resetAt: NOW + 3600e3, windowSeconds: 604800 }
  const full = { kind: 'quota', usedPercent: 100, resetAt: NOW + 3600e3, windowSeconds: 604800 }
  const burst = usedPercent => ({ kind: 'quota', role: 'burst', usedPercent, resetAt: NOW + 3600e3, windowSeconds: 18000 })
  assert.equal(pureSandbox.availabilityOf(cycle, null).available, true)
  assert.equal(pureSandbox.availabilityOf(full, null).available, false, '主窗用尽')
  assert.equal(pureSandbox.availabilityOf(cycle, burst(100)).available, false, '短窗用满')
  assert.equal(pureSandbox.availabilityOf(cycle, burst(50)).available, true)
})

// --- 完整源沙箱：占位行真的这样渲染（React 桩与 whole-help 同款）-------------
function buildSandbox() {
  const sandbox = {
    console,
    window: { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true },
    host: { notify: () => {}, navigate: () => {}, state: { profile: { get: () => 'default' } } },
    Switch: () => null,
    PALETTE_AREA: 'palette', ROUTES_AREA: 'routes', SIDEBAR_NAV_AREA: 'sidebarNav',
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
    setInterval: () => 0, clearInterval: () => {}, Date
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
  sandbox.useMemo = fn => fn()
  sandbox.useRef = initial => ({ current: initial })
  sandbox.useLayoutEffect = () => {}
  sandbox.useCallback = fn => fn
  sandbox.useValue = atom => (atom && typeof atom.get === 'function' ? atom.get() : null)
  const source = pluginSource.replace(/^import\s.*$/gm, '').replace('export default', 'globalThis.__pluginDefault =')
  vm.runInNewContext(`${source}\n`, sandbox, { filename: 'plugin.js' })
  sandbox.__resetHooksState = () => { hookIndex = 0 }
  return sandbox
}

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

function renderPlaceholderRow() {
  const sandbox = buildSandbox()
  sandbox.__resetHooksState()
  const raw = { id: 'xiaomi', providerId: 'xiaomi', label: 'XIAOMI', kind: 'quota', status: 'no_fetcher', gap: 'no_fetcher' }
  const subscription = sandbox.normalizeRow(raw)
  return { sandbox, nodes: collect(sandbox.WeeklyQuotaRow({ subscription, now: NOW, quotaPool: [] })) }
}

// 余额行渲染助手：造一行 balance 行 → normalizeRow → BalanceSpendRow → 展平节点。
// colorMode 省略 = 'default'（兜底紫口径的两色钉各自显式传）。
function renderBalanceRow(extra, colorMode = 'default') {
  const sandbox = buildSandbox()
  sandbox.__resetHooksState()
  const subscription = sandbox.normalizeRow({ id: 'b', providerId: 'b', label: 'BALPROV', kind: 'balance', ...extra })
  return collect(sandbox.BalanceSpendRow({ subscription, now: NOW, colorMode }))
}

test('占位行渲染：有名字、无数值、无矩阵，缺格有说法（不静默少画）', () => {
  const { nodes } = renderPlaceholderRow()
  const text = textOf(nodes)
  assert.ok(text.includes('XIAOMI'), '名字必须在')
  assert.ok(text.includes('Unknown —'), '配额格必须写 Unknown —（不造百分比）')
  assert.ok(text.includes('Reset —'), '倒计时只留窗口词加占位符（不造时刻）')
  assert.ok(!nodes.some(node => node.props?.['data-meter-cell']), '占位行不画 84 格矩阵')
  assert.ok(!nodes.some(node => /^[$¥]/.test(textOf([node]))), '占位行不造任何金额')
  assert.ok(!text.includes('No fetcher adapter yet'), 'quota 行的提示放格子 title，不占格子文字')
  const quotaCell = nodes.find(node => textOf([node]) === 'Unknown —')
  assert.ok(quotaCell, '配额格必须存在')
  assert.equal(quotaCell.props.style?.color, '#404040', '占位行名字与配额格都用不可用灰')
  assert.match(String(quotaCell.props.title), /no fetcher adapter yet/i, '提示文案与设置页同一套说法')
})

test('占位余额行：BALANCE 金额位置写 No fetcher adapter yet（与设置页口径一致）', () => {
  const sandbox = buildSandbox()
  sandbox.__resetHooksState()
  const subscription = sandbox.normalizeRow({ id: 'm', providerId: 'mimo', label: 'MIMO', kind: 'balance', status: 'no_fetcher' })
  const nodes = collect(sandbox.BalanceSpendRow({ subscription, now: NOW, colorMode: 'default' }))
  const text = textOf(nodes)
  assert.ok(text.includes('MIMO'), '名字必须在')
  assert.ok(text.includes('No fetcher adapter yet'), '占位说明必须出现')
  assert.ok(!nodes.some(node => /^[$¥]/.test(textOf([node]))), '不造任何金额')
  const holder = nodes.find(node => textOf([node]) === 'No fetcher adapter yet')
  assert.equal(holder.props.style?.color, '#404040', '占位说明用不可用灰')
})

test('不可用 quota 行整行灰、格子配色不受影响；「超额红」「锁定色」语义不冲突', () => {
  const sandbox = buildSandbox()
  sandbox.__resetHooksState()
  // 主窗用尽：usedPercent=100（还能排序沉底，但看起来整行灰）
  const subscription = sandbox.normalizeRow({
    id: 'g', providerId: 'g', label: 'GRAYPROV', kind: 'quota', role: 'cycle',
    usedPercent: 100, resetAt: (NOW + 3600e3) / 1000, windowSeconds: 604800
  })
  const nodes = collect(sandbox.WeeklyQuotaRow({ subscription, now: NOW, quotaPool: [] }))
  const quotaCell = nodes.find(node => textOf([node]) === '0% left')
  assert.ok(quotaCell, '配额格必须存在')
  assert.equal(quotaCell.props.style?.color, '#404040', '用尽的行整行灰')
  // 矩阵还在（窗口有效）：超额橙不会被灰覆盖——灰是行级状态色，不进 weeklyCell。
  assert.ok(nodes.some(node => node.props?.['data-meter-cell']), '矩阵保留')
})

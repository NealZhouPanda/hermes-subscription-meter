// 5H 短窗附属化（2026-09-10 Neal 定）：5h 行不参与排序——5h 是撞墙预警显示器
// （起因=GLM 富余多跑长任务却在 5h 撞墙中断），不是独立供给池；周行按自身 P 排序，
// 渲染仍用 findFiveHourSibling 算锁定段（锁定段用例保留不动）。
// 跟随 peak-capsule 的正则提取 + vm 全量源码两种模式，测的都是 plugin.js 真实代码。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const pluginSource = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

// ---------------------------------------------------------------------------
// 提取排序相关函数（同 peak-capsule.test.mjs 的提取方式）
// ---------------------------------------------------------------------------
function loadSortFns() {
  const names = ['orderRowsForDisplay', 'rowPriority', 'activePeakRule', 'localClockAt', 'peakRuleHit', 'collapseDuplicateQuotaRows', 'quotaCycleMs', 'clamp', 'toEpochMillis']
  const snippets = names.map(name => {
    const match = pluginSource.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))
    assert.ok(match, `function ${name} must exist in plugin.js`)
    return match[0]
  })
  // M5：CYCLE_MS 已删（7 天默认不再是前端事实），沙箱只注入 CELL_COUNT。
  const constants = ['CELL_COUNT'].map(name => {
    const match = pluginSource.match(new RegExp(`^const ${name} = [^\\n]*\\n`, 'm'))
    assert.ok(match, `constant ${name} must exist in plugin.js`)
    return match[0]
  })
  return new Function(`${[...constants, ...snippets].join('\n\n')}; return { orderRowsForDisplay }`)()
}

const NOW = Date.parse('2026-09-06T12:00:00+08:00') // Sunday noon BJ — off-peak for all
const HOUR = 60 * 60 * 1000

function row(providerId, label, usedPercent, hoursUntilReset, windowSeconds, share) {
  return {
    kind: 'quota',
    providerId,
    label,
    usedPercent,
    windowSeconds: windowSeconds ?? 604800,
    resetAt: NOW + hoursUntilReset * HOUR,
    // 行契约：时间行必带 role；份额只写在主窗行上（M2 起唯一真源，前端无表可查）。
    role: windowSeconds === 18000 ? 'burst' : 'cycle',
    ...(share === undefined ? {} : { burstShare: share })
  }
}

// M5 起前端无 7 天默认：凡省略 windowSeconds 的用例行都必须显式带 604800，
// 否则 quotaCycleMs 会正确地判为「无窗」（见 windowless 行为）。
function windowlessRow(providerId, label, usedPercent, hoursUntilReset) {
  return row(providerId, label, usedPercent, hoursUntilReset, 604800)
}

test('排序：无 5h 兄弟行时行为不变（周行用自己的 P）', () => {
  const { orderRowsForDisplay: sort } = loadSortFns()
  // W 周行 P=0.5 > X 周行 P=0.4，且 W 没有 5h 行 → 顺序不受影响。
  const rows = [
    windowlessRow('W', 'W', 25, 84),
    windowlessRow('X', 'X', 30, 84)
  ]
  assert.deepEqual(sort(rows, NOW).map(r => r.label), ['W', 'X'])
})

test('排序：短窗附属化——5h 行不参与排序，周行按自身 P（含被 5h 撞墙风险的周行）', () => {
  const { orderRowsForDisplay: sort } = loadSortFns()
  // W 周行 P=0.5、W 5h 行 P=0.1（2.5h 后重置、已用 45%）、X P=0.4。
  // 09-09 旧规则取 min 会把 W 压到 X 之后；附属化后 5h 不参战 → W(0.5) > X(0.4)，
  // 5h 行 P=0.1 殿后但仍以自身 P 在组内占位。
  const rows = [
    row('W', 'W', 25, 84),
    row('W', 'W 5H', 45, 2.5, 18000),
    row('X', 'X', 30, 84)
  ]
  assert.deepEqual(sort(rows, NOW).map(r => r.label), ['W', 'X', 'W 5H'])
})

test('排序：5h 新窗 P=0 也不拖累自家周行（GLM 2026-09-10 实况回归钉）', () => {
  const { orderRowsForDisplay: sort } = loadSortFns()
  // 实况复刻：GLM 周 P≈1.7（富余 37pp）、GLM 5h 刚重置 0.6h 流逝仅用 1% → P=0，
  // 旧 min 规则把周行拖到队尾；新规则 GLM 周行凭自身 P 居首。
  const rows = [
    row('GLM', 'GLM', 41, 36.5),
    row('GLM', 'GLM 5H', 1, 4.7, 18000),
    row('KIMI', 'KIMI 5H', 0, 0.8, 18000),
    windowlessRow('KIMI', 'KIMI', 25, 110)
  ]
  // KIMI 5h P≈(0.8/5−0)/0.84≈高富余 → 第一；GLM 周 P≈1.7 第二；KIMI 周、GLM 5h 垫后。
  const order = sort(rows, NOW).map(r => r.label)
  assert.equal(order[1], 'GLM', 'GLM 周行不得被自家 5h 新窗压低')
  assert.ok(order.indexOf('GLM') < order.indexOf('GLM 5H'), 'GLM 周行应排在自家 5h 行前')
})

// ---------------------------------------------------------------------------
// 锁定段格数：lockedRemainingCellCount（% → 84 格末尾格数）
// ---------------------------------------------------------------------------
function loadLockedFns() {
  const fnNames = ['lockedRemainingCellCount', 'burstShareOf', 'normalizeBurstShare', 'numericOrNull', 'quotaCellCount', 'clamp', 'isMonthlyWindow', 'meterCellCount']
  const snippets = fnNames.map(name => {
    const match = pluginSource.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))
    assert.ok(match, `function ${name} must exist in plugin.js`)
    return match[0]
  })
  const cellCount = pluginSource.match(/^const CELL_COUNT = [^\n]*\n/m)
  assert.ok(cellCount, 'constant CELL_COUNT must exist in plugin.js')
  return new Function(`${cellCount[0]}\n${snippets.join('\n\n')}; return { lockedRemainingCellCount }`)()
}

test('前端不再自带任何份额表：行上没有 burstShare 就锁不出来', () => {
  const { lockedRemainingCellCount } = loadLockedFns()
  const weekly = row('KIMI', 'KIMI', 20, 120)
  const five = row('KIMI', 'KIMI 5H', 50, 1, 18000)
  assert.equal(lockedRemainingCellCount(weekly, five), 0)
})

test('锁定段：MiniMax 周剩 91%、5h 剩 79% → 实心 7.9%、锁 83.1%（69.8 格，几何读行上 burstShare）', () => {
  const { lockedRemainingCellCount } = loadLockedFns()
  // 份额 1:10（5h 窗 = 周窗 × 0.1）：5h 剩 79% 只能托底周剩余的 7.9%。
  // 这条事实由后端写在同一 fetcher 吐出的周期行上（前端没有任何供应商表）。
  const weekly = row('minimax-cn', 'MINIMAX', 9, 34, 604800, 0.1)
  const five = row('minimax-cn', 'MINIMAX 5H', 21, 1.3, 18000)
  assert.equal(lockedRemainingCellCount(weekly, five), (83.1 / 100) * 84)
  // 同行去掉 share 就锁不出来 → 证明几何读的是行上的事实。
  assert.equal(lockedRemainingCellCount({ ...weekly, burstShare: null }, five), 0)
})

test('锁定段：GLM 周剩 64%、5h 撞墙 0% → 整条周剩余都锁（53.76 格）', () => {
  const { lockedRemainingCellCount } = loadLockedFns()
  const weekly = row('GLM', 'GLM', 36, 100, 604800, 0.2) // 周剩 64%，份额 0.2 由主窗行声明
  const five = row('GLM', 'GLM 5H', 100, 0.1, 18000) // 5h 剩 0%
  assert.equal(lockedRemainingCellCount(weekly, five), (64 / 100) * 84)
})

test('锁定段：GLM 周剩 64%、5h 满血 100% → 实心 20%、锁 44%（36.96 格）', () => {
  const { lockedRemainingCellCount } = loadLockedFns()
  const weekly = row('GLM', 'GLM', 36, 100, 604800, 0.2)
  const five = row('GLM', 'GLM 5H', 0, 2, 18000) // 5h 剩 100% → solid=min(64, 20)=20
  assert.equal(lockedRemainingCellCount(weekly, five), (44 / 100) * 84)
})

test('锁定段边界：5h 剩余充足到实心≥周剩余 → 锁 0 格；无兄弟行/无份额 → 0', () => {
  const { lockedRemainingCellCount } = loadLockedFns()
  // CODEX 行份额 0.15：5h 剩 100% → solid=min(30, 15)=15 < 30，锁 15%。改用周剩 10%：
  // solid=min(10,15)=10 → 锁 0（实心吃满整条剩余）。
  const weeklySmall = row('CODEX', 'CODEX', 90, 100, 604800, 0.15)
  const fiveFull = row('CODEX', 'CODEX 5H', 0, 2, 18000)
  assert.equal(lockedRemainingCellCount(weeklySmall, fiveFull), 0, 'solid ≥ 周剩余 → 不锁')
  // 无兄弟行（主窗行仍带份额也没用）。
  assert.equal(lockedRemainingCellCount(windowlessRow('GLM', 'GLM', 36, 100), null), 0)
  // 两行都没声明份额（grok 无短窗口径，绝不瞎猜一个比例）。
  assert.equal(lockedRemainingCellCount(row('GROK', 'GROK', 36, 100), row('GROK', 'GROK 5H', 0, 2, 18000)), 0)
})

test('锁定段：整段边界——周剩 100%、5h 全空 → 锁满 84 格（0.2 托底无效）', () => {
  const { lockedRemainingCellCount } = loadLockedFns()
  const weekly = row('KIMI', 'KIMI', 0, 168, 604800, 0.2)
  const five = row('KIMI', 'KIMI 5H', 100, 0.1, 18000)
  assert.equal(lockedRemainingCellCount(weekly, five), 84)
})

// ---------------------------------------------------------------------------
// 渲染路径：vm 跑全量源码，直接渲染 WeeklyMeter，检查锁定段的格数与样式
// ---------------------------------------------------------------------------
// 2026-09-12 Neal 定五色契约：色值=截图逐像素取样；受限=深绿/深蓝（5h 锁定，不是高峰）。
const COLORS_OF = {
  green: '#14AE68',       // 翠绿：剩余可用
  greenLocked: '#006935', // 深绿：剩余受限
  blue: '#28A7E0',        // 天蓝：富余可用
  blueLocked: '#0A499D',  // 深蓝：富余受限
  orange: '#F39800',      // 橙：超额
  track: 'var(--ui-bg-quaternary)'
}
function buildRenderSandbox() {
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

// 收集 WeeklyMeter 渲染树里的 data-meter-cell 格子（含 data-locked 标记）。
function collectMeterCells(sandbox, subscription, fiveHourSibling) {
  const element = sandbox.WeeklyMeter({ subscription, now: NOW, fiveHourSibling })
  const cells = []
  const walk = node => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    if (node.props?.['data-meter-cell']) cells.push(node.props)
    walk(node.props?.children)
  }
  walk(element)
  assert.equal(cells.length, 84, ' WeeklyMeter must always render exactly 84 cells')
  return cells
}

function countLockedCells(sandbox, subscription, fiveHourSibling) {
  return collectMeterCells(sandbox, subscription, fiveHourSibling)
    .filter(props => props['data-locked']).length
}

test('渲染：GLM 周剩64% + 5h 撞墙 → 剩余区域末尾 53 格锁定', () => {
  const sandbox = buildRenderSandbox()
  const weekly = row('GLM', 'GLM', 36, 100, 604800, 0.2)
  const five = row('GLM', 'GLM 5H', 100, 0.1, 18000)
  // 已用 36% → 前 30.24 格消耗区；剩余 53.76 格全部锁定 → index>=30.24 的 53 格。
  assert.equal(countLockedCells(sandbox, weekly, five), 53)
})

test('渲染：GLM 周剩64% + 5h 满血 → 末尾 36 格锁定，实心部分不受影响', () => {
  const sandbox = buildRenderSandbox()
  const weekly = row('GLM', 'GLM', 36, 100, 604800, 0.2)
  const five = row('GLM', 'GLM 5H', 0, 2, 18000)
  // 锁 44% = 36.96 格 → index >= 84-36.96=47.04 → 48..83 共 36 格。
  assert.equal(countLockedCells(sandbox, weekly, five), 36)
})

test('渲染：无兄弟行 / 行上无份额 → 0 格锁定（现状）', () => {
  const sandbox = buildRenderSandbox()
  const weekly = row('GLM', 'GLM', 36, 100)
  assert.equal(countLockedCells(sandbox, weekly, null), 0, '无兄弟行不锁')
  assert.equal(
    countLockedCells(sandbox, row('GROK', 'GROK', 36, 100), row('GROK', 'GROK 5H', 100, 0.1, 18000)),
    0,
    'grok 行上没有份额 → 不瞎猜比例'
  )
})

// ---------------------------------------------------------------------------
// 锁定格样式：锁定格与普通格同一套实色渲染（goneColor 背景 + fill 子元素）。
// ---------------------------------------------------------------------------
test('锁定格样式：goneColor 背景 + fill 子元素，与普通格同一套渲染', () => {
  const sandbox = buildRenderSandbox()
  const weekly = row('GLM', 'GLM', 36, 100, 604800, 0.2)
  const five = row('GLM', 'GLM 5H', 100, 0.1, 18000)
  const cells = collectMeterCells(sandbox, weekly, five)
  const locked = cells.filter(props => props['data-locked'])
  assert.ok(locked.length > 0, 'fixture must produce locked cells')

  // 逐格对照 weeklyCell 的真实输出：背景=goneColor，fill 子元素=presentColor + fillRatio 宽度。
  // 2026-09-12 起 weeklyCell 收锁定布尔选受限色档，此处传入渲染层同款判定结果
  // （data-locked 即 WeeklyMeter 用 lockedRemainingCellCount 唯一结果算出的布尔）。
  for (let index = 0; index < 84; index += 1) {
    const props = cells[index]
    const expected = sandbox.weeklyCell(NOW, weekly, index, Boolean(props['data-locked']))
    assert.equal(props.style.backgroundColor, expected.goneColor,
      `cell ${index} background must be the real goneColor`)
    if (props['data-locked']) {
      assert.ok(props.children && typeof props.children === 'object',
        `locked cell ${index} must render its fill child again`)
      assert.equal(props.children.props.style.backgroundColor, expected.presentColor,
        `locked cell ${index} fill keeps weeklyCell presentColor`)
      assert.equal(props.children.props.style.width, `${expected.fillRatio * 100}%`,
        `locked cell ${index} fill width follows fillRatio`)
    }
  }
})

test('锁定格样式：锁定段走受限档深蓝/深绿（5h 锁定，fillRatio 驱动，不按高峰换色）', () => {
  const sandbox = buildRenderSandbox()
  // GLM 周剩 50%（usedPercent=50）、5h 满血 → solid=min(50, 50×0.2)=20 → 锁 30% = 25.2 格
  // → index ≥ 84−25.2 = 58.8 → 59..83 共 25 格；该段全部在未来区（底色=富余档、fill=剩余档），
  // 2026-09-12 起锁定段整体走受限档：底色深蓝 #0A499D、fill 深绿 #006935。
  const weekly = row('GLM', 'GLM', 50, 100, 604800, 0.2)
  const five = row('GLM', 'GLM 5H', 0, 2, 18000)
  const cells = collectMeterCells(sandbox, weekly, five)
  const locked = cells.filter(props => props['data-locked'])
  assert.equal(locked.length, 25)
  for (const props of locked) {
    assert.equal(props.style.backgroundColor, COLORS_OF.blueLocked, 'future locked cells take the restricted dark-blue goneColor')
    assert.equal(props.children.props.style.backgroundColor, COLORS_OF.greenLocked, 'presentColor follows weeklyCell restricted dark-green')
    assert.equal(props.children.props.style.width, '100%', 'future cells keep a full fill bar')
  }
  // 非锁定剩余格（index 42..58：剩余区内、锁定段外）：翠绿 fill。
  const unlockedRemaining = cells.filter(props => {
    const index = Number(props.key.match(/cell-(\d+)/)[1])
    return index >= 42 && index <= 58
  })
  assert.ok(unlockedRemaining.length > 0, 'fixture must have non-locked remaining cells')
  for (const props of unlockedRemaining) {
    assert.equal(props.children.props.style.backgroundColor, COLORS_OF.green,
      'non-locked remaining cells stay bright green')
    assert.equal(props.children.props.style.width, '100%')
  }
  // 无锁定 fixture：绝不能带 data-locked。
  const plain = collectMeterCells(sandbox, weekly, null)
  assert.equal(plain.filter(props => props['data-locked']).length, 0)
})

test('锁定格样式：普通格保持日虚线；锁定格无日虚线', () => {
  const sandbox = buildRenderSandbox()
  const weekly = row('GLM', 'GLM', 36, 100, 604800, 0.2)
  const five = row('GLM', 'GLM 5H', 100, 0.1, 18000)
  const cells = collectMeterCells(sandbox, weekly, five)
  for (const props of cells) {
    const style = props.style
    if (props['data-locked']) {
      assert.equal(style.borderLeft, undefined, 'locked cells must not get the dashed day divider')
    } else {
      // 日分界（DAY_CELL_COUNT=12，即 index%12===0 且 index>0）上的普通格必须保留虚线。
      const index = Number(props.key.match(/cell-(\d+)/)[1])
      if (index > 0 && index % 12 === 0) {
        assert.equal(style.borderLeft, '1px dashed var(--ui-stroke-secondary)',
          `day divider at cell ${index} must keep its dashed left border`)
      } else {
        assert.equal(style.borderLeft, undefined, `non-divider cell ${index} must have no left border`)
      }
    }
  }
})

test('渲染接线：WeeklyQuotaRow 是 WeeklyMeter 唯一调用点，且把兄弟行传了下去', () => {
  const meterCalls = pluginSource.match(/jsx\(WeeklyMeter, \{[^}]*\}\)/g) || []
  assert.equal(meterCalls.length, 1, `WeeklyMeter 只应在 WeeklyQuotaRow 里调用一次，实际 ${meterCalls.length}`)
  assert.match(meterCalls[0], /fiveHourSibling/, '调用点必须传 fiveHourSibling')
  const rowCalls = pluginSource.match(/jsx\(WeeklyQuotaRow, \{[\s\S]*?\}\)/g) || []
  assert.equal(rowCalls.length, 1, `WeeklyQuotaRow 只应调用一次，实际 ${rowCalls.length}`)
  assert.match(rowCalls[0], /quotaPool/, '调用点必须传 quotaPool')
})

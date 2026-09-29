// 高对比度（服务色觉异常）配色 —— 2026-09-26 Neal 定。
// 这里把「为什么要有这个模式」钉成可复算的断言：WCAG 2.x §1.4.1 的 3:1 明度判据、
// 三种色觉缺失下的 CIELAB ΔE、以及图例文案必须描述此刻真正画出来的颜色。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const pluginSource = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

const sliceFunction = name => {
  const block = pluginSource.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))?.[0]
  assert.ok(block, `plugin.js 必须有 function ${name}`)
  return block
}
const PALETTE_SAND = vm.runInNewContext([
  // COLORS 现在引用 UNAVAILABLE_GRAY（gray 键），必须先注入它。
  pluginSource.match(/^const UNAVAILABLE_GRAY = .*$/m)[0],
  pluginSource.match(/const COLORS = \{[\s\S]*?\n\}/)[0],
  pluginSource.match(/const HIGH_CONTRAST_COLORS = \{[\s\S]*?\n\}/)[0],
  pluginSource.match(/const HIGH_CONTRAST_MODE = '[^']*'/)[0],
  pluginSource.match(/const HELP_COLOR_NAMES = \{[\s\S]*?\n\}/)[0],
  pluginSource.match(/const isHighContrast = [^\n]*/)[0],
  pluginSource.match(/const paletteFor = [^\n]*/)[0],
  sliceFunction('wholeHelpLines'),
  ';({ COLORS, HIGH_CONTRAST_COLORS, HIGH_CONTRAST_MODE, HELP_COLOR_NAMES, isHighContrast, paletteFor, wholeHelpLines })'
].join('\n'), { console })

const MODE_SAND = mode => {
  const store = new Map(mode === null ? [] : [['subscription-meter:color-mode', mode]])
  const sandbox = vm.runInNewContext([
    pluginSource.match(/const COLOR_MODE_STORAGE_KEY = '[^']*'/)[0],
    pluginSource.match(/const HIGH_CONTRAST_MODE = '[^']*'/)[0],
    sliceFunction('readColorMode'),
    sliceFunction('writeColorMode'),
    ';({ readColorMode, writeColorMode })'
  ].join('\n'), {
    console,
    window: { localStorage: { getItem: key => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, value) } }
  })
  return { ...sandbox, store }
}

// --- 色觉模拟（Machado 等 2009 的 100% 强度矩阵）+ CIELAB ΔE --------------------
const srgbToLinear = value => {
  const c = value / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const linearToSrgb = value => {
  const c = Math.max(0, Math.min(1, value))
  return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)
}
const hexToRgb = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16))
const CVD_MATRICES = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]]
}
const toLab = hex => {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear)
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
  const f = t => (t > 0.008856 ? t ** (1 / 3) : 7.787 * t + 16 / 116)
  const [fx, fy, fz] = [f(x), f(y), f(z)]
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}
const deltaE = (a, b) => Math.sqrt(toLab(a).reduce((sum, value, index) => sum + (value - toLab(b)[index]) ** 2, 0))
const simulate = (hex, kind) => {
  const linear = hexToRgb(hex).map(srgbToLinear)
  const out = CVD_MATRICES[kind].map(row => row.reduce((sum, factor, index) => sum + factor * linear[index], 0))
  return '#' + out.map(value => Math.round(linearToSrgb(value)).toString(16).padStart(2, '0')).join('')
}
const relativeLuminance = hex => {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
// WCAG 对比度（1.4.1 认可的那条：两色明度对比 ≥3:1 即算颜色之外多了一层区分）
const contrastRatio = (a, b) => {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
const worstCvdDeltaE = palette => Math.min(...Object.keys(CVD_MATRICES).map(kind =>
  Math.min(...[['green', 'greenLocked'], ['green', 'blue'], ['green', 'orange'],
    ['greenLocked', 'blue'], ['greenLocked', 'blueLocked'], ['greenLocked', 'orange'],
    ['blue', 'blueLocked'], ['blue', 'orange'], ['blueLocked', 'orange']]
    .map(([a, b]) => deltaE(simulate(palette[a], kind), simulate(palette[b], kind))))))

const DEFAULT_PALETTE = PALETTE_SAND.COLORS
const CONTRAST_PALETTE = PALETTE_SAND.paletteFor(PALETTE_SAND.HIGH_CONTRAST_MODE)

// 2026-09-29 起面板新增的三个状态色：不可用灰（行级状态）+ 余额**兜底**色两套。
// 同日 Neal 看板实测纠正：余额行主色 = 该供应方的 accent（identity.yaml meta，后端
// _apply_provider_meta 抄进行），与订阅行圆点同源同色；BALANCE_VALUE_COLORS 只在
// 行上没有 accent 时兜底（xai/qwen/deepseek 等未配 accent 的供应方）。兜底紫仍按
// 与配色常量一样字节锁死；区分度要求 = 对「它会在同一模式里出现的每个色」
// min(3×CVD 双方模拟, 普通视觉) ≥ 20（经全域扫描选出的最大可行下限，见钉表）。
const STATE_COLORS_SAND = vm.runInNewContext([
  pluginSource.match(/const HIGH_CONTRAST_MODE = '[^']*'/)[0],
  pluginSource.match(/const isHighContrast = [^\n]*/)[0],
  pluginSource.match(/const BALANCE_VALUE_COLORS = .*\n/)[0],
  pluginSource.match(/const UNAVAILABLE_GRAY = '[^']*'/)[0],
  pluginSource.match(/const balanceValueColor = [^\n]*/)[0],
  ';({ BALANCE_VALUE_COLORS, UNAVAILABLE_GRAY, balanceValueColor })'
].join('\n'), { console })
const UNAVAILABLE_GRAY = STATE_COLORS_SAND.UNAVAILABLE_GRAY
const BALANCE_DEFAULT = STATE_COLORS_SAND.balanceValueColor('default')
const BALANCE_HIGH_CONTRAST = STATE_COLORS_SAND.balanceValueColor(PALETTE_SAND.HIGH_CONTRAST_MODE)
const STATE_HIGH_CONTRAST_MODE = PALETTE_SAND.HIGH_CONTRAST_MODE

test('默认配色就是 2026-09-12 定稿的五色（这个模式不该动它）', () => {
  assert.equal(DEFAULT_PALETTE.green, '#14AE68')
  assert.equal(DEFAULT_PALETTE.greenLocked, '#006935')
  assert.equal(DEFAULT_PALETTE.blue, '#28A7E0')
  assert.equal(DEFAULT_PALETTE.blueLocked, '#0A499D')
  assert.equal(DEFAULT_PALETTE.orange, '#F39800')
  assert.equal(PALETTE_SAND.paletteFor('default'), PALETTE_SAND.COLORS, '默认模式必须原样返回，不能多挂属性')
})

test('高对比度配色：绿 / 黄 / 红，色值锁死', () => {
  assert.equal(CONTRAST_PALETTE.green, '#228833')
  assert.equal(CONTRAST_PALETTE.greenLocked, '#13581E')
  assert.equal(CONTRAST_PALETTE.blue, '#F0E442')
  assert.equal(CONTRAST_PALETTE.blueLocked, '#A8A02B')
  assert.equal(CONTRAST_PALETTE.orange, '#EE6677')
  assert.equal(CONTRAST_PALETTE.track, DEFAULT_PALETTE.track, '底轨/危险色不跟着换')
})

test('WCAG 1.4.1 判据：「可用 ↔ 富余」的明度对比必须过 3:1', () => {
  const before = contrastRatio(DEFAULT_PALETTE.green, DEFAULT_PALETTE.blue)
  const after = contrastRatio(CONTRAST_PALETTE.green, CONTRAST_PALETTE.blue)
  assert.ok(before < 3, `默认配色本来就不过（${before.toFixed(2)}:1）——这正是要有这个模式的原因`)
  assert.ok(after >= 3, `高对比度模式必须过 3:1，实际 ${after.toFixed(2)}:1`)
})

test('三种色觉缺失下最差 ΔE：默认 12.3 会看成同色，高对比度模式明显拉开', () => {
  const before = worstCvdDeltaE(DEFAULT_PALETTE)
  const after = worstCvdDeltaE(CONTRAST_PALETTE)
  assert.ok(before < 15, `默认配色最差 ΔE ${before.toFixed(1)}（蓝盲把可用绿与富余蓝看成同色）`)
  assert.ok(after >= 15, `高对比度模式最差 ΔE ${after.toFixed(1)} 太低`)
  assert.ok(after > before + 5, `改进幅度太小：${before.toFixed(1)} → ${after.toFixed(1)}`)
  // 蓝盲下这两档必须真的分开（历史缺陷就是这里）
  const tritanGap = deltaE(simulate(CONTRAST_PALETTE.green, 'tritan'), simulate(CONTRAST_PALETTE.blue, 'tritan'))
  assert.ok(tritanGap >= 15, `蓝盲下可用绿与富余黄只差 ${tritanGap.toFixed(1)}`)
})

test('配色模式按机器读写；读不到 / 存坏了都回默认，不抛错', () => {
  assert.equal(MODE_SAND(null).readColorMode(), 'default', '没存过 → 默认')
  assert.equal(MODE_SAND('high-contrast').readColorMode(), 'high-contrast')
  assert.equal(MODE_SAND('nonsense').readColorMode(), 'default', '值不认识 → 默认（不猜）')

  const sandbox = MODE_SAND(null)
  sandbox.writeColorMode('high-contrast')
  assert.equal(sandbox.store.get('subscription-meter:color-mode'), 'high-contrast')
  sandbox.writeColorMode('default')
  assert.equal(sandbox.store.get('subscription-meter:color-mode'), 'default')
  sandbox.writeColorMode('nonsense')
  assert.equal(sandbox.store.get('subscription-meter:color-mode'), 'default', '写坏值也要落成 default')

  // localStorage 抛错（隐私模式）时不能把面板带崩
  const broken = vm.runInNewContext([
    pluginSource.match(/const COLOR_MODE_STORAGE_KEY = '[^']*'/)[0],
    pluginSource.match(/const HIGH_CONTRAST_MODE = '[^']*'/)[0],
    sliceFunction('readColorMode'), sliceFunction('writeColorMode'),
    ';({ readColorMode, writeColorMode })'
  ].join('\n'), { console, window: { get localStorage() { throw new Error('blocked') } } })
  assert.equal(broken.readColorMode(), 'default')
  assert.doesNotThrow(() => broken.writeColorMode('high-contrast'))
})

test('图例文案跟着配色走：高对比度模式下不许再说「天蓝 / 橙」', () => {
  const normal = PALETTE_SAND.wholeHelpLines(DEFAULT_PALETTE, 'default').map(line => line.text)
  const contrasted = PALETTE_SAND.wholeHelpLines(CONTRAST_PALETTE, PALETTE_SAND.HIGH_CONTRAST_MODE).map(line => line.text)
  assert.ok(normal.includes('Sky blue: surplus available quota'), '默认模式文案不变')
  assert.ok(normal.includes('Orange: over-consumed quota'))
  assert.ok(contrasted.includes('Yellow: surplus available quota'), '换色后必须说黄')
  assert.ok(contrasted.includes('Dark yellow: surplus quota locked by the 5h window'))
  assert.ok(contrasted.includes('Red: over-consumed quota'))
  assert.ok(contrasted.includes('Green: remaining available quota'), '绿色语义没变')
  assert.ok(!contrasted.some(line => /Sky blue|Dark blue|Orange/.test(line)), '不许留旧颜色名')
  // 色块颜色也必须跟着换（不然图例自己就对不上）；2026-09-29 起灰行说明也带色块。
  const swatches = PALETTE_SAND.wholeHelpLines(CONTRAST_PALETTE, PALETTE_SAND.HIGH_CONTRAST_MODE).filter(line => line.swatch).map(line => line.swatch)
  assert.deepEqual(Array.from(swatches), ['#228833', '#13581E', '#F0E442', '#A8A02B', '#EE6677', UNAVAILABLE_GRAY])
})

test('开关与描边真的接在界面上（不是只有配色常量）', () => {
  assert.ok(pluginSource.includes("'aria-label': 'High-contrast colors'"), '开关缺 aria-label')
  assert.ok(pluginSource.includes('colour-vision deficiencies'), '说明里要写清服务色觉异常用户')
  assert.ok(pluginSource.includes('Saved on this computer'), '按机器保存这件事要在界面上说清')
  assert.match(pluginSource, /jsx\(DisplaySettingsSection, \{\}\)/, '显示分区必须挂在设置面板里')
  assert.ok(pluginSource.includes('writeColorMode(checked ? HIGH_CONTRAST_MODE'), '开关要真的写偏好')
  // 纯本地偏好：不许悄悄借道后端的 per-provider settings 接口（那套是按 provider 存的）
  const displayBlock = pluginSource.slice(pluginSource.indexOf('function DisplaySettingsSection'),
    pluginSource.indexOf('// 五色图例'))
  assert.ok(!/\brest\b|fetch\(|monthlyEnabled/.test(displayBlock), '显示开关不得走后端 provider 设置接口')
  // 两种描边：矩阵格子 + 图例色块
  assert.match(pluginSource, /outline: cellOutline/, '格子要挂描边')
  assert.match(pluginSource, /outline: swatchOutline/, '图例色块要挂描边')
  assert.ok(pluginSource.includes("outline: cellOutline,\n            outlineOffset: '-1px'"), '描边要内缩一圈（否则会盖住相邻格）')
})

// --- 防退化钉（2026-09-26 Neal 定）------------------------------------------------
// 换来的取舍先摆明：新配色把「可用绿 ↔ 富余蓝」从 ΔE 12.3 拉到 52.7（这是它存在的理由），
// 代价是另外六对的两两色差被压小 —— 例：「剩余可用 ↔ 超额使用」35.9 → 19.2。
// 十九分左右仍在「能分开」档，所以配色先不动，但**不许再往下走**：下面这张表是
// 2026-09-26 的实测基线，任何一对跌破基线（容差 0.5 给取整留边）就红。
// 想把某对再压低，必须显式改这张表，并在 commit 里写清代价。
const HIGH_CONTRAST_PAIR_FLOOR = {
  green: { greenLocked: 18.9, blue: 52.7, orange: 19.2 },
  greenLocked: { blue: 69.0, blueLocked: 43.3, orange: 33.3 },
  blue: { blueLocked: 24.2, orange: 55.8 },
  blueLocked: { orange: 32.8 }
}
// 明度判据（WCAG 1.4.1 的 3:1）今天过得去的只有三对 —— 本模式修的是最差那一对，
// 不是全部；这三对不许丢，「只有三对过」这件事也一并记着。
const LUMINANCE_PASSING_PAIRS = ['green|blue', 'greenLocked|blue', 'greenLocked|blueLocked']
const FLOOR_PAIRS = Object.keys(HIGH_CONTRAST_PAIR_FLOOR)
  .flatMap(a => Object.keys(HIGH_CONTRAST_PAIR_FLOOR[a]).map(b => [a, b]))
const pairWorstDeltaE = (palette, a, b) => Math.min(...Object.keys(CVD_MATRICES).map(kind =>
  deltaE(simulate(palette[a], kind), simulate(palette[b], kind))))

test('防退化：高对比度配色九对状态都不许跌破 2026-09-26 基线', () => {
  for (const [a, b] of FLOOR_PAIRS) {
    const actual = pairWorstDeltaE(CONTRAST_PALETTE, a, b)
    assert.ok(actual >= HIGH_CONTRAST_PAIR_FLOOR[a][b] - 0.5,
      `${a} ↔ ${b} 模拟最差 ΔE ${actual.toFixed(1)} 跌破基线 ${HIGH_CONTRAST_PAIR_FLOOR[a][b]}`)
  }
  // 已经让给新配色的那六对：谁想让掉的再让一步，上面的表会先红。
  const traded = FLOOR_PAIRS.filter(([a, b]) => pairWorstDeltaE(CONTRAST_PALETTE, a, b) < pairWorstDeltaE(DEFAULT_PALETTE, a, b))
  assert.equal(traded.length, 6, `让掉的对比数变了（基线 6）：${traded.map(p => p.join('↔')).join(', ')}`)
})

test('防退化：过 3:1 明度判据的那三对不许丢', () => {
  for (const key of LUMINANCE_PASSING_PAIRS) {
    const [a, b] = key.split('|')
    assert.ok(contrastRatio(CONTRAST_PALETTE[a], CONTRAST_PALETTE[b]) >= 3, `${key} 掉了 3:1`)
  }
  const passing = FLOOR_PAIRS.filter(([a, b]) => contrastRatio(CONTRAST_PALETTE[a], CONTRAST_PALETTE[b]) >= 3)
  assert.equal(passing.length, LUMINANCE_PASSING_PAIRS.length,
    `过 3:1 的对数变了：${passing.length}（基线 ${LUMINANCE_PASSING_PAIRS.length}）`)
})

// --- 2026-09-29 新增状态色的防退化钉（Neal 存量需求①②）--------------------------
// 口径与五色钉一致：Machado 三色盲双方模拟 + 普通视觉，取最小值；基线容差 0.5。
// 灰与余额色是**行级状态色**，不进格子矩阵，只要求「同一屏上分得开」，
// 所以每色只钉它实际会同屏出现的色（default / high-contrast 各一份）。
const pairWorstStateDeltaE = (a, b) => Math.min(
  ...Object.keys(CVD_MATRICES).map(kind => deltaE(simulate(a, kind), simulate(b, kind))),
  deltaE(a, b)
)

test('不可用灰 #404040 与两套配色全部语义色都分得开（基线 2026-09-29）', () => {
  assert.equal(UNAVAILABLE_GRAY, '#404040', '灰值字节锁死')
  const GRAY_FLOORS = {
    [STATE_HIGH_CONTRAST_MODE]: { green: 39.2, greenLocked: 24.8, blue: 63.7, blueLocked: 39.9, orange: 27.5, balance: 50.2 },
    default: { green: 40.1, greenLocked: 21.7, blue: 53.5, blueLocked: 25.1, orange: 66.9, balance: 31.9 }
  }
  for (const [mode, floors] of Object.entries(GRAY_FLOORS)) {
    const balance = STATE_COLORS_SAND.balanceValueColor(mode)
    for (const [name, floor] of Object.entries(floors)) {
      const other = name === 'balance' ? balance : (mode === 'default' ? DEFAULT_PALETTE : CONTRAST_PALETTE)[name]
      const actual = pairWorstStateDeltaE(UNAVAILABLE_GRAY, other)
      assert.ok(actual >= floor - 0.5,
        `${mode}：灰 ↔ ${name} ΔE ${actual.toFixed(1)} 跌破基线 ${floor}`)
    }
  }
})

test('余额兜底色（default 紫 / high-contrast 亮紫红）与同屏各色分得开（基线 2026-09-29）', () => {
  assert.equal(BALANCE_DEFAULT, '#8820e8', 'default 兜底色字节锁死')
  assert.equal(BALANCE_HIGH_CONTRAST, '#d75cd7', 'high-contrast 兜底色字节锁死')
  const BALANCE_FLOORS = {
    [STATE_HIGH_CONTRAST_MODE]: { value: BALANCE_HIGH_CONTRAST, others: { green: 70.7, greenLocked: 68.0, blue: 47.2, blueLocked: 39.7, orange: 28.9, gray: 50.2 } },
    default: { value: BALANCE_DEFAULT, others: { green: 63.6, greenLocked: 49.2, blue: 41.7, blueLocked: 28.0, orange: 59.4, gray: 31.9 } }
  }
  for (const [mode, { value, others }] of Object.entries(BALANCE_FLOORS)) {
    for (const [name, floor] of Object.entries(others)) {
      const other = name === 'gray' ? UNAVAILABLE_GRAY : (mode === 'default' ? DEFAULT_PALETTE : CONTRAST_PALETTE)[name]
      const actual = pairWorstStateDeltaE(value, other)
      assert.ok(actual >= floor - 0.5,
        `${mode}：余额色 ↔ ${name} ΔE ${actual.toFixed(1)} 跌破基线 ${floor}`)
    }
  }
  // 两套余额色互相也要分得开（同一个人两台显示模式切换时不至于认不出同一行）
  const across = pairWorstStateDeltaE(BALANCE_DEFAULT, BALANCE_HIGH_CONTRAST)
  assert.ok(across >= 35.5, `两套余额色 ΔE ${across.toFixed(1)} 跌破基线 36.0`)
})

test('3:1 明度判据：新增状态色带来的过线对按 2026-09-29 口径钉住', () => {
  // 灰与深档（greenLocked/blueLocked）明度接近，3:1 判据本来就不适合它们——
  // 那两对靠 ΔE（色相差）区分，这里钉的是「新色确实至少带来这些 3:1 对」：
  const NEW_PASSING = {
    default: [['gray', 'green'], ['gray', 'blue'], ['gray', 'orange']],
    [STATE_HIGH_CONTRAST_MODE]: [['gray', 'blue'], ['gray', 'blueLocked'], ['gray', 'orange'], ['gray', 'balance']]
  }
  const counts = {}
  for (const [mode, pairs] of Object.entries(NEW_PASSING)) {
    const balance = STATE_COLORS_SAND.balanceValueColor(mode)
    let pass = 0
    for (const [a, b] of pairs) {
      const ca = a === 'gray' ? UNAVAILABLE_GRAY : a === 'balance' ? balance : (mode === 'default' ? DEFAULT_PALETTE : CONTRAST_PALETTE)[a]
      const cb = b === 'gray' ? UNAVAILABLE_GRAY : b === 'balance' ? balance : (mode === 'default' ? DEFAULT_PALETTE : CONTRAST_PALETTE)[b]
      assert.ok(contrastRatio(ca, cb) >= 3, `${mode}：${a}↔${b} 掉了 3:1`)
      pass += 1
    }
    counts[mode] = pairs.length
    assert.equal(pass, pairs.length)
  }
  assert.equal(counts.default, 3)
  assert.equal(counts[STATE_HIGH_CONTRAST_MODE], 4)
})

test('图例跟着新状态色走：灰行说明两套配色都在，余额色说法更新', () => {
  const normal = PALETTE_SAND.wholeHelpLines(DEFAULT_PALETTE, 'default').map(line => line)
  const contrasted = PALETTE_SAND.wholeHelpLines(CONTRAST_PALETTE, PALETTE_SAND.HIGH_CONTRAST_MODE).map(line => line)
  const GREY_TEXT = 'Grey row = unavailable right now: balance spent or at its cap, or the 5-hour / weekly window is used up. Matrix colors are unchanged — it is a row state, not a new quota tier.'
  for (const lines of [normal, contrasted]) {
    const greyLine = lines.find(line => line.text === GREY_TEXT)
    assert.ok(greyLine, '灰行说明必须存在')
    assert.equal(greyLine.swatch, UNAVAILABLE_GRAY, '灰行说明的色块必须是不可用灰')
  }
  const DOT_TEXT = 'The dot by a plan name distinguishes providers; balance rows use the same provider colour as the plan dot — grey marks a row you cannot use right now.'
  assert.ok(normal.some(line => line.text === DOT_TEXT) && contrasted.some(line => line.text === DOT_TEXT),
    '圆点/余额色的说法必须替换旧「not cell colors or balance status」')
  assert.ok(!normal.concat(contrasted).some(line => line.text.includes('not cell colors or balance status')),
    '旧说法必须删干净')
})

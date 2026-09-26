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
  // 色块颜色也必须跟着换（不然图例自己就对不上）
  const swatches = PALETTE_SAND.wholeHelpLines(CONTRAST_PALETTE, PALETTE_SAND.HIGH_CONTRAST_MODE).filter(line => line.swatch).map(line => line.swatch)
  assert.deepEqual(Array.from(swatches), ['#228833', '#13581E', '#F0E442', '#A8A02B', '#EE6677'])
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

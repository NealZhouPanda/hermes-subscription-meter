// 供应方 accent 分主题两套（2026-09-29）：行上取哪一只，只看当前主题；
// 取不到宿主信息时必须静默退回亮色，不能把面板带崩。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const pluginSource = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

function sliceFunction(name) {
  const start = pluginSource.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `源码里没有 function ${name}(`)
  let depth = 0
  for (let i = pluginSource.indexOf('{', start); i < pluginSource.length; i++) {
    if (pluginSource[i] === '{') depth++
    else if (pluginSource[i] === '}') {
      depth--
      if (depth === 0) return pluginSource.slice(start, i + 1)
    }
  }
  throw new Error(`function ${name} 花括号没闭合`)
}

const ACTIVE_SCHEME_DECL = pluginSource.match(/let activeColorScheme = '[^']*'/)[0]

function sandboxFor({ colorScheme, prefersDark, matchMediaThrows = false, noDocument = false }) {
  const documentElement = { style: {} }
  if (colorScheme !== undefined) documentElement.style.colorScheme = colorScheme
  const sandbox = {
    console,
    window: {
      matchMedia: matchMediaThrows
        ? () => { throw new Error('nope') }
        : () => ({ matches: Boolean(prefersDark) })
    },
    document: { documentElement }
  }
  if (noDocument) delete sandbox.document
  return vm.runInNewContext([
    ACTIVE_SCHEME_DECL,
    sliceFunction('readColorScheme'),
    sliceFunction('accentFor'),
    ';({ readColorScheme, accentFor, getActive: () => activeColorScheme })'
  ].join('\n'), sandbox)
}

const DARK_ROW = { accent: '#8F3224', accentDark: '#C4604D' }

test('暗色主题取 accentDark，亮色主题取 accent', () => {
  const sandbox = sandboxFor({ colorScheme: 'light' })
  assert.equal(sandbox.accentFor(DARK_ROW, 'light'), '#8F3224')
  assert.equal(sandbox.accentFor(DARK_ROW, 'dark'), '#C4604D')
})

test('行上没有 accentDark（老数据/没配的家）时，暗色主题也退回 accent，不留空', () => {
  const sandbox = sandboxFor({ colorScheme: 'light' })
  assert.equal(sandbox.accentFor({ accent: '#28A7E0' }, 'dark'), '#28A7E0')
  assert.equal(sandbox.accentFor({ accentDark: '#28A7E0' }, 'light'), null,
    '亮主题缺 accent 时不给值（由调用方决定兜底色）')
  assert.equal(sandbox.accentFor(null), null)
  assert.equal(sandbox.accentFor({}), null)
})

test('取色默认读模块变量：useColorScheme 写入的那一只是全局默认', () => {
  const sandbox = sandboxFor({ colorScheme: 'dark' })
  assert.equal(sandbox.getActive(), 'light', '初始为亮色（读到宿主之前）')
  assert.equal(sandbox.accentFor(DARK_ROW), '#8F3224', '默认走亮主题那一只')
})

test('readColorScheme：优先读宿主的 color-scheme，其次媒体查询，最后亮色', () => {
  assert.equal(sandboxFor({ colorScheme: 'dark', prefersDark: false }).readColorScheme(), 'dark')
  assert.equal(sandboxFor({ colorScheme: 'light', prefersDark: true }).readColorScheme(), 'light')
  assert.equal(sandboxFor({ prefersDark: true }).readColorScheme(), 'dark')
  assert.equal(sandboxFor({ prefersDark: false }).readColorScheme(), 'light')
  assert.equal(sandboxFor({ colorScheme: 'system', prefersDark: false }).readColorScheme(), 'light',
    'system 不是二值，交给媒体查询')
})

test('宿主没有 document 或 matchMedia 抛错时不崩，退回亮色', () => {
  const noDoc = sandboxFor({ noDocument: true, prefersDark: true })
  assert.equal(noDoc.readColorScheme(), 'dark', '没有 document 时仍能用媒体查询')

  const broken = vm.runInNewContext([
    ACTIVE_SCHEME_DECL,
    sliceFunction('readColorScheme'),
    ';({ readColorScheme })'
  ].join('\n'), { console, window: { matchMedia: () => { throw new Error('nope') } } })
  assert.equal(broken.readColorScheme(), 'light')

  const nothing = vm.runInNewContext([
    ACTIVE_SCHEME_DECL,
    sliceFunction('readColorScheme'),
    ';({ readColorScheme })'
  ].join('\n'), { console })
  assert.equal(nothing.readColorScheme(), 'light')
})

test('两个取色点都走 accentFor，且没有任何地方直接读 subscription.accent', () => {
  assert.ok(pluginSource.includes('(accentFor(subscription) || balanceValueColor(colorMode))'),
    '余额行必须按主题取色')
  assert.ok(pluginSource.includes('(accentFor(subscription) || COLORS.green)'),
    '订阅行必须按主题取色')
  assert.ok(!/subscription\.accent\b/.test(pluginSource),
    '不许再直接读 subscription.accent（会绕开主题判定）')
})

test('useColorScheme 在「没数据先返回骨架」之前调用（React #310 防线）', () => {
  const hookCall = pluginSource.indexOf('\n  useColorScheme()')
  const skeletonReturn = pluginSource.indexOf('if (!rows.length) {')
  assert.notEqual(hookCall, -1, '面板 body 里必须调用一次 useColorScheme()')
  assert.notEqual(skeletonReturn, -1)
  assert.ok(hookCall < skeletonReturn,
    'useColorScheme() 落在提前 return 之后 → 数据到达那次渲染 hook 数变化 → #310')
})

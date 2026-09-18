import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const pluginSource = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')
const functionSource = pluginSource.match(/function formatRemaining\(resetAt, now\) \{[\s\S]*?\n\}/)?.[0]
assert.ok(functionSource, 'formatRemaining must exist in plugin.js')
const formatRemaining = vm.runInNewContext(`${functionSource}\nformatRemaining`)
const cycleSource = pluginSource.match(/function quotaCycleMs\(subscription\) \{[\s\S]*?\n\}/)?.[0]
assert.ok(cycleSource, 'quotaCycleMs must exist in plugin.js')
// M5 起 quotaCycleMs 不再依赖 CYCLE_MS（7 天默认已删，定稿「禁止缺省当 7 天」）。
const quotaCycleMs = vm.runInNewContext(`${cycleSource}\nquotaCycleMs`)

test('quota cycle follows each provider window duration', () => {
  assert.equal(quotaCycleMs({ windowSeconds: 5 * 60 * 60 }), 5 * 60 * 60 * 1000)
  assert.equal(quotaCycleMs({ windowSeconds: 7 * 24 * 60 * 60 }), 7 * 24 * 60 * 60 * 1000)
  assert.equal(quotaCycleMs({ windowSeconds: 30 * 24 * 60 * 60 }), 30 * 24 * 60 * 60 * 1000)
})

// M5（2026-09-18）：去 7 天假设——windowSeconds 缺失/非法必须返回 null（无窗），
// 绝不能回退到内置 7 天（定稿 round2-grok-final §1「windowSeconds 禁止缺省当 7 天」）。
test('missing windowSeconds yields no cycle (null), never a built-in 7-day default', () => {
  assert.equal(quotaCycleMs({}), null)
  assert.equal(quotaCycleMs({ windowSeconds: 0 }), null)
  assert.equal(quotaCycleMs({ windowSeconds: -1 }), null)
  assert.equal(quotaCycleMs(undefined), null)
  assert.equal(quotaCycleMs(null), null)
})

test('countdown includes whole minutes after days and hours', () => {
  const now = 1_000_000
  const remaining = (((1 * 24 + 2) * 60 + 3) * 60 + 4) * 1000
  assert.equal(formatRemaining(now + remaining, now), '1d 2h 3m')
})

test('reset metadata column reserves width for minute text and surplus cells', () => {
  const columns = pluginSource.match(/const QUOTA_GRID_COLUMNS = '([^']+)'/)?.[1]
  assert.equal(columns, '6.5rem 3.75rem 9.5rem minmax(6rem, 1fr)')
})

const layoutSource = pluginSource.match(/function quotaRowLayout\(containerWidth\) \{[\s\S]*?\n\}/)?.[0]
assert.ok(layoutSource, 'quotaRowLayout must exist in plugin.js')
const quotaRowLayout = vm.runInNewContext(
  `const NARROW_ROW_BREAKPOINT_PX = 28 * 16\n${layoutSource}\nquotaRowLayout`
)

test('narrow two-line template pins text columns and lets the matrix take the rest', () => {
  const narrow = pluginSource.match(/const QUOTA_GRID_COLUMNS_NARROW = '([^']+)'/)?.[1]
  assert.equal(narrow, '5.25rem 3.75rem minmax(0, 1fr)')
  assert.match(pluginSource, /const NARROW_ROW_BREAKPOINT_PX = 28 \* 16/)
})

test('rows switch to the two-line layout only below the single-line fit width', () => {
  assert.equal(quotaRowLayout(320), 'narrow')
  assert.equal(quotaRowLayout(447), 'narrow')
  assert.equal(quotaRowLayout(448), 'wide')
  assert.equal(quotaRowLayout(900), 'wide')
  // Width 0 means "not measured yet" — never collapse into narrow on missing data.
  assert.equal(quotaRowLayout(0), 'wide')
})

test('countdown floors partial minutes', () => {
  const now = 1_000_000
  assert.equal(formatRemaining(now + (59 * 60 + 59) * 1000, now), '0d 0h 59m')
})

test('expired countdown clamps every unit to zero', () => {
  assert.equal(formatRemaining(1_000, 2_000), '0d 0h 0m')
})

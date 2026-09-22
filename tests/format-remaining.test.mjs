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

test('reset metadata column keeps the fixed-track shape (meta 宽度由量测预算管)', () => {
  const columns = pluginSource.match(/const QUOTA_GRID_COLUMNS = '([^']+)'/)?.[1]
  // 只有矩阵轨道伸缩，前三条是固定轨道（跨行对齐靠它）。meta 轨道到底要多宽，
  // 由 tests/reset-column-fit.test.mjs 按实测宽度预算断言 —— 这里钉形状，不钉数值。
  assert.match(columns, /^6\.5rem 3\.75rem [\d.]+rem minmax\(6rem, 1fr\)$/)
})

const layoutSource = pluginSource.match(/function quotaRowLayout\(containerWidth\) \{[\s\S]*?\n\}/)?.[0]
assert.ok(layoutSource, 'quotaRowLayout must exist in plugin.js')
// 断点从源码里取真实表达式（29 * 16），不再在测试里抄一份数字副本。
const breakpointExpression = pluginSource.match(/const NARROW_ROW_BREAKPOINT_PX = ([^\n]+)/)?.[1]
assert.ok(breakpointExpression, 'NARROW_ROW_BREAKPOINT_PX must exist in plugin.js')
const NARROW_ROW_BREAKPOINT_PX = vm.runInNewContext(breakpointExpression)
const quotaRowLayout = vm.runInNewContext(
  `const NARROW_ROW_BREAKPOINT_PX = ${breakpointExpression}\n${layoutSource}\nquotaRowLayout`
)

test('narrow two-line template pins text columns and lets the matrix take the rest', () => {
  const narrow = pluginSource.match(/const QUOTA_GRID_COLUMNS_NARROW = '([^']+)'/)?.[1]
  assert.equal(narrow, '5.25rem 3.75rem minmax(0, 1fr)')
  // 断点必须够宽才能容下宽排布局（不变量在 reset-column-fit.test.mjs 里核）。
  assert.match(pluginSource, /const NARROW_ROW_BREAKPOINT_PX = \d+ \* 16/)
})

test('rows switch to the two-line layout only below the single-line fit width', () => {
  assert.equal(quotaRowLayout(320), 'narrow')
  assert.equal(quotaRowLayout(NARROW_ROW_BREAKPOINT_PX - 1), 'narrow')
  assert.equal(quotaRowLayout(NARROW_ROW_BREAKPOINT_PX), 'wide')
  assert.equal(quotaRowLayout(900), 'wide')
  // Width 0 means "not measured yet" — never collapse into narrow on missing data.
  assert.equal(quotaRowLayout(0), 'wide')
})

test('countdown floors partial minutes', () => {
  const now = 1_000_000
  assert.equal(formatRemaining(now + (59 * 60 + 59) * 1000, now), '59m')
})

test('expired countdown clamps every unit to zero', () => {
  assert.equal(formatRemaining(1_000, 2_000), '0m')
})

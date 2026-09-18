import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const pluginSource = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')

test('balance blocks wrap as whole units and dividers stay visually centered', () => {
  // 2026-09-10 Neal 定：等宽 grid 改内容紧凑 flex——条目文字长短不一，等宽列里
  // 条目间分隔线无法视觉居中；flex-wrap 同样保证整条换行（整组移动不拆字段）。
  assert.match(
    pluginSource,
    /className:\s*'relative flex min-w-0 flex-wrap items-center gap-y-1[^']*'/,
    'balance entries lay out content-packed and wrap as whole units (lane is the positioning context)'
  )
  assert.match(
    pluginSource,
    /columnGap: 24/,
    'entry spacing comes from columnGap so wrapped row-leading entries are not indented'
  )
  assert.doesNotMatch(
    pluginSource,
    /gridTemplateColumns:\s*'repeat\(auto-fit/,
    'equal-width grid columns were retired: they pushed entry dividers off-center'
  )
  assert.match(
    pluginSource,
    /className:\s*'relative flex min-w-0 items-center'/,
    'each balance entry is the containing block for its divider'
  )
  assert.match(
    pluginSource,
    /index > 0 && balanceRowTops\[index\] === balanceRowTops\[index - 1\]/,
    'divider renders only between two entries sharing a row (wrapped row leaders draw none)'
  )
  assert.match(
    pluginSource,
    /position: 'absolute',\s*\n\s*left: -12,/,
    'divider is absolutely centered in the columnGap between same-row entries'
  )
  assert.doesNotMatch(
    pluginSource,
    /Math\.max\(balanceRows\.length, 1\)/,
    'the layout must derive from available width, not force every entry onto one row'
  )

  const balanceRow = pluginSource.match(/function BalanceSpendRow\([\s\S]*?\n\}/)?.[0] || ''
  assert.ok(balanceRow, 'BalanceSpendRow must exist')
  assert.match(
    balanceRow,
    /className:\s*'flex min-w-0 items-center gap-2 overflow-hidden rounded px-1\.5 py-0 text-left'/,
    'each balance card must clip its own paint area and keep one compact gap before metrics'
  )
  assert.match(
    balanceRow,
    /className:\s*'flex shrink-0 items-center gap-2'/,
    'the provider name must size to its own text so the metric starts after the same fixed gap'
  )
  assert.doesNotMatch(
    balanceRow,
    /w-20/,
    'the provider name must not reserve a fixed 5rem column that makes short names look detached'
  )
  assert.match(
    balanceRow,
    /className:\s*'flex min-w-0 flex-1 flex-nowrap items-baseline gap-x-2 overflow-hidden'/,
    'all four balance metrics must stay on one line inside the entry'
  )
  assert.doesNotMatch(
    balanceRow,
    /flex-wrap/,
    'a balance entry must wrap as a whole block instead of wrapping its metrics internally'
  )
})

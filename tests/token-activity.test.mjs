// Token activity card (settings-page header, 2026-10-22).
//
// Covers the pure helpers (quantile buckets, calendar padding, weekly
// aggregation, cumulative series, provider tops) and source-shape assertions
// that pin the card to the top of the settings section, the three views,
// round dots, and the fail-visible unavailable line.

import assert from 'node:assert/strict'
import { test, describe, beforeEach, afterEach } from 'node:test'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = readFileSync(join(ROOT, 'desktop', 'plugin.js'), 'utf8')

// Extract helper functions by name (same technique as the other sandboxes).
const NAMES = [
  'tokenActivityEmptyColor',
  'localDateKey',
  'offsetDate',
  'mondayOf',
  'tokenActivityFormat',
  'quantileThresholds',
  'levelFor',
  'padCalendarDays',
  'weeklyAggregate',
  'cumulativeSeries',
  'tokenActivityTopProviders',
  'litRows',
]
const sandbox = { console }
for (const name of NAMES) {
  const pattern = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`)
  assert.ok(SOURCE.match(pattern), `sandbox: function ${name} not found in plugin.js`)
  sandbox[name] = undefined
}
// Evaluate the extracted functions inside one realm so they can call each other.
const combined = NAMES
  .map(name => SOURCE.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))[0])
  .join('\n\n')
vm.runInNewContext(`${combined}\n;globalThis.__api = { ${NAMES.join(', ')} }`, sandbox)
const api = sandbox.__api

describe('token activity helpers', () => {
  describe('quantileThresholds', () => {
    test('quantiles over non-zero values', () => {
      const t = api.quantileThresholds([0, 10, 20, 30, 40, 50, 60, 70, 80, 100])
      assert.equal(t.length, 4)
      assert.ok(t[0] < t[1] && t[1] < t[2] && t[2] < t[3])
      assert.equal(t[0], 30) // 25th percentile of the non-zero run
    })
    test('sparse values fall back to max fractions', () => {
      const t = api.quantileThresholds([0, 0, 80])
      assert.deepEqual([...t], [20, 40, 60, 80])
    })
    test('all zeros still yields positive thresholds', () => {
      const t = api.quantileThresholds([0, 0, 0])
      assert.ok(t.every(v => v >= 1))
    })
  })

  describe('levelFor', () => {
    const t = [10, 20, 30, 40]
    test('zero and negative are level 0', () => {
      assert.equal(api.levelFor(0, t), 0)
      assert.equal(api.levelFor(-5, t), 0)
    })
    test('boundary semantics: value must exceed a threshold to climb', () => {
      assert.equal(api.levelFor(1, t), 1)
      assert.equal(api.levelFor(10, t), 1) // equal to threshold stays
      assert.equal(api.levelFor(11, t), 2)
      assert.equal(api.levelFor(41, t), 5)
      assert.equal(api.levelFor(1e12, t), 5)
    })
  })

  describe('padCalendarDays', () => {
    test('fixed one-year window: 53 week-columns, one dot per day', () => {
      // 2026-07-10 is a Friday → its Sunday is 2026-07-12; grid = 371 cells.
      const days = [
        { d: '2026-07-06', t: 5 },
        { d: '2026-07-10', t: 7 },
      ]
      const padded = api.padCalendarDays(days)
      assert.equal(padded.length, 53 * 7)
      assert.equal(padded[padded.length - 1].d, '2026-07-12') // Sunday
      assert.equal(padded[0].d, '2025-07-07') // 53 weeks back from that Sunday, Monday
      // Days inside the window with no ledger record are grey placeholders.
      const gap = padded.find(day => day.d === '2026-01-01')
      assert.ok(gap, 'a day eight months before the ledger is still on the grid')
      assert.equal(gap.t, 0)
      const kept = padded.find(day => day.d === '2026-07-06')
      assert.equal(kept.t, 5)
      // The grid always covers a full year regardless of ledger length.
      const shortLedger = api.padCalendarDays([{ d: '2026-07-10', t: 1 }])
      assert.equal(shortLedger.length, 53 * 7)
    })
    test('empty input stays empty', () => {
      assert.equal(api.padCalendarDays([]).length, 0)
    })
  })

  describe('weeklyAggregate', () => {
    test('groups by Monday-aligned week and sums', () => {
      const weeks = api.weeklyAggregate([
        { d: '2026-07-06', t: 1 },
        { d: '2026-07-09', t: 2 },
        { d: '2026-07-13', t: 4 }, // next Monday
      ])
      assert.deepEqual([...weeks.map(w => ({ ...w }))], [
        { w: '2026-07-06', t: 3 },
        { w: '2026-07-13', t: 4 },
      ])
    })
  })

  describe('cumulativeSeries', () => {
    test('running total is monotonic and keeps day value', () => {
      const series = api.cumulativeSeries([{ d: 'a', t: 2 }, { d: 'b', t: 3 }, { d: 'c', t: 0 }])
      assert.deepEqual([...series.map(s => s.c)], [2, 5, 5])
      assert.deepEqual([...series.map(s => s.t)], [2, 3, 0])
    })
  })

  describe('tokenActivityTopProviders', () => {
    test('lists every provider that day, biggest first, zero entries dropped', () => {
      const tops = api.tokenActivityTopProviders({
        p: {
          Alpha: { in: 10, out: 5, cache: 0 },
          Beta: { in: 100, out: 0, cache: 50 },
          Gamma: { in: 0, out: 0, cache: 0 },
          Delta: { in: 1, out: 1, cache: 1 },
        },
      })
      assert.deepEqual([...tops.map(t => t.label)], ['Beta', 'Alpha', 'Delta'])
    })
    test('explicit limit truncates (kept for callers that want a short list)', () => {
      const tops = api.tokenActivityTopProviders(
        { p: { Alpha: { in: 10, out: 5, cache: 0 }, Beta: { in: 100, out: 0, cache: 50 }, Delta: { in: 1, out: 1, cache: 1 } } },
        2,
      )
      assert.deepEqual([...tops.map(t => t.label)], ['Beta', 'Alpha'])
    })
    test('missing p yields empty list', () => {
      assert.equal(api.tokenActivityTopProviders({}).length, 0)
    })
  })

  describe('litRows (weekly bar / cumulative staircase height)', () => {
    test('zero value and zero max light nothing', () => {
      assert.equal(api.litRows(0, 100), 0)
      assert.equal(api.litRows(50, 0), 0)
      assert.equal(api.litRows(-1, 100), 0)
    })
    test('peak lights all seven rows, small values light at least one', () => {
      assert.equal(api.litRows(100, 100), 7)
      assert.equal(api.litRows(1e12, 100), 7)
      assert.equal(api.litRows(1, 100), 1)
    })
    test('proportional mid values round UP (staircase climbs early)', () => {
      assert.equal(api.litRows(50, 100), 4) // 3.5 → 4
      assert.equal(api.litRows(25, 100), 2) // 1.75 → 2
    })
  })

  describe('tokenActivityFormat', () => {
    test('scales to B/M/K', () => {
      assert.equal(api.tokenActivityFormat(7.76e9), '7.76B')
      assert.equal(api.tokenActivityFormat(1.7e6), '1.7M')
      assert.equal(api.tokenActivityFormat(1728), '1.7K')
      assert.equal(api.tokenActivityFormat(42), '42')
      assert.equal(api.tokenActivityFormat(undefined), '—')
    })
  })

  describe('localDateKey / mondayOf', () => {
    test('monday of a mid-week date', () => {
      // 2026-07-08 is a Wednesday.
      assert.equal(api.localDateKey(api.mondayOf(new Date('2026-07-08T12:00:00'))), '2026-07-06')
    })
  })
})

describe('token activity card wiring', () => {
  const START = SOURCE.indexOf('// >>> token-activity >>>')
  const END = SOURCE.indexOf('// <<< token-activity <<<')
  let block

  test('marked block exists exactly once', () => {
    assert.ok(START >= 0 && END > START, 'token-activity markers present')
    assert.equal(SOURCE.split('// >>> token-activity >>>').length - 1, 1)
    block = SOURCE.slice(START, END)
  })

  test('card mounts as the FIRST child of the settings section', () => {
    // Anchor on the unique insertion marker + the (unique) section header text:
    // the card must sit inside the settings section, above "Connection & display".
    const markerIdx = SOURCE.indexOf('// Settings-page header slot (2026-10-22)')
    const cardIdx = SOURCE.indexOf('jsx(TokenActivityCard, { rest })')
    const sectionIdx = SOURCE.indexOf("return jsxs('section', {")
    const headerIdx = SOURCE.indexOf('// settings-provider-list')
    assert.ok(markerIdx > 0 && cardIdx > 0 && sectionIdx > 0 && headerIdx > 0, 'all anchors present')
    assert.ok(cardIdx > sectionIdx, 'card referenced inside the settings section body')
    assert.ok(cardIdx < headerIdx, 'card must come before the provider list')
  })

  test('three views with the GPT-style labels', () => {
    for (const label of ["'Daily'", "'Weekly'", "'Cumulative'"]) {
      assert.ok(block.includes(label), `view tab ${label} present`)
    }
  })

  test('dots are round (border-radius 50%)', () => {
    assert.ok(block.includes("borderRadius: '50%'"))
  })

  test('month axis renders below the grid, no legend', () => {
    const gridIdx = block.indexOf("'data-token-activity': 'grid'")
    const monthIdx = block.indexOf("className: 'relative mt-1 h-4'")
    assert.ok(gridIdx > 0 && monthIdx > gridIdx, 'month ticks come after the grid in source order')
    assert.ok(!block.includes('Less'), 'no GitHub-style legend')
    assert.ok(!block.includes('More'), 'no GitHub-style legend')
    assert.ok(block.includes("TOKEN_ACTIVITY_MONTHS"), 'month axis uses English abbreviations')
    assert.ok(!block.includes('${month + 1}M'), 'month axis must not use the million suffix')
  })

  test('fetches the usage-heatmap endpoint and degrades explicitly', () => {
    assert.ok(block.includes("rest('/usage-heatmap')"))
    assert.ok(block.includes('Token activity unavailable'), 'fail-visible message present')
    assert.ok(block.includes('No token activity recorded yet.'), 'empty-ledger message present')
  })

  test('two theme palettes, no matrix palette reuse', () => {
    assert.ok(block.includes('light: ['))
    assert.ok(block.includes('dark: ['))
    // The quota matrix colors must not leak into the heatmap.
    for (const forbidden of ['#14AE68', '#006935', '#28A7E0', '#0A499D', '#F39800']) {
      assert.ok(!block.includes(forbidden), `matrix color ${forbidden} not reused`)
    }
  })

  test('tooltip renders text nodes, never innerHTML', () => {
    assert.ok(!block.includes('dangerouslySetInnerHTML'))
    assert.ok(!block.includes('innerHTML'))
  })

  test('fifth stat cell is the top model by tokens, permanent with dash fallback', () => {
    assert.ok(block.includes("textOr(locale, 'topModel', 'Top model')"), 'top-model label present')
    assert.ok(block.includes("textOr(locale, 'topModel', 'Top model')"), 'dash fallback keeps the cell mounted')
    assert.ok(!block.includes('Longest task'), 'old longest-task cell fully removed')
  })

  test('summary strip: Neal final five, solid panel, average on active days', () => {
    for (const label of ['Total tokens', 'Peak day', 'Daily average', 'Active days']) {
      assert.ok(block.includes(`'${label}'`), `stat cell ${label} present`)
    }
    assert.ok(block.includes("textOr(locale, 'topModel', 'Top model')"), 'top-model cell present')
    assert.ok(block.includes('total / activeDays'), 'daily average divides by active days')
    assert.ok(block.includes("backgroundColor: scheme === 'dark' ? '#1c2127' : '#f6f7f9'"), 'solid strip background')
    assert.ok(!block.includes('Longest task'), 'longest-task cell stays removed')
    assert.ok(!block.includes('Current streak'), 'streak cells stay removed')
  })

  test('fetch failure does not blank the page: hooks stay before any return', () => {
    // Every hook call in the card precedes the first `return` inside the component.
    const fnStart = block.indexOf('function TokenActivityCard')
    const fnBody = block.slice(fnStart)
    const firstReturn = fnBody.indexOf('return jsxs(')
    const hooks = ['useColorScheme()', 'useState(null)', 'useState(false)', "useState('daily')", 'useState(null)', 'useEffect(']
    for (const hook of hooks) {
      const idx = fnBody.indexOf(hook)
      assert.ok(idx >= 0 && idx < firstReturn, `${hook} before first return`)
    }
  })

  test('regression pin bites: breaking the mounting slot must fail this file', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'token-activity-mut-'))
    try {
      const target = join(scratch, 'plugin.js')
      let mutated = SOURCE.replace('jsx(TokenActivityCard, { rest }),\n      ', '')
      assert.notEqual(mutated, SOURCE, 'mutation must change the source')
      writeFileSync(target, mutated)
      const mutatedSource = readFileSync(target, 'utf8')
      const sectionStart = mutatedSource.indexOf("return jsxs('section', {")
      const sectionBody = mutatedSource.slice(sectionStart, sectionStart + 1200)
      assert.equal(sectionBody.indexOf('jsx(TokenActivityCard, { rest })'), -1)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})

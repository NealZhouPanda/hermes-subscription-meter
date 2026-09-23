import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const pluginSource = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

test('quota rows keep a compact six-pixel rhythm and balanced section spacing', () => {
  assert.match(pluginSource, /rowGap: 6, paddingTop: 8, paddingBottom: 8/)
  assert.match(pluginSource, /marginTop: 2, paddingTop: 8/)
  const quotaRow = pluginSource.match(/function WeeklyQuotaRow\([\s\S]*?\n\}/)?.[0] || ''
  assert.ok(quotaRow, 'WeeklyQuotaRow must exist')
  assert.doesNotMatch(
    quotaRow,
    /flex-1/,
    'quota rows must keep their natural 1.2rem height instead of stretching into free pane space'
  )
  assert.match(
    pluginSource,
    /flex h-full min-w-0 flex-col gap-y-1 overflow-y-auto/,
    'the body keeps its compact flex stack; inline spacing supplies the six-pixel rhythm'
  )
  assert.match(
    pluginSource,
    /flex min-w-0 flex-wrap items-center gap-y-1/,
    'the balance wrap must keep the same 4px row gap as the body stack'
  )
})

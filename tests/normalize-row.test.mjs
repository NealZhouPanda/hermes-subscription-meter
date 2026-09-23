import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const pluginSource = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

function extract(name) {
  const source = pluginSource.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0]
  assert.ok(source, `${name} must exist in plugin.js`)
  return source
}

const helpers = ['clamp', 'toEpochMillis', 'numericOrNull', 'sanitizeRowError', 'normalizeBurstShare', 'normalizePeakHours', 'normalizeRow']
  .map(extract)
  .join('\n')
const normalizeRow = vm.runInNewContext(`${helpers}\nnormalizeRow`)

test('normalization preserves provider-neutral quota metadata', () => {
  const row = normalizeRow({
    id: 'codex:session',
    providerId: 'codex',
    accountId: 'default',
    label: 'CODEX',
    kind: 'quota',
    windowLabel: 'Session',
    windowSeconds: 18_000,
    usedPercent: 25,
    resetAt: 1_788_000_000
  })

  assert.equal(row.kind, 'quota')
  assert.equal(row.providerId, 'codex')
  assert.equal(row.accountId, 'default')
  assert.equal(row.windowLabel, 'Session')
  assert.equal(row.windowSeconds, 18_000)
})

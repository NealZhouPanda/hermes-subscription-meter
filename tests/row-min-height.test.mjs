import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const pluginSource = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')

function functionSource(name, nextName) {
  const start = pluginSource.indexOf(`function ${name}(`)
  const end = pluginSource.indexOf(`function ${nextName}(`, start + 1)
  assert.notEqual(start, -1, `${name} must exist`)
  assert.notEqual(end, -1, `${nextName} must exist`)
  return pluginSource.slice(start, end)
}

test('weekly and balance rows share the same readable minimum height', () => {
  const balanceRow = functionSource('BalanceSpendRow', 'WeeklyMeter')
  const weeklyRow = functionSource('WeeklyQuotaRow', 'ProviderSettingsPanel')

  assert.match(balanceRow, /minHeight:\s*'1\.2rem'/, 'balance rows must use the shared 1.2rem minimum')
  assert.match(weeklyRow, /minHeight:\s*'1\.2rem'/, 'weekly rows must use the shared 1.2rem minimum')
  assert.doesNotMatch(balanceRow, /py-1/, 'balance row padding must not force a taller minimum')
  assert.doesNotMatch(weeklyRow, /py-1/, 'weekly row padding must not force a taller minimum')
})

test('the meter scrolls instead of compressing rows below their minimum', () => {
  const body = functionSource('SubscriptionMeterBody', 'SubscriptionMeterPage')
  assert.match(body, /overflow-y-auto/)
})

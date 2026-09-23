import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const pluginSource = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

test('provider settings UI saves visibility and refreshes meter views', () => {
  assert.match(pluginSource, /function ProviderSettingsPanel\(/)
  assert.match(pluginSource, /jsx\(Switch,/)
  assert.match(pluginSource, /`\/settings\/\$\{encodeURIComponent\(providerId\)\}`/)
  assert.match(pluginSource, /method:\s*'PUT'/)
  assert.match(pluginSource, /subscription-meter:settings-changed/)
})

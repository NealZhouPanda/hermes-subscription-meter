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

// 2026-10-03 Neal 定：需要额外填一条 API 的家要在设置里说清（原话「都表明在设置里」）。
// 落地方式：后端拼好 requires / optional 两句，设置页每张卡直接摆出来——不再只活在
// 默认折叠的 Setup & access 里；前端一个供应商名都不认，所以这里也钉住「没有写死」。
test('provider settings card shows what the provider needs and what is optional', () => {
  assert.match(pluginSource, /'data-credentials': 'requires'/)
  assert.match(pluginSource, /'data-credentials': 'optional'/)
  assert.match(pluginSource, /children: `Needs: \$\{provider\.credentials\.requires\}`/)
  assert.match(pluginSource, /children: `Optional: \$\{provider\.credentials\.optional\}`/)
  // 缺字段（老后端 / 没有凭据可说的家）不画，也不炸。
  assert.match(
    pluginSource,
    /provider\.credentials && provider\.credentials\.requires/,
    'requires 缺失时整行不出现（老后端兼容）'
  )
  assert.doesNotMatch(
    pluginSource,
    /DEEPSEEK_PLATFORM_TOKEN|XAI_TEAM_ID|ALIBABA_CLOUD_ACCESS_KEY/,
    '凭据文案必须由后端下发——前端不得出现任何供应商专属 env 名'
  )
})

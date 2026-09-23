// 切 profile 立刻换数（2026-09-12 Neal 定）：面板订阅 SDK 的活动 profile 原子
// （host.state.profile = $activeGatewayProfile，就是决定 ctx.rest 路由到哪个后端的那颗），
// 变了就重取，不轮询、不读 App 内部键。这里测的是「响应归属校验」这条契约——
// 请求发出时与回来时的 profile 不一致，那份数据属于上一个 profile，必须丢弃。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const pluginSource = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

function loadGuard() {
  const match = pluginSource.match(/function responseProfileIsStale\(([\s\S]*?)\n\}/)
  assert.ok(match, 'responseProfileIsStale must exist in plugin.js')
  return new Function(`${match[0]}; return responseProfileIsStale`)()
}

test('同一个 profile 的响应不算过期', () => {
  const isStale = loadGuard()
  assert.equal(isStale('default', 'default'), false)
  assert.equal(isStale('profile-a', 'profile-a'), false)
})

test('飞行中切了 profile → 那份响应判为过期（丢弃）', () => {
  const isStale = loadGuard()
  assert.equal(isStale('default', 'profile-a'), true)
  assert.equal(isStale('profile-a', 'default'), true)
})

test('拿不到 profile（null/undefined）也要能判出差异，不许静默当成同一份', () => {
  const isStale = loadGuard()
  assert.equal(isStale(null, 'default'), true)
  assert.equal(isStale('default', null), true)
  assert.equal(isStale(null, null), false)
})

// B5（2026-09-26，全球用户审计 #5）：高峰时段提示必须给出**用户本地时间**。
// 供应商的 peakHours 带的是它自己的时区，只写「Peak hours」对别的时区用户等于没说。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const pluginSource = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

const sliceFunction = name => {
  const block = pluginSource.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))?.[0]
  assert.ok(block, `plugin.js 必须有 function ${name}`)
  return block
}
const sliceConst = name => {
  const block = pluginSource.match(new RegExp(`const ${name} = [\\s\\S]*?\\n\\}`))?.[0]
  assert.ok(block, `plugin.js 必须有 const ${name}`)
  return block
}

const sandbox = vm.runInNewContext([
  sliceFunction('zoneOffsetMinutes'),
  sliceConst('minutesToClock'),
  sliceFunction('localTimeZone'),
  sliceFunction('peakWindowText'),
  ';({ zoneOffsetMinutes, minutesToClock, peakWindowText })'
].join('\n'), { console, Intl })

// 固定时刻：2026-09-26 06:00 UTC（= 上海 14:00、纽约 02:00，都在夏令时/标准时稳定段内）
const NOW = Date.UTC(2026, 8, 26, 6, 0, 0)
const SHANGHAI_2PM_6PM = { timezone: 'Asia/Shanghai', daily: false, windows: [[14 * 60, 18 * 60]] }

test('高峰窗口同时给出供应商时区与用户本地时间', () => {
  assert.equal(
    sandbox.peakWindowText(SHANGHAI_2PM_6PM, NOW, 'Asia/Shanghai'),
    'Peak hours: Mon–Fri 14:00–18:00 (Asia/Shanghai)',
    '同一时区不必重复换算'
  )
  assert.equal(
    sandbox.peakWindowText(SHANGHAI_2PM_6PM, NOW, 'UTC'),
    'Peak hours: Mon–Fri 14:00–18:00 (Asia/Shanghai) = 06:00–10:00 your time'
  )
  assert.equal(
    sandbox.peakWindowText(SHANGHAI_2PM_6PM, NOW, 'America/New_York'),
    'Peak hours: Mon–Fri 14:00–18:00 (Asia/Shanghai) = 02:00–06:00 your time'
  )
})

test('时区偏移按当前时刻算（夏令时靠 Intl，不写死 +8/−5）', () => {
  const shanghai = sandbox.zoneOffsetMinutes('Asia/Shanghai', NOW)
  const newYorkSummer = sandbox.zoneOffsetMinutes('America/New_York', Date.UTC(2026, 6, 1, 12))
  const newYorkWinter = sandbox.zoneOffsetMinutes('America/New_York', Date.UTC(2026, 0, 1, 12))
  assert.equal(shanghai, 480)
  assert.equal(newYorkSummer, -240, '7 月是 EDT（−4）')
  assert.equal(newYorkWinter, -300, '1 月是 EST（−5）：不能写死一个数')
})

test('跨午夜 / 多窗口 / 每天 vs 工作日', () => {
  const overnight = { timezone: 'Asia/Shanghai', daily: true, windows: [[23 * 60, 60]] }
  assert.equal(
    sandbox.peakWindowText(overnight, NOW, 'UTC'),
    'Peak hours: Daily 23:00–01:00 (Asia/Shanghai) = 15:00–17:00 your time',
    '跨午夜的窗口要绕回来，不是负数'
  )
  const two = { timezone: 'UTC', daily: false, windows: [[9 * 60, 12 * 60], [14 * 60, 18 * 60]] }
  assert.equal(sandbox.peakWindowText(two, NOW, 'UTC'), 'Peak hours: Mon–Fri 09:00–12:00, 14:00–18:00 (UTC)')
})

test('没有高峰规则 / 落后端字段时不编造文案', () => {
  assert.equal(sandbox.peakWindowText(null, NOW, 'UTC'), null)
  assert.equal(sandbox.peakWindowText({ timezone: 'UTC', windows: [] }, NOW, 'UTC'), null)
})

test('PEAK 徽标用这条文案做 title（不是只说 Peak hours）', () => {
  assert.ok(pluginSource.includes("peakWindowText(activePeakRule(subscription, now), now)"),
    'PEAK 徽标的 title 必须走 peakWindowText')
  assert.ok(!pluginSource.includes("title: 'Peak hours: priority halved"),
    '不该再有写死的高峰说明')
})

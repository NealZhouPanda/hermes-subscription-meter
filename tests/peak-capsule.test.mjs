import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const pluginSource = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

// Extract the priority/sort functions + module constants so tests run the real code.
function loadFns() {
  const names = ['orderRowsForDisplay', 'rowPriority', 'activePeakRule', 'localClockAt', 'peakRuleHit', 'surplusBlocks', 'collapseDuplicateQuotaRows', 'quotaCycleMs', 'clamp', 'toEpochMillis']
  const snippets = names.map(name => {
    const match = pluginSource.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))
    assert.ok(match, `function ${name} must exist in plugin.js`)
    return match[0]
  })
  // 单行常量按行提取；PEAK_RULES 是多行对象，单独匹配到首个顶格 }。
  // 不能用「吞到 ^}」的宽松正则——不同常量的 blob 会重叠，重复 const 直接语法错误。
  // M5：CYCLE_MS 已删（7 天默认不再是前端事实），沙箱只注入 CELL_COUNT。
  const constants = ['CELL_COUNT'].map(name => {
    const match = pluginSource.match(new RegExp(`^const ${name} = [^\\n]*\\n`, 'm'))
    assert.ok(match, `constant ${name} must exist in plugin.js`)
    return match[0]
  })
  return new Function(`${[...constants, ...snippets].join('\n\n')}; return { orderRowsForDisplay, rowPriority, activePeakRule }`)()
}

const NOW = Date.parse('2026-09-06T12:00:00+08:00') // Sunday noon BJ — outside all peak windows
const HOUR = 60 * 60 * 1000
const WEEK = 7 * 24 * HOUR

// 高峰事实住在行上（后端抄进行），前端没有供应商表：
// GLM=周一至五 14:00–18:00；DEEPSEEK=周一至五 09:00–12:00、14:00–18:00（两家均非「每天」）。
const GLM_PEAK = { timezone: '+08:00', daily: false, windows: [[840, 1080]] }
const DEEPSEEK_PEAK = { timezone: '+08:00', daily: false, windows: [[540, 720], [840, 1080]] }

function quotaRow(label, usedPercent, hoursUntilReset) {
  return {
    kind: 'quota',
    providerId: label,
    label,
    usedPercent,
    windowSeconds: WEEK / 1000,
    resetAt: NOW + hoursUntilReset * HOUR
  }
}

test('priority sort: surplus leader first; 用超进度记负分（欠得越深越靠后，用满恒垫底）', () => {
  const { orderRowsForDisplay: sort } = loadFns()
  // 2026-09-06 截图口径：GLM 已流逝5/168 仅用2% → 富余；KIMI 61/100 ≈ 进度持平 → 负分。
  const rows = [
    quotaRow('GLM', 2, 163),
    quotaRow('GROK', 100, 47),
    quotaRow('KIMI', 61, 68),
    quotaRow('CODEX', 16, 162)
  ]
  const order = sort(rows, NOW).map(row => row.label)
  // P：GLM +0.010 > KIMI −0.037 > CODEX −0.129 > GROK −1（用满恒 −1）。
  // 09-12 前把负富余截断成 0，GROK 靠「重置最近」压过 KIMI/CODEX 排第 2；记负分后沉底。
  assert.deepEqual(order, ['GLM', 'KIMI', 'CODEX', 'GROK'])
})

test('blue-green ratio: surplus leader stays #1 even when peak-halved (09-09 screenshot)', () => {
  const { orderRowsForDisplay: sort } = loadFns()
  const WED_PEAK = Date.parse('2026-09-09T15:00:00+08:00') // weekday inside GLM peak
  // 09-09 实况：KIMI 98% left/5d21h46m，CODEX 84%/5d23h42m，GLM 78%/2d20h29m。
  const rows = [
    { kind: 'quota', providerId: 'KIMI', label: 'KIMI', usedPercent: 2, windowSeconds: 604800, resetAt: WED_PEAK + (5 * 24 + 21.767) * HOUR },
    { kind: 'quota', providerId: 'CODEX', label: 'CODEX', usedPercent: 16, windowSeconds: 604800, resetAt: WED_PEAK + (5 * 24 + 23.7) * HOUR },
    { kind: 'quota', providerId: 'GLM', label: 'GLM', usedPercent: 22, windowSeconds: 604800, resetAt: WED_PEAK + (2 * 24 + 20.483) * HOUR, peakHours: GLM_PEAK }
  ]
  // GLM P=0.913，高峰 ÷2 → 0.457 仍 > KIMI 0.162：惩罚不得把富余王拉下马（Neal 09-09 定）。
  assert.deepEqual(sort(rows, WED_PEAK).map(r => r.label), ['GLM', 'KIMI', 'CODEX'])
})

test('equal-ish surplus: peak penalty alone flips GLM below the non-peak row', () => {
  const { orderRowsForDisplay: sort } = loadFns()
  const WED_PEAK = Date.parse('2026-09-09T15:00:00+08:00')
  // GLM 富余略高（u=25 vs 30），高峰 ÷2 后反输；同一份数据离峰则赢——只有惩罚在起作用。
  const rows = [
    { kind: 'quota', providerId: 'KIMI', label: 'KIMI', usedPercent: 30, windowSeconds: 604800, resetAt: WED_PEAK + 48 * HOUR },
    { kind: 'quota', providerId: 'GLM', label: 'GLM', usedPercent: 25, windowSeconds: 604800, resetAt: WED_PEAK + 48 * HOUR, peakHours: GLM_PEAK }
  ]
  assert.deepEqual(sort(rows, WED_PEAK).map(r => r.label), ['KIMI', 'GLM'])
  const WED_OFFPEAK = Date.parse('2026-09-09T13:00:00+08:00')
  const rowsOff = rows.map(r => ({ ...r, resetAt: WED_OFFPEAK + 48 * HOUR }))
  assert.deepEqual(sort(rowsOff, WED_OFFPEAK).map(r => r.label), ['GLM', 'KIMI'])
})

test('GLM quota row is halved only inside the weekday 14-18 peak window', () => {
  const { orderRowsForDisplay: sort } = loadFns()
  // Rows must be built relative to EACH instant: an expired window sinks regardless.
  const at = iso => {
    const now = Date.parse(iso)
    const rows = [
      { kind: 'quota', providerId: 'OTHER', label: 'OTHER', usedPercent: 50, windowSeconds: 604800, resetAt: now + 48 * HOUR },
      { kind: 'quota', providerId: 'GLM', label: 'GLM', usedPercent: 40, windowSeconds: 604800, resetAt: now + 48 * HOUR, peakHours: GLM_PEAK }
    ]
    return sort(rows, now).map(r => r.label)
  }
  assert.deepEqual(at('2026-09-09T15:00:00+08:00'), ['OTHER', 'GLM'], 'inside peak: GLM halved → loses despite more remaining')
  assert.deepEqual(at('2026-09-09T13:00:00+08:00'), ['GLM', 'OTHER'], 'off-peak: full weight → wins')
})

test('DEEPSEEK peaks on weekdays only; weekends are off-peak for both (official rule)', () => {
  const { activePeakRule } = loadFns()
  const sunday930 = Date.parse('2026-09-13T09:30:00+08:00')
  assert.equal(activePeakRule({ providerId: 'deepseek', peakHours: DEEPSEEK_PEAK }, sunday930), null, 'weekend morning ≠ peak (official: weekday-only)')
  assert.equal(activePeakRule({ providerId: 'glm', peakHours: GLM_PEAK }, sunday930), null, 'GLM weekend ≠ peak')
  const wed930 = Date.parse('2026-09-09T09:30:00+08:00')
  assert.ok(activePeakRule({ providerId: 'deepseek', peakHours: DEEPSEEK_PEAK }, wed930), 'weekday 9:30 inside morning peak')
  const sat1200 = Date.parse('2026-09-12T12:00:00+08:00')
  assert.equal(activePeakRule({ providerId: 'deepseek', peakHours: DEEPSEEK_PEAK }, sat1200), null, 'Saturday noon ≠ peak')
})

test('用满的行恒垫底，即使它重置最近（2026-09-12 GROK 实况钉）；无 resetAt 的行仍沉底', () => {
  const { orderRowsForDisplay: sort } = loadFns()
  // 09-12 13:39 实况：GROK 周额度用满（剩 0%）且 48.8h 后重置——全场重置最近，
  // 旧规则（负富余截断成 0 + 同分按重置近）把它抬到第 2，剩 96% 的 GLM 反而垫底。
  const AUG_NOW = Date.parse('2026-09-12T13:39:00+08:00')
  const H = 60 * 60 * 1000
  const liveRow = (label, usedPercent, hoursUntilReset, resetAt) => ({
    kind: 'quota',
    providerId: label,
    label,
    usedPercent,
    windowSeconds: 604800,
    resetAt: resetAt === undefined ? AUG_NOW + hoursUntilReset * H : resetAt
  })
  const rows = [
    liveRow('GROK', 100, 48.83),
    liveRow('CODEX', 80, 72.14),
    liveRow('GLM', 4, 164.91),
    liveRow('KIMI', 38, 70.19),
    liveRow('N', 20, 0, null)
  ]
  // P：KIMI +0.484 > GLM −0.022 > CODEX −0.534 > GROK −1 > N(−Infinity)。
  assert.deepEqual(sort(rows, AUG_NOW).map(row => row.label), ['KIMI', 'GLM', 'CODEX', 'GROK', 'N'])
})

test('balance rows still trail all quota rows', () => {
  const { orderRowsForDisplay: sort } = loadFns()
  const rows = [
    { kind: 'balance', providerId: 'DEEPSEEK', label: 'DEEPSEEK' },
    quotaRow('GROK', 100, 47)
  ]
  const order = sort(rows, NOW).map(row => row.label)
  assert.deepEqual(order, ['GROK', 'DEEPSEEK'])
})

test('PEAK capsule renders on both quota and balance rows', () => {
  const quotaCalls = pluginSource.match(/activePeakRule\(subscription, now\)/g) || []
  // 不再数调用次数（行内现在不止一处用 activePeakRule：门控 + 徽标 title 的本地时间说明），
  // 改成逐个组件检查「有徽标 + 由高峰规则门控」——这才是要守的 invariants。
  assert.ok(quotaCalls.length >= 2, 'capsule wired into WeeklyQuotaRow and BalanceSpendRow')
  assert.match(pluginSource, /children: 'PEAK'/)
  for (const name of ['WeeklyQuotaRow', 'BalanceSpendRow']) {
    const body = pluginSource.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))?.[0]
    assert.ok(body && body.includes("children: 'PEAK'"), `${name} must render the PEAK capsule`)
    assert.ok(body && body.includes('activePeakRule(subscription, now)'), `${name} must gate it on the peak rule`)
  }
})

// 中立行契约（M0，2026-09-15；M2 删表后为唯一契约）：前端只认行上下发的供应商事实。
// 这里用**假供应商 ZETA**（10 天窗 + 3h 短窗 + 份额 0.12，随机值）验证：
// 只给行、不给任何名表条目，锁定段/短窗配对/高峰/强调色都必须正确。
// plugin.js 里已不存在任何按供应商名的表（份额/配色/高峰都在行上）。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const pluginSource = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

function extract(name) {
  const match = pluginSource.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))
  assert.ok(match, `function ${name} must exist in plugin.js`)
  return match[0]
}

function constant(name, { multiline = false } = {}) {
  const pattern = multiline ? `^const ${name} = \\{[\\s\\S]*?\\n\\}` : `^const ${name} = [^\\n]*\\n`
  const match = pluginSource.match(new RegExp(pattern, 'm'))
  assert.ok(match, `constant ${name} must exist in plugin.js`)
  return match[0]
}

const PURE_HELPERS = [
  'clamp', 'numericOrNull', 'normalizeBurstShare', 'normalizePeakHours', 'burstShareOf',
  'lockedRemainingCellCount', 'quotaCellCount', 'findFiveHourSibling',
  'localClockAt', 'peakRuleHit', 'activePeakRule', 'normalizeRow', 'toEpochMillis', 'sanitizeRowError',
  'isMonthlyWindow', 'meterCellCount'
]

const sandbox = new Function(
  [
    constant('CELL_COUNT'),
    // M5：CYCLE_MS 已删，不再注入沙箱（7 天默认不再是前端事实）。
    ...PURE_HELPERS.map(extract)
  ].join('\n\n') +
  `; return { ${PURE_HELPERS.join(', ')} }`
)()

const NOW = Date.parse('2026-09-16T12:00:00+08:00') // Wednesday noon Beijing
const HOUR = 60 * 60 * 1000

// 假供应商：名字、窗口长度、份额全都不在 plugin.js 的任何表里。
function zetaCycle(extra = {}) {
  return {
    kind: 'quota', providerId: 'zeta', label: 'ZETA', usedPercent: 20,
    windowSeconds: 864_000, resetAt: NOW + 120 * HOUR, role: 'cycle', burstShare: 0.12, ...extra
  }
}
function zetaBurst(extra = {}) {
  return {
    kind: 'quota', providerId: 'zeta', label: 'ZETA', usedPercent: 50,
    windowSeconds: 10_800, resetAt: NOW + 1 * HOUR, role: 'burst', ...extra
  }
}

test('短窗配对：role="burst" 同 providerId 即可配对（不靠 18000 这个魔数）', () => {
  const cycle = zetaCycle()
  const burst = zetaBurst()
  assert.equal(sandbox.findFiveHourSibling(cycle, [cycle, burst]), burst)
})

test('锁定段：份额来自行上 burstShare，假供应商也能算（10 天窗 + 3h 短窗 + 0.12）', () => {
  const cells = sandbox.lockedRemainingCellCount(zetaCycle(), zetaBurst())
  // 主窗剩 80%；短窗剩 50% × 0.12 = 6% 可托底 → 锁 74% → 74% × 84 格 = 62.16
  assert.ok(Math.abs(cells - 62.16) < 0.01, `expected ≈62.16 cells, got ${cells}`)
})

test('锁定段：行上没有份额 → 0 格（不瞎猜比例）', () => {
  const cycle = zetaCycle({ burstShare: null })
  assert.equal(sandbox.lockedRemainingCellCount(cycle, zetaBurst({ burstShare: null })), 0)
})

test('锁定段：短窗行自己带份额也能被认到', () => {
  const cycle = zetaCycle({ burstShare: null })
  assert.ok(sandbox.lockedRemainingCellCount(cycle, zetaBurst({ burstShare: 0.12 })) > 0)
})

test('锁定段：份额只认行——真实供应商名（KIMI）也不加分', () => {
  const cycle = { kind: 'quota', providerId: 'KIMI', label: 'KIMI', usedPercent: 20, windowSeconds: 604_800, resetAt: NOW + 120 * HOUR }
  const burst = { kind: 'quota', providerId: 'KIMI', label: 'KIMI', usedPercent: 50, windowSeconds: 18_000, resetAt: NOW + HOUR }
  assert.equal(sandbox.lockedRemainingCellCount(cycle, burst), 0)
})

test('高峰：行上 peakHours 命中（假供应商，靠 timezone 而非供应商名）', () => {
  const peakHours = { timezone: '+08:00', daily: false, windows: [[840, 1080]] }
  const row = { providerId: 'zeta', label: 'ZETA', peakHours }
  assert.ok(sandbox.activePeakRule(row, Date.parse('2026-09-16T15:00:00+08:00')), '周三 15:00 应命中')
  assert.equal(sandbox.activePeakRule(row, Date.parse('2026-09-20T15:00:00+08:00')), null, '周日不命中')
})

test('高峰：IANA 时区名按当地时刻判定（夏令时交给 Intl）', () => {
  const peakHours = { timezone: 'America/New_York', daily: false, windows: [[540, 720]] }
  const row = { providerId: 'zeta', label: 'ZETA', peakHours }
  assert.ok(sandbox.activePeakRule(row, Date.parse('2026-09-16T09:30:00-04:00')), '纽约 09:30 应命中')
  assert.equal(sandbox.activePeakRule(row, Date.parse('2026-09-16T12:30:00-04:00')), null, '纽约 12:30 不在窗口')
})

test('高峰：peakHours 缺 timezone → 当无高峰规则，不猜时区', () => {
  const row = { providerId: 'zeta', label: 'ZETA', peakHours: { windows: [[840, 1080]] } }
  assert.equal(sandbox.activePeakRule(row, Date.parse('2026-09-16T15:00:00+08:00')), null)
  assert.equal(sandbox.normalizePeakHours({ windows: [[840, 1080]] }), null)
})

test('高峰：只认行上 peakHours——真实供应商名（GLM）完全不加分', () => {
  const glm = { providerId: 'glm', label: 'GLM' }
  assert.equal(sandbox.activePeakRule(glm, Date.parse('2026-09-16T15:00:00+08:00')), null)
})

test('normalizeRow：新契约字段被解析，脏值一律降级为 null', () => {
  const row = sandbox.normalizeRow({
    id: 'zeta', providerId: 'zeta', label: 'ZETA', kind: 'quota', usedPercent: 20,
    windowSeconds: 864_000, resetAt: 1_788_000_000,
    role: 'cycle', burstShare: 0.12, accent: '#123456', gap: 'no_share',
    peakHours: { timezone: '+08:00', windows: [[840, 1080]] }
  })
  assert.equal(row.role, 'cycle')
  assert.equal(row.burstShare, 0.12)
  assert.equal(row.accent, '#123456')
  assert.equal(row.gap, 'no_share')
  assert.deepEqual(row.peakHours, { timezone: '+08:00', daily: false, windows: [[840, 1080]] })

  const junk = sandbox.normalizeRow({
    id: 'x', providerId: 'x', label: 'X', kind: 'quota', usedPercent: 10,
    role: 'primary', burstShare: 1.5, accent: '   ', gap: '', peakHours: { windows: [[1, 2]] }
  })
  assert.equal(junk.role, null, 'role 只认 cycle/burst')
  assert.equal(junk.burstShare, null, '份额超出 (0,1] 视为无')
  assert.equal(junk.accent, null)
  assert.equal(junk.gap, null)
  assert.equal(junk.peakHours, null)
})

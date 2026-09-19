import { Switch, host, PALETTE_AREA, ROUTES_AREA, SIDEBAR_NAV_AREA, useValue } from '@hermes/plugin-sdk'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

// Live data from the plugin's own Python backend — Hermes-native credentials
// only (~/.hermes/.env keys + ~/.codex/auth.json OAuth).
// No CodexBar CLI involvement by design (2026-08-27).
// 数据刷新广播：设置面板据此重新读取连接状态。事件失败绝不能影响数据加载本身
// （非浏览器环境没有 Event 构造器）。
function emitDataUpdated() {
  try {
    window.dispatchEvent(new Event('subscription-meter:data-updated'))
  } catch {
    // 环境不支持事件广播时静默跳过。
  }
}

const CLOCK_TICK_MS = 10 * 1000
const REFRESH_MS = 5 * 60 * 1000
// 活动 profile（2026-09-12 Neal 定：切 profile 必须同步换数）：用 SDK 正式出口
// host.state.profile（= $activeGatewayProfile，正是决定 ctx.rest 路由到哪个后端的那颗
// 原子）——组件里 useValue 订阅、一变就重取，不轮询、也不读 App 内部键。
const CELL_COUNT = 84

// 响应归属校验：请求发出时的 profile 与回来时不一致 → 这份数据属于上一个 profile，
// 必须丢弃（否则旧 profile 的数字会画在新 profile 的界面上）。
function responseProfileIsStale(profileAtStart, currentProfile) {
  return currentProfile !== profileAtStart
}

// Cell width caps at its own height so a wide page never stretches the matrix
// into horizontal bars — extra page width stays as trailing space.
const CELL_SIZE = '0.75rem'
const DAY_GAP = '0.35rem'
// 网格模板（M5 起）按行派生：日线间隙列只在该行窗口为整日倍数时出现
// （dayCellIntervalOf 给出「多少格 = 一天」），非整日窗列数恒为 84。
const dayGapColumns = dayCellInterval =>
  Array.from({ length: CELL_COUNT - 1 }, (_, i) => ((i + 1) % dayCellInterval === 0 ? DAY_GAP : null))
    .filter(Boolean)
const gridTemplateColumns = subscription => {
  const dayCellInterval = dayCellIntervalOf(subscription)
  if (!dayCellInterval) {
    return Array.from({ length: CELL_COUNT }, () => `minmax(0px, ${CELL_SIZE})`).join(' ')
  }
  const totalColumns = CELL_COUNT + dayGapColumns(dayCellInterval).length
  return Array.from({ length: totalColumns }, (_, columnIndex) =>
    columnIndex > 0 && (columnIndex + 1) % (dayCellInterval + 1) === 0
      ? DAY_GAP
      : `minmax(0px, ${CELL_SIZE})`
  ).join(' ')
}
// Compact fixed metadata columns keep all 84-cell matrices vertically aligned.
// Meta track fits "Reset 6d 23h 59m" + "+19.1 cells" (~140px); quota track fits "100% left".
const QUOTA_GRID_COLUMNS = '6.5rem 3.75rem 9.5rem minmax(6rem, 1fr)'
// Below this row width the single-line tracks can no longer fit their text;
// rows switch to two lines (text line + full-width matrix) instead of truncating.
const QUOTA_GRID_COLUMNS_NARROW = '5.25rem 3.75rem minmax(0, 1fr)'
const NARROW_ROW_BREAKPOINT_PX = 28 * 16

function quotaRowLayout(containerWidth) {
  return containerWidth > 0 && containerWidth < NARROW_ROW_BREAKPOINT_PX ? 'narrow' : 'wide'
}

function useQuotaRowLayout(ref) {
  const [layout, setLayout] = useState('wide')
  useEffect(() => {
    const node = ref.current
    if (!node || typeof ResizeObserver !== 'function') return undefined
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect?.width ?? 0
      setLayout(quotaRowLayout(width))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref])
  return layout
}

// 五色图例配色（2026-09-12 Neal 定，色值取自 Neal 截图逐像素取样）：
// 绿/蓝各分可用（浅）/受限（深）两档，受限 = 5h 短窗锁定（NOT 高峰）；
// 橙 = 超额使用。灰 track（已流逝+已消耗）截图图例未画，矩阵仍保留。
const COLORS = {
  green: '#14AE68',       // 翠绿：剩余可用额度（未流逝+未消耗+未锁定）
  greenLocked: '#006935', // 深绿：剩余受限额度（未流逝+未消耗+5h 锁定段）
  blue: '#28A7E0',        // 天蓝：富余可用额度（已流逝+未消耗+未锁定）
  blueLocked: '#0A499D',  // 深蓝：富余受限额度（已流逝+未消耗+锁定；现算法锁定段只落
                          // 在周剩余区末尾，实物格可能为 0，图例仍保留此项）
  orange: '#F39800',      // 橙：超额使用额度（未流逝+已消耗，不分锁定）
  track: 'var(--ui-bg-quaternary)',
  danger: 'var(--ui-danger, #f87171)'
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

// M5：windowSeconds 缺失/非法返回 null——7 天默认已删（定稿「禁止缺省当 7 天」），
// 调用方对 null 必须按「无窗口」处理，不得回退到任何内置窗长。
function quotaCycleMs(subscription) {
  const seconds = Number(subscription?.windowSeconds)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null
}

// 格时值 = windowSeconds / 84（定稿 round2-grok-final §1「格时值=ws/N（N=84 恒定）」）。
// 「每格 2 小时」只是 windowSeconds=604800 的特例；缺 windowSeconds → null。
function cellDurationSeconds(subscription) {
  const windowSeconds = Number(subscription?.windowSeconds)
  return Number.isFinite(windowSeconds) && windowSeconds > 0 ? windowSeconds / CELL_COUNT : null
}

// 日线间隔（定稿：「日线：仅 windowSeconds%86400===0 时每 86400/格时值 格一条」）。
// 窗口不是整日倍数或缺 windowSeconds → null：不画日虚线、也不画日间隙列。
function dayCellIntervalOf(subscription) {
  const windowSeconds = Number(subscription?.windowSeconds)
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0 || windowSeconds % 86400 !== 0) return null
  return Math.round(86400 / (windowSeconds / CELL_COUNT))
}

function formatCellDurationLabel(cellSeconds) {
  if (cellSeconds % 86400 === 0) return `${cellSeconds / 86400} day${cellSeconds === 86400 ? '' : 's'}`
  if (cellSeconds < 3600) return `${Math.round(cellSeconds / 60)} minutes`
  const hours = cellSeconds / 3600
  return Number.isInteger(hours) ? `${hours} hours` : `${hours.toFixed(1)} hours`
}

// 日分界线（2026-09-10 Neal 定）：细灰虚线，弱于实线，只作分段参考不抢视觉。
const DAY_DIVIDER = '1px dashed var(--ui-stroke-secondary)'

// 锁定段格数（2026-09-09）：solidRemaining% = min(周剩余%, 5h兄弟剩余% × 比例)，
// locked% = 周剩余% − solidRemaining%；换算成 84 格矩阵里剩余区域末尾的格数。
// 剩余% 以 usedPercent 反推，clamp 到 [0,100] 防御脏数据；无兄弟行/行上无份额
// /脏 usedPercent → 返回 0 格（不渲染锁定段，现状）。
// 份额唯一真源 = 行上的 burstShare（主窗行或短窗行任一处都认），取不到就不画。
function burstShareOf(row, sibling) {
  return normalizeBurstShare(sibling?.burstShare) ?? normalizeBurstShare(row?.burstShare)
}

function lockedRemainingCellCount(row, sibling) {
  if (!sibling) return 0
  const ratio = burstShareOf(row, sibling)
  if (ratio === null) return 0
  const weeklyRemaining = 100 - (clamp(Number(row.usedPercent) || 0, 0, 100))
  const shortRemaining = 100 - (clamp(Number(sibling.usedPercent) || 0, 0, 100))
  const solidRemaining = Math.min(weeklyRemaining, shortRemaining * ratio)
  const lockedPercent = Math.max(0, weeklyRemaining - solidRemaining)
  return (lockedPercent / 100) * CELL_COUNT
}

// 单格配色（2026-09-12 Neal 定五色契约）：locked 由 WeeklyMeter 用
// lockedRemainingCellCount 的唯一结果算出（格数算法只有那一套，此处不复制），
// 传进来只为选 可用/受限 色档。2×2 语义不变：
//   已流逝+已消耗=track；已流逝+未消耗=富余（天蓝/深蓝）；
//   未流逝+已消耗=超额（橙，不分锁定）；未流逝+未消耗=剩余（翠绿/深绿）。
function weeklyCell(now, subscription, index, locked = false) {
  const usedPercent = clamp(Number(subscription.usedPercent) || 0, 0, 100)
  const resetAt = Number(subscription.resetAt)
  const cycleMs = quotaCycleMs(subscription)
  const elapsedCells = Number.isFinite(resetAt)
    ? clamp(((now - (resetAt - cycleMs)) / cycleMs) * CELL_COUNT, 0, CELL_COUNT)
    : 0
  const quotaGone = index < quotaCellCount(usedPercent)
  const elapsed = elapsedCells - index

  let fillRatio = 1
  if (elapsed >= 1) fillRatio = 0
  else if (elapsed > 0) fillRatio = 1 - elapsed

  const goneColor = quotaGone ? COLORS.track : (locked ? COLORS.blueLocked : COLORS.blue)
  const presentColor = quotaGone ? COLORS.orange : (locked ? COLORS.greenLocked : COLORS.green)

  return { fillRatio, goneColor, presentColor }
}

function quotaCellCount(usedPercent) {
  return (clamp(Number(usedPercent) || 0, 0, 100) / 100) * CELL_COUNT
}

function isDayDivider(index, dayCellInterval) {
  return Boolean(dayCellInterval) && index > 0 && index % dayCellInterval === 0
}

// 供应商声明的时区里现在是周几、当地几点（分钟数）。固定偏移走 UTC 平移，
// IANA 名走 Intl（夏令时交给 Intl）——不再把 UTC+8 写死在代码里（M0，2026-09-15）。
function localClockAt(now, timezone) {
  // tz 必带（M0 契约）：缺时区一律判无高峰，绝不就地取材——Intl 缺省 timeZone
  // 会悄悄退回本机时区，那正是「按环境猜」，本机不是 Asia/Shanghai 时还会算错。
  if (typeof timezone !== 'string' || !timezone.trim()) return null
  const fixed = /^([+-])(\d{2}):?(\d{2})$/.exec(timezone.trim())
  if (fixed) {
    const offsetMinutes = (Number(fixed[2]) * 60 + Number(fixed[3])) * (fixed[1] === '-' ? -1 : 1)
    const shifted = new Date(now + offsetMinutes * 60 * 1000)
    return { weekday: shifted.getUTCDay(), minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() }
  }
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date(now))
    const pick = type => parts.find(part => part.type === type)?.value
    const weekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[pick('weekday')]
    const hour = Number(pick('hour')) % 24
    const minute = Number(pick('minute'))
    if (weekday === undefined || !Number.isFinite(hour) || !Number.isFinite(minute)) return null
    return { weekday, minutes: hour * 60 + minute }
  } catch {
    return null
  }
}

function peakRuleHit(rule, now) {
  const clock = localClockAt(now, rule.timezone)
  if (!clock) return null
  if (!rule.daily && (clock.weekday < 1 || clock.weekday > 5)) return null
  return rule.windows.some(([from, to]) => clock.minutes >= from && clock.minutes < to) ? rule : null
}

function activePeakRule(row, now) {
  // 唯一真源 = 行上的 peakHours（含 timezone，由后端抄进行）。M2（2026-09-16）
  // 已删旧特例表 / 北京时间兜底——前端不再知道任何一家的高峰时段。
  return row?.peakHours ? peakRuleHit(row.peakHours, now) : null
}

// 综合优先度 P（2026-09-09 Neal 定「蓝绿比」，09-12 补负富余）：P = (已流逝 − 已用) ÷ 未流逝。
// 语义=蓝格÷绿格：按当前消耗节奏推算重置前的富余度，富余越多越先薅。
// 用超进度（e≤u）记负分、不再截断成 0（2026-09-12 Neal 定）：负值=欠账深度，
// 用满恒为 −1（(e−1)/(1−e)≡−1）钉最底。截断成 0 会让多行同塌 0 分，只剩
// 「重置近在前」兜底 —— 用光的行反被抬到还有剩的行前面（09-12 GROK 用满排第 2、
// 剩 96% 的 GLM 垫底的实况）。Y=0 或无/过期 resetAt → -Infinity 沉底。
// 高峰削弱保留（2026-09-09 Neal 定，富余多者 ÷2 仍居首）：仅削 kind=quota 订阅行；
// DEEPSEEK 无订阅全是 API（balance 行），不参与 quota 排序，天然不受影响。
function rowPriority(row, now) {
  const usedPercent = clamp(Number(row.usedPercent) || 0, 0, 100)
  const resetAt = Number(row.resetAt)
  if (!Number.isFinite(resetAt) || resetAt <= now) return -Infinity
  const cycleMs = quotaCycleMs(row)
  const elapsed = clamp((now - (resetAt - cycleMs)) / cycleMs, 0, 1)
  const remainingFraction = 1 - elapsed
  if (!(remainingFraction > 0)) return -Infinity
  const surplus = elapsed - usedPercent / 100
  const priority = surplus / remainingFraction
  const subscriptionOnly = row.kind === 'quota'
  return subscriptionOnly && activePeakRule(row, now) ? priority / 2 : priority
}

function orderRowsForDisplay(rows, now) {
  // 单键优先度排序（2026-09-09 Neal 定「蓝绿比」）：P 见 rowPriority（盈余÷未流逝）。
  // 高峰减半保留；同分（分数完全相等，如两行都用满 −1）按重置近在前兜底；余额/错误行恒在队尾。
  // 无/非法 resetAt → Infinity 沉底；Number(null)=0 是有限数，必须先挡掉。
  // 短窗附属化（2026-09-10 Neal 定）：5h 行不参与排序——5h 是撞墙预警显示器
  // （起因=GLM 富余多跑长任务却在 5h 撞墙中断），不是独立供给池，周行排序
  // 不再取 min(周P, 5hP)；渲染仍用 findFiveHourSibling 算锁定段。
  const eta = row => {
    const value = Number(row.resetAt)
    return Number.isFinite(value) && value > 0 ? value : Infinity
  }
  const quotaRowsAll = collapseDuplicateQuotaRows(rows.filter(row => row.kind === 'quota'))
  const quota = quotaRowsAll
    .sort((a, b) => (rowPriority(b, now) - rowPriority(a, now)) || (eta(a) - eta(b)))
  return [
    ...quota,
    ...rows.filter(row => row.kind !== 'quota')
  ]
}

// 渲染路径用：给周行找同 providerId 的 5h 兄弟行。2026-09-10 起排序已短窗附属化
// （orderRowsForDisplay 不再取 min），此函数仅服务锁定段显示——5h 是撞墙预警
// 显示器，不是排序维度。windowSeconds 以秒记（resetAt 已是毫秒）。
function findFiveHourSibling(row, pool) {
  // 配对只认 role：主窗行（cycle）找同 providerId 的短窗行（burst）。
  if (row?.role !== 'cycle') return null
  return pool.find(candidate =>
    candidate !== row &&
    candidate.providerId === row.providerId &&
    candidate.role === 'burst') || null
}

function collapseDuplicateQuotaRows(rows) {
  const seen = new Set()
  const unique = []
  for (const row of rows) {
    const key = [row.providerId, row.usedPercent, row.resetAt, row.windowSeconds].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(row)
  }
  return unique
}

function quotaDisplayName(subscription) {
  const suffix = compactWindowLabel(subscription.windowLabel)
  return suffix ? `${subscription.label} ${suffix}` : subscription.label
}

function compactWindowLabel(windowLabel) {
  const text = String(windowLabel || '').trim().toLowerCase()
  if (!text || text === 'weekly' || text.includes('supergrok')) return ''
  // M5（定稿「标签禁止啃英文窗词」）：逐词处理，不再substring啃词——
  //   · 窗型词（session/build/api）整词剔除；
  //   · 数字与单位词（5h / 10d / 4w / 5 hours / 10 days）换算成大写缩写；
  //   · 其余任何英文词（供应商名、plan…）→ 不啃，返回 ''。
  const UNIT_OF = { h: 'H', d: 'D', w: 'W' }
  const WINDOW_WORDS = new Set(['session', 'build', 'api'])
  let out = ''
  for (const token of text.split(/\s+/)) {
    const numUnit = /^(\d+(?:\.\d+)?)([hdw])$/.exec(token)
    if (numUnit) {
      out += `${Math.round(Number(numUnit[1]))}${UNIT_OF[numUnit[2]]}`
      continue
    }
    if (/^\d+(?:\.\d+)?$/.test(token)) {
      out += `${Math.round(Number(token))}`
      continue
    }
    const word = token.replace(/s$/, '')
    if (word === 'hour' || word === 'hr') { out += 'H'; continue }
    if (word === 'day') { out += 'D'; continue }
    if (word === 'week') { out += 'W'; continue }
    if (UNIT_OF[word]) { out += UNIT_OF[word]; continue }
    if (WINDOW_WORDS.has(token)) continue
    return ''
  }
  // 纯数字后缀没有窗长语义（如「CODEX 5」），不输出。
  return /\d+[HDW]/.test(out) ? out : ''
}

function formatRemaining(resetAt, now) {
  const remainMs = Math.max(0, Number(resetAt) - now)
  const days = Math.floor(remainMs / (24 * 60 * 60 * 1000))
  const hours = Math.floor((remainMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000))
  const minutes = Math.floor((remainMs % (60 * 60 * 1000)) / (60 * 1000))
  return `${days}d ${hours}h ${minutes}m`
}

// 盈余/亏损时间块：均摊口径 = (已过比例 − 已用比例) × 84 格。
// 正=省余、负=超支；块长=格时值（M5 起从行上 windowSeconds 推导，不再恒为 2h）。
function surplusBlocks(subscription, now) {
  const usedPercent = clamp(Number(subscription.usedPercent) || 0, 0, 100)
  const resetAt = Number(subscription.resetAt)
  if (!Number.isFinite(resetAt) || resetAt <= now) return null
  const cycleMs = quotaCycleMs(subscription)
  // M5：无窗长就没有均摊基准（7 天默认已删）——宁可不显示盈亏，
  // 也不能拿错误分母算一个假数字。
  if (cycleMs === null) return null
  const elapsedPercent = clamp(((now - (resetAt - cycleMs)) / cycleMs) * 100, 0, 100)
  return (elapsedPercent - usedPercent) / 100 * CELL_COUNT
}

function formatSurplus(blocks) {
  if (blocks === null) return null
  // 「格」单位与 84 格矩阵同一口径，避免被误读为金额或百分比。
  return `${blocks >= 0 ? '+' : '−'}${Math.abs(blocks).toFixed(1)} cells`
}

function formatMoney(value, currency) {
  // 未知值（null/undefined/NaN）显示为 —；真实 0 仍显示 0.00。
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return `${currency === 'CNY' ? '¥' : `${currency || ''} `}—`
  }
  const symbol = currency === 'CNY' ? '¥' : `${currency || ''} `
  return `${symbol}${Number(value).toFixed(2)}`
}

// Fixed neutral theme color for all money values and balance dots; no
// amount-based dynamic coloring anymore.
const NEUTRAL_VALUE_COLOR = 'var(--ui-text-quaternary)'

function toEpochMillis(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  // The backend uses Unix seconds; Date.now() and the meter use milliseconds.
  return numeric < 100_000_000_000 ? numeric * 1000 : numeric
}

// 数值语义：仅接受有限 number 或非空合法数值 string；其余（null/undefined/空白/
// boolean/array/object/NaN/Infinity）= 未知（null）。真实 0 与 '0' 保持 0。
function numericOrNull(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value)
    return Number.isFinite(numeric) ? numeric : null
  }
  return null
}

// 行级错误只显示固定安全文案：原始文本（可能嵌入密码/token/URL）一律丢弃，
// 不做任何基于正则的"打码透传"。
function sanitizeRowError(value) {
  if (value === null || value === undefined) return null
  return '[redacted] fetch failed; display data preserved'
}

// --- 中立行契约 ---------------------------------------------------------------
// 后端在行情里直接下发这些事实，前端只按行渲染：份额/配色/高峰全部来自行，
// 代码里没有任何按供应商名的表。字段语义见 DESIGN.md。
// 份额：短窗额度 ÷ 主窗额度，取值 (0,1]；两行都有绝对值 limit 时由后端算好。
function normalizeBurstShare(value) {
  const ratio = numericOrNull(value)
  return ratio !== null && ratio > 0 && ratio <= 1 ? ratio : null
}

// 高峰时段：{ timezone: IANA 名或 ±HH:MM, daily?: bool, windows: [[起,止) 分钟] }。
// timezone 缺失即视为无高峰规则——宁可不说，也不按时区猜。
function normalizePeakHours(value) {
  if (!value || typeof value !== 'object') return null
  const timezone = typeof value.timezone === 'string' ? value.timezone.trim() : ''
  const windows = Array.isArray(value.windows)
    ? value.windows
        .map(window => (Array.isArray(window) && window.length >= 2
          ? [Number(window[0]), Number(window[1])]
          : null))
        .filter(window => window && Number.isFinite(window[0]) && Number.isFinite(window[1]))
    : []
  if (!timezone || !windows.length) return null
  return { timezone, daily: value.daily === true, windows }
}

/** Coerce one backend row into render shape. 后端出行（含供应商事实），前端只管画。 */
function normalizeRow(row) {
  if (!row || typeof row !== 'object') return null
  const kind = row.kind === 'balance' ? 'balance' : 'quota'
  const balance = numericOrNull(row.balance)
  const todaySpend = numericOrNull(row.todaySpend)
  const sevenDaySpend = numericOrNull(row.sevenDaySpend)
  const thirtyDaySpend = numericOrNull(row.thirtyDaySpend)
  const windowSeconds = Number(row.windowSeconds)
  const usedPercent = numericOrNull(row.usedPercent)
  return {
    id: String(row.id || ''),
    providerId: String(row.providerId || row.id || '').split(':', 1)[0],
    accountId: String(row.accountId || 'default'),
    label: String(row.label || row.id || '').toUpperCase(),
    kind,
    windowLabel: row.windowLabel ? String(row.windowLabel) : null,
    windowSeconds: Number.isFinite(windowSeconds) && windowSeconds > 0 ? windowSeconds : null,
    // role：'cycle' 主窗 / 'burst' 短窗；同一 providerId 恰好一对才画锁定段。
    // 脏值记 null：role 缺了就不配对，也不按窗口秒数反推。
    role: row.role === 'burst' || row.role === 'cycle' ? row.role : null,
    burstShare: normalizeBurstShare(row.burstShare),
    peakHours: normalizePeakHours(row.peakHours),
    accent: typeof row.accent === 'string' && row.accent.trim() ? row.accent.trim() : null,
    // 缺事实的原因码（no_window/no_share/...）：看板行内要明说，禁止静默少画。
    gap: typeof row.gap === 'string' && row.gap.trim() ? row.gap.trim().slice(0, 80) : null,
    usedPercent: usedPercent === null ? null : clamp(usedPercent, 0, 100),
    resetAt: toEpochMillis(row.resetAt),
    // Dynamic tone fields are gone: all money values render in a fixed
    // neutral theme color regardless of amount.
    currency: row.currency || 'CNY',
    balance,
    todaySpend,
    sevenDaySpend,
    thirtyDaySpend,
    error: sanitizeRowError(row.error)
  }
}

function SpendMetric({ label, value, currency }) {
  return jsxs('span', {
    className: 'flex shrink-0 items-baseline gap-1 whitespace-nowrap leading-none',
    children: [
      jsx('span', {
        className: 'shrink-0 tracking-[0.08em]',
        style: { fontSize: '0.625rem', color: 'var(--ui-text-tertiary)' },
        children: label
      }),
      jsx('span', {
        className: 'font-mono text-[0.68rem] tabular-nums',
        style: { color: NEUTRAL_VALUE_COLOR },
        children: formatMoney(value, currency)
      })
    ]
  })
}

function BalanceSpendRow({ subscription, now }) {
  const failed = Boolean(subscription.error)
  const accent = failed ? COLORS.danger : NEUTRAL_VALUE_COLOR

  return jsxs('div', {
    title: failed ? String(subscription.error || '') : undefined,
    className: 'flex min-w-0 items-center gap-2 overflow-hidden rounded px-1.5 py-0 text-left',
    style: { minHeight: '1.2rem' },
    children: [
      jsxs('span', {
        className: 'flex shrink-0 items-center gap-2',
        children: [
          jsx('span', {
            className: 'size-1.5 shrink-0 rounded-full',
            style: { backgroundColor: accent }
          }),
          jsx('span', {
            className: 'truncate text-[0.65rem] font-semibold tracking-[0.08em] text-foreground',
            children: subscription.label
          }),
          activePeakRule(subscription, now)
            ? jsx('span', {
                className: 'shrink-0 rounded-full px-1.5 py-px font-mono text-[0.5rem] font-semibold leading-none text-white',
                style: { backgroundColor: COLORS.danger },
                title: 'Peak hours: usage costs more now',
                'aria-label': 'Peak hours',
                children: 'PEAK'
              })
            : null
        ]
      }),
      failed
        ? jsx('span', {
            className: 'min-w-0 flex-1 truncate font-mono text-[0.68rem] tabular-nums',
            style: { color: accent },
            children: `ERR ${String(subscription.error || 'data unavailable').slice(0, 60)}`
          })
        : jsxs('span', {
            className: 'flex min-w-0 flex-1 flex-nowrap items-baseline gap-x-2 overflow-hidden',
            children: [
              jsx(SpendMetric, {
                label: 'BALANCE', value: subscription.balance,
                currency: subscription.currency
              }),
              jsx(SpendMetric, {
                label: 'TODAY', value: subscription.todaySpend,
                currency: subscription.currency
              }),
              jsx(SpendMetric, {
                label: '7D', value: subscription.sevenDaySpend,
                currency: subscription.currency
              }),
              jsx(SpendMetric, {
                label: '30D', value: subscription.thirtyDaySpend,
                currency: subscription.currency
              })
            ]
          })
    ]
  })
}

function WeeklyMeter({ subscription, now, fiveHourSibling }) {
  // M5：格时值从行上 windowSeconds 推导（定稿「格时值=ws/N」），7 天特例文案删除；
  // 缺 windowSeconds 时只说 period / 84，不再宣称任何具体小时数。
  const dayCellInterval = dayCellIntervalOf(subscription)
  const cellSeconds = cellDurationSeconds(subscription)
  const cellPhrase = cellSeconds === null
    ? 'each cell = period / 84'
    : `each cell = period / 84 (${formatCellDurationLabel(cellSeconds)} per cell)`
  const matrixTitle = `84-cell matrix: ${quotaDisplayName(subscription)}, ${Math.round(100 - subscription.usedPercent)}% remaining, ${cellPhrase}`
  // 锁定段渲染：锁定格与普通格同一套实色渲染（goneColor 底 + fill 子元素）。
  // 2026-09-12 Neal 定五色契约：锁定格颜色走 weeklyCell 的受限档（深绿/深蓝），
  // 判定只在此算一次（格数唯一来源 lockedRemainingCellCount），以布尔传给
  // weeklyCell 选色，不复制第二套格数算法。
  const lockedCells = lockedRemainingCellCount(subscription, fiveHourSibling)
  const quotaGoneBoundary = quotaCellCount(subscription.usedPercent)
  const lockedStart = CELL_COUNT - lockedCells
  const isLockedIndex = index => index >= quotaGoneBoundary && index >= lockedStart
  const cells = useMemo(
    () =>
      Array.from({ length: CELL_COUNT }, (_, index) =>
        weeklyCell(now, subscription, index, isLockedIndex(index))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [now, subscription, fiveHourSibling, quotaGoneBoundary, lockedStart]
  )
  const gridChildren = []
  cells.forEach((cell, index) => {
    const isLocked = isLockedIndex(index)
    const fill = jsx('div', {
      className: 'h-full',
      style: {
        width: `${cell.fillRatio * 100}%`,
        marginLeft: 'auto',
        backgroundColor: cell.presentColor
      }
    })
    gridChildren.push(jsx('div', {
      key: `cell-${index}`,
      'data-meter-cell': true,
      'data-locked': isLocked || undefined,
      'aria-hidden': true,
      className: 'min-w-0 overflow-hidden rounded-[2px]',
      style: isLocked
        // 锁定格不叠加日分界虚线，避免左边线加深。
        ? {
            backgroundColor: cell.goneColor
          }
        : {
            backgroundColor: cell.goneColor,
            borderLeft: isDayDivider(index, dayCellInterval) ? DAY_DIVIDER : undefined
          },
      children: fill
    }))

    if (dayCellInterval && index < CELL_COUNT - 1 && isDayDivider(index + 1, dayCellInterval)) {
      gridChildren.push(jsx('span', {
        key: `day-gap-${index + 1}`,
        'data-day-gap': true,
        'aria-hidden': true,
        style: { width: DAY_GAP }
      }))
    }
  })

  return jsx('div', {
    className: 'h-3 shrink grow basis-24 min-w-[6rem]',
    role: 'img',
    title: matrixTitle,
    'aria-label': matrixTitle,
    children: jsx('div', {
      className: 'grid h-full min-w-0 items-stretch',
      style: {
        gridTemplateColumns: gridTemplateColumns(subscription),
        justifyContent: 'start',
        gap: 1
      },
      children: gridChildren
    })
  })
}

// Weekly quota has its own row structure: name -> remaining quota -> reset -> matrix.
function WeeklyQuotaRow({ subscription, now, quotaPool }) {
  const failed = Boolean(subscription.error)
  const unknown = subscription.usedPercent === null || subscription.usedPercent === undefined
  // 配色来自行（后端抄进行）；行上没给就用中性绿。
  const accent = failed ? COLORS.danger : (subscription.accent || COLORS.green)
  const quotaText = failed ? 'ERR' : (unknown ? 'Unknown —' : `${Math.round(100 - subscription.usedPercent)}% left`)
  const clockText = failed
    ? String(subscription.error || 'data unavailable').slice(0, 60)
    : `Reset ${subscription.resetAt ? formatRemaining(subscription.resetAt, now) : '—'}`
  const blocks = failed || unknown ? null : surplusBlocks(subscription, now)
  const surplusText = blocks === null ? null : formatSurplus(blocks)
  const surplusTone = surplusText ? (blocks >= 0 ? COLORS.green : COLORS.danger) : null
  // Unknown/failed quota rows must not render a surplus prediction: blocks
  // would only reflect time progress, never real surplus.
  const surplusTitle = surplusText
    ? `Surplus vs. even-time pacing, in cells: ${blocks >= 0 ? 'positive = saved relative to even pacing' : 'negative = consumed ahead of pacing'}`
    : undefined
  const rowRef = useRef(null)
  const narrow = useQuotaRowLayout(rowRef) === 'narrow'

  const nameCell = jsxs('span', {
    className: 'flex min-w-0 items-center gap-2',
    children: [
      jsx('span', {
        className: 'size-1.5 shrink-0 rounded-full',
        style: { backgroundColor: accent }
      }),
      jsx('span', {
        className: 'truncate text-[0.65rem] font-semibold tracking-[0.08em] text-foreground',
        children: quotaDisplayName(subscription)
      }),
      activePeakRule(subscription, now)
        ? jsx('span', {
            className: 'shrink-0 rounded-full px-1.5 py-px font-mono text-[0.5rem] font-semibold leading-none text-white',
            style: { backgroundColor: COLORS.danger },
            title: 'Peak hours: priority halved — off-peak usage costs less',
            'aria-label': 'Peak hours',
            children: 'PEAK'
          })
        : null
    ]
  })
  const quotaCell = jsx('span', {
    className: 'shrink-0 font-mono text-[0.68rem] tabular-nums',
    style: { color: accent },
    title: failed ? undefined : 'Remaining quota (not used)',
    children: quotaText
  })
  const metaCell = jsxs('span', {
    className: 'flex min-w-0 items-baseline gap-1.5 tabular-nums',
    children: [
      jsx('span', {
        className: 'min-w-0 truncate',
        style: { fontSize: '0.625rem', color: 'var(--ui-text-tertiary)' },
        title: failed ? undefined : 'Time remaining until the next cycle starts',
        children: clockText
      }),
      surplusText
        ? jsx('span', {
            className: 'shrink-0 font-mono text-[0.56rem]',
            style: { color: surplusTone },
            title: surplusTitle,
            'aria-label': surplusTitle,
            children: surplusText
          })
        : null
    ]
  })
  // 5h 兄弟行（2026-09-09）：从全部 quota 行池里找同 providerId 的短窗行，
  // 传给 WeeklyMeter 算锁定段；找不到则 null → 不渲染锁定段（现状）。
  const fiveHourSibling = quotaPool
    ? findFiveHourSibling(subscription, quotaPool)
    : null
  // M5（定稿 §1「windowSeconds … 缺→不画轴」）：无窗行不画矩阵，只留文字；
  // 行内缺口文案（gap 通道）口径待 Neal 认可，本轮不加。
  const meterCell = failed || !subscription.windowSeconds ? null : (unknown ? null : jsx(WeeklyMeter, { subscription, now, fiveHourSibling }))

  if (narrow) {
    return jsxs('div', {
      ref: rowRef,
      title: failed ? String(subscription.error || '') : undefined,
      className: 'flex min-w-0 flex-col gap-0.5 overflow-hidden rounded px-1.5 py-0.5 text-left',
      style: { minHeight: '1.2rem' },
      children: [
        jsxs('div', {
          className: 'grid min-w-0 items-center gap-2',
          style: { display: 'grid', gridTemplateColumns: QUOTA_GRID_COLUMNS_NARROW },
          children: [nameCell, quotaCell, metaCell]
        }),
        // WeeklyMeter 根节点的 flex 属性在网格里是惰性的，但到了纵向 flex 容器
        // 会沿纵轴生效（basis-24 会把矩阵撑到 6rem 高），所以套一层块级壳。
        meterCell ? jsx('div', { className: 'w-full', children: meterCell }) : null
      ]
    })
  }

  return jsxs('div', {
    ref: rowRef,
    title: failed ? String(subscription.error || '') : undefined,
    className: 'grid min-w-0 items-center gap-2 overflow-hidden rounded px-1.5 py-0 text-left',
    style: { display: 'grid', gridTemplateColumns: QUOTA_GRID_COLUMNS, minHeight: '1.2rem' },
    children: [nameCell, quotaCell, metaCell, meterCell]
  })
}

const CONNECTION_LABELS = {
  unknown: 'Not checked yet', disabled: 'Hidden · not fetched', unconfigured: 'Not configured',
  ok: 'Last check succeeded', partial: 'Partial data available', auth_error: 'Auth or permission failed', request_error: 'Request failed',
  unrecognized: 'API key not recognized', no_fetcher: 'No fetcher available'
}

function ProviderSettingsPanel({ rest }) {
  const [providers, setProviders] = useState([])
  const [state, setState] = useState('loading')
  const [savingId, setSavingId] = useState(null)
  const savePending = useRef(false)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const payload = await rest('/settings')
        if (!alive) return
        setProviders(Array.isArray(payload?.providers) ? payload.providers : [])
        setState('ready')
      } catch {
        if (alive) setState('error')
      }
    }
    void load()
    window.addEventListener('subscription-meter:data-updated', load)
    return () => {
      alive = false
      window.removeEventListener('subscription-meter:data-updated', load)
    }
  }, [rest])

  const toggle = async (providerId, enabled) => {
    if (savePending.current) return
    savePending.current = true
    setSavingId(providerId)
    try {
      const payload = await rest(`/settings/${encodeURIComponent(providerId)}`, {
        method: 'PUT',
        body: { enabled }
      })
      setProviders(Array.isArray(payload?.providers) ? payload.providers : [])
      setState('ready')
      window.dispatchEvent(new Event('subscription-meter:settings-changed'))
    } catch {
      // Fixed safe message only: the raw exception may embed secrets/URLs.
      setState('error')
      host.notify({
        kind: 'error',
        message: `Failed to save display settings for ${providerId}. [redacted]`
      })
    } finally {
      savePending.current = false
      setSavingId(null)
    }
  }

  const refreshStatus = async () => {
    if (savePending.current) return
    savePending.current = true
    setRefreshing(true)
    try {
      await rest('/data?refresh=true')
      const payload = await rest('/settings')
      setProviders(Array.isArray(payload?.providers) ? payload.providers : [])
      setState('ready')
      window.dispatchEvent(new Event('subscription-meter:settings-changed'))
    } catch {
      setState('error')
      host.notify({ kind: 'error', message: 'Refreshing connection status failed — try again later.' })
    } finally {
      savePending.current = false
      setRefreshing(false)
    }
  }

  return jsxs('section', {
    className: 'rounded-md border border-(--ui-stroke-secondary) p-3',
    children: [
      jsxs('div', {
        className: 'mb-3 flex items-start justify-between gap-3',
        children: [
          jsxs('div', {
            children: [
              jsx('h2', {
                className: 'text-sm font-medium text-foreground',
                children: 'Connection & display'
              }),
              jsx('p', {
                className: 'mt-1 text-xs text-(--ui-text-tertiary)',
                children: 'Switches control display and fetching; connection status reflects the last check and does not mean the credential stays valid. Keys are never stored on this page.'
              })
            ]
          }),
          jsx('button', {
            type: 'button', 'aria-label': 'Refresh connection status',
            disabled: state === 'loading' || savingId !== null || refreshing,
            className: 'rounded border border-(--ui-stroke-secondary) px-2 py-1 text-xs',
            onClick: () => void refreshStatus(),
            children: refreshing ? 'Checking…' : 'Refresh connection status'
          }),
          state === 'error'
            ? jsx('span', {
                className: 'text-xs text-(--ui-danger)',
                children: 'Action failed — click refresh to retry'
              })
            : null
        ]
      }),
      jsx('div', {
        className: 'grid gap-2 sm:grid-cols-2 lg:grid-cols-3',
        children: providers.map(provider =>
          jsxs('div', {
            className: 'flex items-center justify-between gap-3 rounded border border-(--ui-stroke-secondary) px-3 py-2',
            children: [
              jsxs('span', {
                className: 'min-w-0',
                children: [
                  jsx('span', {
                    className: 'block truncate text-xs font-medium text-foreground',
                    children: provider.label
                  }),
                  jsx('span', {
                    className: 'block text-[0.65rem] text-(--ui-text-quaternary)',
                    children: provider.kind === 'balance' ? 'Account balance' : 'Subscription quota · 84 cells'
                  }),
                  jsx('span', {
                    className: 'block text-xs text-(--ui-text-secondary)',
                    'data-connection-status': provider.status || 'unknown',
                    children: CONNECTION_LABELS[provider.status] || CONNECTION_LABELS.unknown
                  }),
                  provider.checkedAt ? jsx('span', {
                    className: 'block text-[0.65rem] text-(--ui-text-quaternary)',
                    children: `Last checked: ${new Date(provider.checkedAt * 1000).toLocaleString()}`
                  }) : null,
                  jsxs('details', {
                    className: 'mt-1 text-xs text-(--ui-text-secondary)',
                    children: [
                      jsx('summary', { children: 'Setup & access' }),
                      jsx('p', { className: 'mt-1 whitespace-normal', children: provider.actionHint || 'Configure an account for the current profile, then refresh; auth status has not been checked yet.' })
                    ]
                  })
                ]
              }),
              jsx(Switch, {
                checked: provider.enabled !== false,
                disabled: state === 'loading' || savingId !== null || refreshing,
                'aria-label': `Show ${provider.label} in the subscription quota window`,
                onCheckedChange: checked => void toggle(provider.id, checked)
              })
            ]
          }, provider.id)
        )
      })
    ]
  })
}


// Independent mouse-following explanation tooltip. Renders nothing until the
// pointer is inside the meter container; pointer-events:none so it never
// steals the cursor (no enter/leave flicker). All visual styles are inline
// (no runtime-compiled Tailwind classes) and the rect — not the pointer —
// is kept inside the viewport: width min(TOOLTIP_PREFERRED_WIDTH_PX, viewport-24), pointer offset
// +16, flipped left/up when the bottom-right corner would overflow.
// 首选宽度（2026-09-11 Neal 定「色块说明一行完整不要过行」）：以最长图例行
// （0.56rem 字号）单行放得下为准；窄视口仍由 placeTooltipRect 收缩兜底。
const TOOLTIP_PREFERRED_WIDTH_PX = 340

const TOOLTIP_MARGIN_PX = 12
const TOOLTIP_POINTER_OFFSET_PX = 16
const TOOLTIP_MAX_HEIGHT_PX = 260

function placeTooltipRect(pointerX, pointerY, width, height, viewportWidth, viewportHeight) {
  const maxWidth = Math.min(width, Math.max(TOOLTIP_MARGIN_PX, viewportWidth - TOOLTIP_MARGIN_PX * 2))
  const maxHeight = Math.min(height || TOOLTIP_MAX_HEIGHT_PX, TOOLTIP_MAX_HEIGHT_PX)
  const maxLeft = Math.max(TOOLTIP_MARGIN_PX, viewportWidth - TOOLTIP_MARGIN_PX - maxWidth)
  const maxTop = Math.max(TOOLTIP_MARGIN_PX, viewportHeight - TOOLTIP_MARGIN_PX - maxHeight)
  const preferredX = pointerX + TOOLTIP_POINTER_OFFSET_PX
  const preferredY = pointerY + TOOLTIP_POINTER_OFFSET_PX
  // Flip left / above the pointer when the rect would overflow bottom-right.
  const left = preferredX + maxWidth > viewportWidth - TOOLTIP_MARGIN_PX
    ? clamp(pointerX - TOOLTIP_POINTER_OFFSET_PX - maxWidth, TOOLTIP_MARGIN_PX, maxLeft)
    : clamp(preferredX, TOOLTIP_MARGIN_PX, maxLeft)
  const top = preferredY + maxHeight > viewportHeight - TOOLTIP_MARGIN_PX
    ? clamp(pointerY - TOOLTIP_POINTER_OFFSET_PX - maxHeight, TOOLTIP_MARGIN_PX, maxTop)
    : clamp(preferredY, TOOLTIP_MARGIN_PX, maxTop)
  return { left, top, maxWidth, maxHeight }
}

function SubscriptionMeterTooltip({ visible, x, y, viewportWidth, viewportHeight, width, height, tooltipRef }) {
  if (!visible) return null
  const rect = placeTooltipRect(
    Number(x) || 0,
    Number(y) || 0,
    Number(width) || TOOLTIP_PREFERRED_WIDTH_PX,
    Number(height) || 0,
    Number(viewportWidth) || 0,
    Number(viewportHeight) || 0
  )
  // 五色图例（2026-09-12 Neal 定，与 Neal 截图一致，一条一行）：
  // 可用=浅、受限=深（受限=5h 短窗锁定，不是高峰）；灰 track 截图未画、矩阵仍保留；
  // 高峰不写进色块图例。
  const legendItems = [
    { color: COLORS.green, text: 'Green: remaining available quota' },
    { color: COLORS.greenLocked, text: 'Dark green: remaining quota locked by the 5h window' },
    { color: COLORS.blue, text: 'Sky blue: surplus available quota' },
    { color: COLORS.blueLocked, text: 'Dark blue: surplus quota locked by the 5h window' },
    { color: COLORS.orange, text: 'Orange: over-consumed quota' }
  ]
  return jsxs('div', {
    'data-meter-tooltip': true,
    'role': 'tooltip',
    ref: tooltipRef,
    style: {
      position: 'fixed',
      left: rect.left,
      top: rect.top,
      width: 'max-content',
      maxWidth: rect.maxWidth,
      maxHeight: rect.maxHeight,
      overflowY: 'auto',
      overflowWrap: 'anywhere',
      pointerEvents: 'none',
      zIndex: 50,
      // 实底（2026-09-10 Neal 定「浮窗不要透明背景」）：--ui-bg-primary 是
      // accent 16% + transparent 74% 的填充色，透字；App 浮层标准底为
      // --ui-bg-elevated（浅色近白/深色 #161618 实底），与 App popover 同源。
      backgroundColor: 'var(--ui-bg-elevated)',
      color: 'var(--ui-text-secondary, inherit)',
      border: '1px solid var(--ui-stroke-secondary)',
      borderRadius: '4px',
      padding: '8px',
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25)',
      fontSize: '0.56rem',
      lineHeight: 1.4
    },
    children: [
      jsx('div', { children: '84 cells align quota with cycle time; each cell = window / 84 (a 7-day window = 2 hours).' }),
      // 图例（2026-09-11 Neal 定「一行完整，不要过行，色块对准那一行」）：
      // 一条说明独占一行（block + nowrap），色块 flex-shrink 0 与本行文字垂直居中；
      // 浮窗首选宽 340px 保证最长一条单行放下。
      ...legendItems.map(item =>
        jsxs('span', {
          style: { display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' },
          children: [
            jsx('span', {
              style: {
                display: 'inline-block',
                flexShrink: 0,
                width: 6,
                height: 6,
                borderRadius: 2,
                backgroundColor: item.color
              },
              'aria-hidden': true
            }),
            item.text
          ]
        }, item.text)
      ),
      jsx('div', { children: 'The dot by a plan name distinguishes providers — not cell colors or balance status.' }),
      jsx('div', { children: '"N% left" = remaining quota (not used). "Reset" = time until the next cycle.' }),
      jsx('div', { children: '"Unknown —" = no quota percentage returned, so no surplus is shown.' }),
      jsx('div', { children: '"ERR" = fixed safe message; "Refresh failed" keeps last good data, marked stale.' })
    ]
  })
}

function SubscriptionMeterBody({ rest }) {
  const [rows, setRows] = useState([])
  const [loadState, setLoadState] = useState('loading')
  const [lastSuccessAt, setLastSuccessAt] = useState(null)
  const [now, setNow] = useState(() => Date.now())
  const [tooltip, setTooltip] = useState({ visible: false, x: 0, y: 0 })
  const [viewport, setViewport] = useState(() => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 0,
    height: typeof window !== 'undefined' ? window.innerHeight : 0
  }))
  const tooltipRef = useRef(null)
  // 活动 profile：切了就重取（见下方 effect）。useValue 必须无条件调用。
  const activeProfile = useValue(host.state.profile)
  const aliveRef = useRef(true)
  const succeededRef = useRef(false)

  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Measure the real tooltip rect so placement accounts for actual size.
  useLayoutEffect(() => {
    const node = tooltipRef.current
    if (!node) return
    const width = Math.ceil(node.getBoundingClientRect().width) || TOOLTIP_PREFERRED_WIDTH_PX
    const height = Math.ceil(node.getBoundingClientRect().height)
    setTooltip(state => (state.width !== width || state.height !== height)
      ? { ...state, width, height }
      : state)
  }, [tooltip.visible, tooltip.x, tooltip.y, viewport.width, viewport.height])

  // 余额条行首竖线判定（2026-09-11 Neal 定「分割线只出现在同一行 2 个余额条中间」）：
  // flex-wrap 换行由实际宽度决定，渲染前无法知道某条目是否落到行首；这里读真实
  // offsetTop，与上一条同顶才算同一行。竖线显隐不改布局 → 测量不会抖动。
  const balanceLaneRef = useRef(null)
  const [balanceRowTops, setBalanceRowTops] = useState([])
  useLayoutEffect(() => {
    const lane = balanceLaneRef.current
    if (!lane) return
    const tops = Array.from(lane.children).map(node => node.offsetTop)
    setBalanceRowTops(prev => prev.length === tops.length && prev.every((top, i) => top === tops[i])
      ? prev
      : tops)
  })

  // load(force) 是唯一取数入口：挂载 / 5 分钟轮询 / 设置页改动 / 切 profile 都走它。
  const load = useCallback(async (force = false) => {
    const profileAtStart = host.state.profile.get()
    try {
      const payload = await rest(force ? '/data?refresh=true' : '/data')
      if (!aliveRef.current) return
      // 飞行中切了 profile：这份响应属于上一个 profile，丢弃——切 profile 的 effect
      // 已经在取新的，这里不重入（避免自引用与请求风暴）。
      if (responseProfileIsStale(profileAtStart, host.state.profile.get())) return
      setRows((payload?.rows || []).map(normalizeRow).filter(Boolean))
      setLoadState('ready')
      // 恢复成功：记录成功时间并清除过期错误（失败时间不得覆盖最后成功时间）。
      succeededRef.current = true
      setLastSuccessAt(Date.now())
      emitDataUpdated()
    } catch {
      if (!aliveRef.current) return
      // 刷新失败：保留最后成功数据；横幅只用固定安全文案，不透传原始错误。
      setLoadState(succeededRef.current ? 'stale' : 'error')
    }
  }, [rest])

  useEffect(() => {
    aliveRef.current = true
    void load()
    const refresh = setInterval(() => void load(), REFRESH_MS)
    const reload = () => void load()
    window.addEventListener('subscription-meter:settings-changed', reload)

    return () => {
      aliveRef.current = false
      clearInterval(refresh)
      window.removeEventListener('subscription-meter:settings-changed', reload)
    }
  }, [load])

  // 切 profile → 立刻强刷一次，不等 5 分钟轮询（跳过首次：上面的 effect 已发起取数）。
  const profileRef = useRef(activeProfile)
  useEffect(() => {
    if (profileRef.current === activeProfile) return
    profileRef.current = activeProfile
    void load(true)
  }, [activeProfile, load])

  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(clock)
  }, [])

  const tooltipHandlers = {
    onPointerEnter: event => {
      const x = Number(event?.clientX) || 0
      const y = Number(event?.clientY) || 0
      setTooltip(state => ({ ...state, visible: true, x, y }))
    },
    onPointerMove: event => {
      const x = Number(event?.clientX) || 0
      const y = Number(event?.clientY) || 0
      setTooltip(state => (state.x !== x || state.y !== y)
        ? { ...state, visible: true, x, y }
        : state)
    },
    onPointerLeave: () => setTooltip(state => (state.visible ? { ...state, visible: false } : state))
  }

  if (!rows.length) {
    return jsx('div', {
      className: 'flex h-full items-center border-t border-(--ui-stroke-secondary) px-3',
      ...tooltipHandlers,
      children: [
        jsx('span', {
          className: 'text-[0.6rem] tracking-[0.08em] text-(--ui-text-quaternary)',
          children: loadState === 'error'
            ? 'SUBSCRIPTION DATA UNAVAILABLE'
            : loadState === 'ready'
              ? 'NO ENABLED QUOTA PROVIDERS'
              : 'LOADING SUBSCRIPTIONS…'
        }),
        jsx(SubscriptionMeterTooltip, {
          ...tooltip,
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
          tooltipRef
        })
      ]
    })
  }

  const displayRows = orderRowsForDisplay(rows, now)
  // 全量 quota 行池：含短窗行，供主窗行算锁定段（排序自 09-10 起不再取 min）。
  const quotaPool = displayRows.filter(r => r.kind === 'quota')
  // 短窗行不单独成行显示（2026-09-09 Neal 定）：只作主窗行的计算依据，不渲染。
  // 判定只认 role='burst'。
  const quotaRows = quotaPool.filter(r => r.role !== 'burst')
  const balanceRows = displayRows.filter(r => r.kind !== 'quota')
  const staleBanner = loadState === 'stale'
    ? `Refresh failed · data as of ${new Date(lastSuccessAt || 0).toLocaleTimeString()} (showing the last successful data)`
    : null

  return jsxs('div', {
    className: 'flex h-full min-w-0 flex-col gap-y-1 overflow-y-auto border-t border-(--ui-stroke-secondary) px-2 py-1',
    style: { rowGap: 6, paddingTop: 8, paddingBottom: 8 },
    ...tooltipHandlers,
    children: [
      staleBanner
        ? jsx('div', {
            className: 'shrink-0 truncate text-[0.6rem] text-(--ui-danger)',
            children: staleBanner
          })
        : null,
      ...quotaRows.map((subscription, index) =>
        jsx(WeeklyQuotaRow, {
          key: `subscription-${subscription.id || index}`,
          subscription,
          now,
          quotaPool
        })
      ),
      balanceRows.length > 0
        ? jsx('div', {
            ref: balanceLaneRef,
            // 与额度矩阵区之间一条淡分割线（2026-09-10 Neal 定的高级 SaaS 卡片化分隔）。
            // 布局（2026-09-10 Neal 定）：等宽 grid 改内容紧凑 flex——条目文字长短不一，
            // 等宽列里分隔线无法视觉居中；flex 下分隔线靠两侧等距 margin 真正居中。
            // 竖线（2026-09-11 Neal 定「分割线只出现在同一行 2 个余额条中间」）：
            // 条目间 24px 由 columnGap 提供（flex gap 不跨行，行首条目不缩进）；
            // 竖线 absolute 但挂在条目 div（relative）坐标系里——left:-12 即两条目
            // 间隙正中；offsetTop 与上一条不同 = 换行后的行首，不画。
            // 注意包含块：竖线若只相对容器定位，left:-12 会全部跑到容器左缘外。
            className: 'relative flex min-w-0 flex-wrap items-center gap-y-1 border-t border-(--ui-stroke-secondary) pt-1',
            style: { marginTop: 2, paddingTop: 8, columnGap: 24 },
            children: balanceRows.map((subscription, index) =>
              jsxs('div', {
                className: 'relative flex min-w-0 items-center',
                children: [
                  index > 0 && balanceRowTops[index] === balanceRowTops[index - 1]
                    ? jsx('span', {
                        key: 'sep',
                        'aria-hidden': true,
                        className: 'h-3 w-px shrink-0',
                        style: {
                          position: 'absolute',
                          left: -12,
                          top: '50%',
                          transform: 'translateY(-50%)',
                          backgroundColor: 'var(--ui-stroke-secondary)',
                          borderRadius: 0.5
                        }
                      })
                    : null,
                  jsx(BalanceSpendRow, {
                    key: 'row',
                    subscription,
                    now
                  })
                ]
              }, `subscription-${subscription.id || index}`)
            )
          })
        : null,
      jsx(SubscriptionMeterTooltip, {
        ...tooltip,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        tooltipRef
      })
    ]
  })
}

function SubscriptionMeterPage({ rest }) {
  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col gap-4 overflow-auto p-4',
    children: [
      jsxs('header', {
        children: [
          jsx('h1', {
            className: 'text-base font-medium text-foreground',
            children: 'Subscriptions'
          }),
          jsx('p', {
            className: 'mt-1 text-xs text-(--ui-text-tertiary)',
            children: 'Unified quota view across providers; plans show the 84-cell matrix, accounts show balance.'
          })
        ]
      }),
      jsx(ProviderSettingsPanel, { rest }),
      jsx('div', {
        className: 'min-h-40 flex-1',
        children: jsx(SubscriptionMeterBody, { rest })
      })
    ]
  })
}

export default {
  id: 'subscription-meter',
  name: 'Subscription Meter',
  description: 'Live subscription meters (Kimi/GLM/Codex weekly windows + DeepSeek balance).',
  defaultEnabled: true,
  register(ctx) {
    // 只访问当前 profile 的插件后端；失败即失败，不跨 profile 自动重试或读写
    // 其他 profile 的数据/设置（订阅凭据由各 profile 的插件启用状态自行决定）。
    const rest = (path, options = {}) => ctx.rest(path, options)

    const result = ctx.registerMany([
      {
        id: 'bottom',
        area: 'panes',
        order: 80,
        title: 'Subscriptions',
        data: {
          placement: 'bottom',
          dock: { pane: 'workspace', pos: 'bottom' },
          height: '13rem'
        },
        render: () => jsx(SubscriptionMeterBody, { rest: rest })
      },
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: '/subscription-meter' },
        render: () => jsx(SubscriptionMeterPage, { rest: rest })
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 56,
        data: { path: '/subscription-meter', label: 'Subscriptions', codicon: 'server' }
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'subscription-meter.open',
          keywords: ['订阅', '额度', 'subscription', 'quota'],
          label: 'Subscriptions: open the meter dashboard',
          run: () => host.navigate('/subscription-meter')
        }
      }
    ])

    host.notify({ kind: 'info', message: 'Subscription Meter registered (Hermes-native credentials)' })

    return result
  }
}

// reload nudge: 2026-09-10 locked cells solid blue/green, dashed day dividers

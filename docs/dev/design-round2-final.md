## 1. MeterRow 定稿字段表

只列通用化相关。已有 `used` / `usedPercent` / `resetAt` / `balance` 等保留。语义必改：`windowSeconds` **禁止**缺省当 7 天；禁止用 `18000` 认兄弟；标签禁止啃英文窗词。

| 字段 | 必填 | 语义 | 谁填 | 前端 |
|---|---|---|---|---|
| `providerId` | 必填 | 产品级 id，配对/去重/可见性 | 规范化←Identity | 只比相等，不查名表 |
| `role` | 时间行必填 | `cycle` \| `burst` | fetcher | 只渲染 `cycle`；`burst` 仅作家属 |
| `windowSeconds` | 时间行必填 | 本行窗口秒 | fetcher | 格时值=`ws/N`（N=84 恒定）；缺→不画轴，行内响 |
| `limit` | 有窗建议有 | 绝对值，量纲与 `used` 同 | fetcher | 两行 `limit` 都有则 `share=burst.limit/cycle.limit` |
| `burstShare` | 有 burst 时条件必填 | 锁定段占 cycle 的比例 (0,1] | 规范化能算则算；否则**同一 fetcher** 写在 **cycle 行** | `lockCells=clamp(round(share*N),0,N)`；缺→响，禁止当 0 |
| `peakHours` | 可选 | `{start,end,timezone}`，tz 必带 | 规范化从 Spec 抄 | 按该 tz 标高峰；有时刻无 tz→当无高峰并响 |
| `accent` | 可选 | 色 | 规范化：Spec 盖否则 `hash(id)` | 皮肤，不参与取数 |
| `gap` | 缺事实时必填 | 行内原因码（如 `no_window`/`no_share`/`no_peak_tz`/`partial`） | 规范化 | 看板行内文案；不静默少画 |

锁定段（零特例）：同 `providerId` 恰好一对 `cycle`+`burst`；cycle 用自家 `used/reset` 画主条；锁定格数来自 `burstShare`（或双 `limit`）；锁定填充/重置来自 burst 的 `used|usedPercent` 与 `resetAt`。burst **不单独成行**。日线：仅 `windowSeconds%86400===0` 时每 `86400/格时值` 格一条；`HOURS_PER_CELL=2` 删除。

看板必须行内响（不只 settings）：已出时间行但缺 `windowSeconds`；已配对 burst 但 share 与双 limit 皆无；`peakHours` 缺 tz；fetcher 已调用但 `partial`。仅 settings、看板不占行：`unrecognized` / `no_fetcher` / `unconfigured`。fetcher 已调用而全失败：出一行带 `gap` 的占位，避免空白。

## 2. FetcherSpec 定稿字段表

单模块 dataclass，detect+fetch 引用+显示默认；取数必须是代码。

| 字段 | 必填 | 语义 | 谁用 |
|---|---|---|---|
| `id` | 必填 | 产品级（`minimax-cn`≠`minimax`，`xai`≠`xai-inference`） | Identity.id |
| `fetch` | 可选 | 可调用对象；**空=有身份无取数** | 调度；空→`no_fetcher` |
| `shareable` | 必填 | 是否可与其它 id 共用取数源 | 仅取数层；不影响行/色/排序 |
| `matchers` | 必填 | 本 id 的规则组（见下） | detect，不发网 |
| `meta.accent` | 可选 | 品牌色盖 | 规范化抄到行 |
| `meta.peakHours` | 可选 | 须含 `timezone` | 规范化抄到行 |

**身份 ≠ 取数：** matcher 命中只产 `Identity{id, fetch|∅, status}`；无 `fetch` 绝不盲探、不占看板。

**detect 全局序（跨 Spec 一次排队，不是无序数组）：** ① 前缀按**长度**竞争；② OAuth 按 host id；③ env 槽位弱先验；④ ledger。禁止把三类拍平。

`account_usage` 只是一种 `fetch` 实现；失败走插件 fallback，出口仍是 MeterRow。宿主形状不进前端。禁止 OpenAI 兼容盲探。

## 3. 迁移步骤定稿

N=84 全程不动。禁止同一 PR 改契约又改所有 `_fetch_*`。标了 **[重启]** 的步须重启桌面 App；其余前端热更即时。

**M0 前端热更（先于任何后端）：** 新字段可选；有则用，无则旧表。验收：不重启、观感与今相同。风险：低。目的：后续重启不会红。

**M1 [重启] 仅 MiniMax fetcher 填新字段，旧字段仍发：** 验收：重启后锁定段仍在，且几何读的是新字段。风险：未做 M0 就重启会红——禁止。

**M2 前端热更删旧表：** 删 `18000` / `SHORT_WINDOW_RATIO` / `PEAK_RULES` / `ACCENTS` / 7 天默认 / `HOURS_PER_CELL` / `DEEPSEEK_TZ_SECONDS` / `compactWindowLabel` 啃词。验收：MiniMax 锁定仍对；缺 share→行内 `gap`。风险：M1 未重启时热更会红——必须 M1 已落地。

**M3 [重启] 7 表收成 FetcherSpec，不搬家函数体：** 验收：detect/fetch 与今一致。可与 M0 并行，**不可与 M2 同发**。

**M4 [重启] CN/Global 共用规范化，只差 base：** 验收：一家两端点两行身份不合并。

**M5 去 7 天假设（前端热更为主）：** 日线按整日倍数。验收：月窗 84 格有日线；非整日无；burst 不成行。

**M6 [重启] `shareable` 上 Spec，删 `shared_sources` 白名单：** 验收：共享只改取数源，看板行数/排序不变。

同类硬编码一并在 M2/M6 清掉，禁止再留名表。

**验收两组（不是名单变长）：**
- 通用：假供应商 ZETA（10d + 3h burst + share 0.12，随机窗），前端零名表；缺 share/缺 `windowSeconds` 必须响。
- 不回归：MiniMax / Kimi / Codex 各一份**冻结 MeterRow JSON fixture**，只断言纯函数——`lockCells`、`cellDuration`、有无日线、burst 不成行、排序键。禁止 DOM/文案/色值快照，避免 change-detector。

## 4. 我们仍不一致的点

1. **peak/accent 是否出现在 MeterRow。** 你：meta 层、非每行字段。我：真源在 Spec，**规范化必须抄进行**。定：抄进行。理由：否则前端必查 Spec，等于名表复活。
2. **burst 形态。** 你：`primary`+`role` 配对。我：值用 `cycle`\|`burst`（`primary` 易理解成主供应商）；数组双行、渲染过滤 burst，不嵌套。定：按我。理由：旧契约改动最小，英文社区语义更稳。
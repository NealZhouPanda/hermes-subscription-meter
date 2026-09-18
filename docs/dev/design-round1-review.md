**不同意你方案的核心：把「一家一条描述符」当唯一真源，再让前端按 `windowSeconds` 改格数，是把三件不同的事捆死了。** 通用化边界不是「装上就能显示全世界」，是「新增适配器只碰一处注册；缺事实必须响，不许默默少画」。

## 1. 错、脆弱、过度

**(1) 「一家一个条目」是假抽象。** 现实是产品/端点/置信度三层：`xai-` 推理 key ≠ Management 余额；`minimax-cn` ≠ `minimax`；DashScope 推理 key ≠ 阿里云 AK。detect 也不能收成无序的 `[前缀, OAuth, env]`：前缀按长度竞争，OAuth 靠 host id，env 槽位只是弱先验。压成一条会同时放大误认和漏认。识别表与取数表必须能独立存在（有身份无 fetcher = 已有的 `no_fetcher`）。

**(2) 短窗份额 / 高峰 / 品牌色不是同类事实，不该进同一描述符，更不该每行都带。** 份额是两行之间的量纲换算，真源是两行的绝对值 `limit`（能算就算）；算不出才由**吐出这两行的同一个 fetcher** 写在周期行上。高峰是定价/限流注解，API 几乎不给、还绑时区，塞进余额行/短窗行是噪声。accent 是皮肤，挡不了取数契约。`shared_sources` 白名单写死 `codex/grok` 同属漏一处。

**(3) 反对按窗口改矩阵格数。** 84 格是对齐用的视觉语法，不是「7 天」的数据模型。格数随窗变：月窗爆炸、多行对不齐、5h 变成短条，和「短窗只作家属、不单独成行」的产品决策冲突。正确：N 恒定，格时值 = `windowSeconds/N`；日线仅当窗口是整日倍数。前端用 `windowSeconds===18000` 找兄弟，和漏 `MINIMAX` 键是同一类硬编码，必须死。`windowSeconds` 缺失时默当 7 天，也是静默撒谎。

**(4) 「前端不认识任何供应商名」过纯。** visibility / 共享源 / 去重 / 兄弟配对仍要稳定 `providerId`。中立的是几何和配色，不是抹掉身份。`compactWindowLabel` 啃英文词同样要换成行上的 `role`。

**(5) 不要承诺探测任意中转 `/usage`。** 无适配器就无正确数字。一致性测试不要对照真名单。

## 2. 分层与数据流

```
凭据发现                 识别(有序,不发网)              取数                         规范化                    渲染
.env/auth.json      →  前缀 > OAuth > ledger     →  Fetcher                   →  MeterRow[]             →  固定 N 格
ledger/registry        槽位弱先验 > registry         可调宿主 account_usage        周期行 + burst 家属        burst 不单独成行
只收集,不分类            产出 Identity                 返回快照(used/limit/reset)    burstShare/peak/accent    缺字段 → 明示,不画假
                         (id, fetcher|∅, status)     不知皮肤                     唯一跨端契约               只比 id 相等,不查名表
```

发现不分类；识别不发网；取数不知皮肤；**规范化是唯一行契约**；渲染不查供应商表。Identity id 是产品级（`minimax-cn`、`xai`），不是厂牌级。

## 3. 四个决策

**a. 形态：单模块 dataclass 注册表**（detect 规则 + fetch 引用 + 显示默认）。不要 YAML/JSON——取数必须是代码，一拆又散。不要 `providers/*.py`——十来家、独立仓靠 PR，文件爆炸无收益。类型靠 dataclass + pytest。宿主不可改，别幻想描述符被核心复用；对外复用面是 MeterRow JSON。保留 `globals()` 这条 monkeypatch 缝。

**b. 套餐事实：API 绝对值 > fetcher 声明默认 > 暂不做用户覆盖。** 不表达 = MiniMax 验收失败。高峰无 API 就写在 fetcher meta，**必须带 timezone**，禁止前端写死 UTC+8。色：`hash(id)` 默认 + meta 可盖。设置项等真出现分档再做。

**c. 无适配器：停在 settings 的 `unrecognized` / `no_fetcher`，看板不占行。** 禁止 OpenAI 兼容盲探。中转 key 前缀能认上游但无 fetcher → `no_fetcher`，不要假装余额行。

**d. 插件自建 MeterRow；`account_usage` 只是一种 fetcher 实现。** 宿主形状不进前端。宿主新增供应商不会自动成行——刻意的，宿主字段不够 burst/reset。

## 4. 迁移（可独立验收，禁大爆炸）

- **S1** 行契约加可选 `role` / `limit` / `burstShare` / `peak` / `accent`；只让 MiniMax fetcher 填。前端新字段优先、旧表兜底。验收：锁定段出现。
- **S2** 删 `SHORT_WINDOW_RATIO` / `PEAK_RULES` / `ACCENTS` / `18000` / 7 天默认。缺 `burstShare` 改警告。紧接 S1。
- **S3** 后端 7 表收成 `FetcherSpec`，**不搬家函数体**。可与 S1 并行。
- **S4** MiniMax CN/Global 共用规范化，只差 base。证明一家多端点。
- **S5** 去 7 天假设；日线按整日倍数；格数不动。

禁止同一 PR 改契约又改所有 `_fetch_*`。

## 5. 验收（证明通用化，不是证明名单变长）

- 假供应商 ZETA：10 天窗 + 3h burst + share 0.12，前端零名表，锁定格正确。
- burst 在而 share/limit 缺 → 明示，锁定格 ≠ 静默 0。
- `windowSeconds` 缺 → 不按周画，明示。
- 月窗仍 84 格有日线；非整日窗无日线；burst 不单独成行。
- 只加 Spec+函数、前端不改，新供应商能画。
- matcher 无 fetcher → 仅 settings；未识别 key → `unrecognized` 无行。
- 同厂两产品（xai / xai-inference）不合并。
- `account_usage` 失败走插件 fallback，仍是 MeterRow。
- Spec：能吐 burst 则必须有绝对值或 share；`shareable` 在 Spec 上，不写死两家。
- 渲染测试用随机窗口，禁用真名表。
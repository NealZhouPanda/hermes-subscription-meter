# 供应商资料库（2026-09-22 草稿）

合并 batch-a/b 12 家候选供应商的 key 规则与余额/额度查询方式。状态：draft，未经真实账户实测。来源与证据等级见 catalog.json 与 sources.jsonl。

## 总表（12 家）

| 供应商 | id | key 已知特征（证据强度） | 查询方法（级别） | 鉴权方式 | 主要缺口 |
|---|---|---|---|---|---|
| OpenAI | openai | sk-proj-/sk-svcacct-/sk-admin-/sk- 凭据类型官方提及；长度本次未查到官方规范（社区帖见 48/156 字符说法，community 级，未核实） | 用量/成本报表 API（public-documented，需 Admin key）；Codex 订阅配额仅客户端响应头 | Bearer（推理）/ Admin key / OAuth | 预付费余额公开端点本次未查到 |
| Anthropic | anthropic | sk-ant- 前缀官方明示；完整长度/结构本次未查到官方规范 | 用量/成本报表 API（public-documented，需 Admin key 或 org:admin OAuth） | x-api-key 头 | 个人账号不可用报表；订阅用量已查到的途径为 CLI /status 展示 |
| Google | google | Standard / Authorization (auth) 两类密钥及迁移已获文档支持；具体前缀（社区见 AIza/AQ.Ab 字样）本次未核实 | 限流按 RPM/TPM/RPD 文档口径；余额端点本次未查到 | x-goog-api-key / ?key= / OAuth | 完整 key 长度本次未查到规范；订阅用量查询 API 本次未查到 |
| xAI | xai | 推理 key 格式本次未查到官方公开资料（unverified） | 管理面 prepaid/balance + usage（official-console-undocumented，字段规格本次未查到） | Management key Bearer（与推理 key 分开；管理 key 查询≠普通推理 key 可查询） | 未见编程订阅套餐（未核实）；推理 key 格式未核实 |
| DeepSeek | deepseek | 社区见 sk-（community 级）；官方格式规范本次未查到 | GET /user/balance 余额（public-documented，父代理官方页复核） | Bearer 常规 API key | 未见编程订阅套餐（未核实） |
| 字节·火山方舟 | volcengine-ark | 各类 key 格式官方公开资料本次未查到（unverified） | 管控面 OpenAPI ListUsage / GetCodingPlanUsage / GetAFPUsage（AK/SK SigV4；字段规格部分本次未查到） | 推理 Bearer key 与火山 AK/SK 两套凭据，互不可代替 | Coding/Agent Plan key 与后付费 key 格式异同未核实 |
| 阿里云百炼 | aliyun-bailian | 通用 sk-、Coding Plan sk-sp-（docs-prefix-only）；两家 sk-sp- 前缀重合，仅记录文档所见 | BSS QueryAccountBalance + GetBillingOverview（official-documented，AK/SK/RAM）；Coding Plan 额度查询接口未核实，已查到的途径为控制台 | 阿里云 AK/SK 或 RAM | 通用 key 精确长度规范本次未查到；Coding Plan 查询 API 未核实 |
| 智谱 AI | zhipu-glm | id.secret 两段点分（docs-structure-only）；前缀本次未查到 | 公开余额/积分查询 API 本次未查到；已查到的途径为控制台查看 | Bearer 直用或派生 JWT | 个人版 Coding key 与按量 key 是否同 key 未证实 |
| 月之暗面 Kimi | moonshot-kimi | 社区见 sk-（community 级）；Kimi Code key 控制台创建仅显示一次 | GET /v1/users/me/balance（official-documented，含 available/voucher/cash_balance） | Bearer API key | Coding 额度查询 API 未核实；两套 key 是否通用未核实 |
| MiniMax | minimax | 两类 key 前缀官方文档未给出，本次未查到（社区传闻不采信） | 订阅 Token Plan：GET /v1/token_plan/remains（official-documented，属套餐额度 quota 非现金余额）；按量余额查询接口未核实，已查到的途径为控制台 | Bearer 订阅 Key | 按量余额公开 API 本次未查到 |
| 腾讯云混元/TokenHub | tencent-hunyuan | 按量 sk-、Coding Plan sk-sp-、TokenHub sk-tp-（官方脱敏示例，docs 级）；sk-sp- 与阿里重合仅记录文档所见 | DescribeAccountBalance（official-documented，AK/SK）；TokenHub DescribeTokenPlanList 等（official-documented）；Coding Plan 用量查询接口未核实，已查到的途径为控制台 | 腾讯云 AK/SK / Bearer key | 按量 key 长度规范本次未查到；剩余额度专用接口等价性未核实 |
| 百度千帆 | baidu-qianfan | bce-v3/ALTAK- 官方示例所见（docs-example-partial）；Coding Plan key 前缀本次未查到 | /v1/finance/cash/balance 账号级余额（official-documented，AK/SK）；Coding Plan 用量查询接口未核实，已查到的途径为控制台 | BCE AK/SK 签名 / Bearer key | 资源包/点数余量查询接口未核实 |

## 重要口径
- 「未查到/未核实」表示本次检索未找到证据，不等于不存在；「已查到的途径为…」只描述已核实的途径，不排除其他途径。
- 云厂商账号级余额查询使用 AK/SK 管理凭据，不代表普通推理 API key 可查询余额。
- Google：Standard/Auth 两类密钥已获文档支持；具体前缀本次未核实，不作为可执行规则传播。
- 所有条目仅记录证据强度，不做「均无规范」「全网不存在」式概括。
- 管理台/工具对 key 的脱敏占位不代表公开 key 格式；Admin key 是官方凭据类型概念，其完整样式本次未核实。

## 文件
- catalog.json：结构化主档（schema_version 1.0, status=draft, 12 providers）
- sources.jsonl：46 条公开证据（含 URL/引文/验证方式）
- validation.json：stdlib 程序校验结果（pass）
- MAINTENANCE.md：维护方式

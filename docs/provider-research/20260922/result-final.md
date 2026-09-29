# result-final.md — 供应商资料库最终状态

日期：2026-09-22　状态：draft（未经真实账户实测）

## 产出文件（长期目录 docs/provider-research/20260922/ 与 zip）
catalog.json / sources.jsonl / README.md / MAINTENANCE.md / validation.json / result-final.md / provider-research-20260922.zip

## 12 家供应商（24 产品线）
1. OpenAI（openai）— 2 个产品线
2. Anthropic（anthropic）— 2 个产品线
3. Google（google）— 2 个产品线
4. xAI（xai）— 1 个产品线
5. DeepSeek（deepseek）— 1 个产品线
6. 字节跳动（火山引擎·方舟）（volcengine-ark）— 3 个产品线
7. 阿里云（百炼 Model Studio / 通义）（aliyun-bailian）— 2 个产品线
8. 智谱 AI（BigModel / z.ai）（zhipu-glm）— 2 个产品线
9. 月之暗面（Kimi 开放平台）（moonshot-kimi）— 2 个产品线
10. MiniMax（开放平台）（minimax）— 2 个产品线
11. 腾讯云（混元 / TokenHub）（tencent-hunyuan）— 3 个产品线
12. 百度智能云（千帆 ModelBuilder）（baidu-qianfan）— 2 个产品线

## 证据状态
- 所有 key 格式/长度/前缀类条目只记录证据强度（official / docs / community / unverified）。
- 无来源支持的断言已从规则与正文移除，仅存于 unverified note 或标注 unverified_parts 的来源条目。
- 未查到的能力一律记为「本次未查到/未核实」，不声明全网不存在。

## 程序验证结果
validation.json status=pass：12 家唯一 id，24 个产品线，46 条唯一来源 URL（每条证据单一 URL），50 条证据行（2026-09-23 追加 Kimi 4 条，旧行未改）；全部 URL 可解析、全部 JSON 可解析。

## 边界声明
- 真实账户测试仅 Kimi Code 额度一处（2026-09-23，coding key 实调 `/coding/v1/usages` 与订阅页月额度口）。其余查询接口仍是文档/来源级核验，未用真实 key 实调。
- 无自动更新：维护见 MAINTENANCE.md，纯手工流程，无定时任务。
- git 仅新增 docs/provider-research/20260922/ 目录，不改已有代码/文档，不提交不推送。

# Development Log

2026-09-22 — docs/provider-research/20260922: provider reference library added

- Added `docs/provider-research/20260922/`, a reference library covering API key ownership rules and quota/balance lookup paths for mainstream providers: structured `catalog.json`, public-source `sources.jsonl` (46 evidence entries), Chinese README, `MAINTENANCE.md`, and `validation.json`. An archive zip was placed at `docs/provider-research/provider-research-20260922.zip`.
- Current coverage: 12 providers (openai, anthropic, google, xai, deepseek, volcengine-ark, aliyun-bailian, zhipu-glm, moonshot-kimi, minimax, tencent-hunyuan, baidu-qianfan), 24 product lines, 46 evidence entries. Every entry keeps its source, verification date, evidence strength, and open gaps (items not found are recorded as "not found this pass", never as "does not exist").
- Verification scope: public documentation and source inspection only. No real-account API testing was performed; catalog status remains `draft`.
- Out of scope this round: no plugin recognition code was updated, the isolated user_ patch was not applied, no auto-update task was scheduled, and nothing was committed or pushed.

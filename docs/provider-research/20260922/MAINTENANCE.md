# MAINTENANCE 维护方式

## 现状
本资料库为 2026-09-22 一次性合并产物（status=draft）。**没有任何定时自动更新任务已实现**——不得声称自动更新。

## 手工维护流程
1. 每次修订前先对来源核验：逐条打开 sources.jsonl 的 URL，确认引文仍存在且口径未变；失效的标记 stale 并注明日期。
2. 修改 catalog.json 后必须重跑 validation（stdlib 断言：12 家唯一 id、必填字段、source URL 单一、来源链接可回溯），更新 validation.json。
3. 变更追加点：key 前缀/格式变化、查询端点变化、订阅套餐上下线、官方文档口径变化。
4. 新证据只追加到 sources.jsonl，不改写旧行（保留历史）；确认被后续纠正的结论在 catalog 中改口径并注明。

## 定期核验建议（均为建议，尚未落地）
- 季度核验一轮：各家官方文档 URL 存活 + 关键引文比对。
- 官方公告渠道（changelog/blog）发生涉 key/计费/额度变化时优先复核对应供应商。
- 核验通过后建议由人工审核（PR review）再合入，不自动提交。

## 测试与审核
- 每次改动跑 validation.json 生成流程并检查 status=pass。
- 禁止在本库中存放真实 key、会话或任务日志；打包前检查。

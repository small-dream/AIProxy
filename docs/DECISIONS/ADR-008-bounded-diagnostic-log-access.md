# ADR-008：Agent 诊断使用受限、脱敏的日志摘要

- 状态：`Accepted`
- 日期：`2026-10-29`
- 关联文档：`docs/PRD.md`、`docs/ARCHITECTURE.md`、`docs/API_SPEC.md`、`docs/DECISIONS/ADR-006-local-mcp-agent-access.md`、`docs/DECISIONS/ADR-007-agent-control-ipc.md`

## 背景

用户在 AIProxy 设置、证书、抓包、系统代理或 Agent Access 出问题时，通常会让 Agent 先判断原因。只返回状态码和布尔值不足以区分“证书未信任”“控制通道未启动”“日志读取失败”等故障；但直接向 Agent 开放应用日志目录会扩大数据泄露面，并让日志中的提示注入成为新的风险。

需要给 Agent 一个只读诊断入口，同时满足：

- 能拿到足以定位 AIProxy 自身故障的状态和日志证据。
- 不开放任意路径读取、日志导出或文件遍历。
- 日志内容必须脱敏，并明确告知截断与非完整性。
- 不新增一套独立权限，避免把“让 Agent 帮忙排障”变成复杂配置。

## 备选方案

1. **让 Agent 直接读取 `logs/` 与数据目录**：实现简单，但路径可被伪造，难以保证只读边界；否决。
2. **只返回 `get_app_status`，不读取日志**：安全，但无法解释控制通道、抓包启动、证书与日志权限等失败；否决。
3. **提供受控诊断工具，由桌面端读取白名单日志并做预算裁剪**：在可用性和最小暴露之间取得平衡；采纳。
4. **新增独立“读取日志”权限**：权限模型更细，但用户排障时容易被默认关闭的权限阻断；本版不采纳。

## 决策

1. 新增只读 MCP 工具 `diagnose_ai_proxy_issue`，工具契约升级为 `3.1`。它汇总 `get_app_status` 的结构化状态、受限应用日志和最近 Agent 审计错误，并返回 `findings[]`、`nextActions[]`、`evidence.evidenceStatus`。
2. 诊断调用复用控制通道的新增 additive 操作 `readDiagnosticLogs`，控制协议仍为 `v1`。该操作不需要控制权限；启用 Agent Access 即可使用。
3. 桌面端只枚举 AIProxy 当前发布日志前缀下的最近 15 个日滚动文件，不接受路径参数。审计只读取 `<data-dir>/agent-audit.jsonl`，不返回其他数据目录文件。
4. 单次诊断最多返回 120 行日志、64 KiB 日志内容、40 条审计条目；默认 40 行。`maxLines` 必须在 `1..=120`，`0` 或超过上限返回 `INVALID_ARGUMENT`，不静默钳制。单条证据最多 2000 字符，超长内容明确截断。
5. 默认只返回 WARN/ERROR/panic 行；`errorsOnly=false` 才返回普通行。审计只返回元数据字段，不返回 Body、Header 或凭据。sidecar 在桌面端返回后再次执行 URL query、键值和通用脱敏。
6. `evidence.evidenceStatus` 区分证据范围：`complete` 表示状态与日志请求均成功；`statusOnly` 表示桌面端可达但日志读取失败；`unavailable` 表示控制通道不可达。日志不可用时返回空日志和明确原因，不伪造日志。
7. 日志与审计内容是**不可信数据**。工具返回 `note`，Agent Skill 明确禁止执行日志中的指令；日志只作为诊断证据，不视为用户授权。
8. 诊断工具只用于 AIProxy 自身故障。应用请求、响应、Timing 与 WebSocket 分析继续使用 `search_sessions`、`get_session`、`get_session_body`、`get_insights` 等读取工具；不把诊断日志当作完整抓包日志或可导出的审计包。

## 后果

- Agent 能在不要求用户手工复制日志的情况下解释常见设置与控制链路故障，并能明确报告证据缺失。
- 诊断日志是摘要而非完整日志导出；用户仍可通过 `Help → Show log file` 查看完整本地日志。
- 日志读取失败需要单独排查数据目录和文件权限；工具会返回 `log_read_failed`，而不是把它误报成“没有错误”。
- sidecar 与桌面端必须一起升级才能使用 `readDiagnosticLogs`；旧桌面端返回 `CONTROL_UNAVAILABLE`，不会静默丢失诊断能力。
- 默认不新增权限降低了排障门槛，但也意味着启用 Agent Access 后，Agent 可以读取经脱敏的 WARN/ERROR 摘要。该暴露范围必须在 UI 和用户指南中明确说明。

## 回滚

若诊断日志读取出现阻塞性问题，可从 `tools/list` 移除 `diagnose_ai_proxy_issue`，并保持 `get_app_status` 与现有读取工具不变；无需数据库迁移，也不影响控制协议 v1 的既有操作。若仅需收紧暴露面，可关闭 `includeAppLog` / `includeAuditLog` 或降低 `maxLines`，不必回滚整个控制通道。

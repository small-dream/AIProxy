# ADR-009：Agent 重放直连上游，临时规则只存在于内存

- 状态：`Accepted`
- 日期：`2026-10-30`
- 关联文档：`docs/PRD.md`、`docs/ARCHITECTURE.md`、`docs/API_SPEC.md`、`docs/MCP_AGENT_LOOP_PLAN.md`、`docs/DECISIONS/ADR-006-local-mcp-agent-access.md`、`docs/DECISIONS/ADR-007-agent-control-ipc.md`

## 背景

3.1 之前，Agent 能“看抓包”，但不能可靠完成“复现并验证”。两个缺口最明显：

- 用户要求重发一条请求时，Agent 只能生成 cURL，交给用户手工执行。
- 需要模拟 Header、Query、响应 Body 或 Mock 边界条件时，Agent 无法安全地临时改动代理链路，也没有自动失效机制。

重放与规则写入都会放大风险。如果重放经过 AIProxy 监听端口，规则会参与请求，Agent 可能把规则效果误当成上游行为；如果允许任意持久化规则，临时实验很容易残留并影响用户日常流量。如果允许跨 host 重放或 Map Remote，生产请求可能被发送到未经验证的目标。

## 备选方案

1. **重放经过 AIProxy 监听端口**：能复用规则和抓包链路，但依赖代理运行与证书信任，且很容易让 Agent 误以为重放在验证规则；否决。
2. **重放使用新的 HTTP 客户端实现**：行为可能和现有 Compose 发送器不一致，重复实现超时、TLS、Header 与二进制 Body 处理；否决。
3. **Agent 规则持久化到用户规则表**：实现简单，但需要 schema 变更、清理任务和“临时/永久”冲突处理，残留风险高；否决。
4. **重放直连原始上游，临时规则只存在于内存**：复用现有发送器，规则生命周期清晰，不污染用户配置；采纳。

## 决策

1. `replay_session` 从已持久化的完整 HTTP 会话恢复方法、URL、Headers 与二进制请求 Body，通过桌面端现有的 `send_direct_request_bytes` 直连原始上游 host 发送。请求不经过 AIProxy 监听端口，也不执行用户或 Agent 规则。
2. 重放严格锁定原始 host。URL 只允许通过 `setQueryParams` 修改 Query；设置或删除 `Host`、HTTP/2 pseudo-header 一律返回 `INVALID_ARGUMENT`。`mapRemote` 同样只能指向匹配 host。
3. 重放串行执行，同一时刻最多一个请求，60 秒窗口内最多 10 次；超限返回 `RATE_LIMITED` 且 `retryable=true`。捕获时已截断的请求 Body 不得静默重放，必须由调用方提供完整 `body` 覆盖。
4. 重放结果作为新会话持久化，`timingSource=agentReplay`。成功返回 `newSessionId`、`statusCode`、`durationMs` 与可选 `failure`；发送前失败返回 `REPLAY_FAILED`，不伪造新会话。
5. 新增权限 `sendRequests`，默认关闭。重放是真实出站请求，非幂等方法的调用必须由用户在当前对话中明确要求；MCP annotation 标记 `openWorldHint=true`、`destructiveHint=false`、`idempotentHint=false`，提示客户端确认外部副作用。
6. 新增权限 `manageRules`，默认关闭，控制 `create_agent_rule`、`list_agent_rules`、`remove_agent_rules`。Agent 只能管理注册表中的临时规则，不能读取或修改用户规则。
7. Agent 规则复用现有 `RewriteManager` 与 `MapManager`，但注册表 `AgentRuleRegistry` 只存在于桌面进程内存。规则不写入用户规则数据库；应用重启后自然消失。
8. Agent 规则动作限制为 Header、Query、响应 Header/Body、同 host `mapRemote` 与本地 Mock Response。匹配方式默认 `wildcard`，也可显式使用 `exact`；禁止 `contains`、regex、wildcard host、跨 host 目标与任意脚本。规则管理器除 URL pattern 外还会保存并比较精确 host 锁。TTL 默认 600 秒、最大 3600 秒，最多 20 条，每 15 秒清理过期项并删除 mock Body 文件。
9. Mock Body 写入 `<data-dir>/agent-rules/<ruleId>.body`，最大 256 KiB；Unix 目录 `0700`、文件 `0600`，Windows 继承当前用户数据目录 ACL。删除、过期、一键清理与规则页删除都会同步移除辅助 Content-Type 规则和 Body 文件。
10. 规则页将 Agent 规则标记为 `source="agent"` 并展示 `expiresAt`。Agent 规则只读：不能编辑、启停、选择、拖拽或批量更新；仍可删除和复制。复制会去掉 `source` / `expiresAt`，生成普通持久化规则；规则页提供清除全部 Agent 规则的确认入口。
11. 审计摘要只记录 session ID、规则动作类型、覆盖字段名与数量，不记录 Header、Query、Body 或规则值。规则页保存 Agent 规则 ID 返回 `RULE_READ_ONLY`，避免通过 UI 命令绕过注册表。
12. 工具描述、MCP instructions 与内置 Skill 必须明确“重放不经过规则”。验证规则时应由真实客户端重发，再用 `wait_for_sessions` 等待新会话并读取 `ruleTraces`。

## 后果

- Agent 可以完成“复现 → 修改输入 → 观察结果 → 清理临时规则”的闭环，同时不会把临时实验写进用户规则库。
- 重放仍会产生真实外部副作用，限流和权限只能降低误操作概率，不能替代用户授权。
- 由于重放不经过规则，不能用它验证 Rewrite / Map / Throttle；需要在 Skill 和输出模板中持续强调，避免错误结论。
- Agent 规则在应用重启后失效是刻意行为；如果用户需要持久化，只能显式复制成普通规则。
- 内存规则与数据库规则共用 manager 快照，因此列表必须过滤辅助规则，并在用户命令入口检查 Agent 注册表，防止绕过只读约束。
- mock Body 文件需要清理策略覆盖删除、过期、应用退出和异常残留；当前使用 TTL 清理与启动后空注册表，不主动信任上次进程遗留文件。

## 回滚

若重放出现阻塞性问题，可移除 `replay_session` 并关闭 `sendRequests`，不影响读取、诊断与既有控制工具。若临时规则出现影响面问题，可移除三个规则工具并停止创建注册表；规则只存在于内存，回滚无需数据库迁移，重启即清空。清除入口与规则页标记可保留为防御性 UI。

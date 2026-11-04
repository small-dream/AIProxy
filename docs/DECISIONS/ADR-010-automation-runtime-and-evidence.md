# ADR-010：Agent 自动化使用数据库权威状态、统一运行时快照与分级证据

- 状态：`Accepted`
- 日期：`2026-11-04`
- 关联文档：`docs/PRD.md`、`docs/ARCHITECTURE.md`、`docs/API_SPEC.md`、`docs/UI_GUIDELINES.md`、`docs/PAGE_BLUEPRINTS.md`、`docs/MCP_AGENT_AUTOMATION_CONTROL_PLAN.md`、`docs/DECISIONS/ADR-006-local-mcp-agent-access.md`、`docs/DECISIONS/ADR-007-agent-control-ipc.md`、`docs/DECISIONS/ADR-009-agent-replay-and-temporary-rules.md`

## 背景

Agent 已经可以读取抓包、受控操作桌面端、直连重放和创建内存临时规则，但“修改规则”仍缺少可自动验证、可回滚、可解释的闭环。若直接开放全部规则 CRUD，会出现以下风险：

- `replay_session` 直连上游并绕过全部规则，不能证明 Rewrite / Map 生效；若误当作验证手段，会得到错误结论。
- 规则写入口分散在 UI、Agent IPC、TTL 清理和启动恢复中，SQLite、内存 manager 与文件系统无法共享一个真正的跨资源事务。
- 旧 `manageRules` 只表示有限的临时规则，若升级后自动扩展为持久化规则、脚本或跨 host 映射，等于扩大既有授权。
- 整个 workspace 哈希回滚会被无关规则变化阻断；临时实验也可能覆盖用户后来切换的 Throttle Profile。
- Breakpoint 没有 workspace 列且需要人工处理命中请求，不能与普通 workspace 规则共用隔离和自动清理语义。

## 备选方案

1. **直接开放全部规则 CRUD，并继续用 `replay_session` 验证**：实现快，但重放不经过规则，证据语义错误；同时把高风险权限混入旧授权。否决。
2. **只提供离线预演，不发布真实运行时**：安全，但无法证明规则在代理链路中实际生效。仅作为证据的一级，不足以独立完成闭环。否决为唯一方案。
3. **为每次写入实现跨 SQLite、内存和文件的分布式事务**：需要复杂补偿协议，现有后台无法提供真正的原子提交。否决。
4. **数据库权威状态 + 共享写锁 + 统一运行时快照 + 分级证据**：接受“数据库已提交但运行时发布失败”这一可恢复状态，用明确状态和恢复流程处理，而不是承诺不存在的原子性。采纳。

## 决策

### 1. 权限独立且默认关闭

- 新增 `manageAutomation`、`manageUserAutomation`、`manageScripts`、`manageCrossHostMappings`、`manageProxiedVerification`、`manageGlobalAutomation`，全部默认 `false`。
- 旧 `manageRules` 保持临时 Rewrite / Map 规则的语义，不推导任何新权限；升级不会隐式提权。
- 所有自动化工具至少要求 `manageAutomation`。更新、删除或回滚用户资源额外要求 `manageUserAutomation`；代理验证额外要求 `manageProxiedVerification`。
- 首版仅开放 Rewrite 与 Map Local。Map Remote、DNS、Script、Throttle、Breakpoint、Throttle activation 与 global scope 返回 `FEATURE_NOT_AVAILABLE`；预留权限不会绕过该限制。
- Rewrite Redirect 的目标 host 必须与规则匹配的精确 host 一致。跨 host Redirect 同样返回 `FEATURE_NOT_AVAILABLE`，`manageCrossHostMappings` 不能绕过；代理验证在发送前和收到 trace 后都检查变换后的 host，避免规则把凭据带到未授权目标。

### 2. 数据库是权威状态，运行时是发布结果

- 新增 `automation_resources`、`automation_change_sets`、`automation_change_items`、`automation_experiments`、`automation_verifications`。
- 资源所有权、生命周期、change 状态、实验、验证与清理状态以 SQLite 为准；运行时 manager 只是已发布的投影。
- `automation_mutation_lock` 串行化 UI、Agent、TTL 清理、回滚、提升和 clear 的自动化写入；`AgentRuleRegistry::mutation_lock` 保护 legacy 临时规则注册表。
- 写入流程为：validate → 准备托管资产和目标规则 → 同一 SQLite 事务写入业务数据、ownership、change items 与 change set → 发布统一 `RuntimeRuleSnapshot` → 记录 `active`。
- 只有 change set 进入 `active` 才返回 apply 成功。若数据库已提交但运行时发布失败，返回 `RUNTIME_PUBLISH_FAILED`；重试同一幂等计划会重新发布并激活原 change，而不是创建重复资源。

### 3. Rewrite 与 Map 统一发布代次

- `RuntimeRuleSnapshot` 同时承载 Rewrite 与 Map manager 快照，一次发布递增共享 `runtimeGeneration`。
- 代理请求在入口固定 generation，避免请求处理中看到半更新的规则集合。
- legacy Agent 临时规则在注册表锁内合并到快照；它们继续只存在内存，不获得持久化、脚本、DNS、Throttle 或跨 host 能力。
- 验证结果携带 `runtimeGeneration`。目标资源版本或 generation 已变化时，旧证据不能被当作当前资源的证明。

### 4. 资源级回滚与明确恢复语义

- 回滚按 change items 的目标版本和依赖检查，不使用整个 workspace 哈希；无关资源变化不得阻断回滚。
- 更新项只有在当前版本等于 `versionAfter` 且依赖未变时才恢复 `before`；删除项只有在目标仍不存在时才重建；冲突返回 `ROLLBACK_CONFLICT`。
- 常驻 change 可提升为用户资源，状态变为 `promoted` 且不可回滚。`clear_agent_automation` 只清理当前安装实例中的 Agent 自有资源，不删除或恢复用户资源；它直接删除目标资源和元数据，并终止这些资源的完整 change 历史，不能靠回滚最后一个 change 恢复出更早的 Agent 版本。运行时发布后仍有目标残留时返回 `CLEANUP_INCOMPLETE`。
- `ephemeral` 首版只允许新建资源，禁止 update、delete 和激活既有 Profile；TTL 为 60-3600 秒，默认 600 秒。到期、clear 或应用重启都会撤销实验。
- 常驻计划禁止更新仍归属 `ephemeral` change 的资源；调用方必须等待 TTL、先 clear，或新建常驻资源。禁止跨生命周期原地转换，避免旧临时快照覆盖新内容。
- 启动恢复丢弃重启前仍有效的 ephemeral change；对未完成常驻 change 比较目标版本处于变更前或变更后，混合状态返回 `RECOVERY_CONFLICT`，不猜测修复。
- Breakpoint 明确为全局资源，首版不开放写控制；未来需要独立权限与有次数、时限、作用域限制的处理能力。

### 5. 三级证据，禁止混淆证明范围

- `offline`：使用与代理链路相同的匹配和变换实现执行离线预演，不发网络请求。证明匹配与变换结果，不证明代理运行时、网络路径或客户端渲染。
- `proxy`：通过当前 AIProxy 监听端口向精确 origin 白名单发送受控请求，只允许 `GET` / `HEAD` / `OPTIONS`，单批最多 20 个、每分钟最多 10 个请求，响应体最多 256 KiB。需要代理运行；HTTPS 需要 SSL interception 与受信任根证书。
- `external`：读取真实客户端在 change 激活后产生的持久化会话，检查规则 trace 与断言。`agentReplay` 会话和激活前的会话返回 `INSUFFICIENT_EVIDENCE`。
- 每个结果都返回 `evidenceLevel`、`runtimeGeneration`、断言结果、证据会话、规则 trace 引用、冲突诊断和 `limitations`。UI 与 Agent 必须报告证据等级，不能把 `offline` 或 `proxy` 说成真实客户端验证。
- 断言结果同时返回 `subject` 与 `path`，使调用方知道 `actual` 的来源；输出脱敏按资源结构和断言来源执行，不能只对裸字符串做值匹配。

### 6. 可恢复失败与资源清理

- 托管资产只写入 change staging 目录，Map Local 的 `approvedPath` 必须位于用户通过系统选择器批准的根目录内；路径越界和符号链接逃逸返回 `PATH_NOT_APPROVED`。
- 失败状态区分 `RUNTIME_PUBLISH_FAILED`、`ACTIVATION_RECORD_FAILED`、`STATE_CONFLICT`、`CHANGE_NOT_APPLICABLE` 与 `ROLLBACK_CONFLICT`，调用方不得用“完全成功”或“完全失败”概括未知状态。
- validate 必须拒绝同一计划内重复更新、重复删除，以及同一资源的 upsert/delete 重叠；这些冲突不能留到数据库或回滚阶段才暴露。
- `automation-changed` 事件携带 change、generation、scope、生命周期、实验与清理状态；前端定向刷新查询，不直接合并载荷，也不清空编辑草稿。
- 敏感值在 API、审计、事件与 UI 快照中继续脱敏；自动化输出识别 Header、Query、JSON 字段及断言 `subject/path` 的来源结构，自动化日志只记录动作摘要、资源 ID、数量、状态和错误码。

## 后果

- Agent 可以完成“读取资源 → 校验计划 → 应用 → 分级验证 → 查看证据 → 回滚 / 提升 / 清理”的闭环，而不需要用户手工复制规则或解释原始日志。
- 首版能力有意收窄到 Rewrite + Map Local；Script、DNS、Throttle、Map Remote 与 Breakpoint 的用户价值要等各自的安全模型和证据链路成熟后再开放。
- 数据库事务与运行时发布不是单一原子操作，因此存在需要恢复的中间状态；这是显式接受并测试的失败语义，不应在文案中承诺“零残留”。
- 资源级回滚需要保存 before / after 快照和依赖指纹，数据库体积会增长；后续需要按保留策略清理已结束实验的详细记录。
- 代理验证会产生真实出站请求，必须依赖权限、origin 白名单、方法限制、限流和证书前提共同约束，不能替代用户对生产流量的判断。

## 回滚

- 功能级回滚：关闭 `manageAutomation` 并移除 8 个自动化 MCP 工具；已持久化的 Agent 资源可先通过 `clear_agent_automation` 清理，用户资源不受影响。
- 数据级回滚：新增表只做增量迁移，不回写旧规则表；保留旧 `create_agent_rule` / `list_agent_rules` / `remove_agent_rules` 与 `manageRules` 兼容路径。
- 运行时回滚：恢复旧 Rewrite / Map 发布路径，停止使用 `RuntimeRuleSnapshot` 与自动化 generation；legacy 临时规则仍在内存注册表中工作。
- 权限回滚：删除新增权限时，旧配置按缺失字段补 `false` 处理，不自动开启任何能力；需要同步更新 API、UI 和帮助文档。


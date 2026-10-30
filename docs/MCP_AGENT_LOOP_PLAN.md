# AIProxy MCP v3.2：Agent 闭环能力实施计划

## 1. 文档信息

- 文档类型：技术实施计划
- 文档状态：`已实施 / 已验收`
- 更新日期：`2026-10-30`
- 工作分支：`feat/mcp-agent-loop`（完成后 squash 为单个提交合入 `dev`）
- 适用范围：`crates/mcp-server`、`crates/agent-control`、`crates/db`、`crates/proxy-core`、`apps/desktop`（Tauri 与前端）、Agent Skill
- 来源：2026-10-30 对 MCP v3.1 的设计评审（P0 / P1 建议），评审时实测了 `get_app_status`、`search_sessions`、`get_session` 和 `get_insights`
- 关联文档：
  - `docs/MCP_AGENT_SKILL_ARCHITECTURE.md`（当前工具契约、脱敏与审计架构）
  - `docs/DECISIONS/ADR-006-local-mcp-agent-access.md`
  - `docs/DECISIONS/ADR-007-agent-control-ipc.md`
  - `docs/DECISIONS/ADR-008-bounded-diagnostic-log-access.md`
  - `docs/API_SPEC.md`、`docs/PRD.md`、`docs/NEXT_6_MONTH_ROADMAP.md`

## 2. 结论先行

1. v3.1 已经覆盖了“看抓包”这一步，安全底座（默认脱敏、fail-closed、审计、统一信封）保持不变。v3.2 要补齐的是 Agent 的完整闭环：**触发 → 等待 → 看证据 → 复现/验证 → 模拟边界条件**。
2. 分五个阶段交付：
   - 阶段 A：不改数据面的契约修正（P0 #1 #2 #3 #5）。
   - 阶段 B：只改 sidecar 的闭环工具（P1 #6 #7）。
   - 阶段 C：失败原因落库（P0 #4，需要为会话表新增可空列，并改造 proxy-core 的错误分类）。
   - 阶段 D：请求重放（P1 #8，新增权限 `sendRequests`）。
   - 阶段 E：Agent 临时规则（P1 #9，新增权限 `manageRules`）。
3. 新的写能力全部走 ADR-007 的本地控制 IPC：由桌面端执行、做权限判断和审计。sidecar 仍然只读数据库。重放复用现有 Compose 直连发送器；Agent 规则只复用现有 Rewrite / Map 能力，只存在于内存，不新造规则类型。
4. 新权限默认关闭，在磁盘上是增量字段（`serde(default)`），旧版 sidecar 可以继续读取同一份配置。
5. 工具契约版本从 `3.1` 升到 `3.2`。所有变更都是增量或修正，不删除字段（timing 键名规范化除外，见 §4.5）。

## 3. 范围

### 3.1 本次范围

| 编号 | 能力 | 阶段 | 是否需要桌面端 | 是否改 schema |
|---|---|---|---|---|
| P0-1 | 工具注解（annotations）+ title | A | 否 | 否 |
| P0-2 | 参数说明与预算写进 JSON Schema | A | 否 | 否 |
| P0-3 | `get_insights` 瘦身，并修正截断信号 | A | 否 | 否 |
| P0-5 | timing 键名统一、补全 `fields` 枚举、声明 outputSchema | A | 否 | 否 |
| P1-6 | `wait_for_sessions` + watermark + “无新流量”提示 | B | 否 | 否 |
| P1-7 | `export_session_as_curl` | B | 否 | 否 |
| P0-4 | 结构化失败原因（`failure`）落库与检索 | C | 是（proxy-core） | **是** |
| P1-8 | `replay_session`（直连上游，复用 Compose 发送器） | D | 是 | 否 |
| P1-9 | Agent 临时规则（创建 / 列出 / 删除） | E | 是 | 否（规则只存在于内存，见 §4.9） |

### 3.2 非目标

- 不做实时流式推送（SSE / 订阅）。等待新流量用 SQLite 长轮询实现，不伪装成实时。
- 不开放任意规则、脚本规则或断点控制。Agent 规则只开放 §4.9 列出的白名单动作，且必须有 TTL。
- 不允许 Agent 读取或修改自己的权限，权限仍只能在桌面 UI 中修改。
- 不做 P2 项（动态工具列表、Resources / Prompts、脱敏准确度、按设备过滤、`suggestedCall`），这些留到后续版本。

## 4. 详细设计

### 4.1 P0-1 工具注解

在每个 `#[tool]` 上声明 `annotations(...)` 和 `title`（rmcp 3.5.1 已支持）。客户端可以据此自动放行只读工具，对破坏性工具弹出确认。

| 工具 | readOnly | destructive | idempotent | openWorld |
|---|---|---|---|---|
| 全部读取工具（含 `get_app_status`、`diagnose_ai_proxy_issue`、`wait_for_sessions`、`export_session_as_curl`、`list_agent_rules`） | true | — | — | false |
| `configure_workspace`、`start_capture`、`stop_capture`、`set_system_proxy`、`open_certificate_installer` | false | false | true | false |
| `generate_certificate`（`forceRegenerate=true` 时会使旧证书失效） | false | true | false | false |
| `remove_certificate_trust`、`clear_sessions`、`delete_sessions`、`remove_agent_rules` | false | true | true | false |
| `create_agent_rule` | false | false | false | false |
| `replay_session` | false | false | false | **true** |

验收：`tools/list` 契约测试断言每个工具都声明了注解，且破坏性工具集合与上表一致。

### 4.2 P0-2 参数说明

- 所有请求结构体的字段补 `///` 文档注释，由 schemars 生成 `description`。写法沿用 `DiagnoseIssueRequest`。注释必须说明：
  - 匹配语义：精确 / 包含 / 后缀，是否大小写敏感；
  - 取值格式，例如 `mime` 接受 `json` 还是 `application/json`，`since` 的格式；
  - 默认值与上限。
- 数值预算用 `#[schemars(range(min, max))]` 写进 schema，例如 `limit` 的范围是 1–100。
- 动手前先核对各过滤参数在 `aiproxy-db` 中的真实匹配逻辑，注释以代码为准，不凭猜测写。
- 验收：契约测试遍历 `tools/list` 中每个工具的 `inputSchema.properties`，断言每个属性都带 `description`。

### 4.3 P0-3 `get_insights` 瘦身与截断信号

问题：实测一次调用返回约 15KB。`groupBy=host` 时 `byHost` 与 `groups` 重复；排行榜每条带约 600 字符的完整 URL；`truncated=true` 但 `truncatedReason=null`，而且判断条件 `len() >= 20` 几乎总是成立（`tools/insights.rs:130`）。

新增参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `sections` | `["summary","groups","slowRequests"]` | 可选 `summary`、`byHost`、`byMethod`、`byStatusCode`、`groups`、`slowRequests`、`largestRequests` |
| `topN` | 10 | 每个排行榜返回的条数，范围 1–20 |
| `maxGroups` | 20 | 分组条数，范围 1–50 |

返回调整：

- 排行条目只返回 `sessionId`、`method`、`host`、`path`（不带 query）、`statusCode`、`durationMs`、`sizeBytes`。
- `groupBy=host` 时，即使请求了 `byHost` 也不重复返回，在 `notes` 里说明“已由 groups 覆盖”。
- 截断判断：向聚合引擎多取一条（`N+1`）来判断是否真的有更多数据。只有真的丢弃了数据才标 `truncated=true`，同时给出 `truncatedReason`（例如 `slowRequests limited to topN=10`）。
- 如果 `compute_insights` 的上限是硬编码的，在 `InsightsFilter` 中增加可选上限参数。UI 调用不传，行为保持不变。

验收：默认调用的返回体积不超过 4KB（fixture 测试）；`truncated` 与 `truncatedReason` 总是同时出现或同时不出现。

### 4.4 P0-5 字段一致性与 outputSchema

- timing：桌面端在 `bootstrap/converters.rs:392` 手工拼出 snake_case 的 timing JSON 并落库（同时包含 `timing_source`），`sessions.rs` 再原样透传给 Agent（实测为 `response_read_ms`）。MCP 测试 fixture 用的却是 camelCase（`dnsMs`），所以现有测试没有发现这个问题。在 MCP 读取侧新增递归规范化函数，把 snake_case 键统一转成 camelCase；`get_session` 和 `compare_sessions` 共用这个函数，fixture 改为真实的 snake_case 格式。不修改落库格式，避免影响桌面端的读取解析（`converters.rs:260`）。
- `SummaryField` 枚举补上 `applicationProtocol` 和 `transportProtocol`，与实际返回的字段对齐。
- outputSchema：所有工具声明同一个信封 schema，即 `{ ok: boolean, data?: object, meta?: object, error?: {code, message, retryable, details?} }`。`data` 暂不细化。这样既满足 MCP 对“结构化输出必须符合 outputSchema”的要求，也不破坏错误结果。
- `MCP_TOOL_SCHEMA_VERSION` 改为 `3.2`。

### 4.5 兼容性说明（阶段 A）

timing 键名规范化会改变已有返回结构。由于 schemaVersion 已经递增，Skill 也同版本交付，并且 timing 原本就同时存在两种命名，本次直接修正，不保留旧键名。release notes 中要说明这一点。

### 4.6 P1-6 `wait_for_sessions` 与流量新鲜度

**watermark**：用 `session_summaries` 的 `rowid`（插入顺序）作为不透明水位，编码为字符串 `w1:<rowid>`。

- 不用 `started_at`：会话是批量写入的，写入顺序可能与开始时间不一致。
- 前提已确认：`session_summaries` 以 `TEXT PRIMARY KEY` 建表，不是 `WITHOUT ROWID` 表，有隐式 rowid；`upsert_session`（`crates/db/src/sessions.rs:69`）采用“先 UPDATE 再 INSERT”，没有用 `REPLACE`，所以同一会话更新时 rowid 不变。
- 进行中的会话：proxy-core 会先写入 pending 会话，完成后再更新同一行。等待条件只统计**已完成**的会话（`finished_at` 已写入且状态码不为 0）。已知边界：调用时已在途、稍后才完成的请求，rowid 早于水位，不会被计入。文档和工具描述中要说明这一点。
- `search_sessions` 的 `meta` 新增 `watermark`。

**新工具 `wait_for_sessions`**：

| 参数 | 默认 | 说明 |
|---|---|---|
| 过滤条件 | — | 复用 `search_sessions` 的过滤子集：host、hostContains、pathContains、queryParams、method、status、mime、keyword |
| `afterWatermark` | 调用时刻的水位 | 只匹配该水位之后写入的会话 |
| `minCount` | 1 | 范围 1–100 |
| `timeoutMs` | 15000 | 范围 1000–30000，不受全局 15 秒 `TOOL_TIMEOUT` 约束，单独计时 |

- 实现：以只读连接每 300ms 轮询一次。客户端提供 `progressToken` 时发送 progress 通知。
- 返回：`{ satisfied, timedOut, items(compact), watermark }`。超时不算错误，返回 `ok:true, timedOut:true`。
- 提示：抓包未运行（`captureStatus != running`）时，仍然等待，但在 `notes` 中提示“抓包未运行，可能不会有新流量”。

**流量新鲜度**：`get_app_status` 在 sidecar 侧补充 `traffic` 字段：`latestSessionAt`、`lastSessionAgeSec`、`sessionsSinceCaptureStart`。如果抓包在运行、开始超过 2 分钟但 `sessionsSinceCaptureStart=0`，或最近一条会话距今超过 10 分钟，`nextSteps` 追加提示：“抓包运行中但没有新流量，请检查设备 / 系统代理是否指向 `<port>`”。

### 4.7 P1-7 `export_session_as_curl`

| 参数 | 默认 | 说明 |
|---|---|---|
| `sessionId` | 必填 | 支持现有的前缀解析 |
| `shell` | `posix` | `posix` 或 `powershell`（跨平台要求） |
| `includeBody` | true | 需要 `readBodies`，未授权时省略 body 并在 `omitted` 中说明 |
| `redactionMode` | `redacted-text` | `raw` 需要 `readRawBodies` |

- 脱敏：敏感 Header、Cookie、query、body 字段替换为环境变量占位符（例如 `$AIPROXY_AUTHORIZATION`）。返回 `placeholders: [{ name, source }]`，source 例如 `header:Authorization`，告诉用户需要提供哪些值。占位符名称固定，不包含原值。
- 生成规则：
  - 去掉 hop-by-hop 头和 `content-length`；
  - 有 `accept-encoding` 时加 `--compressed`；
  - HTTP/2 加 `--http2`；
  - 二进制或超过 64KiB 的 body 不内联，放进 `omitted`；
  - 按 shell 类型做引号转义，用单元测试覆盖特殊字符。
- 返回：`{ command, shell, placeholders, omitted[], warnings[] }`。
- 权限：`readSessions`；body 部分需要 `readBodies`；与 `get_session_body` 一样计入敏感审计。

### 4.8 P0-4 结构化失败原因

**现状（调研结论）**

- proxy-core 没有保存任何结构化失败信息。`ProxyError`（`crates/proxy-core/src/error.rs:9`）的 `UpstreamError(String)` 和 `TlsError(String)` 已经把底层错误压平成字符串；会话只得到一个固定状态码和固定响应文案（例如 “The proxy could not reach the upstream server.”），真实错误只写进 `tracing` 日志。
- 会话结构体和数据库表都没有 error / note / failure 字段，所以 `diagnose_ai_proxy_issue` 目前只能从日志里找失败原因。
- 合成错误响应的位置：

| 状态 | 位置 | 能拿到的错误 |
|---|---|---|
| 502 上游失败 | `http_proxy.rs:123` `build_upstream_error_response_and_session`（由 `:1413` 调用） | `&ProxyError`（字符串） |
| 504 上游超时 | `http_proxy.rs:811` | `UpstreamTimeout{timeout_secs}` |
| 502 响应改写失败 | `http_proxy.rs:907` | 改写错误 |
| 504 限流丢弃 | `http_proxy.rs:541`、`:1125`、`:1873` | 限流原因 |
| 502 WebSocket 升级失败 | `ws_upgrade.rs:57`、`:474` | 错误字符串 |
| 499 | `http_proxy.rs:1953` `PendingRequestCancellationGuard::drop` | 无。客户端断开和内部未处理错误（`:1390`）都会走到这里，无法区分 |
| 盲转发 CONNECT 失败 | `connect.rs:114`，直接向客户端写 502/504 | **不生成会话** |
| 客户端 TLS 握手失败（MITM） | `connect.rs:433`；`classify_client_handshake_error`（`:40`）已能区分 `CertificateRejected` / `UntrustedRoot` / `Other` | **只写日志，不生成会话** |

- `io::ErrorKind` 只在底层还能拿到：`timing_connector.rs` 的 DNS 解析（`:290`，NotFound）、连接（`:309`，ConnectionRefused 等）和上游 TLS（`:227`）。经过 `upstream.rs:667` 等处的 `format!` 之后就丢失了。

**设计**

- 类型：proxy-core 新增 `SessionFailure { origin, kind, message }`。
  - `origin`：`client`、`proxy` 或 `upstream`。
  - `kind`（首版）：`dns`、`connect_refused`、`connect_timeout`、`upstream_tls`、`client_tls_rejected`、`client_tls_untrusted_root`、`upstream_reset`、`upstream_timeout`、`client_closed`、`throttled`、`rewrite_failed`、`proxy_internal`、`other`。
  - `message`：截断到 512 字节，经过脱敏。
  - 在 `ProxySessionDetail` 上增加 `failure: Option<SessionFailure>`。
- 保留错误类别：把 `UpstreamError(String)` 改成携带 `kind` 的结构化变体，在 `timing_connector` 和 `forward_h1_request` / h2 发送处，在 `format!` 之前完成分类。`hyper::Error` 用 `is_timeout()`、`is_closed()`、`is_incomplete_message()` 判断。
- 区分 499：守卫默认记为 `client_closed`；内部错误兜底路径（`:1390`）显式记为 `proxy_internal`。
- 握手失败生成会话（已采纳，见 §8）：
  - 客户端 TLS 握手失败和盲转发 CONNECT 失败，生成一条 `method=CONNECT`、状态码为 0 的“连接失败”会话，只包含 host 和 SNI。
  - 同一 host 每 10 秒最多记录 1 条，避免启用证书钉扎的 App 反复重试时刷屏。
  - `handle_connect_mitm`（`connect.rs:400`）已经拿到 `session_sender` 参数，可以直接发送会话。
- 落库：
  - 沿用 `migrate_add_column`（`schema.rs:548`）。仓库没有版本表，迁移是幂等的“列不存在才添加”。
  - 新增 `session_summaries.failure_origin`、`session_summaries.failure_kind`（建索引，用于检索），以及 `session_details.failure_message`。
  - 同步修改 `CREATE TABLE` 文本、`upsert_session` 中的 INSERT / UPDATE、三个 SELECT（`sessions.rs:231/255/272`）、`converters.rs` 的转换，以及所有直接构造 `ProxySessionDetail` 字面量的地方（约 15 处，含桌面端 bootstrap 和测试）。
  - 历史会话为 NULL，表示“未记录”。
- MCP：
  - 摘要新增 `failure`（无失败时省略）；
  - `search_sessions` 和 `wait_for_sessions` 新增过滤参数 `failedOnly`、`failureKind`、`failureOrigin`；
  - `get_insights` 新增 `byFailureKind`；
  - `diagnose_ai_proxy_issue` 改为从数据库读取失败原因，不再从日志中解析；新增发现项“近期客户端 TLS 握手失败集中的 host（疑似证书钉扎或 CA 未信任）”。
  - sidecar 按列探测能力，旧库降级为不返回 `failure`。
- 桌面 UI：Inspector 概览显示失败原因（i18n）；会话列表中的连接失败会话使用独立的状态样式。同步 `docs/PAGE_BLUEPRINTS.md` 与 `user-guides/*/sessions.md`。
- **评审点**：`MCP_AGENT_SKILL_ARCHITECTURE.md` §3.3 规定“未评审前不新增数据库表，不改变现有会话 schema”。本节就是这次变更的评审请求，只新增可空列，不新增表。

### 4.9 P1-8 / P1-9 写能力

**现状（调研结论）**

- 发送器：仓库里只有一个后端发送器 `send_direct_request_bytes`（`crates/proxy-core/src/server.rs:655`）。
  - 它使用静态 reqwest 客户端（`:19`，`no_proxy()`、不跟随重定向），**直连上游，不经过抓包端口，也不执行 map / rewrite / script / 限流 / 断点规则**。
  - 它自己构造 `ProxySessionDetail`，生成新的 UUID，`timing_source="compose"`。调用方通过 `upsert_session_async`（`bootstrap/mod.rs:433`）把会话写入当前工作区并通知 UI，**新会话 ID 直接就是返回值里的 `detail.id`**。
  - Compose（`commands/compose.rs:18`）和 Collections 批量执行（`commands/collections.rs:596`）都复用这条链路。
- 现有的“重复请求”功能完全在前端（`use-session-context-actions.ts`），只支持内联文本 body，二进制 body 会丢失。后端没有“按 sessionId 重放”的入口。
- 规则模型：
  - Rewrite 规则（`proxy-core/src/rules/types.rs:20`）：请求阶段支持 `header`、`query`、`body`、`redirect`；响应阶段只支持 `header`、`body`。**没有状态码改写，也没有 mock 动作。**
  - Map 规则（`:63`）支持 `local` 和 `remote` 两种模式；`local` 的目标必须是磁盘上已存在的文件或目录（`commands/rules.rs:522` 会校验），不能内联 body。
  - Script 规则可以返回 `response_override`（status、headers、body），但需要生成并编译 JS，风险和复杂度都高。
  - 元数据只有 `note` 和 `enabled`，**没有 source / createdBy / expiresAt 字段**。
- 热加载：`AppState` 持有 `RewriteManager` / `MapManager` 的 `Arc`，运行中的代理共享同一实例。调用 `save_rule` / `delete_rule` 立即生效，不需要重启（`proxy-core/src/rules/managers.rs`）。启动时由 `init_from_db` 只从数据库加载规则。
- 前端：规则行统一由 `RulesSharedUi.tsx` 的 `ManagedRuleListItem`（`:541`）渲染，尾部已有 chip 区域（`:764`）。`use-agent-control-events.ts` 收到控制事件后只刷新代理、工作区、证书和会话相关的查询，不刷新规则查询。

**权限**：`AgentAccessPermissions` 新增两个权限，都默认关闭：

- `sendRequests`：允许重放请求，会向外部服务真实发包；
- `manageRules`：允许创建临时规则，会影响本机所有经过代理的流量。

两者都需要同步到 `ControlPermission`、`ensure_permission` / `permission_name`、`shared-types`、设置页开关与风险说明、i18n、设置搜索、`doctor` 输出，以及 `agent-access.helpers` 的测试。

**控制协议**：`ControlOperation` 新增 `ReplaySession`、`CreateAgentRule`、`ListAgentRules`、`RemoveAgentRules`。目前只有 `readDiagnosticLogs` 的“unknown variant”被映射为“请升级”（`agent_control.rs:437`），这次推广到所有未知操作，统一返回 `CONTROL_UNAVAILABLE` 并提示升级。协议版本保持 1（纯增量）。`use-agent-control-events.ts` 的 `ACTION_LABEL_KEYS` 补上新操作的文案，并在规则类操作后刷新规则查询。

**`replay_session`（P1-8）**

- 实现：桌面端新增后端函数 `replay_session`：
  - 从数据库和 Body Store 读取原会话**未脱敏**的请求头和 body 字节（支持二进制，比前端的“重复请求”更完整）；
  - 应用覆盖参数；
  - 调用 `send_direct_request_bytes`，再调用 `upsert_session_async`；
  - 返回 `{ newSessionId, statusCode, durationMs, failure? }`。
  - Agent 不需要也看不到 token，就能复现带认证的请求。
- 行为（已采纳，见 §8）：沿用直连语义，不经过抓包端口。
  - 优点：不要求抓包在运行，能直接拿到新会话 ID，与 Compose 行为一致。
  - 代价：**Agent 临时规则和用户规则都不会作用于重放请求**。工具描述和 Skill 必须写明：要验证规则效果，应该让真实客户端重新发起请求，再用 `wait_for_sessions` 等待。
- 标记：`timing_source` 记为 `agentReplay`，用来区分 Compose 发出的请求。原会话 ID 写进审计记录；不新增会话列。
- 覆盖参数：`method`、`setHeaders`、`removeHeaders`、`setQueryParams`、`body`（文本）、`jsonSet`（`{ jsonPath: value }`，仅限 JSON body）。
- 安全约束：
  - 目标 host 必须与原会话一致；
  - 同时只能有 1 个重放在执行，每分钟最多 10 次，超出返回 `RATE_LIMITED`；
  - 超时沿用直连客户端的超时设置；
  - 审计记录原会话 ID、方法和覆盖了哪些字段名，不记录值；
  - 非幂等方法（POST/PUT/PATCH/DELETE）在描述和 Skill 中要求“当前对话中用户明确要求”。

**Agent 临时规则（P1-9）**

- 工具：`create_agent_rule`、`list_agent_rules`、`remove_agent_rules`。
- 动作只复用现有规则引擎已有的能力，首版白名单如下：

| Agent 动作 | 底层实现 |
|---|---|
| `setRequestHeader` / `removeRequestHeader` | Rewrite，请求阶段 `header` |
| `setQueryParam` / `removeQueryParam` | Rewrite，请求阶段 `query` |
| `setResponseHeader` / `removeResponseHeader` | Rewrite，响应阶段 `header` |
| `replaceResponseBody` / `setResponseJsonFields` | Rewrite，响应阶段 `body`（按 `RewriteBodyPayload` 的现有模式） |
| `mapRemote` | Map，`remote` 模式（目标 host 限制同重放） |
| `mockResponseBody` | Map，`local` 模式，指向 `<data-dir>/agent-rules/<ruleId>.body`，文件由桌面端写入，body 不超过 256KiB；状态码沿用 map local 现有行为 |

- 不在首版的动作：**状态码改写**和**延迟**。引擎目前没有状态码改写，需要在 proxy-core 的 Rewrite 中新增 `status` 动作；这会同时影响用户侧规则编辑器，作为单独的扩展评审（见 §8）。延迟属于限流功能，不放进规则。
- 匹配：沿用规则的 `url_pattern` / `match_type`，默认 `wildcard`，也可显式使用 `exact`；Agent 规则禁用 `contains` 和 `regex`，pattern 必须包含精确 host。规则管理器同时保存 host 锁，并在每次匹配前比较请求 host，不能只依赖 pattern 文本。
- 生命周期（**无 schema 变更方案**）：
  - Agent 规则**只存在于内存**：只写入 `RewriteManager` / `MapManager`，不写数据库。
  - 桌面端用 `AgentRuleRegistry` 记录 `{ ruleId, kind, createdBy, createdAt, expiresAt }`。
  - 应用重启后规则自然消失，因为 `init_from_db` 只从数据库加载。
  - `ttlSeconds` 默认 600，最大 3600；最多 20 条有效规则；后台任务每 15 秒清理一次到期规则，同时删除对应的 mock 文件。
- 可见性：
  - `list_rewrite_rules` / `list_map_rules` 在数据库结果后追加 Agent 规则，返回 `source: "agent"` 和 `expiresAt`；
  - `ManagedRuleListItem` 增加 Agent 标记和到期时间 chip；规则页提供“清除全部 Agent 规则”入口；
  - Agent 规则在规则页只读，不能编辑、启停、选择或拖拽；复制时去掉 `source` / `expiresAt` 生成普通持久化规则，并提示该规则会写入用户规则库。
- 隔离：Agent 只能列出和删除注册表中的规则，看不到也改不了用户自己的规则。
- 验证：`create_agent_rule` 返回 `ruleId`；`get_session(include=ruleTraces)` 已经能显示命中的规则 ID，可以直接对照。
## 5. 交付阶段与验证

每个阶段一个逻辑提交（最终 squash），完成后都要通过：

- `cargo fmt --check --all`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `cargo test -p aiproxy-mcp -p aiproxy-agent-control`，以及涉及到的 crate 的测试
- 改动前端时：`pnpm --filter @aiproxy/desktop lint typecheck test format:check`
- 修改帮助文档时：`pnpm --filter @aiproxy/desktop test -- src/features/docs/docs-navigation.test.ts`

| 阶段 | 内容 | 主要测试 |
|---|---|---|
| A | P0-1/2/3/5 | `tools/list` 契约测试（注解、description、outputSchema）；insights 体积与截断；timing 规范化单测 |
| B | P1-6/7 | 等待命中 / 超时 / 水位推进的集成测试（测试中另起线程写库）；curl 生成在两种 shell 下的转义快照测试；占位符不泄露原值 |
| C | P0-4 | 迁移测试（旧库升级，旧行为 NULL）；proxy-core 各失败路径的分类单测（DNS、拒绝连接、超时、上游 TLS、499 两种来源）；握手失败会话的限频；检索过滤；sidecar 旧库降级 |
| D | 权限与重放 | preflight 权限 / 参数 / 限流单测；host 锁定；二进制 body 原样重放；审计只含字段名不含值；未知控制操作提示升级；设置页开关测试 |
| E | Agent 规则 | 白名单与 host 校验；TTL 清理（同时删除 mock 文件）；数量上限；Agent 只能看到注册表中的规则；重启后不残留；规则页 Agent 标记渲染测试 |

## 6. 文档同步清单

- `docs/MCP_AGENT_SKILL_ARCHITECTURE.md`：工具矩阵 §8.2、权限矩阵 §8.7、新鲜度 §7.8，以及“非目标”中对重放和规则的表述。
- `docs/API_SPEC.md`：MCP 工具契约、控制操作、错误码（`RATE_LIMITED`、`RULE_LIMIT_EXCEEDED` 等）。
- `docs/PRD.md`：Agent Access 能力边界。
- 新增 `docs/DECISIONS/ADR-009-agent-replay-and-temporary-rules.md`：说明对外发包与流量改写的风险边界，以及“Agent 规则只存在于内存”的决定。
- `docs/ARCHITECTURE.md`：会话失败原因字段，以及 proxy-core 错误分类。
- `docs/PAGE_BLUEPRINTS.md` / `docs/UI_GUIDELINES.md`：Inspector 失败原因、连接失败会话样式、规则页 Agent 标记。
- `apps/desktop/src-tauri/resources/agent-skill/aiproxy/SKILL.md`：新工具、闭环工作流、写能力护栏、“重放不经过规则”的说明。
- `apps/desktop/user-guides/{zh-CN,en}/`：`agent-access.md`（新权限、风险说明与排障）、`sessions.md`（失败原因）、`map-rules.md` / `rewrite-rules.md`（Agent 规则标记）。
- i18n：`en.ts` 与 `zh-CN.ts` 同步。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 重放会对生产服务产生副作用（重复下单等） | 默认关闭；锁定原 host；限流；非幂等方法需要用户明确要求；`openWorldHint=true` 让客户端弹窗确认 |
| Agent 以为重放会经过规则，得出错误结论 | 工具描述、返回值和 Skill 都写明“重放直连上游，不执行规则”；验证规则时改用“真实客户端重发 + `wait_for_sessions`” |
| Agent 规则残留影响用户日常流量 | 只存在于内存，重启即失效；强制 TTL 和数量上限；UI 明显标记并支持一键清除 |
| 抓包内容中的提示注入诱导 Agent 创建规则或重放 | Skill 护栏 + 注解确认 + 权限默认关闭；审计记录每次写操作 |
| 新旧版本 sidecar 与桌面端不匹配 | 未知控制操作统一提示升级；配置字段使用 `serde(default)` 增量扩展 |
| `wait_for_sessions` 长时间占用连接 | 超时上限 30 秒；只读连接；轮询间隔 300ms |
| 会话 schema 变更 | 只新增可空列；补迁移测试；sidecar 按列探测能力，旧库降级为不返回 `failure` |
| 握手失败会话刷屏（证书钉扎 App 反复重试） | 同一 host 每 10 秒最多 1 条 |
| `ProxyError` 重构波及面大 | 只把 `UpstreamError` 改为携带 `kind` 的结构化变体，其余变体保持不变；保留原有错误文案，日志不受影响 |

## 8. 已确认决策

1. **会话 schema 变更（阶段 C）**：采纳。只新增 3 个可空列，不新增表，并为旧库提供幂等迁移与能力降级。
2. **握手失败生成会话（阶段 C）**：采纳。客户端 TLS 握手失败与盲转发 CONNECT 失败生成状态码为 0 的连接失败会话，同一 host 每 10 秒最多记录 1 条。
3. **重放语义（阶段 D）**：采纳直连方案。重放不经过抓包端口、用户规则或 Agent 规则，避免把规则效果误当成上游行为。
4. **重放 host 锁定（阶段 D）**：采纳严格锁定。首版只能通过 Query 覆盖修改请求，不允许改 host；需要跨环境验证时由用户使用真实客户端发起。
5. **Agent 规则持久化（阶段 E）**：采纳内存方案。规则不写入用户规则库，应用重启即失效；TTL、数量上限和自动清理共同限制残留影响。
6. **状态码改写（阶段 E）**：本次不做。只开放现有引擎可安全复用的白名单动作，状态码改写留待单独评审。
7. **交付节奏**：本次按同一功能分支交付全部阶段；提交粒度由维护者在合并前决定，不影响运行时契约。

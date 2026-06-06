# AIProxy 全面代码审查报告

## 修复状态

**全部 P0 + P1 已修复并验证通过**（2026-06-03）

| # | 状态 |
|---|------|
| 1 | ✅ 已修复 |
| 2 | ✅ 已修复 |
| 3 | ✅ 已修复 |
| 4 | ✅ 已修复 |
| 5 | ✅ 已修复 |
| 6 | ✅ 已修复 |
| 7 | ✅ 已修复 |
| 8 | ✅ 已修复 |
| 9 | ✅ 已修复 |
| 10 | ⏳ 待修 |
| 11 | ⏳ 待修 |
| 12 | ⏳ 待修 |
| 13 | ⏳ 待修 |
| 14 | ⏳ 待修 |
| 15 | ⏳ 待修 |
| 16 | ⏳ 待修 |
| 17 | ⏳ 待修 |
| 18 | ⏳ 待修 |
| 19 | ⏳ 待修 |
| 20 | ⏳ 待修 |
| 21 | ⏳ 待修 |
| 22 | ⏳ 待修 |

---

**审查日期**: 2026-06-03
**审查范围**: 全量代码库（Rust crates + Tauri 后端 + React 前端 + 共享类型）
**审查方法**: 7 角度并行扫描（逐行 / 并发资源 / 跨文件合约 / 错误处理 / 性能 / 简化 / 架构），42 个候选发现 → 去重 → 逐一验证 → 人工复核校正
**审查统计**: 扫描 259 个源文件 | 7 个审查角度 × 6 候选 | 49 个 agent | 42 候选 → 22 个经复核确认

**复核说明**: 初版报告含 25 条发现，经人工逐条复核后，移除 3 条不成立条目（#18 系统 proxy 恢复、#24 HAR 导入部分失败、#25 Dev Logger 轮转），调整多条描述和优先级。

---

## 按严重程度汇总

| 严重程度 | 数量 | 说明 |
|---------|------|------|
| 🔴 High | 4 | 数据丢失、请求损坏、资源泄漏等高影响问题 |
| 🟡 Medium | 18 | 性能退化、健壮性不足、维护隐患 |

---

## 一、🔴 高严重度问题

### 1. Transfer-Encoding: chunked 请求体被静默丢弃 ✅ 已解决

> **P2.5 重构已修复**：手动 HTTP/1.1 解析（`read_proxy_request_from_stream`、`check_transfer_encoding`、`read_chunked_body`）已替换为 hyper server connection。hyper 原生支持 chunked transfer encoding，不再有手动解码遗漏的风险。

- **原文件**: ~~server.rs:2329~~ → 相关代码已删除
- **分类**: Bug · 数据丢失
- **影响**: 使用 `Transfer-Encoding: chunked` 的 POST/PUT 请求（无 Content-Length）会被代理静默丢弃全部请求体

**问题描述**:
`read_proxy_request_from_stream` 仅基于 `Content-Length` 读取请求体。当请求使用 `Transfer-Encoding: chunked`（没有 Content-Length 头）时，`body_length` 为 0，实际请求体被完全忽略。同时 `build_upstream_headers` 会显式剥离 `Transfer-Encoding` 头。最终上游收到一个无 body 的请求。

**复现场景**:
```bash
# 客户端发送 chunked POST
curl -X POST -H "Transfer-Encoding: chunked" --data-binary @file http://target/api
# → 上游收到空 body，返回错误
```

**修复方案**:
在 `read_proxy_request_from_stream` 中就地实现 chunked 传输编码的解码逻辑（优先方案）：
1. 检测请求头是否包含 `Transfer-Encoding: chunked`
2. 实现 chunked body 读取（读取 chunk size → 读取 chunk data → 循环直到 0\r\n）
3. 将解码后的 body 存入请求并移除 `Transfer-Encoding` 头，添加 `Content-Length`

> ⚠️ "改用 hyper body" 会是更大的架构调整，不建议和此修复混在一起。

---

### 2. SessionDetailPayload 缺失多个共享类型字段

- **文件**: [sessions.rs:382](apps/desktop/src-tauri/src/commands/sessions.rs#L382)
- **分类**: Bug · 数据桥接断裂
- **影响**: 前端永远无法获取 `timingSource`、`trailers`、`h2StreamId`、`throttleTraces`、`scriptTraces`、`rewriteTraces` 等字段

**问题描述**:
`SessionDetailPayload` 是 Tauri 命令层的手工映射结构体，`build_session_detail_payload` 只映射了 `mapTraces`，以下字段未映射：
- `timingSource` — 计时来源（proxy/compose/HAR import）
- `trailers` — HTTP/2 尾部头
- `h2StreamId` — HTTP/2 流 ID
- `throttleTraces` / `scriptTraces` / `rewriteTraces` — 规则执行追踪

**修复方案**:
1. 在 `SessionDetailPayload` 中补全所有 `SessionDetail` 声明的字段
2. 在 `build_session_detail_payload` 中从 `ProxySessionDetail` 映射所有字段
3. **长期方案**: 考虑直接序列化 `ProxySessionDetail`（已有自定义 Serialize），但需保留现有轻量 body/raw deferred 策略，不能简单替换

---

### 3. Query Key 重复定义导致缓存失效隐患

- **文件**: [use-proxy-status.ts:17](apps/desktop/src/features/proxy-status/use-proxy-status.ts#L17)
- **分类**: Bug · 维护隐患
- **影响**: 当前可工作，但 key 形状已分歧，任何重构将导致缓存静默失效

**问题描述**:
`SESSION_DETAIL_QUERY_KEY` 在两处独立定义：
- `use-session-detail.ts:5` — 定义为字符串 `"session-detail"`
- `use-proxy-status.ts:17` — 重新定义为数组 `["session-detail"]`

`use-proxy-status.ts` 用 `removeQueries({ queryKey: [SESSION_DETAIL_QUERY_KEY] })` 清除缓存，当前因 TanStack Query 前缀匹配恰好工作。但修改原始 key 定义时，此处的副本不会被同步更新。

**修复方案**:
```typescript
// use-proxy-status.ts — 删除本地定义，改为导入
import { SESSION_DETAIL_QUERY_KEY } from '@/features/sessions/use-session-detail';
```

---

### 4. 连接池 TOCTOU 竞争导致雷鸣群体效应

- **文件**: [upstream_pool.rs:50](crates/proxy-core/src/upstream_pool.rs#L50)
- **分类**: 性能 · 并发竞争
- **影响**: 并发请求同一上游主机时触发冗余 TLS 握手，浪费 CPU 和文件描述符

**问题描述**:
`get_or_connect` 采用两阶段加锁模式：
1. 获取写锁 → 检查缓存 → 释放锁（未命中）
2. 无锁状态下执行 DNS + TCP + TLS + h2 握手（耗时数十到数百毫秒）
3. 获取写锁 → 插入连接

步骤 1-3 之间存在 TOCTOU 窗口：多个并发请求同时通过步骤 1，各自建立独立连接，最终只有最后一个存活。被丢弃的 h2 driver task 会持续运行直到远端关闭。

**修复方案**:
使用 `OnceCell` 替代两阶段锁：
```rust
pub struct UpstreamConnectionPool {
    connections: RwLock<HashMap<(String, u16), Arc<OnceCell<SendStream<bytes::Bytes>>>>>,
}
```
第一个请求建立连接，后续请求等待并复用。

> ⚠️ 需处理连接失败/h1 fallback 后的 cell 移除，不能把失败固化在 cell 里。

---

## 二、🟡 中等严重度问题

### 5. CONNECT 端口解析错误

- **文件**: [server.rs:349](crates/proxy-core/src/server.rs#L349)
- **分类**: Bug · 请求路由错误
- **状态**: ✅ CONFIRMED

**问题描述**:
```rust
let port: u16 = request.path.parse().unwrap_or(DEFAULT_HTTPS_PORT);
```
对于 CONNECT 请求，`request.path` 是 `"host:port"` 格式，解析为 `u16` 必然失败（包含主机名前缀），所以 `unwrap_or(443)` 永远返回 443。任何非 443 端口的 CONNECT 请求都被静默路由到错误端口。

**修复方案**:
```rust
let port = request.url.port().unwrap_or(DEFAULT_HTTPS_PORT);
```
使用已解析的 URL 获取端口，与 WebSocket 升级路径（server.rs:1886）的做法一致。

---

### 6. Script 规则不支持 matchType

- **文件**: [schema.rs:178](crates/db/src/schema.rs#L178) + [rules.rs:653](crates/proxy-core/src/rules.rs#L653)
- **分类**: Bug · 功能缺失
- **状态**: ✅ CONFIRMED

**问题描述**:
`ScriptRule` 在 shared-types 中声明了 `matchType?: MatchType`，但整个数据链路不支持：
- DB 的 `script_rules` 表没有 `match_type` 列
- `ScriptRuleRow` 没有 `match_type` 字段
- `ScriptRuleMatch` 没有 `match_type` 字段
- 运行时 `active_script_rules_for_stage` 硬编码 `None` 作为 match_type
- 用户即使在前端设置了 "regex" 或 "exact" 匹配模式，运行时始终用 "contains"

**对比**: rewrite 和 breakpoint 规则已正确支持 matchType。

**修复方案**:
1. 在 `schema.rs` 中为 `script_rules` 添加 `match_type TEXT DEFAULT 'contains'` 列（CREATE TABLE + ALTER TABLE 迁移）
2. 在 `ScriptRuleRow` 和 `ScriptRuleMatch` 中添加 `match_type` 字段
3. 补全 Tauri row ↔ shared-type 映射（`script_row_to_rule` 等）
4. 在 `active_script_rules_for_stage` 中传递 `match_type` 到 `pattern_matches`

---

### 7. 断点取消导致代理连接硬错误

- **文件**: [breakpoints.rs:241](crates/proxy-core/src/breakpoints.rs#L241)
- **分类**: Bug · 健壮性
- **状态**: ✅ CONFIRMED

**问题描述**:
`cancel_all()` 清空 HashMap 导致所有 `oneshot::Sender` 被 drop，等待中的 `Receiver` 收到 `Err`。`intercept_request_stage` 和 `intercept_response_stage` 将此错误向上传播，终止代理连接。没有优雅转发原始请求的机制。更严重的是：用户仅关闭断点开关（不停止代理）时，没有对应的取消机制，pending 条目会无限累积。

**修复方案**:
1. 在 `cancel_all` 中为每个 pending 条目发送一个"放行"信号而非直接 drop sender
2. 收到"放行"信号的拦截阶段应转发原始请求而非报错
3. 增加 `cancel_for_rule(rule_id)` 方法，在关闭特定断点规则时调用

---

### 8. WebSocket 帧读取无超时

- **文件**: [ws.rs:66](crates/proxy-core/src/ws.rs#L66)
- **分类**: 健壮性 · 拒绝服务
- **状态**: ✅ CONFIRMED

**问题描述**:
`parse_ws_frame` 使用 `read_exact` 读取最多 16MB 的 payload，但没有超时保护。恶意客户端发送大 payload_len 的帧头但不发送数据时，中继循环永久阻塞，双向 WebSocket 通信完全停滞。

**修复方案**:
```rust
tokio::time::timeout(Duration::from_secs(30), stream.read_exact(&mut buf))
    .await
    .map_err(|_| "WebSocket frame read timeout")?
```

---

### 9. 连接池 evict_expired() 是死代码

- **文件**: [upstream_pool.rs:148](crates/proxy-core/src/upstream_pool.rs#L148)
- **分类**: 健壮性 · 资源泄漏
- **状态**: ✅ CONFIRMED

**问题描述**:
`evict_expired()` 标记了 `#[allow(dead_code)]` 且从未被调用。没有后台定时器、shutdown hook 或任何触发机制。流量高峰后池中累积的空闲 h2 连接永远不会被清理，造成文件描述符和内存缓慢泄漏。

**修复方案**:
1. 在 proxy 启动时 spawn 一个后台定时任务，每 60 秒调用 `evict_expired()`
2. 在 proxy shutdown 时也调用一次
3. 移除 `#[allow(dead_code)]`

---

### 10. Insights 查询 LOWER(host) 破坏索引

- **文件**: [insights.rs:95](crates/db/src/insights.rs#L95)
- **分类**: 性能 · 全表扫描
- **状态**: ✅ CONFIRMED

**问题描述**:
所有 host 相关 WHERE 子句都使用 `LOWER(host)`，但 `idx_session_summaries_host` 是普通列索引。SQLite 无法在 `LOWER()` 表达式上使用普通索引，导致每次 insights 查询都进行全表扫描。`compute_host_p95` 为 top-50 结果中的每个 host 再执行一次这样的扫描，放大了性能影响。

**修复方案**:
1. 创建表达式索引: `CREATE INDEX idx_host_lower ON session_summaries(LOWER(host))` — 对 `=`/`NOT IN` 查询有效
2. 对于 `%keyword%` LIKE 查询，表达式索引仍不够高效，可考虑存储 `host_lower` 列或引入 FTS
3. 同时为 `compute_host_p95` 的子查询添加覆盖索引

---

### 11. 日志系统热路径上的 String 分配浪费

- **文件**: [server.rs:927](crates/proxy-core/src/server.rs#L927) + [logging.rs](crates/proxy-core/src/logging.rs)
- **分类**: 性能 · 热路径开销
- **状态**: ✅ CONFIRMED

**问题描述**:
`emit_log` 是普通函数（非宏），接受 `&[(&str, String)]`。所有 String 参数（`.clone()`, `.to_string()`）在调用点就已分配，即使日志级别为 INFO 时 DEBUG 日志的参数也已构造完毕。server.rs 中有 66 处 `emit_log` 调用，其中 22+ 处为 DEBUG 级别。

**修复方案**:
1. 将 `emit_log` 改为宏，利用 `tracing::debug!` / `tracing::info!` 的惰性求值
2. 或在 `emit_log` 入口先检查级别再构造参数
3. 热路径中避免 `.clone()` 和 `.to_string()`，改用 `tracing::debug!` 的字段语法

---

### 12. WebSocket 消息逐条加锁 DB

- **文件**: [proxy.rs:176](apps/desktop/src-tauri/src/commands/proxy.rs#L176)
- **分类**: 性能 · 锁竞争
- **状态**: ✅ CONFIRMED

**问题描述**:
WebSocket 消息处理分支每条消息都获取一次 DB 互斥锁执行 `insert_ws_message`。高吞吐 WebSocket 流下（如实时数据推送），每秒可能产生数十条消息，每条都独占 DB 锁，阻塞 session 批量写入器。

**修复方案**:
参照 session 批量收集器的模式，将 WS 消息先缓冲到本地 Vec，在 `tokio::select!` 循环中定期 flush（或按数量阈值），一次锁获取写入多条记录。

---

### 13. Session 过滤全部在客户端执行

- **文件**: [session-explorer.helpers.ts](apps/desktop/src/features/sessions/session-explorer.helpers.ts)
- **分类**: 性能 · 可扩展性（扩展性重构，非 bug）
- **状态**: PLAUSIBLE

**问题描述**:
Session 存储在内存 Vec 中（上限 15000 条），前端接收全量数据后在 JavaScript 中执行所有过滤（host 关键词、忽略 host、状态码、搜索词、路径树构建、MIME 分类）。用户无法搜索超过内存窗口的历史会话，且随会话数增长前端性能下降。

**修复方案**:
1. 在 Tauri 命令层增加过滤参数（host keyword, status code range, search text）
2. 在 Rust 侧执行过滤后只返回匹配结果
3. 增加分页支持（offset + limit + count）
4. 需设计实时 upsert 与分页视图一致性

---

### 14. Zustand Store 派生状态冗余计算

- **文件**: [session-container.store.ts:23](apps/desktop/src/features/sessions/session-container.store.ts#L23)
- **分类**: 性能 · 状态管理
- **状态**: PLAUSIBLE

**问题描述**:
`activeSessionIds` 和 `activeSessionSummaries` 在每次 store 变更时通过 `deriveActiveData` 重新计算。更严重的是遗留 passthrough 方法 `setActiveSessionIds` / `setActiveSessionSummaries` 绕过了 `deriveActiveData`，可以造成状态不同步。

**修复方案**:
1. 将 `activeSessionIds` 和 `activeSessionSummaries` 改为 Zustand selector / getter，从 `activeContainerId + containers + sessionSummaryById` 惰性计算
2. 删除遗留 passthrough 方法或标记为 `@deprecated`

---

### 15. parseJsonBody 条件分支无效

- **文件**: [session-inspector.helpers.ts:304](apps/desktop/src/features/sessions/components/session-inspector.helpers.ts#L304)
- **分类**: Bug · 死代码 / 未完成功能
- **状态**: ✅ CONFIRMED

**问题描述**:
`if (body.sizeBytes > LARGE_JSON_SOFT_LIMIT && options?.preferSoftWarning !== false)` 分支和 else 分支返回完全相同的 `{ status: 'success', value: parsed }`。`preferSoftWarning` 选项和 `LARGE_JSON_SOFT_LIMIT` 常量是死代码。

**修复方案**:
1. 如果曾计划实现大 JSON 警告，则补充 warning 状态和 UI 展示
2. 如果不需要此功能，删除死代码分支和 `preferSoftWarning` 选项

---

### 16. HTTP 请求头构建的字符串分配（微优化）

- **文件**: [http_io.rs:437](crates/proxy-core/src/http_io.rs#L437)
- **分类**: 性能 · 微优化
- **状态**: PLAUSIBLE

**问题描述**:
`build_raw_http_head` 使用 `String::new()` 后连续 `push_str` 构建 HTTP 头。以 20 个 header 为例约 83 次 push_str，从容量 0 开始会有少量重分配。

**修复方案**:
```rust
let mut head = String::with_capacity(512); // 预分配合理大小
```

---

### 17. DB Schema 迁移中的 .ok() 吞掉错误

- **文件**: [schema.rs:355](crates/db/src/schema.rs#L355)
- **分类**: 健壮性 · 错误吞没
- **状态**: PLAUSIBLE

**问题描述**:
`ALTER TABLE rewrite_rules ADD COLUMN match_type TEXT DEFAULT 'contains'` 使用 `.ok()` 吞掉了所有错误。如果 ALTER TABLE 因非 "duplicate column" 原因失败（权限、损坏等），也会被静默忽略。

**修复方案**:
检查 SQLite 错误码，只在 "duplicate column" 时静默通过，其他错误应传播或记录日志。

---

### 18. MITM 服务中 TLS 握手错误信息不足

- **文件**: ~~mitm_service.rs~~ → 已迁移至 [http_proxy.rs](crates/proxy-core/src/http_proxy.rs)
- **分类**: 健壮性 · 可调试性（体验增强）
- **状态**: PLAUSIBLE

**问题描述**:
TLS 握手失败时错误信息不够具体，难以区分是证书问题、协议版本不匹配还是网络中断。用户在 UI 上只能看到模糊的错误提示。

**修复方案**:
1. 细化 TLS 错误分类（cert-untrusted, protocol-version, handshake-failure）
2. 在 session 错误信息中包含具体原因
3. 前端根据错误类型给出可操作建议（如"请在系统设置中信任 CA 证书"）

---

### 19. React Query Key 管理分散

- **文件**: 多个 `use-*.ts` 文件
- **分类**: 维护性 · 缓存一致性（低优先级）
- **状态**: PLAUSIBLE

**问题描述**:
Query Key 在各 hook 文件中分散定义，没有统一的 key registry。除了第 3 项中确认的 key 形状分歧问题，还有多个文件独立定义相似的 key 前缀。

**修复方案**:
创建 `apps/desktop/src/services/query-keys.ts` 统一管理所有 query key。

---

### 20. Session 批量收集器与 WS 消息处理共享 DB 锁

- **文件**: [proxy.rs](apps/desktop/src-tauri/src/commands/proxy.rs)
- **分类**: 性能 · 架构
- **状态**: PLAUSIBLE

**问题描述**:
Session 收集器和 WS 消息处理在同一个 `tokio::select!` 中共享同一个 DB 互斥锁。虽然 select 本身不阻塞，但 WS 消息的逐条加锁模式会饿死 session 批量写入。

**修复方案**:
将 WS 消息和 session 更新分别缓冲，合并为一个批量 DB 写入操作，减少锁获取频率。

---

### 21. rule-engine 与 proxy-core 规则评估路径重复

- **文件**: [rule-engine/src/lib.rs](crates/rule-engine/src/lib.rs) + [proxy-core/src/rules.rs](crates/proxy-core/src/rules.rs)
- **分类**: 架构债（非已证明 bug）
- **状态**: PLAUSIBLE

**问题描述**:
`rule-engine` crate 定义了规则数据结构，但 `proxy-core/src/rules.rs` 中有独立的规则匹配逻辑（`active_rewrite_rules_for_stage`, `active_script_rules_for_stage` 等）。两者之间的 matchType 支持已不同步（见第 6 项），暗示抽象层级不对。

**修复方案**:
将规则匹配逻辑收敛到 `rule-engine` 中，`proxy-core` 只调用 rule-engine 的评估接口。

---

### 22. TLS Manager trust 命令的平台差异（体验增强）

- **文件**: [trust.rs](crates/tls-manager/src/trust.rs)
- **分类**: 健壮性 · 跨平台（体验增强）
- **状态**: PLAUSIBLE

**问题描述**:
TLS 证书信任操作在不同平台上的行为差异较大。Linux 上没有系统级信任 store API（依赖发行版），macOS 需要通过 `security` 命令，Windows 需要通过 certutil。当前实现可能未完全覆盖所有发行版或未正确处理权限不足的情况。

**修复方案**:
1. 对 Linux 检测发行版并适配（update-ca-certificates vs ca-certificates）
2. 所有平台增加权限检查和明确的错误提示
3. 提供手动信任的回退方案

---

## 三、复核时移除的条目

以下条目经人工复核确认不成立或描述过强，已从问题列表中移除：

### ~~系统 proxy 恢复逻辑缺失~~（不成立）

- `system_proxy_recovery.rs:65` 已有 pending snapshot 机制，启动时会恢复异常退出遗留的系统代理设置。

### ~~HAR 导入部分成功部分失败~~（描述过强）

- `session-import.helpers.ts:187` 解析阶段先整体 map，失败会抛错不会进入导入。真正缺的是更完整的格式校验和事务式产品体验，而非"部分导入残留"问题。

### ~~Dev Logger 日志文件轮转缺失~~（不成立）

- `dev_logger.rs:128` 已使用 `tracing_appender` daily rotation，保留 15 个文件。

---

## 四、修复优先级建议

### P0 — 立即修复（数据丢失 / 请求损坏）

| # | 问题 | 预估工作量 |
|---|------|-----------|
| 1 | chunked 请求体丢弃 | 中（需实现 chunked 解码） |
| 5 | CONNECT 端口解析错误 | 小（改一行） |
| 6 | Script 规则 matchType 缺失 | 中（DB 迁移 + 全链路补全） |

### P1 — 本迭代修复（资源泄漏 / 并发问题 + 数据桥接）

| # | 问题 | 预估工作量 |
|---|------|-----------|
| 4 | 连接池雷鸣群体效应 | 中（改用 OnceCell，需处理失败场景） |
| 2 | SessionDetailPayload 字段缺失 | 中（补全映射，保留现有 deferred 策略） |
| 8 | WS 帧读取无超时 | 小（加 timeout wrapper） |
| 9 | 连接池 evict_expired 未调用 | 小（加定时任务） |
| 7 | 断点取消硬错误 | 中（改信号机制） |

### P2 — 近期修复（性能 / 健壮性）

| # | 问题 | 预估工作量 |
|---|------|-----------|
| 10 | Insights LOWER(host) 破坏索引 | 小（加表达式索引） |
| 11 | 日志热路径 String 浪费 | 中（改宏或改调用模式） |
| 12/20 | WS 消息逐条 DB 锁 | 中（改批量写入） |
| 17 | Schema .ok() 吞错 | 小（区分错误码） |

### P3 — 后续迭代（维护性 / 架构清理 / 体验增强）

| # | 问题 | 预估工作量 |
|---|------|-----------|
| 3, 14, 15, 19 | 前端状态管理清理 / key 统一 | 小~中 |
| 13 | Session 服务端过滤 | 大（需重构查询层） |
| 18, 22 | TLS 错误细化 / 规则引擎架构收敛 | 中~大 |
| 16 | HTTP head String 预分配（微优化） | 小 |
| 21 | 规则评估路径收敛 | 大 |

---

## 五、审查方法说明

本次审查采用结构化多角度扫描方法：

1. **7 个独立审查角度**（各最多 6 个候选发现）：
   - A: 逐行扫描 — 条件错误、off-by-one、空指针、缺失 await
   - B: 并发与资源管理 — 竞争条件、死锁、泄漏、超时
   - C: 跨文件合约 — 前后端接口不匹配、类型分歧
   - D: 错误处理与健壮性 — 空捕获、溢出、部分失败
   - E: 性能与效率 — 冗余分配、缺少索引、客户端过滤
   - F: 简化与死代码 — 重复逻辑、未使用代码
   - G: 架构与高度 — 抽象层级不对、特殊案例堆叠

2. **1-vote 验证**（recall-biased）：
   - 每个候选发现由独立 agent 读取源文件验证
   - PLAUSIBLE 为默认：竞争条件、罕见 nil 路径、缺失边界检查均视为可信
   - REFUTED 仅当：事实错误、可证明不可能、已在 diff 中处理

3. **人工复核校正**：
   - 对初版 25 条发现逐条复核源码
   - 移除 3 条不成立条目
   - 修正多条文件行号引用和描述
   - 调整优先级（#2 升至 P1，#16/#19/#21/#22 降至 P3）

4. **最终结果**：
   - 42 个候选 → 25 个验证通过 → 22 个经复核确认
   - 17 个已确认（CONFIRMED），5 个可信（PLAUSIBLE）

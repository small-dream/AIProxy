# P1 — 代码质量与架构治理

> 来源：`docs/ARCHITECTURE_REVIEW.md` P1 改进项 #6-#13
> 创建日期：2026-06-07
> 最后更新：2026-06-07 — 第二轮审查反馈修订
> 预计总工期：14-20 天（可并行压缩至 3-4 周）
> 当前分支：dev

---

## 目标

将 P0 修复后的工程基础进一步提升：消除 proxy-core 职责膨胀、修正 async 路径上的阻塞 IO、统一错误处理、收敛 API 文档漂移、拆分前端核心组件。所有改动是"让好的架构变得更好"，而非紧急修复。

---

## 执行阶段与依赖关系

```
Phase 1 — 低风险高确定性项（#11, #6）        ~2 天    ← 可立即开始
Phase 2 — 快速性能修复（#7）                   ~1 天    ← 依赖 Manager 设计确认
Phase 3 — 参数收敛（#10a）                     ~1.5 天  ← 为后续铺路
Phase 4 — proxy-core 纯结构拆分（#9a）          ~2 天    ← 依赖 Phase 3
Phase 5 — handle_http_request 拆分（#8）        ~5-8 天  ← 依赖 Phase 4，最复杂
Phase 6 — 渐进式类型治理（#10b, #12）           ~3-4 天  ← 与 Phase 5 可并行
Phase 7 — 前端重构（#13）                       ~2 天    ← 独立，不与 Rust 重构塞进同一迭代
Phase 8 — rules 行为整理（#9b）                 ~2 天    ← 依赖 #7, #9a
```

> #13 不与 Rust 核心重构共享验收窗口，避免同时大改前后端增加回归风险。

---

## Phase 1：低风险高确定性项

### #11 — 更新 API_SPEC.md Insights 章节（1 天）

**问题**：文档与实现严重漂移——字段名、输入参数、返回结构完全不同。

**影响文件**：
- `docs/API_SPEC.md` — Insights 相关章节

**方案**：

根据实际实现（Rust `crates/db/src/insights.rs` + TS `packages/shared-types/src/sessions.ts`）重写文档：

| 文档当前（错误） | 实际实现（需更新到文档） |
|---|---|
| `GetInsightsInput: { workspaceId, startTime?, endTime?, limit? }` | `{ sessionIds, excludedHosts?, hostExact?, hostKeyword? }` |
| `InsightsResult.totalSizeBytes` | `totalBytes` |
| `InsightsResult.hosts` | `byHost` |
| `InsightsResult.statusCodes` | `byStatusCode` |
| `InsightsResult.methods` | `byMethod` |
| 无 `totalErrors` | `totalErrors: number` |
| 无 `p50DurationMs` | `p50DurationMs: number` |
| 无 `p99DurationMs` | `p99DurationMs: number` |
| `HostInsight.medianDurationMs` | `p95DurationMs` |
| `SlowRequest: { host, path, startedAt }` | `{ sessionId, url, method, statusCode, durationMs }` |

**验证**：
- 逐字段对比 `API_SPEC.md` 与 `packages/shared-types/src/sessions.ts` 中的 `InsightsResult` / `GetInsightsInput`
- 确认所有字段名、类型完全一致
- 不需要任何代码改动，零风险

---

### #6 — SQLite 同步写入移到 `spawn_blocking`（1-1.5 天）

**问题**：`persist_session_to_db` 在 async 路径上持有 `Mutex<Connection>` 进行同步 SQLite 写入，高 QPS 下造成代理延迟尖峰。

**影响文件**：
- `apps/desktop/src-tauri/src/bootstrap/mod.rs` — `persist_session_to_db`（L448-539）、`upsert_session`（L437）、`upsert_session_batch`（L628）
- `apps/desktop/src-tauri/src/commands/proxy.rs` — session collector 循环（~L172）、WS message insert（~L180-198）
- `apps/desktop/src-tauri/src/commands/common.rs` — `run_blocking_command` 已有模式可复用

**方案**：

**核心原则**：不硬塞 `spawn_blocking` 到同步函数内部，而是新增 async 版本让调用链显式 async。

#### 决策门：body spill 的 IO 性质（已核实）

`spill_session_bodies_to_disk` → `BodyStore::write_body` 使用 `std::fs::write` + `std::fs::create_dir_all`（`crates/db/src/body_store.rs` L23-34），是**同步阻塞文件 IO**。

**结论**：body spill 和 SQLite 写入一起进入 `spawn_blocking`，不能留在 async 上下文。

#### 调用链迁移方案

当前调用链：

| 调用方 | 位置 | async? | 当前调用 |
|--------|------|--------|----------|
| `send_composed_request` | `compose.rs` L21 | ✅ async | `state.upsert_session(detail.clone())` |
| batch execute | `collections.rs` L561 | ✅ async | `state.upsert_session(detail.clone())` |
| session collector | `proxy.rs` ~L172 | ✅ async (tokio::spawn) | `state.upsert_session_batch(...)` |
| WS message | `proxy.rs` ~L180-198 | ✅ async (tokio::spawn) | `state.db.lock()` 直接写 |

迁移步骤：

1. **新增 `AppState::upsert_session_async`**：
   - 签名 `pub async fn upsert_session_async(&self, session_detail: ProxySessionDetail)`
   - 内部使用 `tauri::async_runtime::spawn_blocking`（与现有 `run_blocking_command` 保持一致，`commands/common.rs` L44），不混用 `tokio::task::spawn_blocking`
   - blocking 闭包内完成：body spill（同步 fs）+ row build（纯内存）+ SQLite 写入
   - `update_session_cache_and_emit` 在 `spawn_blocking` **外部** async 上下文执行（它操作 `session_details` / `sessions` 等 `Arc<Mutex<>>`，不应与 DB mutex 在同一线程）

2. **`AppState::upsert_session_batch_async`**：同理，使用 `tauri::async_runtime::spawn_blocking`

3. **调用方全部改为 `.await`**：
   - `compose.rs` L21 → `state.upsert_session_async(detail.clone()).await`
   - `collections.rs` L561 → `state.upsert_session_async(detail.clone()).await`
   - `proxy.rs` session collector → `state.upsert_session_batch_async(...).await`
   - `proxy.rs` WS message → 同理包裹 `spawn_blocking`

4. **保留原同步函数**：
   - `upsert_session`（sync）保留，标记 `#[deprecated]`
   - 仅供测试或确认同步上下文的调用方使用
   - 如果确认所有调用方都已迁移，可在后续 PR 中删除

#### trait 约束确认（已核实）

- `Arc<Mutex<rusqlite::Connection>>`：`Arc: Send`，`Mutex<Connection>: Send`（`rusqlite::Connection: Send`）→ 可安全跨 `spawn_blocking` 捕获 ✅
- `Arc<BodyStore>`：`BodyStore` 内部仅持 `PathBuf`，无非 Send 字段 → `Send` ✅
- `session_details: Arc<Mutex<HashMap<...>>>` **不在** `spawn_blocking` 闭包内被锁住，避免跨线程死锁 ✅

**风险**：
- `spawn_blocking` 线程池默认 512 线程，高 QPS batch 写入不会溢出
- `update_session_cache_and_emit` 必须在 `spawn_blocking` 返回后执行，不能在 blocking 闭包内，否则会与 DB mutex 产生嵌套锁

**验收门槛**：
- `cargo test -p aiproxy-desktop` — 全量通过
- 压测：记录本机基线 p95/p99 代理延迟，修复后对比，确认尖峰消失或显著降低
- 确认 `SESSION_NOT_FOUND` 等错误路径仍然正常工作
- 确认无 `upsert_session`（sync）的残余调用（`grep -rn 'state\.upsert_session(' --include='*.rs'`，排除 `_async` 版本）

---

## Phase 2：快速性能修复

### #7 — 预编译 regex 规则（1 天）

**问题**：`pattern_matches`（`rules.rs` L518-572）在热路径上每次调用 `Regex::new()`，浪费 CPU。

**影响文件**：
- `crates/proxy-core/src/rules.rs` — `pattern_matches`（L518-572）、4 个 Manager（L158-438）

**方案**：

**核心原则**：不在 DTO 类型（`RewriteRuleMatch`、`MapRule`、`ThrottleRuleData`）中添加 `Regex` 字段。这些类型派生了 `Serialize/Deserialize/PartialEq/Eq/Clone/Debug`，加入 `Option<Regex>` 会破坏 serde、比较语义、clone 行为。改为在 Manager 内部维护 runtime wrapper。

1. **定义 runtime rule wrapper**（Manager 内部类型，不暴露到外部 API）：
   ```rust
   // 仅在 Manager 内部可见，不影响 DTO 契约
   struct CompiledRewriteRule {
       rule: RewriteRule,            // 原始规则，保持不变
       compiled_match: Option<Regex>, // 仅 match_type == "regex" 时有值
   }
   ```

2. **Manager 内部用 `Vec<CompiledRewriteRule>` 替代 `Vec<RewriteRule>`**：
   - `set_rules(rules: Vec<RewriteRule>)` 时，遍历编译 regex，存储为 `CompiledRewriteRule`
   - 编译失败 → `emit_log!(warn, ...)` + `compiled_match: None`（匹配时该 regex 规则跳过）
   - `get_rules()` 返回时解包回 `Vec<RewriteRule>`，保持外部 API 不变

3. **`pattern_matches` 签名扩展**：
   - 新增 `pattern_matches_compiled(compiled: Option<&Regex>, candidate: &str) -> bool`
   - 原有 `pattern_matches` 保留不变，供非 Manager 调用路径使用（fallback 兼容）

4. **`Regex` 是 `Send + Sync` 的**：不存在线程安全问题，Mutex 保护的是 rules 集合的读写，不是 Regex 本身。

**风险**：
- 规则热更新（`set_rules`）时的编译开销可忽略（规则数量有限）
- 无效 regex 在加载时即可发现并 warn → 比运行时才发现更好

**验收门槛**：
- `cargo test -p aiproxy-proxy-core` — 全量通过
- 新增测试覆盖：
  - 无效 regex → 降级为 skip，不 crash
  - 规则更新后 compiled regex 刷新
  - 非 regex 匹配（exact/wildcard/contains）不回退编译
- 基准对比：`pattern_matches` 对 regex 匹配的 CPU 时间下降

---

## Phase 3：参数收敛

### #10a — 引入 `ProxyManagers` + `ProxyConfig`（1.5 天）

**问题**：`start_proxy_server` 有 11 个参数（8 个 `Option<Arc<Manager>>`），`handle_connection` 有 14 个参数。

**范围**：仅做签名治理，**不引入 `ProxyError`**。错误返回仍保持 `String`，降低行为风险。

**影响文件**：
- 新建 `crates/proxy-core/src/context.rs` — `ProxyManagers` + `ProxyConfig`
- `crates/proxy-core/src/lib.rs` — 导出新类型
- `crates/proxy-core/src/server.rs` — `start_proxy_server` 签名
- `crates/proxy-core/src/http_proxy.rs` — `handle_http_request` 签名
- `crates/proxy-core/src/ws.rs` — WS 相关函数签名
- `apps/desktop/src-tauri/src/bootstrap/mod.rs` — `start_proxy` 调用处

**方案**：

```rust
pub struct ProxyManagers {
    pub tls: Option<Arc<TlsManager>>,
    pub breakpoint: Arc<BreakpointManager>,
    pub rewrite: Arc<RewriteManager>,
    pub map: Arc<MapManager>,
    pub script: Arc<ScriptManager>,
    pub throttle: Arc<ThrottleManager>,
    pub dns: Arc<DnsManager>,
}

pub struct ProxyConfig {
    pub runtime: ProxyRuntimeConfig,
    pub workspace_id: Option<String>,
    pub event_emitter: Option<BreakpointEventEmitter>,
}
```

- `start_proxy_server(config: ProxyConfig, managers: ProxyManagers)` → 2 个参数
- `handle_connection` 接收 `&ProxyManagers` 替代 8 个独立 Arc
- 错误类型不变：`Result<StartedProxyServer, String>`

**风险**：
- 纯签名重构，行为不变 → 风险极低
- 最大的好处：后续 #8、#9 可以直接享受参数收敛，不用再处理 14 参数函数

**验证**：
- `cargo test -p aiproxy-proxy-core` — 全量通过
- `cargo test -p aiproxy-desktop` — 集成测试通过
- `cargo clippy -p aiproxy-proxy-core -- -D warnings`

---

## Phase 4：proxy-core 纯结构拆分

### #9a — 拆分 `rules.rs`（纯文件搬迁，2 天）

**问题**：`rules.rs` 2143 行，混合了类型定义、4 个 Manager、模式匹配、规则应用逻辑。

**范围**：**仅做文件搬迁和模块拆分，不改变任何行为**。不混入 regex 预编译、manager 分离、管线函数整理。

**影响文件**：
- 将 `crates/proxy-core/src/rules.rs` 拆为 `crates/proxy-core/src/rules/` 模块目录

**目标结构**：

```
crates/proxy-core/src/rules/
├── mod.rs           — re-exports + 管线编排函数（apply_request_runtime_rules 等）
├── types.rs         — 所有规则/追踪类型定义（~150 行）
├── patterns.rs      — pattern_matches、wildcard 匹配（~80 行）
├── managers.rs      — RewriteManager、MapManager、ThrottleManager、DnsManager（~280 行）
├── rewrite.rs       — apply_request_rewrite_rules、apply_response_rewrite_rules（~300 行）
├── map.rs           — apply_map_rules + 本地/远程映射逻辑（~200 行）
├── throttle.rs      — apply_request_throttle、apply_response_throttle + 模拟逻辑（~150 行）
├── script.rs        — apply_request_script_rules、apply_response_script_rules（~100 行）
└── json_path.rs     — JSON path 操作辅助函数（~150 行）
```

**方案**：

1. 创建 `rules/` 目录，按职责拆分
2. `mod.rs` 负责所有 `pub` re-exports，保持外部 `use crate::rules::RewriteManager` 等不变
3. 每个子文件 `use super::types::*` 访问共享类型
4. 所有 `pub` 接口签名完全不变

**验收门槛**：
- **第一阶段验收**：`cargo build` 编译通过 + `cargo test -p aiproxy-proxy-core` 全量通过 = 搬迁成功
- **禁止项**：不允许在搬迁 PR 中修改任何函数签名、逻辑、命名
- `cargo clippy -p aiproxy-proxy-core -- -D warnings` 无新增 warning

---

## Phase 5：handle_http_request 拆分

### #8 — 拆分 `handle_http_request` — Strangler Fig 重构（5-8 天）

**问题**：`http_proxy.rs` 中的 `handle_http_request`（L670-1378，709 行）包含 15 个阶段，维护困难。

**前置依赖**：#10a（ProxyManagers）+ #9a（rules 拆分）完成后进行。

**影响文件**：
- `crates/proxy-core/src/http_proxy.rs` — 主要重构目标

**方案 — Strangler Fig 策略**：

分三个渐进步骤，每步独立可合并：

**Step 1：提取纯辅助函数（不引入 Pipeline struct）**
- 将 `handle_http_request` 中已边界清晰的代码块提取为独立函数
- 重点：URL 构建（阶段 2）、session 构建辅助（阶段 11, 14）、错误响应构建（阶段 15）
- 这些函数无状态依赖，提取风险最低
- `handle_http_request` 仍是一个大函数，但部分逻辑已委托出去

**Step 2：提取请求侧阶段函数**
- 阶段 1-7（WebSocket 检测 → 请求限速）
- 每个阶段函数签名显式接收必要参数，返回阶段结果
- 阶段间通过返回值传递数据（不用 Pipeline struct）
- 断点阶段的 Drop/Mock/Forward 三分支在阶段函数内部处理

**Step 3：提取响应侧阶段函数**
- 阶段 8-15（WS 升级/转发 → 最终返回）
- 同上，通过返回值传递数据

**设计决策**：
- **不预先设计重型 `RequestPipeline` struct**。先用返回值模式验证边界，如果阶段间数据传递确实复杂到需要 struct，再引入
- **每个 PR 只移动一组连续阶段**，保持行为等价
- **不混入**：命名重构、错误语义重构（ProxyError）、规则逻辑变化

**验收门槛**：
- 每个 PR（Step 1/2/3）合并前：
  - `cargo test -p aiproxy-proxy-core` 全量通过
  - 保存拆分前一组 session detail JSON（覆盖 HTTP/HTTPS/WS/断点/规则/限速场景），拆分后对比关键字段一致
  - 手动测试矩阵：HTTP 请求 → HTTPS 请求 → WS 升级 → 断点拦截 → 规则重写 → 限速
- **不设 diff 行数限制**，以行为等价为唯一验收标准

---

## Phase 6：渐进式类型治理

### #10b — 引入 `ProxyError` enum（2 天）

**问题**：所有 proxy-core 函数返回 `Result<T, String>`，丢失结构化错误信息。

**范围**：渐进引入 `ProxyError`，先从内部模块开始，边界函数统一 `.to_string()`。与 #10a 分开做，降低风险。

**影响文件**：
- `crates/proxy-core/Cargo.toml` — 添加 `thiserror` 依赖
- 新建 `crates/proxy-core/src/error.rs` — `ProxyError` enum
- `crates/proxy-core/src/lib.rs` — 导出
- proxy-core 内部模块逐步迁移

#### 依赖说明

`crates/proxy-core/Cargo.toml` 当前**没有** `thiserror` 依赖。两种选择：

- **推荐**：添加 `thiserror` 依赖。理由：`aiproxy-desktop` 的 `Cargo.toml` 已有 `thiserror`，`tls-manager` 也已使用，项目内一致性好。`thiserror` 是 proc-macro crate，编译开销仅在首次构建时产生，之后有缓存。
- 备选：手写 `impl std::fmt::Display` + `impl std::error::Error`。省一个依赖但代码量多、维护成本高。

**方案**：

```rust
// crates/proxy-core/src/error.rs
#[derive(Debug, thiserror::Error)]
pub enum ProxyError {
    #[error("upstream connection failed: {0}")]
    UpstreamError(String),
    #[error("TLS handshake failed: {0}")]
    TlsError(String),
    #[error("rule application failed: {0}")]
    RuleError(String),
    #[error("breakpoint cancelled")]
    BreakpointCancelled,
    #[error("request dropped")]
    RequestDropped,
    #[error("script execution timeout")]
    ScriptTimeout,
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
    #[error("{0}")]
    Other(String),
}
```

**迁移策略**：
- 先在 `server.rs` 的 `forward_request` / `handle_connection` 等内部函数中使用 `ProxyError`
- Tauri 命令边界（`bootstrap/mod.rs` 调用 proxy-core 的地方）将 `ProxyError` 转为 `String`：`err.to_string()`
- 保持对外 API（`start_proxy_server` 返回值）仍为 `Result<..., String>`
- 后续再逐步将 `ProxyError` 推到更上层

**验证**：
- `cargo test -p aiproxy-proxy-core` — 全量通过
- `cargo test -p aiproxy-desktop` — 集成测试通过
- 错误消息内容与迁移前一致（`.to_string()` 产出相同文本）

---

### #12 — 统一 Rust 错误返回格式（2-3 天，渐进）

**问题**：`ai.rs` 返回 `{"code":"...","message":"..."}`，其他模块返回纯字符串，前端无法统一解析错误类型。

**P1 范围**：建立统一 helper + 错误码命名规则 + 迁移高频路径。其他 command 文件允许后续渐进迁移。

**影响文件**：
- `apps/desktop/src-tauri/src/commands/common.rs` — 添加共享 `app_error()` 函数 + 错误码常量
- 高频路径：`proxy.rs`、`rules.rs`、`sessions.rs`、`ai.rs`（移除本地 `app_error()`）
- 前端兼容：`packages/shared-types/src/common.ts` — `coerceAppError` 同时支持 JSON error string 和普通 string

**方案**：

1. **在 `common.rs` 中定义共享工具**：
   ```rust
   pub fn app_error(code: &str, message: impl AsRef<str>) -> String {
       serde_json::json!({
           "code": code,
           "message": message.as_ref(),
       }).to_string()
   }

   pub fn app_error_with_details(code: &str, message: &str, details: serde_json::Value) -> String {
       serde_json::json!({
           "code": code,
           "message": message,
           "details": details,
       }).to_string()
   }
   ```

2. **错误码常量**：
   ```rust
   pub const ERR_PROXY_NOT_RUNNING: &str = "PROXY_NOT_RUNNING";
   pub const ERR_INVALID_INPUT: &str = "INVALID_INPUT";
   pub const ERR_NOT_FOUND: &str = "NOT_FOUND";
   pub const ERR_CERT_NOT_FOUND: &str = "CERT_NOT_FOUND";
   pub const ERR_INTERNAL: &str = "INTERNAL_ERROR";
   ```

3. **P1 迁移范围**（高频路径）：
   - `ai.rs` — 移除本地 `app_error()`，改用 `common::app_error()`
   - `proxy.rs` — 代理启停、系统代理相关错误
   - `rules.rs` — 规则保存/删除错误
   - `sessions.rs` — session_not_found_error 改用 `common::app_error_with_details()`

4. **P2 允许渐进**：
   - `certificates.rs`、`workspaces.rs`、`collections.rs`、`throttling.rs`、`ws.rs` 可后续逐步迁移
   - 旧格式（纯 string）在前端仍可正常显示，只是没有 code

5. **前端兼容**：
   - `coerceAppError` 已能解析 JSON string → `AppError { code, message }`
   - 需确认纯 string error 仍能降级处理（回退为 `{ code: "UNKNOWN", message: rawString }`）
   - 过渡期内两种格式共存

**验收门槛**：
- `cargo test -p aiproxy-desktop` — 已迁移模块的测试通过
- 前端同时验证旧 string error（未迁移模块）和新 JSON error（已迁移模块）显示正确
- 确认 `coerceAppError` 对两种格式的降级处理无遗漏

---

## Phase 7：前端重构（独立迭代）

### #13 — 拆分 AppShell 为多个 Hook（2 天）

**问题**：`AppShell.tsx` 770 行，混合了代理生命周期、50-case 菜单路由、ADB 操作、端口对话框、缩放、窗口管理等职责。

**影响文件**：
- `apps/desktop/src/components/layout/AppShell.tsx` — 主重构目标
- 新建 hook 文件（建议 `apps/desktop/src/components/layout/hooks/`）

**方案**：

提取以下 5 个自定义 Hook：

| Hook | 职责 | 来源 |
|------|------|------|
| `useProxyLifecycle` | 自动启动、手动 start/stop、端口对话框、系统代理切换 | useState: portDialogOpen/portDraft/portDialogError, useEffect: auto-start |
| `useMenuActions` | 50-case `handleMenuCommand` 路由分发 | useEffect: menu event subscribe, handleMenuCommand 函数 |
| `useAdbActions` | ADB 设备代理设置/清除 | handleAdbSetProxy, handleAdbClearProxy |
| `useZoomControl` | 缩放级别状态 + 键盘快捷键监听 | useState: zoomLevel, useEffect: zoom apply + keyboard |
| `useWindowControls` | 窗口管理（最小化/最大化/全屏/关闭） | handleMenuCommand 中的窗口分支 |

**重构后的 AppShell**：
```tsx
function AppShell() {
  const { portDialogProps, ...proxyProps } = useProxyLifecycle();
  const adbActions = useAdbActions();
  const zoom = useZoomControl();
  useMenuActions({ proxyProps, adbActions, zoom, navigate });
  useWindowControls();

  // 仅保留 JSX 渲染 + 平台判断逻辑
  return (
    <AppProviders>
      <PlatformLayout>
        <Outlet context={{ headerActions }} />
      </PlatformLayout>
      <AppShellDialogs {...portDialogProps} />
      <Snackbar ... />
    </AppProviders>
  );
}
```

**风险**：
- Hook 间有隐式依赖（如 menu action 调用 proxy lifecycle）→ 通过参数/返回值显式传递
- macOS overlay titlebar 逻辑可能与 zoom/window hooks 交互 → 需仔细测试

**验证**：
- `pnpm --filter @aiproxy/desktop typecheck` — 类型检查
- `pnpm --filter @aiproxy/desktop lint` — lint
- 手动测试：启动代理 → 菜单操作 → ADB 操作 → 端口修改 → 缩放 → 窗口控制
- 至少 macOS 全流程验证

---

## Phase 8：rules 行为整理

### #9b — compiled rule 搬迁后整理（2 天，依赖 #7 + #9a）

**背景**：#7 在老的 `rules.rs` 中引入了 `CompiledRewriteRule` wrapper；#9a 将 `rules.rs` 拆为 `rules/` 模块目录。本项只做模块化后的代码摆放与调用路径清理，不重复实现 #7 的编译逻辑。

**与 #7 的边界**：

| 项 | #7 做什么 | #9b 做什么 |
|----|-----------|------------|
| `CompiledRewriteRule` | 引入 wrapper + 编译逻辑 + 测试 | 搬迁后调整代码位置，清理跨文件调用路径 |
| `pattern_matches_compiled` | 新增函数 | 确认在 `patterns.rs` 中的摆放、调用方引用更新 |
| Manager 内部存储 | `Vec<RewriteRule>` → `Vec<CompiledRewriteRule>` | 确认拆分后的 `managers.rs` 中类型引用正确 |

**内容**：
- 确认 `CompiledRewriteRule` 及各 Manager 的 compiled wrapper 在拆分后的文件中位置正确
- 清理 `patterns.rs` 与 `managers.rs` 之间的 `use` 引用路径
- 补充因模块拆分导致的集成测试更新（如有）
- Manager 公共 API 仍暴露原始 rule 类型，内部使用 compiled wrapper

**验收门槛**：
- `cargo test -p aiproxy-proxy-core` — 全量通过（含 #7 新增的 regex 测试）
- Manager 外部 API 不变（`pub` 签名、序列化格式）
- 编译后 regex 在规则更新时正确刷新

---

## 执行时间线

```
Week 1:
  Day 1:     #11 API_SPEC.md（纯文档，零风险）
  Day 1-2.5: #6 SQLite async fix（含 trait 约束验证 + 压测基线）
  Day 3:     #7 Regex pre-compile（Manager runtime wrapper）

Week 2:
  Day 4-5:   #10a ProxyManagers + ProxyConfig（参数收敛）
  Day 5-6:   #9a rules.rs 纯拆分

Week 3:
  Day 7-11:  #8 handle_http_request 拆分（Strangler Fig，3 个 Step）
  Day 7-9:   #13 AppShell Hook 拆分（并行，但独立验收）

Week 4:
  Day 10-11: #10b ProxyError 渐进迁移（与 #8 Step 3 可并行）
  Day 11-13: #12 错误格式统一（P1 范围：helper + 高频路径）
  Day 13-14: #9b rules 行为整理
```

## PR 规划建议

| PR | 内容 | 依赖 | 风险 |
|----|------|------|------|
| PR-1 | #11 API_SPEC.md | 无 | 极低（纯文档） |
| PR-2 | #6 SQLite async fix | 无 | 低（需 trait 验证） |
| PR-3 | #7 Regex pre-compile | 无 | 低（runtime wrapper） |
| PR-4 | #10a ProxyManagers | PR-2, PR-3 | 低（纯签名） |
| PR-5 | #9a rules.rs 纯拆分 | PR-4 | 极低（只搬文件） |
| PR-6a | #8 Step 1 辅助函数提取 | PR-5 | 低 |
| PR-6b | #8 Step 2 请求侧阶段 | PR-6a | 中 |
| PR-6c | #8 Step 3 响应侧阶段 | PR-6b | 中 |
| PR-7 | #10b ProxyError 渐进迁移 | PR-4 | 中（错误语义） |
| PR-8 | #12 错误格式统一（P1 范围） | 无 | 中（前后端兼容） |
| PR-9 | #13 AppShell Hook 拆分 | 无 | 中（前端行为） |
| PR-10 | #9b compiled rule 搬迁后整理 | PR-3, PR-5 | 低 |

> PR-1/2/3 互相独立，可同时开始。PR-1 可立即合并。
> PR-6a→6b→6c 是 #8 的三个 Step，每个独立可合并。
> PR-9 不与 PR-6/7/8 共享验收窗口。

## 全局验证清单（分层）

### 第一层：受影响域测试 — 每个 PR 必跑

| PR 类型 | 必跑命令 |
|---------|----------|
| 纯文档（PR-1） | 无（目视 diff 即可） |
| Rust 改动 | `cargo test -p <affected-crate>` + `cargo clippy -p <affected-crate> -- -D warnings` |
| 前端改动 | `pnpm --filter @aiproxy/desktop typecheck && pnpm --filter @aiproxy/desktop lint && pnpm --filter @aiproxy/desktop test` |

### 第二层：完整全局验证 — 大 PR 必跑

适用于：PR-2（#6）、PR-4（#10a）、PR-6a/b/c（#8）、PR-7（#10b）

- [ ] `cargo test -p aiproxy-proxy-core` — Rust 核心测试
- [ ] `cargo test -p aiproxy-desktop` — 集成测试
- [ ] `cargo clippy -p aiproxy-proxy-core -- -D warnings` — lint
- [ ] `pnpm --filter @aiproxy/desktop typecheck` — 前端类型检查
- [ ] `pnpm --filter @aiproxy/desktop lint` — 前端 lint
- [ ] `pnpm --filter @aiproxy/desktop test` — 前端测试

### 第三层：手动端到端验证 — 阶段验收 / 合并前

适用于：Phase 5（#8）完成时、Phase 7（#13）完成时、整体 P1 收尾

- [ ] 手动启动代理，执行完整请求流程（HTTP/HTTPS/WS/断点/规则/限速）

### 各项专项验收

| 项 | 专项验收 |
|----|----------|
| #6 | 压测前后 p95/p99 代理延迟对比，至少记录本机基线；`grep -rn 'state\.upsert_session(' --include='*.rs'` 确认无 sync 残余调用 |
| #7 | 新增测试：无效 regex 降级、规则更新后刷新、非 regex 不回退编译 |
| #8 | 保存拆分前后一组 session detail JSON，对比关键字段一致 |
| #9a | 只允许移动代码，不允许改逻辑 |
| #12 | 前端同时验证旧 string error 和新 JSON error |

## 不在本次范围内

以下属于 P2，不在本计划中：
- 空壳 crate 清理（#14）
- `TlsOrPlain<S>` 提取（#15）
- reqwest/hyper 统一（#16）
- Windows 网络接口枚举（#17）
- property-based 测试（#18）
- 重复类型定义统一（#19）
- `emit_log` 迁移 tracing（#20）

### #9b/ #10b 之后的 P2 延续
- `ProxyError` 推到 Tauri 命令边界
- #12 剩余 command 文件全量迁移
- rules manager 进一步职责分离

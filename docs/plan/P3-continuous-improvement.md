# P3 持续改进 — 实施计划

## Context

AIProxy 经过 P0（安全基线）、P1（代码质量与架构治理）、P2（工程规范）三轮治理后，整体健康度达到 A 级。P3 是最后一轮持续改进，包含 10 个改进项（#25-#34），目标是进一步提升代码可维护性和测试覆盖率。

当前痛点：
- `db` crate 约 85 个公共函数全部返回 `Result<_, String>`（89 处 `Result<_, String>` 出现），错误上下文丢失
- `http_proxy.rs`（2,315 行）和 `server.rs`（1,714 行）仍是维护热点
- `rule-engine` 单文件 1,178 行，类型/编译/执行/JS bridge 交织
- 4 个前端页面超过 1,000 行，未应用 SessionsPage 拆分模式
- 前端测试覆盖率仅 17.4%

执行策略：**分层递进（小风险先行）**——先收小口（command raw error + ProxyError 外层），再拆模块（纯移动），再做 db 大迁移，最后前端改进。

**硬约束**：所有模块拆分 PR（#27/#25/#26）只允许移动代码和调整可见性，**不做任何行为重写**。http_proxy.rs 和 server.rs 是代理热路径，模块化 PR 最怕顺手改逻辑。

---

## 阶段 1：错误处理收口（#30 → #29 → #34）

> 执行顺序理由：#30 和 #29 都是小范围改动（2 个文件、2 个函数），风险低、收益确定。#34 是审计+单测，不涉及大规模签名变更。这三项先做，把 command 层和 proxy-core 外层收干净。

### 1.1 #30 修复 raw `format!` 错误 → `app_error()`

**范围**：2 个文件，~10 处改动

**文件**：

- `src-tauri/src/commands/ai.rs` — 7 处未结构化错误（6 处 raw `format!` + 1 处 `.to_string()` 回退）
- `src-tauri/src/commands/rules.rs` — 1 处 raw `format!`（行 656）

**做法**：

- ai.rs 的 6 处 `format!(...)` 直接替换为 `app_error(ERR_INTERNAL, "...")`，HTTP status 错误用 `app_error_with_details()` 传递 status code
- ai.rs 行 280 的 `"AI response did not include any summary text.".to_string()` 替换为 `app_error(ERR_INTERNAL, "...")`
- **rules.rs 行 656 需要重构校验顺序**：当前 `delete_rule` 中 unknown type 分支的 `Err(format!(...))` 会被行 658 的 `.map_err(|error| app_error(ERR_INTERNAL, ...))` 二次包装，产生 `app_error(ERR_INTERNAL, "{\"code\":\"INVALID_INPUT\",...}")` 的嵌套 JSON。正确做法是将 rule_type 校验提前到 db 调用之前，与行 661-671 的 in-memory manager match 合并为统一的 early return：
  ```rust
  // 在 db 调用之前校验 rule_type
  let rule_type = match input.rule_type.as_str() {
      "rewrite" | "map" | "dns" | "script" => input.rule_type.as_str(),
      _ => return Err(app_error(ERR_INVALID_INPUT, format!("Unknown rule type: {}", input.rule_type))),
  };
  ```

**验证**：`cargo build` + 相关页面功能测试

### 1.2 #29 `ProxyError` 扩展到外层函数

**范围**：仅 2 个外层入口函数，不改 server.rs 内部 helper

**文件**：

- `crates/proxy-core/src/server.rs` — `handle_connection`（行 284）、`handle_connect_mitm`（行 1298）
- `crates/proxy-core/src/error.rs` — 可能需要新增 variant

**做法**：

- `handle_connection`: `Result<(), String>` → `Result<(), ProxyError>`
- `handle_connect_mitm`: `Result<(), String>` → `Result<(), ProxyError>`
- 可能需要新增 `ProxyError::ConnectionError(String)` variant
- 更新 `http_proxy.rs` 中 `handle_http_request` 的错误转换（移除 `String::from` 中转）
- server.rs 内部 helper 函数（`read_response_body_with_limit`、`tunnel_blind_relay` 等）不在本次范围内。阶段 2 模块拆分仅移动这些 helper 到新文件，**不迁移其错误类型**；helper 的 String 错误类型后续单独处理或暂不纳入 P3

**验证**：`cargo test -p aiproxy-proxy-core` + `cargo build`

### 1.3 #34 列表查询错误传播防回归审计

**范围**：Tauri commands 层，审查所有列表查询命令

**做法**：

- 逐一检查返回 `Vec<T>` 的 command：出错时是否返回 `Err` 而非空 Vec
- 重点检查：`list_sessions`、`list_rules`、`list_collections`、`list_throttle_rules` 等
- P2b 已完成主体治理，本阶段做防回归审计
- 将发现的静默失败改为 `Result::Err(app_error(...))`
- **新增 1-2 个 command/helper 层单测**，覆盖 "查询失败应返回 Err 而非空 Vec" 的回归保护

**验证**：`cargo test`（含新增单测） + `cargo build`

---

## 阶段 2：Rust 模块拆分（#27 → #25 → #26）

> 纯移动拆分放在 DbError 迁移之前。理由：模块拆分只移动代码位置，不改变签名，风险最低。如果先做 DbError 迁移（89 处签名变更），后续移动文件会增加 merge 冲突概率。先拆后迁，每个 batch 的 diff 更干净。

### 2.1 #27 `rule-engine` 拆分为多模块

**范围**：`crates/rule-engine/src/lib.rs`（1,178 行）→ 5 个文件

**硬约束**：只移动代码和调整可见性，不做行为重写。

**拆分方案**：

```text
crates/rule-engine/src/
├── lib.rs          → mod 声明 + pub use re-exports（~30 行）
├── types.rs        → 15 个 struct/enum（~273 行）
├── compile.rs      → compile_script_rule, validate, detect_entrypoints, transpile（~200 行）
├── execute.rs      → execute_request_hook, execute_response_hook, execute_hook, runtime helpers（~260 行）
└── js_bridge.rs    → SCRIPT_HOST_BRIDGE 常量 + build_runtime_module（~230 行）
```

**迁移步骤**：

1. 创建新模块文件，按逻辑分组复制代码
2. 更新 `lib.rs` 为 `mod` 声明 + `pub use` re-exports
3. 更新 `Cargo.toml` 无需改动（crate 内部重组）
4. 运行测试确保所有 11 个测试通过

**验证**：`cargo test -p aiproxy-rule-engine` + `cargo build`

### 2.2 #25 `http_proxy.rs` 瘦身 — WS upgrade 模块化

**范围**：`crates/proxy-core/src/http_proxy.rs`（2,315 行）→ 新增 `ws_upgrade.rs`

**硬约束**：只移动代码和调整可见性，不做行为重写。

**提取到 `ws_upgrade.rs`**（~468 行）：

- `send_ws_upstream_error_session`（行 66-123）
- `handle_ws_upgrade_via_hyper`（行 138-527）
- `parse_upstream_response_head`（行 531-553）
- `ws_headers_to_header_map`（行 556-567）
- `build_ws_upgrade_request`（行 570-589）

**http_proxy.rs 保留**（~1,847 行）：

- Request pipeline stages（stage 1-6 + orchestrator）
- URL/header 构建函数
- Response helper 函数
- Session 管理 + PendingRequestCancellationGuard

**验证**：`cargo test -p aiproxy-proxy-core` + `cargo build`

### 2.3 #26 `server.rs` 瘦身 — upstream + connect 模块化

**范围**：`crates/proxy-core/src/server.rs`（1,714 行）→ 新增 2 个文件

**硬约束**：只移动代码和调整可见性，不做行为重写。

**提取到 `upstream.rs`**（~475 行）：

- `forward_request`（行 464-680）
- `build_upstream_response_from_hyper`（行 684-752）
- `read_response_body_with_limit`（行 754-832）
- `read_hyper_response_body_with_limit`（行 835-916）
- `create_response_spool_file`（行 918-938）

**提取到 `connect.rs`**（~476 行）：

- `tunnel_blind_relay`（行 941-991）
- `handle_connect_mitm`（行 1281-1416）
- `handle_https_websocket_upgrade`（行 1002-1217）
- `read_http_response_head`（行 1221-1251）
- `build_raw_upgrade_request`（行 1254-1273）

**server.rs 保留**（~763 行）：

- `PrefixedStream` + `DIRECT_HTTP_CLIENT`
- `start_proxy_server`
- `handle_connection`
- `read_header_only`
- `send_direct_request`

**验证**：`cargo test -p aiproxy-proxy-core` + `cargo build`

---

## 阶段 3：`db` crate `DbError` 结构化错误迁移（#28）

> 放在模块拆分之后。89 处签名变更涉及 db crate 全部文件，是最系统、风险最高的改动。此前 command 层（#30）和 proxy-core 外层（#29）已收口，模块拆分已完成，DbError 迁移的 diff 将是唯一的正在进行中的大范围变更。

**范围**：db crate 全部文件，约 85 个公共函数（89 处 `Result<_, String>`），渐进迁移

**依赖变更**：`crates/db/Cargo.toml` 新增 `thiserror = "2"`（当前 db crate 无此依赖；workspace 中 proxy-core 和 tls-manager 已使用 thiserror 2.x）

**新文件**：`crates/db/src/error.rs`

```rust
#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("database connection failed: {0}")]
    Connection(String),
    #[error("{context}: {source}")]
    QueryFailed { context: String, #[source] source: rusqlite::Error },
    #[error("{entity} not found: {id}")]
    NotFound { entity: String, id: String },
    #[error("constraint violation: {0}")]
    ConstraintViolation(String),
    #[error("migration failed: {0}")]
    MigrationFailed(String),
    #[error("validation error: {0}")]
    Validation(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}
```

**迁移策略**（分 5 批，每批一个 PR，降低 review 和回归定位成本）：

1. **Batch A — sessions**：`sessions.rs`（~10 个函数）
2. **Batch B — rules CRUD**：`rules.rs` 中 rewrite/map/throttle/breakpoint/dns/script 的 save/load/delete 函数（~20 个）
3. **Batch C — rules runs**：`rules.rs` 中 replace_runs/load_runs/load_entries 的 trace/run 记录函数（~14 个）
4. **Batch D — 管理功能**：`collections.rs`（~12 个）+ `workspaces.rs`（~5 个）+ `environments.rs`（~8 个）
5. **Batch E — 其余**：`insights.rs` + `body_store.rs` + `ai.rs` + `connection.rs` + `schema.rs`

**关键决策 — Tauri 边界转换**：

`From<DbError> for String` 仅做 `DbError::to_string()`，**不会**自动产生 `app_error()` 的 JSON 结构化格式。正确做法：

- db crate 内部全部返回 `Result<T, DbError>`
- Tauri command 边界**显式** `map_err`：`.map_err(|e| app_error(ERR_INTERNAL, format!("...: {e}")))`，或新增 `db_app_error(context, DbError)` helper
- **禁止**依赖 `From<DbError> for String` 的隐式转换来桥接 Tauri 边界——那会丢失结构化错误码

**验证**：每个 batch 完成后运行 `cargo test -p aiproxy-db` + `cargo build`

---

## 阶段 4：前端改进（#32 → #31 → #33）

### 4.1 #32 补齐 throttling + compare 页面 i18n 硬编码

**范围**：4 个文件，~10 处改动

**文件**：

- `apps/desktop/src/pages/throttling/index.tsx` — 8 处硬编码字符串
- `apps/desktop/src/pages/compare/index.tsx` — 2 处硬编码字符串（`"Avg duration"`、`"Total bytes"`）
- `apps/desktop/src/i18n/messages/en.ts` — 新增 key
- `apps/desktop/src/i18n/messages/zh-CN.ts` — 新增翻译

**throttling 硬编码字符串清单**：

- `"Targeted rule"` / `"Any"` → `t("throttling.ruleType.targeted")` / `t("throttling.ruleType.any")`
- `"Hits"` / `"Drops"` / `"Delay"` → `t("throttling.param.hits")` 等
- `"Profiles"` / `"Rules"` → `t("throttling.tab.profiles")` / `t("throttling.tab.rules")`
- `"Any method"` → `t("throttling.anyMethod")`
- `"GET, POST, PUT"` → `t("throttling.methodPlaceholder")`

**compare 硬编码字符串清单**：

- `"Avg duration"` → `t("compare.metric.avgDuration")`
- `"Total bytes"` → `t("compare.metric.totalBytes")`

**验证**：`pnpm --filter @aiproxy/desktop lint` + 切换中英文查看

### 4.2 #31 拆分大型前端页面

**模式参考**：`pages/sessions/` — 9 个自定义 hook + 16 个提取组件

按页面逐个拆分，每个页面一个 PR：

#### Collections（1,573 → 目标 ~400）

- `features/collections/use-collection-tree.ts` — DnD 状态、spring-load 文件夹、光标追踪
- `features/collections/use-collection-editor.ts` — 编辑器状态、环境变量、split ratio 持久化
- `features/collections/components/CollectionTreePane.tsx` — 树视图面板
- `features/collections/components/CollectionEditorPane.tsx` — 编辑器面板

#### Compare（1,441 → 目标 ~350）

- `features/session-compare/use-session-compare.ts` — scope 选择、AI summary mutation、diff payload 计算
- `features/session-compare/components/DiffSectionCard.tsx` — diff 卡片（~130 行）
- `features/session-compare/components/AiSummaryPanel.tsx` — AI 摘要面板（~170 行）
- `features/session-compare/components/SessionCompareWorkbench.tsx` — 工作区（~120 行）

#### Insights（1,258 → 目标 ~350）

- `features/insights/compute-insights.helpers.ts` — 纯数据转换（~90 行）
- `features/insights/use-insights-data.ts` — compute + debounce + filter 逻辑
- `features/insights/components/HostContextMenu.tsx` — 主机右键菜单（~130 行）

#### Throttling（1,042 → 目标 ~300）

- `features/throttling/use-throttle-editor.ts` — CRUD handlers、form state、临时启用逻辑
- `features/throttling/components/ProfileEditor.tsx` — 配置编辑器（~111 行）
- `features/throttling/components/RuleEditor.tsx` — 规则编辑器（~135 行）

**验证**：每个页面拆分后运行 `pnpm --filter @aiproxy/desktop lint` + `pnpm --filter @aiproxy/desktop test` + 手动功能测试

### 4.3 #33 补充核心 Store 单元测试

**范围**：2-3 个新测试文件

**模式参考**：`session-container.store.test.ts`（221 行，14 个用例）— 直接操作 store state，无 React 渲染

**新测试文件**：

- `features/compose/compose-editor.store.test.ts` — 测试 `loadFromSession`、content-type 推断、form state reset
- `features/collections/collection-editor.store.test.ts` — 测试 `loadFromItem`、URL-encoded 解析、迁移逻辑
- 扩展 `sessions/session-container.store.test.ts` — 补充 edge case：并发 upsert、大量 seed 性能

**验证**：`pnpm --filter @aiproxy/desktop test`

---

## 执行顺序与分支策略

```text
feat/p3-phase1a  ← #30 format! 修复
feat/p3-phase1b  ← #29 ProxyError 外层收口
feat/p3-phase1c  ← #34 列表查询错误防回归审计（含单测）
feat/p3-phase2a  ← #27 rule-engine 拆分（纯移动）
feat/p3-phase2b  ← #25 http_proxy WS 瘦身（纯移动）
feat/p3-phase2c  ← #26 server 模块化（纯移动）
feat/p3-phase3a  ← #28 DbError Batch A — sessions
feat/p3-phase3b  ← #28 DbError Batch B — rules CRUD
feat/p3-phase3c  ← #28 DbError Batch C — rules runs
feat/p3-phase3d  ← #28 DbError Batch D — collections + workspaces + environments
feat/p3-phase3e  ← #28 DbError Batch E — 其余
feat/p3-phase4a  ← #32 throttling + compare i18n
feat/p3-phase4b  ← #31 collections 页面拆分
feat/p3-phase4c  ← #31 compare 页面拆分
feat/p3-phase4d  ← #31 insights 页面拆分
feat/p3-phase4e  ← #31 throttling 页面拆分
feat/p3-phase4f  ← #33 Store 测试
```

**每个分支的验证命令**（按改动范围选择）：

- Rust 改动（phase1/2/3）：`cargo build` + 对应 crate 的 `cargo test -p <crate>` + `pnpm --filter @aiproxy/desktop typecheck`
- 前端改动（phase4）：`pnpm --filter @aiproxy/desktop lint` + `pnpm --filter @aiproxy/desktop typecheck` + `pnpm --filter @aiproxy/desktop test`
- 合并到 `dev` 前全量 gate：`cargo test` + `pnpm lint` + `pnpm typecheck`

---

## 文档同步

完成后需更新的文档：

- `docs/ARCHITECTURE_REVIEW.md` — 更新 P3 各项状态为已完成，更新评分
- `docs/ARCHITECTURE.md` — 更新模块结构描述（如有新模块文件）
- `docs/ENGINEERING_GUIDELINES.md` — 补充 `DbError` 使用规范

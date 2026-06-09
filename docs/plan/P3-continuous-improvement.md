# P3 持续改进 — 完成记录

## 状态

- 状态：已完成
- 完成日期：2026-06-09
- 范围：#25-#34 全部完成
- 当前分支：`feat/p3-phase4b`

P3 是 P0 安全基线、P1 架构治理、P2 工程规范之后的最后一轮持续改进，目标是降低维护热点、统一错误处理、补齐 i18n 与测试薄弱点。该计划已完成，本文档保留实施结果、当前代码结构和后续约束，避免计划文档与代码状态漂移。

## 完成清单

| # | 改进项 | 结果 |
|---|--------|------|
| 25 | 瘦身 `http_proxy.rs`，抽出 WebSocket upgrade 逻辑 | 已完成：新增 `crates/proxy-core/src/ws_upgrade.rs` |
| 26 | 瘦身 `server.rs`，抽出 upstream/connect 逻辑 | 已完成：新增 `crates/proxy-core/src/upstream.rs` 和 `crates/proxy-core/src/connect.rs` |
| 27 | 拆分 `rule-engine` monolithic | 已完成：拆为 `types.rs` / `compile.rs` / `execute.rs` / `js_bridge.rs`，`lib.rs` 保留导出与测试 |
| 28 | 为 `db` crate 引入 `DbError` | 已完成：新增 `crates/db/src/error.rs`，公共 DB API 迁移到 `Result<_, DbError>` |
| 29 | 将 `ProxyError` 扩展到代理外层函数 | 已完成：`handle_connection` / `handle_connect_mitm` 等外层路径使用结构化代理错误 |
| 30 | 修复 Tauri commands 原始错误字符串 | 已完成：AI / rules 等路径使用 `app_error()` / `app_error_with_details()` |
| 31 | 拆分大型前端页面 | 已完成：collections / compare / insights / throttling 提取 hooks/helpers/components |
| 32 | 补齐 throttling / compare i18n 硬编码 | 已完成：中英文消息表已补齐相关 key |
| 33 | 补充核心 Store 单元测试 | 已完成：新增 compose、collections store 测试，并扩展 session container edge cases |
| 34 | 审查列表查询错误传播 | 已完成：DB row decode 错误不再被 `filter_map(|r| r.ok())` 静默吞掉 |

## 当前代码结构

### proxy-core

P3 后 `proxy-core` 的代理热路径拆分如下：

```text
crates/proxy-core/src/
├── http_proxy.rs     # hyper Service 与共享 HTTP 请求管线
├── ws_upgrade.rs     # WebSocket upgrade、101/非 101 响应处理、WS relay 建立
├── server.rs         # 监听启动、连接入口、CONNECT 解析、直接请求入口
├── upstream.rs       # 上游请求转发、响应读取、body spool helper
├── connect.rs        # CONNECT blind relay、MITM TLS、CONNECT 相关 response head 读取
├── connection.rs     # ConnectionContext / ConnectionMode
├── error.rs          # ProxyError
└── upstream_pool.rs  # HTTP/2 上游连接池
```

当前关键文件规模：

| 文件 | 行数 |
|------|------|
| `http_proxy.rs` | ~1,648 |
| `server.rs` | ~744 |
| `ws_upgrade.rs` | ~684 |
| `upstream.rs` | ~485 |
| `connect.rs` | ~509 |

### rule-engine

`aiproxy-rule-engine` 已从单文件拆成职责清晰的模块：

```text
crates/rule-engine/src/
├── lib.rs        # mod 声明、pub use、测试
├── types.rs      # 脚本规则、trace、hook 输入输出类型
├── compile.rs    # TypeScript 转译、导出校验、entrypoint 检测
├── execute.rs    # QuickJS 沙箱执行、request/response hook
└── js_bridge.rs  # JS host bridge 与 runtime module 构造
```

### db

`crates/db` 已引入结构化错误类型：

- `DbError::Connection`
- `DbError::QueryFailed`
- `DbError::NotFound`
- `DbError::ConstraintViolation`
- `DbError::MigrationFailed`
- `DbError::Validation`
- `DbError::Io`

约束：

- db crate 内部公共 API 使用 `Result<T, DbError>`。
- 列表查询必须传播 row decode 错误，禁止用 `.filter_map(|r| r.ok())` 丢弃坏行。
- Tauri command 边界必须显式转换为 `app_error(ERR_INTERNAL, ...)`，禁止依赖 `DbError::to_string()` 直接作为用户可见错误。

### 前端页面拆分

P3 后页面文件规模已下降：

| 页面 | 当前行数 | 主要提取内容 |
|------|----------|--------------|
| `pages/collections/index.tsx` | ~617 | `use-collection-tree.ts`、`CollectionTreePane`、`CollectionEditorPane`、pane helpers |
| `pages/compare/index.tsx` | ~238 | `use-session-compare.ts`、`DiffSectionCard`、`AiSummaryPanel`、`SessionCompareWorkbench` |
| `pages/insights/index.tsx` | ~636 | `compute-insights.helpers.ts`、`use-insights-data.tsx`、`HostContextMenu` |
| `pages/throttling/index.tsx` | ~431 | `use-throttle-editor.ts`、`ProfileEditor`、`RuleEditor`、`EditorHeader` |

## 验证记录

P3 完成后已验证：

- `cargo fmt --check`
- `cargo test -p aiproxy-db`
- `cargo test -p aiproxy-proxy-core`
- `pnpm --filter @aiproxy/desktop typecheck`
- `pnpm --filter @aiproxy/desktop test`

最近一次复审结果：

- `cargo fmt --check` 通过
- `cargo test -p aiproxy-db` 通过，63 tests
- `pnpm --filter @aiproxy/desktop typecheck` 通过
- `pnpm --filter @aiproxy/desktop test` 通过，36 files / 267 tests

## 后续维护约束

- 不允许把 `ws_upgrade.rs`、`upstream.rs`、`connect.rs` 的职责重新合回 `http_proxy.rs` 或 `server.rs`。
- 不允许把 `rule-engine` 的类型、编译、执行、JS bridge 重新堆回单个 `lib.rs`。
- 新增 DB 查询时必须传播 prepare/query/row decode 三类错误。
- 新增 Tauri command 用户可见错误必须使用 `app_error()` 或 `app_error_with_details()`。
- 新增大型页面功能时优先扩展 `features/<domain>/` 的 hook/helper/component，不把状态流程堆回 `pages/<domain>/index.tsx`。
- 文档同步入口：`docs/ARCHITECTURE.md`、`docs/ARCHITECTURE_REVIEW.md`、`docs/ENGINEERING_GUIDELINES.md`。

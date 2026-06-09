# AIProxy 架构审查报告

> 审查日期：2026-06-09（P3 持续改进完成后同步）
> 审查范围：整体架构设计、前端代码质量、Rust 核心代码质量、API 契约与类型安全、跨横切关注点
> 代码快照：`feat/p3-phase4b`，P3 #25-#34 已完成

---

## 总体健康度：A（工程基础稳固，持续改进闭环）

AIProxy 已完成 P0 安全基线、P1 架构治理、P2 工程规范和 P3 持续改进。P3 重点解决了维护热点文件、DB 结构化错误、rule-engine 单文件、前端大型页面、i18n 缺口和 Store 测试薄弱点。项目当前进入“文档与代码同步、按功能小步演进”的维护阶段。

### 代码规模一览

| 指标 | 当前状态 |
|------|----------|
| Rust crates | 4 个（proxy-core / db / rule-engine / tls-manager） |
| Rust 测试函数 | 207 个左右 |
| 前端源码文件 | 218 个 `.ts/.tsx` |
| 前端测试文件 | 36 个 |
| Tauri commands | 80+ |
| DB 公共 API 错误类型 | `Result<T, DbError>` |
| Tauri 用户可见错误格式 | `app_error()` / `app_error_with_details()` JSON 载荷 |

---

## 五大维度评分

| 维度 | 评分 | 说明 |
|------|------|------|
| 整体架构设计 | **A** | 四层分离清晰，proxy-core / db / rule-engine 职责边界已进一步收敛 |
| 前端代码质量 | **A** | 大型页面已拆分为 hooks/helpers/components，i18n 缺口已补齐 |
| Rust 核心代码 | **A** | proxy-core 热点文件已瘦身，db 引入 `DbError`，rule-engine 已模块化 |
| API 契约与类型安全 | **A** | 三层同构继续保持，命令错误格式结构化，列表查询错误可感知 |
| 跨横切关注点 | **A-** | 安全、日志、错误、测试基线稳固；仍需持续补前端场景测试 |

---

## 一、整体架构设计

### 核心优势

1. **四层分离清晰**：React/MUI/Zustand 表现层、Tauri commands/events 接入层、Rust crates 领域服务层、SQLite/文件系统基础设施层。
2. **代理核心与 UI 完全解耦**：`proxy-core` 纯 Rust 实现，不依赖 Tauri 或前端类型。
3. **Crate 依赖图为 DAG**：`proxy-core -> rule-engine`、`proxy-core -> tls-manager`，`db` 独立。
4. **代理热路径模块化**：`http_proxy.rs` 保留 hyper Service 和共享请求管线，WS、CONNECT、upstream 已拆出独立模块。
5. **rule-engine 职责拆分**：类型、编译、执行、JS bridge 已分离，避免脚本能力扩展时继续膨胀单文件。
6. **Bootstrap 边界清晰**：repository/cache/converters/events 与 AppState 编排职责分离。

### P3 后关键结构

| 模块 | 当前结构 |
|------|----------|
| proxy-core HTTP 管线 | `http_proxy.rs` |
| WebSocket upgrade | `ws_upgrade.rs` |
| CONNECT / MITM | `connect.rs` |
| 上游转发与 body spool | `upstream.rs` |
| rule-engine | `types.rs` / `compile.rs` / `execute.rs` / `js_bridge.rs` |
| db 错误 | `error.rs` 中的 `DbError` |

---

## 二、前端代码质量

### 已完成改进

- `collections`、`compare`、`insights`、`throttling` 页面已按页面布局、hook 状态流程、helper 纯计算、component 视图拆分。
- `compare` 与 `throttling` 页面硬编码英文已迁移到 i18n 消息表。
- `compose-editor.store`、`collection-editor.store` 和 `session-container.store` 增加单元测试覆盖。
- 页面文件规模已明显下降：

| 页面 | 当前行数 |
|------|----------|
| `pages/collections/index.tsx` | ~617 |
| `pages/compare/index.tsx` | ~238 |
| `pages/insights/index.tsx` | ~636 |
| `pages/throttling/index.tsx` | ~431 |

### 仍需持续关注

- `features/sessions/` 仍是前端最大功能域，后续新增 Inspector 能力时应继续拆分子组件和 helper。
- 前端测试文件已增至 36 个，但复杂 UI 交互仍应在后续功能迭代中补充集成测试。

---

## 三、Rust 核心代码质量

### 已完成改进

- `http_proxy.rs` 从约 2,315 行降至约 1,648 行；WebSocket upgrade 独立到 `ws_upgrade.rs`。
- `server.rs` 从约 1,714 行降至约 744 行；upstream 与 connect 路径独立。
- `rule-engine` 从单文件 1,178 行拆为 5 个职责模块。
- `db` crate 公共 API 已从 `Result<_, String>` 迁移到 `Result<_, DbError>`。
- DB 列表查询不再用 `.filter_map(|r| r.ok())` 静默丢弃 row decode 错误。
- `compute_insights()` 的 host P95 子查询错误会传播为 `DbError`，不再静默返回错误统计值。

### 错误处理现状

| 层级 | 当前约束 |
|------|----------|
| `db` crate | 公共 API 返回 `Result<T, DbError>` |
| `proxy-core` 主流程 | 代理主链路优先使用 `ProxyError` |
| Tauri commands | 用户可见错误使用 `app_error()` / `app_error_with_details()` |
| 前端 | `coerceAppError()` 统一解析命令错误 |

---

## 四、API 契约与类型安全

### 核心优势

- Rust commands、前端 command client、shared-types 三层同构继续保持。
- 前端仍采用 `invoke<unknown>() + parse` 的边界校验模式。
- Tauri command 错误载荷统一为 JSON 字符串，包含 `code` 和 `message`，必要时包含 `details`。
- 列表查询失败会返回 `Err`，前端可区分“空状态”和“查询失败”。

### 维护要求

- 新增 command 时必须同步 Rust payload、前端 parser、shared-types 和 `docs/API_SPEC.md`。
- 新增用户可见错误不得返回裸字符串。
- 新增 DB 列表查询必须覆盖 prepare/query/row decode 错误传播。

---

## 五、跨横切关注点

### 安全性

- SQL 查询使用参数化 API。
- Body store 保持路径遍历防护。
- QuickJS 脚本沙箱保持 16MB 内存限制和 50ms 超时。
- CSP、Cargo.lock、ErrorBoundary、敏感字段脱敏均已建立基线。

### 测试与验证

P3 完成后已验证：

- `cargo fmt --check`
- `cargo test -p aiproxy-db`
- `cargo test -p aiproxy-proxy-core`
- `pnpm --filter @aiproxy/desktop typecheck`
- `pnpm --filter @aiproxy/desktop test`

最近一次复审验证：

- `cargo fmt --check` 通过
- `cargo test -p aiproxy-db` 通过，63 tests
- `pnpm --filter @aiproxy/desktop typecheck` 通过
- `pnpm --filter @aiproxy/desktop test` 通过，36 files / 267 tests

---

## 改进路线图状态

### ✅ P0 — 安全与稳定性

已完成。

### ✅ P1 — 代码质量与架构治理

已完成。

### ✅ P2 — 工程规范

已完成。

### ✅ P3 — 持续改进

| # | 改进项 | 状态 |
|---|--------|------|
| 25 | 瘦身 `http_proxy.rs`，抽出 WS upgrade | ✅ 已完成 |
| 26 | 瘦身 `server.rs`，抽出 upstream/connect | ✅ 已完成 |
| 27 | 拆分 `rule-engine` monolithic | ✅ 已完成 |
| 28 | 为 `db` crate 引入 `DbError` | ✅ 已完成 |
| 29 | 将 `ProxyError` 扩展到外层函数 | ✅ 已完成 |
| 30 | 修复 Tauri commands 原始错误字符串 | ✅ 已完成 |
| 31 | 拆分大型前端页面 | ✅ 已完成 |
| 32 | 补齐 throttling / compare i18n | ✅ 已完成 |
| 33 | 补充核心 Store 单元测试 | ✅ 已完成 |
| 34 | 审查列表查询错误传播 | ✅ 已完成 |

---

## 当前风险 Top 5

1. **前端复杂交互测试仍需持续补强**：P3 增加 Store 测试，但页面级复杂流程仍需要后续按功能补充。
2. **`features/sessions/` 仍是最大功能域**：后续新增 Inspector 能力时必须继续控制组件边界。
3. **Insights 大数据性能仍需关注**：当前聚合查询已结构化错误传播，后续大量会话场景可继续优化 host P95 计算和索引策略。
4. **proxy-core 仍是高复杂度核心**：虽然已拆模块，新增协议/规则能力仍需严格遵守模块边界。
5. **文档同步是持续风险**：P3 后结构变化较多，后续改动必须同步架构、API 和工程规范。

---

## 结论

AIProxy 当前整体健康度为 **A**。

P3 完成后，原先阻碍持续维护的主要问题已经闭环：代理热点文件瘦身、rule-engine 模块化、db 结构化错误、Tauri 错误边界统一、前端大型页面拆分、i18n 与 Store 测试补强。后续重点不再是大规模治理，而是保持边界、补齐场景测试、按功能小步演进。

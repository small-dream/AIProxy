# AIProxy 架构审查报告

> 审查日期：2026-06-08（第二轮全量重新生成）
> 审查范围：整体架构设计、前端代码质量、Rust 核心代码质量、API 契约与类型安全、跨横切关注点
> 审查基准：顶级架构师标准，面向生产级桌面代理调试工具
> 代码快照：dev 分支 `73c6c39`（Phase 6 Windows 接口枚举 + proptest 合入后）

---

## 总体健康度：A（工程基础稳固，进入可持续演进阶段）

AIProxy 当前架构健康度优秀。P0 安全基线、P1 代码质量与架构治理、以及多项 P2 工程规范改进均已闭环。代理核心与 UI 完全解耦、三层同构命令架构执行到位、跨平台适配覆盖三端。项目从"快速迭代"进入"工程基础扎实、可持续交付"的成熟阶段。

### 代码规模一览

| 指标 | 数据 |
|------|------|
| Rust crates | 4 个（proxy-core / db / rule-engine / tls-manager） |
| Rust 代码行 | 20,430 行（44 个 `.rs` 文件） |
| Rust 测试函数 | 202 个（182 `#[test]` + 20 `#[tokio::test]`） |
| 前端代码行 | 47,835 行（195 个 `.ts/.tsx` 文件） |
| 前端测试文件 | 34 个（文件覆盖率 17.4%） |
| Tauri commands | 84 个 `#[tauri::command]` |
| 前端 invoke 调用 | 63 个 `invoke<>()` 调用 |
| 共享类型模块 | 15 个域名模块（3,592 行） |
| i18n 消息行 | 中英各 ~1,400 行 |

---

## 五大维度评分

| 维度 | 评分 | 说明 |
|------|------|------|
| 整体架构设计 | **A** | 四层分离清晰，Crate 依赖图为 DAG，规则管线阶段化，Bootstrap 已拆分 |
| 前端代码质量 | **A-** | 零 `as any`，类型纪律优秀，i18n 覆盖广，但大型页面仍需瘦身 |
| Rust 核心代码 | **A-** | 无危险 unwrap/panic，SQL 全参数化，但错误类型统一未完成 |
| API 契约与类型安全 | **A** | 三层同构执行到位，84 command 全覆盖，JSON 结构化错误 98% 一致 |
| 跨横切关注点 | **A-** | CSP/Cargo.lock/ErrorBoundary 已到位，测试覆盖前端偏弱 |

---

## 一、整体架构设计（A）

### 核心优势

1. **四层分离清晰**：表现层（React + MUI + Zustand）→ 桌面接入层（Tauri commands/events）→ 领域服务层（Rust crates）→ 基础设施层（SQLite + 文件系统）
2. **三层同构原则执行到位**：Rust 命令层 `commands/<domain>.rs`（16 文件）、前端命令客户端 `services/commands/<domain>.ts`（16 文件）、共享类型 `shared-types/src/<domain>.ts`（15 文件）三层一一对应
3. **代理逻辑与 UI 完全解耦**：`proxy-core` 不依赖 Tauri、不依赖前端类型，纯 Rust 实现——这是最重要的架构成就
4. **Crate 依赖图为 DAG**：`proxy-core → rule-engine`，`proxy-core → tls-manager`，`db` 完全独立，无循环依赖
5. **平台差异隔离到位**：`system_proxy` 按 `windows.rs/macos.rs/linux.rs` 拆分；`proxy-core/types` 按 `types_unix.rs/types_windows.rs` 委托
6. **规则引擎管线设计**：请求链 `Rewrite → Map → Script → Breakpoint → Throttle → Upstream`，阶段独立可扩展
7. **Bootstrap 边界原则已落地**：`repository.rs`（750 行）/ `cache.rs`（315 行）/ `converters.rs`（490 行）/ `events.rs`（22 行）职责清晰

### 关键问题

| # | 问题 | 影响 | 优先级 |
|---|------|------|--------|
| A1 | **`http_proxy.rs` 仍为最大文件**（2,315 行）：包含 hyper Service、请求/响应管线、WS upgrade、断点/改写/脚本集成等多条主线 | 维护压力集中在单文件 | P2 |
| A2 | **`server.rs` 偏大**（1,714 行）：连接管理、MITM、blind tunnel、WSS upgrade、内建端点等职责共存 | 同上 | P2 |
| A3 | **`rule-engine` 单文件架构**（1,178 行 monolithic）：类型定义、编译、执行、JS bridge、测试全部交织在一个 `lib.rs` 中 | 维护困难、新人理解成本高 | P2 |
| A4 | **`db` crate 无结构化错误类型**：全部 89 个公共函数返回 `Result<_, String>`，错误上下文丢失 | 调用方无法程序化匹配错误 | P3 |
| A5 | **大型前端页面未拆分**：`collections/index.tsx`（1,573 行）、`compare/index.tsx`（1,441 行）、`insights/index.tsx`（1,258 行）、`throttling/index.tsx`（1,042 行）均为巨型页面文件 | 维护困难、状态管理复杂 | P2 |

### 改进建议

- **A1/A2**：将 `http_proxy.rs` 中的 WS upgrade 路径和响应构建逻辑抽为独立模块；`server.rs` 中 blind tunnel 和内建端点可以独立
- **A3**：将 `rule-engine` 拆分为 `types.rs`、`compile.rs`、`execute.rs`、`js_bridge.rs`
- **A4**：为 `db` crate 引入 `DbError` enum（类似 `ProxyError`/`TlsManagerError`），渐进迁移
- **A5**：沿用 `SessionsPage` hooks 拆分模式，将大型页面拆为 hooks + 子组件

---

## 二、前端代码质量（A-）

### 核心优势

1. **零 `any` 使用**：TypeScript 类型纪律优秀，无 `as any`、`@ts-ignore`、`@ts-nocheck`
2. **`invoke<unknown>()` + parse 模式**：Tauri 命令层做运行时边界校验，不信任后端返回值
3. **i18n 类型安全**：递归 `DotPath<T>` 从消息结构自动推导翻译 key，中英消息各 ~1,400 行
4. **Zustand store 设计清晰**：helper 纯函数提取充分，不可变更新模式一致
5. **性能优化到位**：路由懒加载 + 事件批量处理(100ms 缓冲) + RAF 节流
6. **ErrorBoundary 双层保护**：全局级（`App.tsx`）+ 路由级（`router/index.tsx`）
7. **代码组织优秀**：13 个 feature 目录与业务域高度对应

### 前端模块规模分布

| 模块 | 代码行 | 占比 |
|------|--------|------|
| `features/sessions/` | 18,312 | 38.3% |
| `features/rules/` | 3,361 | 7.0% |
| `features/breakpoints/` | 2,099 | 4.4% |
| `features/collections/` | 1,219 | 2.5% |
| `features/session-compare/` | 1,197 | 2.5% |
| `features/compose/` | 814 | 1.7% |
| `pages/`（页面文件） | 9,795 | 20.5% |
| `i18n/` | 4,631 | 9.7% |
| `services/` | ~3,500 | 7.3% |
| 其余 | ~2,907 | 6.1% |

### 关键问题

| # | 问题 | 影响 | 优先级 |
|---|------|------|--------|
| F1 | **大型页面文件**：`collections`（1,573）、`compare`（1,441）、`insights`（1,258）、`throttling`（1,042）、`settings`（876）均超过 800 行合理上限 | 维护困难 | P2 |
| F2 | **i18n 覆盖不完整**：`pages/throttling/index.tsx` 存在 `"Any"`、`"Targeted rule"`、`"Hits"`、`"Drops"` 等硬编码英文；`pages/compare/index.tsx` 存在 `"Avg duration"`、`"Total bytes"` 等未翻译文案 | 国际化缺口 | P2 |
| F3 | **Store 测试薄弱**：`session-container.store.test.ts` 仅覆盖 legacy 方法；`compose-editor.store`、`collection-editor.store` 等核心 store 缺少测试 | 回归风险 | P2 |
| F4 | **`features/sessions/` 体积过大**（64 文件、18,312 行，占前端 38%）：虽然功能最核心，但 Inspector 子组件仍有持续拆分空间 | 维护集中 | P3 |

### 改进建议

- **F1**：按页面维度逐步拆分，优先处理 `collections` 和 `insights`（结构相对规整）
- **F2**：在下次涉及相关页面改动时同步补齐 i18n，无需单独专项
- **F3**：为 `seedSessions`、`upsertSummary`、`addContainer` 等核心操作补充单元测试

---

## 三、Rust 核心代码质量（A-）

### 各 Crate 评分

| Crate | 代码行 | 测试函数 | 评分 |
|-------|--------|----------|------|
| proxy-core | 12,614 | ~95 | A- |
| db | 5,473 | ~65 | B+ |
| tls-manager | 1,165 | 14 | A- |
| rule-engine | 1,178 | 11 | B+ |

### 核心优势

1. **无危险 unwrap/panic**：生产代码中的 `unwrap()` 全部用于编译期常量（如 `NonZeroUsize::new(512).unwrap()`、hardcoded regex `OnceLock`）；`panic!` 仅 1 处且在 `#[cfg(test)]` 块内
2. **并发模式成熟**：`UpstreamConnectionPool` 使用 `RwLock` + `watch` channel 解决 thundering herd；连接数限制使用 `Semaphore`（上限 1024）
3. **大 body 自动 spool 到磁盘**：超过 20MB 写入临时文件避免 OOM
4. **HTTP/2 连接池复用**：`upstream_pool.rs` 维护 h2 连接池，后台 evict timer 定期清理
5. **unsafe 使用极少且安全**：全部集中在 FFI 边界（`getifaddrs`），有完整 SAFETY 注释
6. **Script 沙箱设计完备**：QuickJS + 50ms 超时 + 16MB 内存限制 + `AtomicBool` 中断 + 独立线程执行
7. **SQL 注入防护完善**：db crate 全部使用 `rusqlite::params!` 参数化查询（75+ 处）
8. **路径遍历防护**：`body_store.rs` 的 `validate_safe_segment` + `canonicalize` 双重校验
9. **结构化错误已建立基线**：`ProxyError`（8 variants）+ `TlsManagerError`（4 variants）+ `app_error()`/`app_error_with_details()` helper
10. **Windows 网络接口枚举已实现**：`types_windows.rs` 通过 PowerShell `Get-NetIPAddress` 枚举 IPv4 地址

### 错误类型分布

| Crate | 结构化错误 | `Result<_, String>` | 统一率 |
|-------|-----------|---------------------|--------|
| proxy-core | 16 处 `ProxyError` | 43 处 `String` | 27% |
| db | 0 | 89 处 | 0% |
| rule-engine | 0 | 6 处 | 0% |
| tls-manager | 全部 `TlsManagerError` | 0 | 100% |
| Tauri commands | 120+ `app_error()` | 2 处 `format!()` | ~98% |

### 关键问题

| # | 问题 | 影响 | 优先级 |
|---|------|------|--------|
| R1 | **`db` crate 全量 `Result<_, String>`**：89 个函数无结构化错误类型，错误上下文在 `format!` 中丢失 | 无法程序化匹配、日志排查困难 | P3 |
| R2 | **`proxy-core` 错误类型混合**：`forward_request()` 使用 `ProxyError`，但 `handle_connection()`/`handle_connect_mitm()` 等外层仍为 `String`，结构化信息在边界丢失 | 错误链断裂 | P3 |
| R3 | **`rule-engine` 单文件 monolithic**：1,178 行含类型、编译、执行、JS bridge 和测试，可读性和可维护性受限 | 维护成本高 | P2 |
| R4 | **Tauri commands 2 处原始 `format!` 错误**：`rules.rs:656` 和 `ai.rs:266` 绕过 `app_error()` helper | 前端 `coerceAppError` 无法提取错误码 | P3 |

### 改进建议

- **R1**：引入 `DbError` enum（`NotFound` / `QueryFailed` / `ConstraintViolation` / `MigrationFailed`），渐进迁移高频查询路径
- **R2**：将 `ProxyError` 从 `forward_request` 扩展到 `handle_connection`、`handle_connect_mitm`、`tunnel_blind_relay` 等外层函数
- **R3**：将 `rule-engine/lib.rs` 拆为 `types.rs` + `compile.rs` + `execute.rs` + `js_bridge.rs`
- **R4**：将 2 处 `format!()` 替换为 `app_error(ERR_INVALID_INPUT, ...)`

---

## 四、API 契约与类型安全（A）

### 核心优势

1. **命令层覆盖完整**：Rust 侧 84 个 `#[tauri::command]`，前端 63 个 `invoke<>()` 调用，按 16 个业务域分文件组织
2. **三层同构严格对齐**：`commands/<domain>.rs` ↔ `services/commands/<domain>.ts` ↔ `shared-types/src/<domain>.ts`，新增业务域必须同步建立
3. **完整 type guard 体系**：每个核心类型都有 `isXxx()`/`parseXxx()` 运行时校验
4. **serde camelCase 统一**：Rust DTO 与前端 TypeScript 命名完全一致
5. **事件批处理设计成熟**：6 个实时事件通道，`session-upsert` 通过 100ms 缓冲窗口批量合并
6. **Tauri command 结构化错误 98% 一致**：`app_error()`/`app_error_with_details()` 统一 JSON 格式，前端 `coerceAppError` 兼容处理
7. **共享类型测试覆盖**：`shared-types/src/index.test.ts`（666 行）提供类型守卫和解析函数的回归测试

### 关键问题

| # | 问题 | 影响 | 优先级 |
|---|------|------|--------|
| C1 | **2 处原始 `format!` 错误**：`commands/rules.rs` 和 `commands/ai.rs` 绕过 `app_error()` | 前端无法提取错误码 | P3 |
| C2 | **列表查询命令静默返回空数组**（历史问题，已部分治理）：部分列表查询出错时不抛异常，前端无法区分"无数据"和"查询失败" | 静默失败 | P3 |

### 改进建议

- **C1**：将 2 处 `format!()` 替换为 `app_error()` 调用
- **C2**：全面审查列表查询命令，确保出错时返回 `Result::Err` 而非空 Vec

---

## 五、跨横切关注点（A-）

### 错误处理 — A-

- **前端**：`coerceAppError` 统一处理 `string | Error | AppError` → `AppError`，`reportCommandFailure` 记录日志；ErrorBoundary 双层保护
- **Rust proxy-core**：`ProxyError` 8 variants 已建立基线，`forward_request` 热路径已迁移，外层函数待推进
- **Rust Tauri 层**：`app_error()`/`app_error_with_details()` helper + 4 个标准错误码常量（`PROXY_NOT_RUNNING` / `INVALID_INPUT` / `CERT_NOT_FOUND` / `INTERNAL_ERROR`），120+ 处调用
- **Rust db/rule-engine**：仍为 `String` 错误，待引入结构化类型

### 安全性 — A

- ✅ SQL 注入防护：全部 `rusqlite::params!` 参数化查询
- ✅ 路径遍历防护：`body_store.rs` 的 `validate_safe_segment` + `canonicalize`
- ✅ 敏感数据脱敏：`redaction.helpers.ts` 对 authorization/cookie/token 自动 REDACTED
- ✅ 脚本沙箱：50ms 超时 + 16MB 内存限制 + `AtomicBool` 中断 + 独立线程 + 日志 8KB 截断
- ✅ 无硬编码密钥或凭证
- ✅ unwrap/panic 使用极为克制（生产代码仅用于编译期常量）
- ✅ CSP 策略已配置：生产限制 script/style 为 `'self'`，`connect-src` 锁定 `ipc://localhost` / `tauri://localhost`
- ✅ Cargo.lock 已追踪（不在 `.gitignore` 内，181KB）

### 测试策略 — B+

| 指标 | 数据 |
|------|------|
| Rust 源文件 | 44 个 |
| 含测试的 Rust 文件 | 26 个（覆盖率 59%） |
| Rust 测试函数 | 202 个 |
| Rust 测试代码 | ~3,000 行 |
| 前端源文件 | 195 个 |
| 前端测试文件 | 34 个（文件覆盖率 17.4%） |
| 属性测试 | `proptest` 已引入 proxy-core 和 db |

- Rust 测试质量高，proxy-core 95 个测试覆盖核心代理链路
- `proptest` 属性测试已引入（Phase 6），适用于 URL pattern、JSON 边界等场景
- 前端测试覆盖不足，尤其核心 Store 操作和大型页面组件
- 性能基准测试框架（criterion）覆盖 `body_decompress`
- CI 流水线已建立（`.github/workflows/ci.yml` + `release.yml`）

### 依赖健康度 — B+

- ✅ Rust 依赖选择合理：hyper 1.x + rustls 0.23 + tokio 1.x + QuickJS + deno_ast
- ✅ 无已知废弃或高危依赖
- ⚠️ 同时使用 reqwest 和 hyper 增加编译时间和二进制体积（已由 ADR-003 记录分工理由：代理路径用 hyper + TimingConnector 采集 7 阶段 timing，Compose 路径用 reqwest）
- ✅ 已删除空壳 crate（session-store、throttle-engine、exporter）

---

## 优先级排序的改进路线图

### ✅ P0 — 安全与稳定性（已完成）

| # | 改进项 | 状态 |
|---|--------|------|
| 1 | 配置 CSP 策略 | ✅ 已完成 |
| 2 | JS 沙箱添加内存限制（16MB） | ✅ 已完成 |
| 3 | 添加前端 ErrorBoundary（全局 + 路由级） | ✅ 已完成 |
| 4 | 修复 `http2Enabled` 前后端契约 | ✅ 已完成 |
| 5 | 追踪 `Cargo.lock` | ✅ 已完成 |

### ✅ P1 — 代码质量与架构治理（已完成）

| # | 改进项 | 状态 |
|---|--------|------|
| 6 | SQLite 同步写入迁移到 `spawn_blocking` | ✅ 已完成 |
| 7 | 预编译 Rewrite regex 规则 | ✅ 已完成 |
| 8 | 拆分 `handle_http_request` 为阶段函数 | ✅ 已完成 |
| 9 | 拆分 `rules.rs` 为 `rules/` 模块目录 | ✅ 已完成 |
| 10 | 引入 `ProxyError` + `ProxyManagers` / `ProxyConfig` | ✅ 已完成 |
| 11 | 更新 `API_SPEC.md` Insights 章节 | ✅ 已完成 |
| 12 | 建立共享 Rust 错误 helper，高频 command 迁移 | ✅ 已完成 |
| 13 | 拆分 `AppShell` 为多个 Hook | ✅ 已完成 |

### ✅ P2 — 工程规范（大部分已完成）

| # | 改进项 | 状态 |
|---|--------|------|
| 14 | 清理空壳 crate 依赖声明 | ✅ 已完成 |
| 15 | 提取 `TlsOrPlain<S>` 共享类型 | ✅ 已完成 |
| 16 | 统一 HTTP 客户端 TLS 策略（ADR-003 记录分工） | ✅ 已完成 |
| 17 | Windows 网络接口枚举（PowerShell `Get-NetIPAddress`） | ✅ 已完成 |
| 18 | 添加 property-based 测试（`proptest`） | ✅ 已完成 |
| 19 | 统一 `BodyType`/`RawLanguage` 等重复类型 | ✅ 已完成 |
| 20 | 将 `emit_log` 迁移到 `tracing` 宏 | ✅ 已完成 |
| 21 | Script/Breakpoint regex 编译缓存 | ✅ 已完成 |
| 22 | `ProxyError` 推进到主要代理路径 | ✅ 已完成 |
| 23 | 拆分 `bootstrap/mod.rs` 为 repository/cache/converters/events | ✅ 已完成 |
| 24 | 拆分 `SessionsPage` hooks | ✅ 已完成 |

### 📋 P3 — 持续改进（待推进）

| # | 改进项 | 优先级 |
|---|--------|--------|
| 25 | 继续瘦身 `http_proxy.rs`（WS upgrade / 响应构建独立模块化） | P3 |
| 26 | 继续瘦身 `server.rs`（blind tunnel / 内建端点独立模块化） | P3 |
| 27 | 拆分 `rule-engine` monolithic 为多模块 | P3 |
| 28 | 为 `db` crate 引入 `DbError` 结构化错误类型 | P3 |
| 29 | 将 `ProxyError` 扩展到 `handle_connection` 等外层函数 | P3 |
| 30 | 修复 Tauri commands 2 处原始 `format!` 错误 | P3 |
| 31 | 拆分大型前端页面（collections / compare / insights / throttling） | P3 |
| 32 | 补齐 throttling / compare 页面 i18n 硬编码字符串 | P3 |
| 33 | 补充核心 Store 单元测试（session-container / compose-editor） | P3 |
| 34 | 全面审查列表查询命令错误传播 | P3 |

---

## 架构亮点 Top 5

1. **代理核心与 UI 完全解耦** — `proxy-core` 纯 Rust、不依赖 Tauri，12,614 行独立测试和复用
2. **三层同构命令架构** — Rust commands → TS commands → shared-types，16 域一一对应、可审计
3. **请求处理管线阶段化** — `handle_http_request` 已拆为 parse/rules/breakpoint/throttle/upstream/response 阶段
4. **运行时类型边界校验** — `invoke<unknown>()` + parse 模式，前后端边界零信任
5. **QuickJS 脚本沙箱** — 50ms 超时 + 16MB 内存限制 + 独立线程 + AtomicBool 中断，安全且不阻塞

## 架构风险 Top 5

1. **`http_proxy.rs`（2,315 行）和 `server.rs`（1,714 行）仍是维护热点** — 功能边界已清晰但体积仍大，后续新增协议处理或规则类型会继续膨胀
2. **错误类型统一仍有差距** — `db`（89 处 String）和 `proxy-core` 外层（43 处 String vs 16 处 ProxyError）未完成迁移，新增代码需防止回归
3. **前端大型页面是后续维护压力点** — `collections`（1,573 行）、`compare`（1,441 行）等页面超过 1,000 行，状态管理和组件拆分需持续推进
4. **`rule-engine` monolithic 结构** — 1,178 行单文件含全部职责，随着脚本能力扩展会成为瓶颈
5. **前端测试覆盖偏弱** — 17.4% 文件覆盖率，核心 Store 和页面组件缺少自动化回归保护

---

## 结论

AIProxy 当前整体健康度为 **A（工程基础稳固）**。

**P0 安全基线 + P1 架构治理 + P2 工程规范** 三轮治理后，项目已建立扎实基础：

- **架构层面**：四层分离清晰、三层同构严格执行、Crate 依赖图为 DAG、规则管线阶段化
- **安全层面**：CSP 已配置、沙箱内存/时间双重限制、SQL 全参数化、Cargo.lock 追踪、零危险 unwrap
- **代码质量**：前端零 `any`、Rust 结构化错误基线已建立、类型安全贯穿前后端
- **跨平台**：Windows 网络接口枚举已实现（Phase 6）、系统代理三端适配到位

**剩余工作集中在持续改进**：`http_proxy.rs`/`server.rs` 继续瘦身、`db` crate 错误类型结构化、`rule-engine` 模块拆分、前端大型页面组件化、测试覆盖提升。这些问题均不影响当前功能交付，可在后续迭代中逐步收敛。

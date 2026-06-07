# P2 — 工程规范（持续改进）

> 来源：`docs/ARCHITECTURE_REVIEW.md` P2 改进项 #14-#24 + P1 遗留项 + 工程基础设施改进
> 创建日期：2026-06-07
> 最后更新：2026-06-08 — 对齐 `c675a5026bf1824e652ccaf06d91944df289992a..HEAD` 重构结果
> 当前分支：dev

---

## 当前执行状态（2026-06-08）

本计划已有多项在 `dev` 分支落地，后续阅读时以本节为准：

| 项目 | 状态 | 当前基线 |
|------|------|----------|
| Phase 0a/0b/0c | ✅ 已完成 | CI 加入 Rust cache、fmt、clippy、Prettier check；`rustfmt.toml` 与 `.prettierrc` 已落地；已完成全量格式化 |
| #19 | ✅ 已完成 | `BodyType` / `RawLanguage` / session query key 已统一到共享位置 |
| #20 | ✅ 已完成 | `emit_log` 已迁移为直接使用 `tracing` 宏 |
| #21 | ✅ 已完成 | Script / Breakpoint regex 已采用 manager runtime wrapper 预编译缓存 |
| #14 | ✅ 已完成 | `session-store` / `throttle-engine` / `exporter` 空壳 crate 已删除 |
| Phase 2a | ✅ 已完成主体 | `ProxyError` 与 `app_error()` 基线已推进；局部纯 helper 仍可返回 `String` |
| Phase 2b | ✅ 已完成 | 列表查询失败已向前端传播，并通过 notification store 做用户可见提示 |
| Phase 3 | ✅ 已完成主体 | `SessionsPage` 已拆出 filters/selection/layout/import-export/repeat 等 hooks；Inspector 仍可继续瘦身 |
| Phase 4 | ✅ 已完成 | `bootstrap` 已拆为 `repository.rs` / `cache.rs` / `converters.rs` / `events.rs` |
| Phase 5 | ⏳ 待推进 | `TlsOrPlain<S>` 与 HTTP 客户端 TLS 策略审计仍待处理 |
| Phase 6 | ⏳ 待推进 | Windows 网络接口枚举与 property-based 测试仍待处理 |

**防回归要求**：已完成项不再按原方案重复执行；后续开发必须遵守 `docs/ENGINEERING_GUIDELINES.md` 与 `docs/ARCHITECTURE.md` 中新增的重构后边界约束。

## 目标

在 P0 安全基线达标、P1 代码质量与架构治理完成后，继续推进工程规范的持续改进：清理空壳依赖、统一重复类型、完成错误处理迁移、拆分大型模块、增强跨平台能力、引入 property-based 测试、加固 CI 与开发体验。所有改动是"让稳固的基础更加健壮"，不涉及新功能。

**设计原则**：先让 CI 和小清理稳定落地，再动 bootstrap 和 HTTP client 这类会牵一片的部分。"工程规范补齐"和"大规模重构"解耦推进。

---

## 不在范围内

- 新功能开发（API Collections、Throttling 升级、Rewrite 升级等已有独立计划）
- 性能调优（不引入新的缓存层或连接池优化，仅做 regex 缓存延续）
- E2E 测试框架引入（Playwright/Cypress 属于更长期的测试战略）
- UI/UX 重新设计
- `rule-engine` 命名与文档不一致问题（A5）——虽列入 P2 但不阻塞其他项，可在后续迭代处理

---

## 执行阶段与依赖关系

```text
Phase 0a — CI 最小加固（Rust cache + clippy + fmt --check）    ~1 天   ← 最高优先，无依赖
Phase 0b — 格式化配置（rustfmt.toml + .prettierrc，仅加配置）   ~0.5 天 ← 0a 之后
Phase 0c — 全量格式化（formatting-only，独立 PR）               ~0.5 天 ← 0b 之后
Phase 1  — 低风险清理（#19, #20, #21）                          ~2-3 天 ← 依赖 0a
Phase 2a — 错误格式迁移（#22 + P1 遗留 C3）                    ~3-4 天 ← 依赖 0a
Phase 2b — 列表查询错误传播（C4，⚠️ 用户可见行为变更）           ~2 天   ← 依赖 2a，独立 PR
Phase 3  — 前端拆分与测试（#24 + F4/F5）                        ~3-4 天 ← 独立于 Rust
Phase 4  — bootstrap 结构拆分（#23，3 个 PR）                   ~5-7 天 ← 最复杂，拆步推进
Phase 5  — Rust 代码质量（#15, #16 调研先行）                   ~5-7 天 ← 2a 完成后
Phase 6  — 平台与测试范式（#17, #18）                           ~3-5 天 ← 独立增强，不阻塞主线
```

> 总预估工期：15-25 天（按串行估算），可并行压缩至 3-4 周。
> P2 无时间压力标签，可跨多个迭代增量交付。

---

## Phase 0a：CI 最小加固

> **目标**：让 CI 成为真正的质量守门。此 PR 只改 CI 配置，不触碰业务代码。
> **PR 边界**：独立 PR，最小改动，最先合入。

**影响文件**：
- `.github/workflows/ci.yml`

**方案**：

在 `ci.yml` 的 `verify` job 中添加：

1. **Rust 构建缓存**：`Swatinem/rust-cache@v2`

```yaml
- name: Cache Rust artifacts
  uses: Swatinem/rust-cache@v2
  with:
    workspaces: |
      crates -> target
      apps/desktop/src-tauri -> target
```

2. **Rust 格式检查**（在 lint 前）：`cargo fmt --check --all`
3. **Clippy 检查**（在 test 前）：`cargo clippy --workspace -- -D warnings`
4. **pnpm store 缓存**（可选）

**前置条件**：若当前 `cargo clippy --workspace -- -D warnings` 不通过，先开独立修复 PR 清理 warning；0a 本身只改 CI 配置。

**验证**：
- 推送后 CI 通过
- 后续 CI 运行时间显著缩短（Rust cache 生效）

---

## Phase 0b：格式化配置（仅加配置，不全量格式化）

> **目标**：建立格式化配置文件，为后续全量格式化做准备。此 PR 只加配置，不改动任何代码。
> **PR 边界**：独立 PR，包含配置文件 + package scripts + lockfile/dependency 更新。

### Rust 格式化配置

**影响文件**：
- `rustfmt.toml`（新建）

**方案**：

创建 `rustfmt.toml`，**仅使用 stable toolchain 支持的配置项**：

```toml
edition = "2021"
max_width = 100
```

> 注意：`imports_granularity`、`group_imports` 等配置属于 unstable/nightly 区域（分别追踪 [rustfmt#4991](https://github.com/rust-lang/rustfmt/issues/4991) 和 [#5083](https://github.com/rust-lang/rustfmt/issues/5083)）。等 stable toolchain 确认支持后再考虑添加。

### 前端格式化配置

**影响文件**：
- `apps/desktop/.prettierrc`（新建）
- `apps/desktop/package.json`（添加 format/format:check 脚本）
- `packages/shared-types/.prettierrc`（新建）
- `packages/shared-types/package.json`（添加 format 脚本）

**方案**：

1. 安装 Prettier：`pnpm --filter @aiproxy/desktop add -D prettier`
2. 创建 `.prettierrc`：

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2
}
```

> 注意：项目原有代码 100% 使用双引号，`singleQuote` 必须为 `false` 以匹配现有风格。

3. 添加 npm script：`"format": "prettier --write 'src/**/*.{ts,tsx}'", "format:check": "prettier --check 'src/**/*.{ts,tsx}'"`

**验证**：
- 配置文件存在且语法正确
- `cargo fmt --check --all` 可运行
- `pnpm --filter @aiproxy/desktop format:check` 可运行（会报告未格式化的文件，但此 PR 不修复）

---

## Phase 0c：全量格式化（独立 PR，formatting-only）

> **目标**：一次性全量格式化，此 PR 只做格式化，不做任何逻辑改动。便于后续 PR 不与格式化 diff 冲突。
> **PR 边界**：独立 PR，formatting-only，便于审查和 revert。

**执行**：
1. `cargo fmt --all` — 全量 Rust 格式化
2. `pnpm --filter @aiproxy/desktop format` — 全量前端格式化
3. `pnpm --filter @aiproxy/shared-types format` — 共享类型格式化

**验证**：
- `cargo fmt --check --all` 通过
- `pnpm --filter @aiproxy/desktop format:check` 通过
- diff 审查：确认无逻辑变更（只有空格/换行/排序变化）

---

## Phase 1：低风险清理

> **目标**：快速清理和统一，每个 item 独立可提交。依赖 Phase 0a 的 CI 加固到位。

### #19 — 统一重复类型定义

**问题**：`BodyType`/`RawLanguage` 在两个 store 中重复定义；`SESSIONS_QUERY_KEY` 在两处各自定义。

**影响文件**：
- 查找 `BodyType` 定义位置：`apps/desktop/src/features/sessions/` 下搜索
- 查找 `RawLanguage` 定义位置：同上
- 查找 `SESSIONS_QUERY_KEY` 定义位置：搜索全局
- 新建或扩展：`apps/desktop/src/features/sessions/types/` 或已有共享类型文件

**方案**：

1. 定位所有重复定义位置
2. 保留语义最完整的定义，移至共享位置（如 `features/sessions/types.ts` 或 `features/sessions/constants.ts`）
3. 所有消费方改为从共享位置 import
4. 删除重复定义

**验证**：
- `pnpm --filter @aiproxy/desktop typecheck` 通过
- `grep -rn "BodyType\|RawLanguage" apps/desktop/src/ | grep -v "import.*from"` 仅剩共享定义处
- `grep -rn "SESSIONS_QUERY_KEY" apps/desktop/src/` 仅剩一处定义

### #20 — 将 `emit_log` 迁移到 `tracing` 宏

**问题**：自定义 `emit_log` 函数（非 macro）仍在 13 个文件、90+ 调用点使用。该函数在 3 处独立定义（`proxy-core/logging.rs`、`tls-manager/lib.rs`、`src-tauri/dev_logger.rs`），内部已直接调用 `tracing` 宏。迁移策略是直接将调用点替换为 `tracing` 宏，消除中间层。

**影响文件**：
- `crates/proxy-core/src/logging.rs`（主定义）
- `crates/proxy-core/src/http_proxy.rs`（22 调用点）
- `crates/proxy-core/src/server.rs`（40+ 调用点）
- `crates/proxy-core/src/ws.rs`（6 调用点）
- `crates/proxy-core/src/upstream_pool.rs`（7 调用点）
- `crates/proxy-core/src/breakpoints.rs`（5 调用点）
- `crates/proxy-core/src/rules/patterns.rs`（1 调用点）
- `crates/tls-manager/src/lib.rs`（独立定义）
- `crates/tls-manager/src/storage.rs`（7 调用点）
- `crates/tls-manager/src/resolver.rs`（3 调用点）
- `crates/tls-manager/src/generator.rs`（1 调用点）
- `apps/desktop/src-tauri/src/dev_logger.rs`（4 参数变体 + 4 调用点）

**方案**：

1. `emit_log("info", "event_name", &[("key", value)])` → `tracing::info!(event = "event_name", key = %value)`
2. **前置确认**：先确认 subscriber（`dev_logger`）和日志展示不依赖 `emit_log` 的旧字段结构，避免迁移后日志格式断档
3. 按模块分批替换，每批独立提交

**迁移顺序**（由少到多，降低单次风险）：
1. `tls-manager`（11 调用点，独立 crate）
2. `proxy-core/rules/patterns.rs`（1 调用点）
3. `proxy-core/breakpoints.rs`（5 调用点）
4. `proxy-core/upstream_pool.rs`（7 调用点）
5. `proxy-core/ws.rs`（6 调用点）
6. `proxy-core/http_proxy.rs`（22 调用点）
7. `proxy-core/server.rs`（40+ 调用点）
8. `dev_logger.rs`（4 参数变体，需单独处理）

**验证**：
- `grep -rn "emit_log" crates/ apps/desktop/src-tauri/src/` 无结果
- `cargo clippy --workspace -- -D warnings` 通过
- `cargo test --workspace` 通过

### #21 — Script/Breakpoint regex 编译缓存

**问题**：P1 #7 已预编译 Rewrite regex，但 Script 和 Breakpoint 的 regex pattern 仍在每次调用时重新编译。

**影响文件**：
- `crates/proxy-core/src/rules/script.rs`（Script regex 编译点）
- `crates/proxy-core/src/rules/breakpoints.rs`（Breakpoint regex 编译点）
- `crates/proxy-core/src/rules/managers.rs`（参考 `CompiledRewriteRule` 模式）

**方案**：

沿用 P1 的 `CompiledRewriteRule` 模式：
1. 在各自文件中添加编译缓存结构体
2. 在 Manager 加载/保存规则时预编译 regex
3. 无效 regex 降级处理：记录 warn 日志，该规则不参与匹配
4. 运行时匹配使用 `compiled_match.as_ref()` 代替 `Regex::new()`

**验证**：
- `cargo test -p aiproxy-proxy-core` 全部通过
- 新增测试：验证无效 regex 规则不会 panic

### #14 — 空壳 crate 去留决策（ADR 决策点）

**问题**：`session-store`（34 行）、`throttle-engine`（47 行）、`exporter`（36 行）几乎无代码。经核实，三个 crate 的类型（`SessionPageRequest`、`ThrottleProfile`、`ExportFormat`）在 Rust 代码中**零引用**。但 crate 名字暗示未来可能扩展。

**⚠️ ADR 决策点**：实施前需先决策，选项如下：

| 选项 | 适用条件 | 操作 |
|------|---------|------|
| **A. 删除** | 确认无近期扩展计划 | 移除 crate 目录、workspace member、`aiproxy-desktop` 依赖声明 |
| **B. 保留占位** | 有中期扩展计划但当前空置 | 保留 crate 但从 `aiproxy-desktop` 依赖中移除（减少编译时间），加 README 说明预期职责 |
| **C. 合并到现有 crate** | 类型归属明确 | `SessionPageRequest` → `aiproxy-db`；`ThrottleProfile` → `aiproxy-proxy-core`；`ExportFormat` → `aiproxy-db` |

**影响文件**：
- `crates/session-store/`、`crates/throttle-engine/`、`crates/exporter/`
- `apps/desktop/src-tauri/Cargo.toml`（依赖声明）
- `Cargo.toml`（workspace members）

**验证**：
- `cargo build --workspace` 通过
- `cargo test --workspace` 通过

---

## Phase 2a：错误格式迁移

> **目标**：延续 P1 建立的 `ProxyError` 和 `app_error()` 基线，纯格式迁移，不改行为语义。

### #22 — 将 `ProxyError` 推进到 WS、rules、http_proxy 内部阶段

**问题**：P1 #10b 仅迁移了 `forward_request` 路径。WS 处理、rules 应用、http_proxy 内部阶段函数仍使用 `String` 错误。

**影响文件**：
- `crates/proxy-core/src/error.rs`（`ProxyError` 定义，可能需新增变体）
- `crates/proxy-core/src/http_proxy.rs`（阶段函数）
- `crates/proxy-core/src/ws.rs`（WS 处理路径）
- `crates/proxy-core/src/rules/`（规则应用错误路径）

**方案**：

1. 审计 `error.rs` 中 `ProxyError` 的变体是否覆盖 WS 和 rules 场景，按需扩展
2. 逐个阶段函数将返回类型从 `Result<..., String>` 改为 `Result<..., ProxyError>`
3. 错误上下文保留：用 `thiserror` 的 `#[source]` 保留原始错误链

**迁移顺序**（由内到外）：
1. `stage_apply_request_rules` → `ProxyError`
2. `stage_intercept_request_breakpoint` → `ProxyError`
3. `stage_send_pending_and_throttle` → `ProxyError`
4. WS 相关函数 → `ProxyError`
5. `handle_http_request` 错误路径统一

**验证**：
- `cargo test -p aiproxy-proxy-core` 全部通过
- `cargo clippy -p aiproxy-proxy-core -- -D warnings` 通过

### P1 遗留 — 剩余 command 文件 `app_error()` 迁移

**问题**：P1 #12 迁移了 `ai`、`proxy`、`rules`、`sessions`，剩余 5 个 command 文件。

**影响文件**：
- `apps/desktop/src-tauri/src/commands/certificates.rs`
- `apps/desktop/src-tauri/src/commands/workspaces.rs`
- `apps/desktop/src-tauri/src/commands/collections.rs`
- `apps/desktop/src-tauri/src/commands/throttling.rs`
- `apps/desktop/src-tauri/src/commands/ws.rs`

**方案**：

逐文件将裸字符串错误替换为 `app_error(ERR_*, &msg)` 或 `app_error_with_details(...)`。

**验证**：
- `cargo build` 通过
- 每个 command 文件中无遗漏的裸字符串错误

---

## Phase 2b：列表查询错误传播（⚠️ 用户可见行为变更）

> **此改动会改变前端空状态与错误状态的语义。** 之前出错时前端看到空列表，之后会看到错误提示。
> **每个消费页面需补充错误 UI 验证。**
> **PR 边界**：独立 PR，不与 2a 混合。

### C4 — 列表查询命令错误传播

**影响文件**：
- 所有返回 `Vec<T>` 的 Tauri command（搜索 `-> Result<Vec<`）
- 对应的前端消费页面

**方案**：

1. 审计所有列表查询 command，识别 `catch` 中返回 `Ok(vec![])` 的地方
2. 将静默空数组改为 `Err(app_error(...))`
3. **每个消费页面需补错误 UI 验证**：
   - 错误时显示 Toast/Snackbar 提示
   - 保持空状态的正常显示
   - 可用 `reportCommandFailure` 统一处理
4. 逐页面修改，每个页面的 Rust+TS 改动放在同一 commit

**验证**：
- 构造查询失败场景（如 DB 不可用），确认前端显示错误提示
- 正常查询返回空时，前端仍正常显示空状态
- 每个消费页面都有对应的错误状态处理

---

## Phase 3：前端拆分与测试

> **目标**：延续 P1 AppShell 拆分的成功模式，处理剩余大型前端组件。

### #24 — 拆分 SessionsPage 与 Session Inspector

**影响文件**：
- `apps/desktop/src/pages/SessionsPage.tsx`（或等效路径）
- `apps/desktop/src/features/sessions/` 下相关组件

**方案**：

沿用 P1 AppShell 的 Hook 提取模式：
1. 审计 `SessionsPage`：识别可提取的独立逻辑块（筛选、排序、分页、会话列表选择等）
2. 提取自定义 Hook：`useSessionFilters()`、`useSessionSelection()`、`useSessionPagination()`
3. 提取子组件：`SessionListToolbar`、`SessionFilterPanel` 等
4. Session Inspector 同理审计拆分

**验收标准（结构性，非行数）**：
- ✅ 页面组件只负责布局与组合，不含业务逻辑
- ✅ 筛选状态有独立 hook（`useSessionFilters`）
- ✅ 选择状态有独立 hook（`useSessionSelection`）
- ✅ Inspector 状态有独立 hook 或 store slice
- ✅ 核心 store 操作有测试覆盖（对应 F5）
- 📊 行数作为参考指标（目标 < 300 行），不作为硬门槛

### F4 — SessionsPage 硬编码字符串 i18n 化

**影响文件**：
- `apps/desktop/src/pages/SessionsPage.tsx`（或拆分后的子组件）
- `apps/desktop/src/i18n/messages/en.ts`
- `apps/desktop/src/i18n/messages/zh-CN.ts`

**方案**：

1. 扫描 `SessionsPage` 及其子组件中的硬编码字符串
2. 为每个字符串在 `en.ts` 和 `zh-CN.ts` 中添加 key
3. 组件中替换为 `t('sessions.xxx')` 调用
4. 可与 #24 在同一 PR 中完成

**验证**：
- `grep -rn '"All Sessions"\|"Throttled"' apps/desktop/src/` 无结果（排除 test）
- 切换语言确认 UI 文案正确

### F5 — 补充 Store 测试

**影响文件**：
- `apps/desktop/src/features/sessions/stores/session-container.store.test.ts`（扩展）

**方案**：

审计 `session-container.store.ts` 的公共 API，按 AAA 模式补充测试：
- `seedSessions` — 初始化、空数据、重复数据
- `upsertSummary` — 新增、更新、不改变
- `addContainer` — 新容器、已有容器
- 参考 `breakpoint.store.test.ts` 的测试风格

**验证**：
- `pnpm --filter @aiproxy/desktop test` 全部通过
- 核心 store 操作均有测试覆盖

---

## Phase 4：bootstrap 结构拆分（3 个独立 PR）

> **目标**：将 `bootstrap/mod.rs`（~2113 行）按职责边界拆分。
> **这是本计划最复杂的结构性改动。采用 3 个 PR 分步推进，每个 PR 保持 AppState 公共 API 不变。**

### PR 4-1：converters + events 纯搬移

**影响文件**：
- `apps/desktop/src-tauri/src/bootstrap/converters.rs`（新建）
- `apps/desktop/src-tauri/src/bootstrap/events.rs`（新建）
- `apps/desktop/src-tauri/src/bootstrap/mod.rs`（精简）

**方案**：
- 将 `row_to_xxx` / `xxx_to_row` 函数移入 `converters.rs`
- 将 Tauri event emit 逻辑移入 `events.rs`
- `mod.rs` 中 `use` 引入，公共 API 不变
- 纯搬移，不改逻辑

**验证**：`cargo build` + `cargo test --workspace` 通过

### PR 4-2：repository 委托层

**影响文件**：
- `apps/desktop/src-tauri/src/bootstrap/repository.rs`（新建）
- `apps/desktop/src-tauri/src/bootstrap/mod.rs`（进一步精简）

**方案**：
- 将所有 DB 读写操作移入 `repository.rs`
- `AppState` 上的方法签名不变，内部委托给 repository
- 编译验证

**验证**：`cargo build` + `cargo test --workspace` 通过

### PR 4-3：SessionCache 结构化

**影响文件**：
- `apps/desktop/src-tauri/src/bootstrap/cache.rs`（新建）
- `apps/desktop/src-tauri/src/bootstrap/mod.rs`（最终精简至 ~300-400 行）

**方案**：
- 将 session 缓存逻辑（HashMap 操作、缓存失效）移入 `cache.rs`
- 可能需要独立的 `SessionCache` 结构体
- `mod.rs` 最终只保留 `AppState` 定义、初始化、公共 API

**验证**：
- `cargo build` + `cargo test --workspace` + `cargo clippy --workspace -- -D warnings` 通过
- `mod.rs` 行数 ~300-400 行
- 每个 PR 独立提交，可单独回滚

---

## Phase 5：Rust 代码质量

### #15 — 提取 `TlsOrPlain<S>` 共享类型

**影响文件**：
- `crates/proxy-core/src/ws.rs`（`WsUpstream` 定义）
- `crates/proxy-core/src/upstream.rs` 或等效文件（`TimingStream` 定义）
- 新建：`crates/proxy-core/src/tls_stream.rs` 或在现有模块中

**方案**：

定义通用类型并统一 `AsyncRead`/`AsyncWrite` 实现：

```rust
pub enum TlsOrPlain<S> {
    Plain(S),
    Tls(Box<tokio_rustls::client::TlsStream<S>>),
}
```

**验证**：`cargo test -p aiproxy-proxy-core` 通过

### #16 — HTTP 客户端 TLS 配置统一审计

> **目标**：审计 TLS 配置与证书策略的一致性。不承诺移除 reqwest——代理路径用 hyper、普通调用用 reqwest 可能是合理共存。是否移除 reqwest 留给调研结论。
> **产出**：ADR 文档 + TLS 配置收敛。移除 reqwest 只是调研后的可选结果。

**方案**：

1. **调研阶段**（输出为 ADR 文档）：
   - 列出 reqwest 的所有使用场景和 TLS 配置
   - 列出 hyper 的所有使用场景和 TLS 配置
   - 对比两套客户端的证书验证策略
   - 评估统一可行性和风险

2. **统一 TLS 配置**（必须做）：
   - 将 `NoVerifier`/`AcceptAnyCert` 等 TLS 配置收敛到 `tls-manager`
   - 证书策略来源统一；底层 TLS adapter 可不同（reqwest 用 `reqwest::ClientBuilder`、hyper 用 `tokio-rustls`），但证书验证行为一致

3. **移除 reqwest**（调研后的可选结果）：
   - 如果调研结论支持统一，渐进替换
   - 如果发现架构冲突（如 reqwest 无法满足代理转发的底层控制需求），保留双客户端但 TLS 配置已统一

**验证**：
- ADR 文档产出，记录决策和理由
- TLS 配置收敛到 `tls-manager`，两套客户端共享证书策略

---

## Phase 6：平台与测试范式（独立增强，不阻塞主线）

### #17 — 增强 Windows 网络接口枚举

**影响文件**：
- `crates/proxy-core/src/types.rs`（当前所有平台代码通过 `#[cfg(unix)]` 内联在此文件，无平台文件拆分）
- 需新建平台拆分文件

**方案**：

当前 Windows 的 `#[cfg(not(unix))]` 路径仅返回空 `Vec`。需实现：
1. 将 `ranked_interface_ipv4_addresses` 等函数按平台拆为独立文件
2. Windows 实现基于 `GetAdaptersAddresses` Win32 API 或 `ipconfig` 命令行
3. 单元测试使用 mock 数据验证解析逻辑

**注意**：需要 Windows 环境验证。可降级为"准备好代码但标记 needs-testing"。

### #18 — 添加 Property-based 测试（proptest）

**影响文件**：
- `crates/proxy-core/Cargo.toml`（添加 proptest 依赖）
- 各模块新增 proptest 测试

**方案**：

优先覆盖**确定性强的纯函数**，避免规则引擎端到端行为：

1. **URL 构造**（`build_url_from_hyper`）：
   - 验证 scheme + host + port + path 组合后解析一致
   - 验证特殊字符（`%xx`、unicode）的 round-trip

2. **HTTP header name/value 清洗**：
   - 验证任意输入不会产生含 CRLF/LF 的 header value（安全属性）
   - 验证 header name 仅含合法字符

3. **Filter/Sort builder**（`db` crate）：
   - 验证任意 filter 参数组合不会导致 SQL 注入
   - 验证 sort 方向参数仅接受合法值

4. **Body size guard**：
   - 验证 body size 边界条件（0、刚好阈值、超出阈值）

```toml
[dev-dependencies]
proptest = "1"
```

**验证**：
- `cargo test -p aiproxy-proxy-core` 通过
- proptest 默认 256 用例，运行 < 30 秒

---

## PR 边界与合并策略

```text
PR 0a: CI 最小加固（Rust cache + clippy + fmt --check）      ← 最高优先
PR 0b: 格式化配置（rustfmt.toml + .prettierrc，仅配置）      ← 0a 后
PR 0c: 全量格式化（formatting-only，独立 PR）                 ← 0b 后

PR 1a: #19 — 统一重复 TS 类型
PR 1b: #20 — emit_log → tracing 迁移
PR 1c: #21 — Script/Breakpoint regex 缓存
PR 1d: #14 — 空壳 crate 去留（需 ADR 决策后执行）

PR 2a: #22 + C3 — ProxyError 推进 + 剩余 command 迁移
PR 2b: C4 — 列表查询错误传播（⚠️ 用户可见行为变更，独立 PR）

PR 3: #24 + F4 + F5 — SessionsPage 拆分 + i18n + Store 测试（纯前端 PR）

PR 4-1: #23 Step 1 — converters + events 纯搬移
PR 4-2: #23 Step 2 — repository 委托层
PR 4-3: #23 Step 3 — SessionCache 结构化

PR 5a: #15 — TlsOrPlain<S> 提取
PR 5b: #16 — HTTP 客户端 TLS 审计（调研 ADR + TLS 配置收敛）

PR 6a: #17 — Windows 网络接口枚举（需 Windows 环境）
PR 6b: #18 — proptest 引入
```

**合并顺序**：

```text
PR 0a → PR 0b → PR 0c（严格串行，CI + 格式化先落地）

PR 1a / 1b / 1c（0a 后并行）
  └→ PR 1d（ADR 决策后）

PR 2a（1b 后）
  └→ PR 2b（2a 后，独立 PR）

PR 3（独立，可与 Rust 侧并行）

PR 4-1 → 4-2 → 4-3（严格串行，每步保持 AppState API 不变）

PR 5a / 5b（2a 后，5b 先调研再实现）

PR 6a / 6b（独立，不阻塞主线）
```

---

## 三层验证检查清单

### 第一层：每项改动自验

| 检查项 | 命令 |
|--------|------|
| Rust 编译 | `cargo build --workspace` |
| Rust 测试 | `cargo test --workspace` |
| Clippy | `cargo clippy --workspace -- -D warnings` |
| Rust 格式 | `cargo fmt --check --all` |
| 前端类型检查 | `pnpm --filter @aiproxy/desktop typecheck` |
| 前端 lint | `pnpm --filter @aiproxy/desktop lint` |
| 前端测试 | `pnpm --filter @aiproxy/desktop test` |

### 第二层：集成验证

| 检查项 | 方法 |
|--------|------|
| 桌面端启动正常 | `pnpm desktop:run` 启动无崩溃 |
| 代理功能正常 | 启动代理，捕获 HTTP/HTTPS 请求 |
| CI 全流程通过 | 推送到 dev 分支后 CI green |

### 第三层：回归验证

| 检查项 | 方法 |
|--------|------|
| 性能无退化 | 使用既有 stress test 基线验证（10k sessions 加载等）；如无基线，先记录当前值，不在 P2 中强行设阈值 |
| 错误提示正常 | 构造各种错误场景，确认 UI 提示正确 |
| 跨平台无回归 | macOS 主力验证 + CI ubuntu 通过 |
| 日志输出正常 | 检查 dev log 中 tracing 输出 |

---

## 风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| #16 调研结论不支持统一 | 中 | 低 | 保留双客户端，仅收敛 TLS 配置，ADR 记录决策 |
| #23 bootstrap 拆分引入编译错误 | 低 | 中 | 3 个独立 PR，每步保持 AppState API 不变 |
| #17 Windows 网络枚举缺乏测试环境 | 中 | 低 | 准备代码标记 needs-testing，macOS/Linux 无回归 |
| C4 错误传播导致前端空状态消失 | 中 | 中 | 逐页面验证，每页补充错误 UI |
| Phase 0c 全量格式化 diff 过大 | 低 | 低 | 独立 PR，formatting-only，不混逻辑改动 |
| #20 emit_log 迁移量大（90+ 调用点） | 低 | 低 | 按模块分批，每批独立提交 |

---

## 工作量估算

| Phase | 预估天数 | 可并行度 |
|-------|---------|---------|
| Phase 0a：CI 最小加固 | 1 天 | 必须先行 |
| Phase 0b：格式化配置 | 0.5 天 | 0a 后 |
| Phase 0c：全量格式化 | 0.5 天 | 0b 后 |
| Phase 1：低风险清理 | 2-3 天 | 4 项可并行 |
| Phase 2a：错误格式迁移 | 3-4 天 | 部分并行 |
| Phase 2b：C4 行为变更 | 2 天 | 2a 后 |
| Phase 3：前端拆分与测试 | 3-4 天 | 独立于 Rust |
| Phase 4：bootstrap 拆分 | 5-7 天 | 串行 3 PR |
| Phase 5：Rust 代码质量 | 5-7 天 | 调研先行 |
| Phase 6：平台与测试 | 3-5 天 | 独立增强 |
| **总计** | **15-25 天** | 可压缩至 3-4 周 |

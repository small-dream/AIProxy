# P0 安全与稳定性修复计划

> 日期：2026-06-07
> 来源：ARCHITECTURE_REVIEW.md 中 P0 级问题
> 修订：2026-06-07 — 根据代码审查反馈修正

## Context

架构审查发现 5 个 P0 级问题，需要立即修复以提升安全性和生产稳定性：
1. CSP 完全禁用 — WebView 无任何内容安全策略
2. JS 沙箱无内存限制 — `rquickjs` 的 `allocator` feature 降低 `set_memory_limit` 精度
3. 缺少 ErrorBoundary — 组件渲染异常导致白屏
4. http2Enabled 前后端契约不一致 — 设置无法持久化
5. Cargo.lock 未追踪 — 构建不可复现

---

## 修复 1：配置 CSP 策略

**文件**：`apps/desktop/src-tauri/tauri.conf.json` 第 24-26 行

**现状**：`"csp": null`，完全禁用 CSP。

**方案**：使用 Tauri 2 内置的 `devCsp` 字段区分 dev/prod。

Tauri 2 的 `SecurityConfig` 原生支持 `"csp"` 和 `"devCsp"` 两个字段。dev 模式自动优先使用 `devCsp`（fallback 到 `csp`），生产构建只用 `csp`。不需要运行时修改、环境变量或 `--config` 合并。

### `tauri.conf.json` 修改

```json
"security": {
  "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src ipc://localhost tauri://localhost https://tauri.localhost",
  "devCsp": "default-src 'self' http://localhost:1420; script-src 'self' http://localhost:1420 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' http://localhost:1420 ipc://localhost tauri://localhost https://tauri.localhost ws://localhost:1420"
}
```

说明：
- **dev/prod 区分**：`csp` 用于生产，`devCsp` 用于开发（Tauri 2 自动选择，无需手动处理）
- `devCsp` 额外包含：`http://localhost:1420`（Vite devServer）、`ws://localhost:1420`（HMR WebSocket）、`'unsafe-eval'`（Vite HMR）
- `'unsafe-inline'`：MUI 使用内联样式，两个模式都保留
- `data: blob:`：Session 详情中可能有 data URI
- `ipc://localhost tauri://localhost`：Tauri IPC bridge 协议
- `font-src 'self' data:`：保守策略，当前使用系统字体，但 MUI / 字体策略后续可能变化

### 验证步骤

1. 生产构建 `pnpm desktop:build` → 启动 → 确认 WebView 正常加载、Console 无 CSP 违规
2. 开发模式 `pnpm desktop:run` → 确认 HMR 正常工作、热更新不报 CSP 错误
3. DevTools Console 检查无 CSP 相关 warning

---

## 修复 2：JS 沙箱添加内存限制

**文件**：`crates/rule-engine/Cargo.toml` + `crates/rule-engine/src/lib.rs`

**现状**：`features = ["full"]` 会启用 `allocator` feature，使 `Runtime::new()` 走 rquickjs 的 Rust custom allocator 路径而非 QuickJS 默认 allocator。`set_memory_limit()` 仍会调用 `JS_SetMemoryLimit`，但 rquickjs 文档/源码注释明确提示 custom allocator 下该限制不可靠——QuickJS 的 limit check 依赖 `malloc_state.malloc_size` 统计，走 custom allocator 后这条路径是否按 QuickJS 预期精确工作不如默认 `JS_NewRuntime()` + 平台 `malloc_usable_size` 可靠。因此去掉 `allocator` 的目的是让 runtime 回到 QuickJS 默认 allocator，使内存限制更可预期。

### 步骤 1：修改 Cargo.toml

```toml
# 之前
rquickjs = { version = "0.8", features = ["full"] }

# 之后（full 减去 allocator，经 cargo tree -e features 确认）
rquickjs = { version = "0.8", features = [
  "chrono", "loader", "dyn-load", "either", "indexmap",
  "classes", "properties", "array-buffer", "macro", "phf"
] }
```

feature 列表来源：`cargo tree -e features -p aiproxy-rule-engine` 输出的 `full` feature 展开后去掉 `allocator`。

### 步骤 2：编译验证

执行 `cargo check -p aiproxy-rule-engine` 确认去掉 allocator 后编译通过。如果有编译错误，根据实际错误调整 feature 列表。

### 步骤 3：在 `lib.rs` 添加内存限制

在 `Runtime::new()` 之后、`set_interrupt_handler` 之前添加：

```rust
let runtime = Runtime::new().map_err(|error| format!("create runtime: {error}"))?;

// Limit QuickJS heap to 16MB per script execution.
// Scripts may access request/response bodies containing large JSON payloads.
// 16MB provides headroom while still preventing runaway allocation.
runtime.set_memory_limit(16 * 1024 * 1024);
runtime.set_gc_threshold(8 * 1024 * 1024);

let started_at = Instant::now();
runtime.set_interrupt_handler(Some(Box::new(move || { ... })));
```

16MB 理由：脚本能读写请求/响应体，大型 JSON body 可能数 MB。现有 50ms 时间限制 + 16MB 内存限制构成双重保护。后续可通过实际脚本负载调低。

### 步骤 4：添加自动测试

在 `crates/rule-engine/tests/` 或 `lib.rs` 的 `#[cfg(test)]` 中添加内存限制测试。**必须走现有公开 API**（`compile_script_rule` → `execute_request_hook`），验证 `ScriptHookResult.trace.outcome` 为 `ScriptRunOutcome::RuntimeError`，而不是直接 `Runtime::new()` eval 孤立脚本：

```rust
#[test]
fn memory_limit_is_enforced() {
    // Script that tries to allocate > 16MB via the real hook path
    let source = r#"
        function onRequest(ctx) {
            var arrays = [];
            for (var i = 0; i < 2000; i++) {
                arrays.push(new Uint8Array(1024 * 1024));
            }
        }
    "#;

    let rule = ScriptRule {
        id: "test-oom".into(),
        // ... 必填字段 ...
        language: ScriptRuleLanguage::JavaScript,
        source_type: ScriptRuleSourceType::Inline,
        source_code: source.to_string(),
        entrypoints: ScriptEntrypoints { on_request: true, on_response: false },
        // ...
    };

    let compiled = compile_script_rule(rule).unwrap();
    let payload = ScriptHookPayload {
        url: "https://example.com".into(),
        method: "GET".into(),
        headers: serde_json::json!({}),
        body: None,
        // ...
    };

    let result = execute_request_hook(&compiled, payload);
    assert!(
        matches!(result.trace.outcome, ScriptRunOutcome::RuntimeError),
        "expected RuntimeError from OOM, got {:?}",
        result.trace.outcome
    );
}
```

### 验证步骤

1. `cargo check -p aiproxy-rule-engine` — 编译通过
2. `cargo test -p aiproxy-rule-engine` — 所有测试通过
3. 自动测试验证内存限制生效
4. 手动验证：创建分配大数组的脚本规则，确认被终止而非 OOM

---

## 修复 3：添加前端 ErrorBoundary

**新文件**：`apps/desktop/src/components/shared/ErrorBoundary.tsx`

**修改文件**：
- `apps/desktop/src/app/App.tsx` — 在 AppProviders **内部**包裹全局 ErrorBoundary
- `apps/desktop/src/app/router/index.tsx` — 在 `renderLazyRoute()` 中添加页面级 ErrorBoundary

### 关键设计决策

ErrorBoundary 必须放在 **AppProviders 内部**（而非外部），确保 fallback UI 能使用 Theme、i18n、QueryClient 上下文。正确层级：

```
AppProviders > CssBaseline > ErrorBoundary(全局) > AppRouter > [页面级 ErrorBoundary]
```

### 步骤 1：创建 `ErrorBoundary` 组件

```tsx
// components/shared/ErrorBoundary.tsx
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Alert, AlertTitle, Button, Box, Stack } from "@mui/material";

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // TODO: integrate with dev_logger or structured logging
    console.error("[ErrorBoundary] caught:", error, errorInfo);
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
  };

  handleFullReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <Box sx={{ p: 3, height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Alert
            severity="error"
            action={
              <Stack direction="row" spacing={1}>
                <Button size="small" onClick={this.handleReload}>Try again</Button>
                <Button size="small" color="inherit" onClick={this.handleFullReload}>Reload app</Button>
              </Stack>
            }
          >
            <AlertTitle>{this.props.fallbackTitle ?? "Something went wrong"}</AlertTitle>
            {this.state.error?.message}
          </Alert>
        </Box>
      );
    }
    return this.props.children;
  }
}
```

说明：
- **"Try again"**：清空 error state 触发重新渲染（如果子组件仍抛错会再进 fallback）
- **"Reload app"**：`window.location.reload()` 完全重置状态
- `componentDidCatch` 留 TODO 集成 dev_logger，当前用 `console.error` 保证不丢信息

### 步骤 2：在 `App.tsx` 中使用

```tsx
// App.tsx
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";

export function App() {
  return (
    <AppProviders>
      <CssBaseline enableColorScheme />
      <ErrorBoundary>
        <AppRouter />
      </ErrorBoundary>
    </AppProviders>
  );
}
```

ErrorBoundary 在 CssBaseline 之后、AppRouter 之前，确保 fallback 能用 MUI Theme 和 i18n。

### 步骤 3：页面级 ErrorBoundary

在 `renderLazyRoute()` 中包裹 ErrorBoundary，确保单个页面崩溃不影响整体布局和导航：

```tsx
function renderLazyRoute(Component: ComponentType) {
  return (
    <ErrorBoundary fallbackTitle="Page Error">
      <Suspense fallback={<LazyRouteFallback />}>
        <Component />
      </Suspense>
    </ErrorBoundary>
  );
}
```

### 验证步骤

1. 在某个页面组件中临时 `throw new Error("test")`，确认看到 ErrorBoundary fallback 而非白屏
2. 点击 "Reload app" 确认页面刷新正常
3. 移除 throw 后确认恢复正常
4. 确认 fallback UI 有正确的 MUI 主题样式（不是无样式白字）

---

## 修复 4：http2Enabled 前后端契约贯通

**核心 bug**：[proxy.rs:137](apps/desktop/src-tauri/src/commands/proxy.rs#L137) 构造第二个 `ProxyRuntimeConfig` 时 `http2_enabled` 硬编码为 `None`，前面算出的 `input.enable_http2` 被丢弃。

**完整影响范围**（经代码核实）：

### 步骤 1：修复 proxy.rs 启动链路

**文件**：`apps/desktop/src-tauri/src/commands/proxy.rs`

行 137：将 `http2_enabled: None` 改为 `http2_enabled`（使用行 63 已解析的值）

```rust
// 修复前
ProxyRuntimeConfig {
    port,
    ssl_enabled: enable_ssl,
    http2_enabled: None,  // BUG: 应为 http2_enabled
},

// 修复后
ProxyRuntimeConfig {
    port,
    ssl_enabled: enable_ssl,
    http2_enabled,
},
```

### 步骤 2：TLS manager 缓存失效

**文件**：`apps/desktop/src-tauri/src/commands/proxy.rs`

`TlsManager` 构造时将 `http2_enabled` 烘焙进 ALPN 配置（`h2` + `http/1.1` 或只有 `http/1.1`），存为不可变 `server_config`。当前 `start_proxy_impl` 行 97-104 优先复用 `state.read_tls_manager()`，不检查 http2_enabled 是否与缓存一致。

修复方式：当缓存的 TLS manager 的 `http2_enabled` 与本次请求不一致时，丢弃缓存并重建：

```rust
let tls_manager = if enable_ssl {
    let existing = state.read_tls_manager();
    let h2 = http2_enabled.unwrap_or(true);
    // Invalidate cached TLS manager if http2_enabled changed
    let compatible = existing.as_ref().is_some_and(|m| m.http2_enabled == h2);
    if compatible {
        existing
    } else {
        // Discard stale TLS manager and rebuild with current http2_enabled
        state.clear_tls_manager();
        match try_load_tls_manager(http2_enabled) {
            Ok(m) => {
                state.set_tls_manager(Arc::clone(&m));
                Some(m)
            }
            Err(_) => {
                return Err(
                    "SSL interception requires a root certificate. Generate one on the Certificates page.".to_string()
                );
            }
        }
    }
} else {
    None
};
```

注意：新增 `AppState::clear_tls_manager()` 方法（`self.tls_manager = None`），避免修改现有 `set_tls_manager` 的签名。

### 步骤 3：DB schema 添加列

**文件**：`crates/db/src/schema.rs`

在 `run_migrations` 函数中添加 migration，使用安全的错误处理：

```rust
// 只忽略 "duplicate column" 错误（重复 migration），其他错误返回 Err
fn migrate_add_column(
    conn: &Connection,
    table: &str,
    column: &str,
    column_def: &str,
) -> Result<(), String> {
    let sql = format!("ALTER TABLE {table} ADD COLUMN {column} {column_def}");
    match conn.execute(&sql, []) {
        Ok(_) => Ok(()),
        Err(e) if e.to_string().contains("duplicate column name") => Ok(()),
        Err(e) => Err(format!("migration add {table}.{column}: {e}")),
    }
}

// 在 run_migrations 中：
migrate_add_column(&conn, "workspaces", "http2_enabled", "INTEGER NOT NULL DEFAULT 1")?;
```

DEFAULT 1 (true) 与前端 `http2Enabled ?? true` 的 fallback 一致。

### 步骤 4：更新 DB 层 `workspaces.rs`

**文件**：`crates/db/src/workspaces.rs`

- `WorkspaceRow` struct 添加 `pub http2_enabled: bool`
- `upsert_workspace` — INSERT 语句添加 `http2_enabled` 列
- `update_workspace` — UPDATE 语句添加 `http2_enabled` 字段；函数签名添加 `http2_enabled: Option<bool>` 参数
- `row_to_workspace` — 添加 `http2_enabled: row.get::<_, i32>("http2_enabled")? != 0`
- `load_workspace`/`load_all_workspaces` — SELECT 语句添加 `http2_enabled` 列
- seed 数据 `http2_enabled: true`
- **DB tests** 要覆盖 `http2_enabled` 字段的读写和默认值

### 步骤 5：更新 `WorkspaceData` 和 `WorkspaceManager`

**文件**：`apps/desktop/src-tauri/src/workspace.rs`

- `WorkspaceData` struct 添加 `pub http2_enabled: bool`
- `WorkspaceManager::new()` — default workspace 设置 `http2_enabled: true`
- `WorkspaceManager::create()` — 添加 `http2_enabled: bool` 参数
- `WorkspaceManager::update()` — 添加 `http2_enabled: Option<bool>` 参数

### 步骤 6：更新 workspace_row_to_data

**文件**：`apps/desktop/src-tauri/src/bootstrap/mod.rs`

`workspace_row_to_data` 函数添加 `http2_enabled: row.http2_enabled` 映射。

### 步骤 7：更新 BootstrapStatus 和 AppState

**文件**：`apps/desktop/src-tauri/src/bootstrap/mod.rs`

- `BootstrapStatus` struct 添加 `pub http2_enabled: bool`
- `Default` impl 设置 `http2_enabled: true`
- `AppState::start_proxy` 签名改为 `start_proxy(&self, port: u16, enable_ssl: bool, http2_enabled: bool, workspace_id: String)`，并在构造 BootstrapStatus 时设置 `http2_enabled`
- `AppState::stop_proxy` 不修改 `http2_enabled`——上一次的 http2_enabled 值保留在 `BootstrapStatus` 中，下次 start 可读取作为默认值
- `proxy.rs` 调用处改为 `state.start_proxy(bound_port, enable_ssl, http2_enabled.unwrap_or(true), input.workspace_id)`

### 步骤 8：更新 Tauri commands

**文件**：`apps/desktop/src-tauri/src/commands/workspaces.rs`

- `CreateWorkspaceInput` 添加 `pub http2_enabled: Option<bool>`
- `UpdateWorkspaceInput` 添加 `pub http2_enabled: Option<bool>`
- `create_workspace` — 传递 `http2_enabled` 到 `WorkspaceManager::create()` 和 `WorkspaceRow`
- `update_workspace` — 传递 `http2_enabled` 到 `WorkspaceManager::update()` 和 DB

### 步骤 9：更新前端 mock fallback

**文件**：`apps/desktop/src/services/commands/workspaces.ts`

所有 mock 返回的 workspace 对象添加 `http2Enabled: true`。

### 步骤 10：更新 shared-types 测试

确认 `packages/shared-types` 中 `Workspace` 类型的 `http2Enabled` 字段和 parser 测试覆盖。

### 验证步骤

1. Settings 页面切换 HTTP/2 开关 → 重启应用 → 确认开关状态被保留
2. 查看 proxy 日志确认 `http2_enabled` 值被正确传入 `ProxyRuntimeConfig`
3. `cargo test -p aiproxy-db` — workspace 测试覆盖 `http2_enabled`
4. `cargo test --workspace` — 全量 Rust 测试通过

---

## 修复 5：追踪 Cargo.lock

**修改文件**：`.gitignore`

**当前状态**：`Cargo.lock` 文件存在于磁盘（183KB），但被 `.gitignore` 排除。

**方案**：
1. 从 `.gitignore` 移除 `Cargo.lock` 这一行
2. 执行 `git add Cargo.lock`

理由：这是应用程序项目（有 `src-tauri/` binary crate），不是库 crate。`Cargo.lock` 应被追踪以确保可复现构建。不需要重新生成文件，文件已存在且最新。

### 验证步骤

1. `git status` 确认 `Cargo.lock` 出现在 changes 中
2. `git diff --cached Cargo.lock` 确认内容合理

---

## 修改文件清单

| 文件 | 修改类型 |
|------|----------|
| `apps/desktop/src-tauri/tauri.conf.json` | 修改 CSP 配置（区分 dev/prod） |
| `crates/rule-engine/Cargo.toml` | 修改 rquickjs features（去掉 allocator） |
| `crates/rule-engine/src/lib.rs` | 添加 set_memory_limit/gc_threshold 调用（16MB） |
| `apps/desktop/src/components/shared/ErrorBoundary.tsx` | 新建 |
| `apps/desktop/src/app/App.tsx` | 在 AppProviders 内部包裹全局 ErrorBoundary |
| `apps/desktop/src/app/router/index.tsx` | renderLazyRoute 中添加页面级 ErrorBoundary |
| `crates/db/src/schema.rs` | 添加 http2_enabled migration + 安全的 migrate_add_column helper |
| `crates/db/src/workspaces.rs` | 全面添加 http2_enabled 字段和 SQL |
| `apps/desktop/src-tauri/src/workspace.rs` | WorkspaceData/WorkspaceManager 添加 http2_enabled |
| `apps/desktop/src-tauri/src/bootstrap/mod.rs` | BootstrapStatus + workspace_row_to_data 添加 http2_enabled |
| `apps/desktop/src-tauri/src/commands/proxy.rs` | 修复 http2_enabled: None → http2_enabled；TLS manager 缓存失效检查 |
| `apps/desktop/src-tauri/src/commands/workspaces.rs` | Create/UpdateWorkspaceInput 添加 http2_enabled |
| `apps/desktop/src/services/commands/workspaces.ts` | Mock fallback 添加 http2Enabled |
| `.gitignore` | 移除 Cargo.lock |

## 建议执行顺序

1. **低风险高收益先行**：Cargo.lock 追踪、ErrorBoundary、http2Enabled 启动链路修复
2. **需要实测的安全项**：CSP（dev/prod 双模式验证）、rquickjs 内存限制
3. CSP 和 rquickjs 都要留出"dev/prod 双模式验证"，不能只靠静态配置判断

## 验证

1. **CSP**：启动桌面端开发模式，确认 HMR 正常；生产构建确认 WebView 正常加载；DevTools Console 无 CSP 违规警告
2. **JS 内存限制**：`cargo check -p aiproxy-rule-engine` 编译通过；`cargo test -p aiproxy-rule-engine` 通过；自动测试验证内存限制生效
3. **ErrorBoundary**：在某个页面组件中临时 `throw new Error("test")`，确认看到 ErrorBoundary fallback 而非白屏；点击 Reload app 确认刷新正常
4. **http2Enabled**：Settings 页面切换 HTTP/2 开关 → 重启应用 → 确认开关状态被保留
5. **Cargo.lock**：`git status` 确认 Cargo.lock 出现在 changes 中
6. **全量验证**：`pnpm typecheck && pnpm lint && pnpm test && cargo test --workspace`

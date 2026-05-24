# M1：可靠性与性能产品化

**里程碑**：M1（2026-06）
**主题**：让现有 P0 功能从"能用"变成"敢长期打开用"。
**状态**：已批准设计

## 背景

AIProxy 的 HTTP/HTTPS/WebSocket 核心调试闭环已经功能完整。但在持续高流量场景下（10k+ session、1k+ WS 消息、大 body），应用暴露出一系列性能问题：滚动事件未经节流、搜索输入无防抖、session 事件双重订阅导致冗余状态更新、Rust 日志同步写入序列化所有异步任务、缓存无上限增长。这些问题削弱了用户对 AIProxy 作为日常工具的信心。

本规格覆盖 M1 全部四个工作流：前端渲染优化、大 body 与导出稳定性、Rust 热路径优化、质量基线。

## 验收标准

- 10,000 条 session：列表筛选和选择详情无明显卡顿。
- 1,000 条 WebSocket 消息：滚动和搜索可用。
- 50MB 响应体：代理和 UI 不崩溃，详情页明确显示截断/延迟加载状态。
- 导出 500 条 session：UI 不冻结。

## 设计决策

| 决策 | 选择 | 理由 |
| ------ | ------ | ------ |
| 虚拟滚动库 | `@tanstack/react-virtual` | 轻量、支持动态 count、兼容树结构展平 |
| 日志框架 | `tracing` + `tracing-appender` | 行业标准、缓冲异步写入、结构化输出 |
| TLS 证书缓存淘汰 | `lru` crate，上限 512 个 host | 防止内存无限增长；512 覆盖典型使用 |
| Session 持久化 | 每事务批量写入最多 50 条 | 减少突发流量下的 DB 锁竞争 |
| 防抖延迟 | 150ms | 输入足够流畅，避免树重建抖动 |

---

## Phase 0：共享基础设施

### 0.1 安装前端依赖

在 `apps/desktop/package.json` 中添加 `@tanstack/react-virtual`。

### 0.2 创建 `useDebouncedValue` hook

新文件：`apps/desktop/src/hooks/use-debounced-value.ts`

通用 hook：`useDebouncedValue<T>(value: T, delayMs?: number = 150): T`。内部用 `useState` 保存防抖副本，`useEffect` + `setTimeout` 延迟更新，清理函数清除定时器。不依赖外部库。

### 0.3 添加 Rust 依赖

- `crates/proxy-core/Cargo.toml`：`tracing`（仅 facade；subscriber 初始化在 src-tauri 中）
- `crates/tls-manager/Cargo.toml`：`tracing`、`lru`
- `apps/desktop/src-tauri/Cargo.toml`：`tracing`、`tracing-subscriber`（fmt、env-filter、json）、`tracing-appender`

---

## Phase 1：前端事件管线与防抖

### 1.1 修复 session 事件双重订阅

**问题**：`useSessionEvents` 和 `SessionsPage` 内联 effect 同时订阅相同的 4 个 Tauri 事件。每条 upsert 触发两次 React 状态更新。

**方案**：

- 从 `apps/desktop/src/pages/sessions/index.tsx`（第 151 行）移除 `useSessionEvents()` 调用。
- 将 React Query 缓存变更（`queryClient.setQueryData`）合并到 `SessionsPage` 现有的 100ms 批量缓冲 `flushUpsertBuffer` 中。
- 清空 `apps/desktop/src/features/sessions/use-session-events.ts` 的 hook 体（若其他地方仍有导入则保留文件）。

**涉及文件**：`pages/sessions/index.tsx`、`features/sessions/use-session-events.ts`

### 1.2 域名过滤器防抖

**问题**：`SessionExplorerPane` 每次按键都触发 `onDomainFilterChange`，导致完整树重建。

**方案**：在 `SessionExplorerPane` 中添加本地 `inputValue` 状态。`InputBase` 绑定 `inputValue`。使用 `useDebouncedValue(inputValue, 150)` 得到 `debouncedValue`，在 `useEffect` 中调用 `onDomainFilterChange(debouncedValue)`。

**涉及文件**：`features/sessions/components/SessionExplorerPane.tsx`

### 1.3 WS 消息搜索防抖

**问题**：`SessionInspectorMessagesPane` 每次按键都更新 `search` 状态，重新过滤整个消息数组。

**方案**：与 1.2 相同的防抖模式。原始输入用本地状态，防抖值传入过滤 `useMemo`。

**涉及文件**：`features/sessions/components/SessionInspectorMessagesPane.tsx`

### 1.4 限制导入 session 存储上限

**问题**：`imported-sessions.store.ts` 使用无上限的 `Map<string, SessionDetail>`。

**方案**：设置 `MAX_IMPORTED_SESSION_DETAILS = 100` 上限。超出时淘汰最早的条目。`Map` 在现代 JS 中保持插入顺序，删除第一个 key 即可。

**涉及文件**：`features/sessions/imported-sessions.store.ts`

---

## Phase 2：虚拟滚动迁移

### 2.1 SessionExplorer

**问题**：手写虚拟滚动在每次滚动事件中未经节流地调用 `setScrollTop`。

**方案**：用 `@tanstack/react-virtual` 的 `useVirtualizer` 替换。

- 现有 `visibleRows` 计算（将树展平为扁平数组）保持不变。
- 用以下代码替换手动的 `scrollTop` 状态、`onScroll` 处理器和 `virtualRows` useMemo：
  ```tsx
  const virtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => SESSION_EXPLORER_ROW_HEIGHT,
    overscan: SESSION_EXPLORER_OVERSCAN,
  });
  ```
- 渲染使用 `virtualizer.getTotalSize()` 和 `virtualizer.getVirtualItems()`。
- 保留 `HostRow` 和 `SessionLeafNode` 上的 `memo()`。

**涉及文件**：`features/sessions/components/SessionExplorerPane.tsx`

### 2.2 WebSocket Messages

**问题**：与 SessionExplorer 相同的手写模式。

**方案**：对扁平消息列表进行相同的 `useVirtualizer` 迁移。

**涉及文件**：`features/sessions/components/SessionInspectorMessagesPane.tsx`

---

## Phase 3：导出与 body 稳定性

### 3.1 导出场景下批量加载 session 详情

**问题**：右键菜单导出 `exportSessionsAsHar` 使用无批量限制的 `Promise.all` 并发加载所有 session 详情。对话框导出使用 `BATCH_SIZE = 10`。

**方案**：提取共享函数 `loadSessionDetailsBatched(queryClient, sessions, batchSize = 10)` 到 `session-export.helpers.ts`。在 `exportSessionsAsHar` 和 `SessionExportDialog` 的 `loadDetailsForScope` 中统一使用。

**涉及文件**：`features/sessions/session-export.helpers.ts`、`pages/sessions/index.tsx`、`features/sessions/components/SessionExportDialog.tsx`

### 3.2 body 截断 UI 提示

**问题**：超过 20MB 被截断的 body 没有用户可见的提示。

**方案**：在请求/响应检查面板中检查 `body.truncated`，显示 MUI `Alert`（severity="warning"）。在 `en.ts` 和 `zh-CN.ts` 中添加 i18n 键。

**涉及文件**：`SessionInspectorResponsePane.tsx`、`SessionInspectorRequestPane.tsx`、`i18n/messages/en.ts`、`i18n/messages/zh-CN.ts`

---

## Phase 4：Rust 热路径优化

### 4.1 build_session_detail body 解压去重

**问题**：`build_session_detail`（http_io.rs:124）每次调用都解压 gzip/brotli/deflate body。断点流程中同一请求会多次调用。

**方案**：
- 在 `server.rs` 的断点代码路径中，首次构建后缓存 `ProxySessionDetail`。后续断点阶段复用缓存的 detail，不再从原始字节重建。
- 在 `http_io.rs` 中添加 `build_body_reference_from_decoded`，用于已解码字节可直接使用的场景。

**涉及文件**：`crates/proxy-core/src/http_io.rs`、`crates/proxy-core/src/server.rs`

### 4.2 日志迁移至 tracing

**问题**：三套自定义同步日志实现，每行日志都打开/写入/关闭文件，使用进程级 Mutex。

**方案**：增量迁移，保持 `emit_log` 函数签名不变：

**4.2a** `crates/proxy-core/src/logging.rs`：将 `emit_log` 内部替换为 `tracing::info!`/`warn!`/`error!`/`debug!`。移除 `WRITE_LOCK`、`append_to_log_file`、`resolve_log_file_path`。

**4.2b** `crates/tls-manager/src/lib.rs`：相同模式。

**4.2c** `apps/desktop/src-tauri/src/dev_logger.rs`：使用 `tracing_subscriber::fmt()` + `tracing_appender::non_blocking` 初始化，实现缓冲异步文件写入。将 guard 存入 `OnceLock` 以保持应用生命周期。

**涉及文件**：`crates/proxy-core/src/logging.rs`、`crates/tls-manager/src/lib.rs`、`apps/desktop/src-tauri/src/dev_logger.rs`、`apps/desktop/src-tauri/src/main.rs`

### 4.3 TLS 证书缓存 LRU 淘汰

**问题**：`crates/tls-manager/src/storage.rs` 中的 `HashMap` 无上限。

**方案**：替换为 `LruCache<String, Arc<CertifiedKey>>`（上限 512）。`get` 自动提升为最近使用。`clear` 变为 `cache.clear()`。

**涉及文件**：`crates/tls-manager/Cargo.toml`、`crates/tls-manager/src/storage.rs`

### 4.4 Session 持久化批量化

**问题**：单 collector task 在 DB mutex 下逐条持久化 session。

**方案**：在 collector 循环中批量处理，每事务最多 50 条。在 `AppState` 中添加 `upsert_session_batch`。获取 DB 锁一次，将所有 INSERT 包在单个事务中。现有 `upsert_session` 变为薄封装。

**涉及文件**：`apps/desktop/src-tauri/src/bootstrap/mod.rs`、`apps/desktop/src-tauri/src/commands/proxy.rs`

---

## Phase 5：质量基线

### 5.1 压测 fixture

脚本：`scripts/generate-stress-fixtures.ts`

生成到 `fixtures/stress/`：
- 10,000 个 `SessionSummary` 对象（50 个不同 host，多样的 path/method/status）
- 1,000 个 `WsMessage` 对象（混合 text/binary/control 帧）
- 50MB 文本 body + gzip 变体

### 5.2 前端压测

- `SessionExplorerPane.stress.test.tsx`：用 10k session 渲染，验证 DOM 仅包含虚拟化条目（非 10k 个节点）。测量 `buildSessionHostGroups` 耗时（< 100ms）。
- `SessionInspectorMessagesPane.stress.test.tsx`：用 1k 消息渲染，验证虚拟化。

### 5.3 Rust 基准测试

- `crates/proxy-core/benches/body_decompress.rs`：对 1MB gzip body 的 `decode_body_bytes` 和 `build_session_detail` 进行基准测试。

### 5.4 发布检查脚本

`scripts/release-checklist.sh`：依次执行 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`cargo test --workspace`、`cargo clippy`。

---

## 迁移安全

| 变更 | 安全策略 |
| ------ | ---------- |
| 虚拟滚动 | 行组件不变，仅滚动容器和位置追踪改变 |
| 日志 | `emit_log` 签名不变，调用点无需修改 |
| TLS 缓存 | `LruCache` API 与 `HashMap` 近乎一致（get/insert/clear） |
| Session 批量化 | 现有 `upsert_session` 保留为便捷封装 |
| 防抖 | 回调语义不变，仅延迟；现有测试不依赖时序断言 |

## 分阶段与依赖关系

```
Phase 0（依赖 + 工具）
  ├── Phase 1（事件 + 防抖）───── 独立 ──┐
  ├── Phase 2（虚拟滚动）─────── 独立 ──┤
  ├── Phase 3（导出 + body）──── 独立 ──┤
  └── Phase 4（Rust 热路径）──── 独立 ──┤
                                          ▼
                                   Phase 5（质量基线）
```

Phase 1-4 在 Phase 0 完成后可并行推进。推荐合并顺序：0 → 1 → 2 → 3 → 4 → 5。

## 不做的事情

- HTTP/2 改造
- 云端能力
- 独立 Mock Server
- 新增 UI 功能

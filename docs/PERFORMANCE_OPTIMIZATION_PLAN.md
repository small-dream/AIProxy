# AIProxy 全局性能优化计划

## 背景

AIProxy 业务功能已基本完善，现从全局出发进行性能优化。本计划基于对前端（React 19 + MUI + Zustand + TanStack Query）、Rust 核心模块（代理、规则引擎、TLS、存储）和构建配置的全面扫描，识别出高/中/低优先级的性能问题，分四个阶段实施，确保不影响现有功能。

---

## Phase 1：快速收益（低风险、高回报的配置与构建优化）

预计耗时：1-2 天

### 1.1 Rust Release Profile 优化
- **文件**: `Cargo.toml`（workspace 根目录）
- **改动**: 添加 `[profile.release]` 配置
  ```toml
  [profile.release]
  lto = true
  codegen-units = 1
  strip = "symbols"
  panic = "abort"
  ```
- **预期收益**: 二进制体积减少 10-20%，运行时性能提升 5-15%
- **风险**: 低。LTO 增加编译时间但不影响运行时行为
- **验证**: `pnpm desktop:bundle` 后对比包体积

### 1.2 Vite 构建目标优化
- **文件**: `apps/desktop/vite.config.ts`
- **改动**: 在 `build` 配置中添加 `target: 'esnext'`，显式设置 `cssCodeSplit: true`，添加 `chunkSizeWarningLimit: 500`
- **预期收益**: 减小 bundle 体积，避免向旧语法转换
- **风险**: 低。Tauri 内置 Chromium，无需兼容旧浏览器
- **验证**: `pnpm --filter @aiproxy/desktop build` 后检查 chunk 大小

### 1.3 chrono 依赖精简
- **文件**:
  - `crates/proxy-core/Cargo.toml`
  - `crates/tls-manager/Cargo.toml`
  - `apps/desktop/src-tauri/Cargo.toml`
- **改动**: 将 `chrono = { version = "0.4", default-features = true, features = ["clock"] }` 改为 `chrono = { version = "0.4", default-features = false, features = ["serde", "std"] }`
- **预期收益**: 减少不必要的 OS 时间绑定，略微减小二进制体积
- **风险**: 低。`Utc::now()` 仅需 `std` feature
- **验证**: `cargo build` 成功，代理功能正常

### 1.4 rquickjs feature 精简
- **文件**: `crates/rule-engine/Cargo.toml`
- **改动**: 将 `rquickjs = { version = "0.8", features = ["full"] }` 改为实际需要的最小 feature 集
- **预期收益**: 减少编译时间和二进制体积
- **风险**: 中。需要审计实际使用的 JS 特性
- **验证**: 脚本规则引擎所有测试通过

### 1.5 PNG 图标优化
- **文件**: `apps/desktop/src-tauri/icons/` 下的 PNG 文件
- **改动**: 使用 `oxipng -o 4` 压缩所有 PNG，重新生成 icns/ico
- **预期收益**: 图标体积减少 30-50%（当前 `128x128@2x.png` 为 440KB）
- **风险**: 低
- **验证**: 应用图标显示正常

---

## Phase 2：前端渲染优化

预计耗时：3-5 天

### 2.1 I18nProvider 上下文值稳定化
- **文件**: `apps/desktop/src/i18n/index.tsx` (lines 124-148)
- **改动**: 用 `useCallback` 包装 `t` 和 `tList`，用 `useMemo` 包装 context value
  ```tsx
  const t = useCallback((key, params) => { ... }, [messages]);
  const tList = useCallback((key) => { ... }, [messages]);
  const value = useMemo(() => ({ locale, preference, setPreference, t, tList }), [...]);
  ```
- **预期收益**: 阻止 i18n 变化导致全应用级联重渲染
- **风险**: 低
- **验证**: React DevTools Profiler 确认切换语言时不会触发无关组件重渲染

### 2.2 关键组件添加 React.memo
- **文件与组件**:
  - `apps/desktop/src/features/sessions/components/SessionExplorerPane.tsx` → `SessionExplorerPane`, `HostRow`, `SessionLeafNode`
  - `apps/desktop/src/features/sessions/components/SessionInspectorJsonTree.tsx` → `JsonTreeRowView`
  - `apps/desktop/src/features/sessions/components/SessionInspectorMessagesPane.tsx` → `MessageRow`
  - `apps/desktop/src/features/sessions/components/SessionContainerTabs.tsx` → `SessionContainerTabs`
- **改动**: 用 `React.memo()` 包装以上组件
- **前置条件**: 确保父组件传入的回调函数用 `useCallback` 稳定化（尤其是 `togglePath`、`onSelectSession`、`onToggleHost`）
- **预期收益**: 大幅减少无关状态变化时的重渲染次数
- **风险**: 低。React.memo 是纯性能优化，不改变行为
- **验证**: React DevTools Profiler 对比优化前后的渲染次数

### 2.3 session-upsert 事件批量化
- **文件**: `apps/desktop/src/pages/sessions/index.tsx` (lines 198-218)
- **改动**:
  1. 添加事件缓冲区，收集 100ms 内的 upsert 事件
  2. 批量更新 `containerState` 而非逐条更新
  3. 使用 `useDeferredValue` 延迟 session 列表计算
  4. 消除 TanStack Query 缓存与本地 state 的双重更新
- **预期收益**: 高流量场景下减少 90%+ 的重渲染次数
- **风险**: 中。需确保批量更新不丢失任何 session 数据
- **验证**: 高流量代理抓包时 UI 流畅度明显改善，无 session 丢失

### 2.4 Session Explorer 列表虚拟化
- **文件**: `apps/desktop/src/features/sessions/components/SessionExplorerPane.tsx` (lines 150-189)
- **改动**: 对展开的 host 组内的 session 叶子节点应用虚拟滚动（复用已有的 `useVirtualWindow` hook 或 `@tanstack/react-virtual`）
- **预期收益**: DOM 节点数从 O(n) 降至 O(视口大小)，大量 session 时不再卡顿
- **风险**: 中。树形结构的虚拟化实现较复杂，需仔细处理展开/折叠状态
- **验证**: 1000+ session 时滚动流畅，内存占用正常

### 2.5 WS Messages 面板虚拟化
- **文件**: `apps/desktop/src/features/sessions/components/SessionInspectorMessagesPane.tsx` (lines 294-306)
- **改动**: 复用 `useVirtualWindow` hook 实现 WS 消息列表虚拟化
- **预期收益**: 高频 WebSocket 连接时不再卡顿
- **风险**: 低
- **验证**: 1000+ WS 消息时滚动流畅

### 2.6 输入框防抖
- **文件**:
  - `apps/desktop/src/features/sessions/components/SessionExplorerPane.tsx` (line 210) — 域名过滤
  - `apps/desktop/src/features/sessions/components/SessionInspectorMessagesPane.tsx` (line 263) — 消息搜索
- **改动**: 添加 200ms debounce，避免每次按键触发 O(n) 的过滤计算
- **预期收益**: 输入时不再卡顿
- **风险**: 低
- **验证**: 快速输入过滤条件时 UI 不卡

### 2.7 TanStack Query 配置优化
- **文件**: `apps/desktop/src/app/providers/AppProviders.tsx` (lines 81-90)
- **改动**:
  1. 默认 `staleTime` 从 10s 提高到 `60_000`（事件驱动更新的数据不需要短轮询）
  2. Session detail 查询添加 `gcTime: 30_000`
  3. Rules/profiles 查询（已有 `staleTime: Infinity`）设置 `gcTime: Infinity`
- **预期收益**: 减少不必要的后台 refetch 和内存占用
- **风险**: 低
- **验证**: Network 面板确认无冗余 IPC 调用

### 2.8 Session 导出 N+1 修复
- **文件**: `apps/desktop/src/features/sessions/components/SessionExportDialog.tsx` (line 270)
- **改动**: 添加客户端并发限制（每批 10 个），或添加 Rust 侧批量查询接口
- **预期收益**: 导出大量 session 时不阻塞 IPC
- **风险**: 低
- **验证**: 导出 500+ session 时 UI 不冻结

### 2.9 Tauri 事件监听器清理修复
- **文件**:
  - `apps/desktop/src/features/sessions/use-session-events.ts` (lines 13-39)
  - `apps/desktop/src/pages/sessions/index.tsx` (lines 199-218)
  - `apps/desktop/src/features/sessions/components/SessionInspectorMessagesPane.tsx` (lines 137-143)
- **改动**: 添加 `cancelled` 标志位，防止组件卸载后仍然注册监听器
- **预期收益**: 消除潜在内存泄漏
- **风险**: 低
- **验证**: 快速切换页面时控制台无报错

---

## Phase 3：Rust 热路径优化（内存 + CPU）

预计耗时：3-5 天

### 3.1 响应体大小限制与流式转发
- **文件**:
  - `crates/proxy-core/src/server.rs` (lines 717-738, `forward_request`)
  - `crates/proxy-core/src/server.rs` (lines 1906-1911, `send_direct_request`)
- **改动**:
  1. 添加可配置的最大 body 大小限制（默认 10MB）
  2. 超过限制的 body 截断并标记 `truncated: true`
  3. 考虑流式转发 + 后台捕获，而非全量缓冲后转发
- **预期收益**: 防止大响应导致 OOM，显著降低内存峰值
- **风险**: 高。核心代理逻辑改动，需要充分测试
- **验证**: 测试大文件下载（>10MB）、API 响应、流式响应均正常

### 3.2 响应体编码优化（消除三重编码）
- **文件**: `crates/proxy-core/src/http_io.rs` (lines 292-327, `build_body_reference`)
- **改动**:
  1. 不再在捕获时同时存储 raw + decoded + base64 + inline text
  2. 仅存储解码后的 bytes，base64 和 inline text 改为按需生成（getter）
  3. 大 body（>64KB）写入磁盘临时文件，内存仅保留引用路径
- **预期收益**: 单个 session 内存占用从 ~4x 降至 ~1x
- **风险**: 高。需确保前端请求 detail 时能正确获取 body 内容
- **验证**: 检查 session 详情页 body 显示正常（包括图片、JSON、二进制）

### 3.3 build_session_detail 去重
- **文件**: `crates/proxy-core/src/server.rs` (lines 468-589)
- **改动**: 将 `build_session_detail` 调用从 5+ 次减少为 1 次。在请求处理完成后构建一次，error/drop 路径复用已构建的 detail
- **预期收益**: 减少不必要的 body 解码和 base64 编码
- **风险**: 中。需仔细处理各错误路径的 session 数据完整性
- **验证**: 代理抓包时 session 详情完整（包括超时、断开等异常场景）

### 3.4 std::sync::Mutex 替换为 parking_lot::RwLock
- **文件**:
  - `crates/proxy-core/src/rules.rs` (RewriteManager, MapManager, ThrottleManager, DnsManager)
  - `crates/rule-engine/src/lib.rs` (ScriptManager)
  - `crates/proxy-core/src/breakpoints.rs` (BreakpointManager)
  - `apps/desktop/src-tauri/src/bootstrap/mod.rs` (AppState 的 ~15 个 Mutex 字段)
- **改动**: 读多写少的场景使用 `parking_lot::RwLock`，避免全量 clone
- **预期收益**: 减少锁争用，消除热路径上的 Vec clone
- **风险**: 中。需确保写锁使用正确，避免死锁
- **验证**: 高并发代理时无死锁，规则匹配正确

### 3.5 TLS 证书缓存优化
- **文件**:
  - `crates/tls-manager/src/resolver.rs` (lines 31-82)
  - `crates/tls-manager/src/storage.rs` (lines 24-34)
- **改动**:
  1. 在 `RootCaPair` 构建时预计算并缓存 issuer certificate，避免每次新 hostname 重新签名
  2. `CertStorage::clone()` 共享 `host_cache`（用 `Arc` 包装）
- **预期收益**: 新 HTTPS 连接时 CPU 开销降低，消除重复证书签名
- **风险**: 中。需确保缓存失效场景正确处理
- **验证**: 首次访问新域名时代理速度改善

### 3.6 规则匹配索引优化
- **文件**: `crates/proxy-core/src/rules.rs` (lines 411-478)
- **改动**:
  1. 规则按 `(workspace_id, stage)` 建立 HashMap 索引
  2. 保持规则按 priority 预排序
  3. 替换全量遍历为索引查找
- **预期收益**: 规则数量多时匹配速度显著提升
- **风险**: 中。需确保规则增删时索引正确更新
- **验证**: 添加 100+ 规则时代理性能不下降

### 3.7 SQLite 写入异步化
- **文件**: `apps/desktop/src-tauri/src/bootstrap/mod.rs` (lines 302-385, `upsert_session`)
- **改动**: 使用 `tokio::task::spawn_blocking` 将 SQLite 写入移到专用线程，或使用 channel-based 后台写入器
- **预期收益**: 不再阻塞 Tauri async runtime 线程
- **风险**: 中。需确保写入顺序和数据一致性
- **验证**: 高流量时代理不出现卡顿，session 数据完整

### 3.8 send_direct_request 复用 HTTP Client
- **文件**: `crates/proxy-core/src/server.rs` (lines 1881-1885)
- **改动**: 接受共享 `Client` 引用而非每次创建新 client
- **预期收益**: 复用连接池和 DNS 缓存
- **风险**: 低
- **验证**: Compose 和批量执行功能正常

### 3.9 日志写入优化
- **文件**: `crates/proxy-core/src/logging.rs` (lines 1-34)
- **改动**: 使用 `tokio::fs` 异步写入，或缓冲日志行后批量刷盘
- **预期收益**: 不再阻塞 async tokio task
- **风险**: 低
- **验证**: 日志正常输出，代理性能不受日志影响

### 3.10 WebSocket 帧掩码优化
- **文件**: `crates/proxy-core/src/ws.rs` (lines 181-186)
- **改动**: 就地 XOR 掩码，避免每帧分配新 Vec
- **预期收益**: 高频 WS 流量时减少分配压力
- **风险**: 低
- **验证**: WS 消息收发正常

### 3.11 build_raw_http_message 预分配
- **文件**: `crates/proxy-core/src/http_io.rs` (lines 373-396)
- **改动**: 根据 headers 和 body 大小预计算并 `String::with_capacity` 预分配
- **预期收益**: 减少 String 重新分配次数
- **风险**: 低
- **验证**: session 详情中 raw HTTP 消息显示正常

### 3.12 save_session_to_collection 查询优化
- **文件**:
  - `apps/desktop/src-tauri/src/commands/mod.rs` (line 2308)
  - `crates/db/src/sessions.rs`
- **改动**: 添加 `load_session_summary_by_id` 函数，使用 `SELECT ... WHERE id = ?` 替代加载 50K 行
- **预期收益**: O(1) 查询替代 O(50000) 扫描
- **风险**: 低
- **验证**: 保存 session 到 collection 功能正常

---

## Phase 4：数据流与架构优化

预计耗时：3-5 天

### 4.1 session-upsert 事件瘦身
- **文件**:
  - `apps/desktop/src-tauri/src/bootstrap/mod.rs` (upsert_session 事件发射)
  - `apps/desktop/src/services/events/index.ts` (前端监听)
  - `packages/shared-types/src/index.ts` (类型定义)
- **改动**:
  1. `session-upsert` 事件仅发送 `SessionSummary`（不含 body 和 raw message）
  2. 前端仅在用户点击 session 时通过 `get_session_detail` 获取完整数据
  3. 更新 shared-types 中的事件类型定义
- **预期收益**: 单次事件数据量从 MB 级降至 KB 级，IPC 压力大幅降低
- **风险**: 高。影响前后端数据流契约，需同步修改 shared-types 和 API_SPEC
- **验证**: session 列表实时更新正常，点击 session 后详情加载正常

### 4.2 Breakpoint 事件瘦身
- **文件**:
  - `packages/shared-types/src/index.ts` (BreakpointHit 类型, lines 191-203)
  - `crates/proxy-core/src/breakpoints.rs`
- **改动**: BreakpointHit 事件仅发送 metadata（sessionId, stage, method, url），body 和 headers 通过 `get_session_detail` 按需加载
- **预期收益**: 大 body 的断点命中时不再阻塞 IPC
- **风险**: 高。需确保断点编辑功能（修改 request/response）仍然完整可用
- **验证**: 断点命中、编辑、放行全流程正常

### 4.3 Session 列表分页
- **文件**:
  - `apps/desktop/src-tauri/src/commands/mod.rs` (list_sessions, line 165)
  - `apps/desktop/src/services/commands/index.ts` (前端调用)
  - `crates/db/src/sessions.rs` (数据库查询)
- **改动**:
  1. 实现 `docs/API_SPEC.md` 中已定义但未实现的 `ListSessionsInput`（含 limit、cursor、filter）
  2. 前端实现游标分页加载
  3. 内存中不再保留全部 15K session summaries
- **预期收益**: 内存占用从 O(总session数) 降至 O(当前页大小)
- **风险**: 高。影响核心 session 列表功能，需确保搜索、过滤、排序不受影响
- **验证**: 滚动加载正常，过滤搜索正常，内存占用合理

### 4.4 Session Detail 缓存策略优化
- **文件**: `apps/desktop/src-tauri/src/bootstrap/mod.rs` (lines 338-385, session_details HashMap)
- **改动**:
  1. 内存中仅缓存最近访问的 200 个 session detail
  2. 超出的 detail 从 SQLite 按需加载
  3. eviction 策略改为 LRU
- **预期收益**: 内存占用从 O(15000 * detail_size) 降至 O(200 * detail_size)
- **风险**: 中。需确保前端切换 session 时 detail 加载无明显延迟
- **验证**: 快速切换不同 session 时详情加载流畅

### 4.5 Script 引擎线程池
- **文件**: `crates/rule-engine/src/lib.rs` (lines 334-339)
- **改动**: 使用固定大小的线程池替代每次 spawn 新线程，考虑复用 QuickJS runtime
- **预期收益**: 多脚本规则匹配时减少线程创建开销
- **风险**: 中。需确保脚本间状态隔离，无数据泄露
- **验证**: 多个脚本规则同时生效时执行结果正确

### 4.6 代理连接缓冲池
- **文件**: `crates/proxy-core/src/server.rs` (line 1696)
- **改动**: 使用 `bytes::BytesMut` 或缓冲池替代每次连接分配 8KB buffer
- **预期收益**: 高并发时减少分配压力
- **风险**: 低
- **验证**: 高并发代理时性能稳定

---

## 通用验证策略

### 每个 Phase 完成后的验证清单

1. **功能验证**:
   - `pnpm --filter @aiproxy/desktop test` — 所有测试通过
   - `pnpm --filter @aiproxy/desktop typecheck` — 类型检查通过
   - `pnpm --filter @aiproxy/desktop lint` — 代码规范通过
   - `cargo test --workspace` — Rust 测试通过

2. **性能验证**:
   - React DevTools Profiler 对比优化前后渲染次数
   - Chrome Memory 面板对比内存占用
   - 高流量代理（100+ 并发请求）时 UI 流畅度
   - 大 body 响应（>10MB）时代理稳定性

3. **回归验证**:
   - 代理抓包（HTTP/HTTPS）正常
   - 断点功能正常
   - 规则引擎（Rewrite/Map/Script）正常
   - Session 导出正常
   - WebSocket 消息捕获正常
   - Compose 发送请求正常
   - 跨平台（macOS）功能正常

4. **构建验证**:
   - `pnpm desktop:build` 成功
   - `pnpm desktop:bundle` 成功
   - 对比 bundle 体积变化

---

## 文档同步清单

以下文档需在对应改动完成后同步更新：

- `docs/API_SPEC.md` — session-upsert 事件类型变更、list_sessions 分页参数变更
- `docs/ARCHITECTURE.md` — 数据流优化说明、缓存策略变更
- `docs/PAGE_BLUEPRINTS.md` — session 列表虚拟化、事件批量化的状态模型变更

---

## 总体时间估算

| Phase | 耗时 | 风险 |
|-------|------|------|
| Phase 1: 快速收益 | 1-2 天 | 低 |
| Phase 2: 前端渲染优化 | 3-5 天 | 低-中 |
| Phase 3: Rust 热路径优化 | 3-5 天 | 中-高 |
| Phase 4: 数据流与架构优化 | 3-5 天 | 高 |
| **总计** | **10-17 天** | |

建议按 Phase 顺序执行，每个 Phase 完成后做一次完整的功能回归测试再进入下一阶段。

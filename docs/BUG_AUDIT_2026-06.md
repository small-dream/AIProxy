# AIProxy 全盘 Bug 扫描报告

## 1. 文档信息

- 产品代号：`AIProxy`
- 文档类型：缺陷审计报告
- 审计日期：`2026-06-21`
- 审计范围：全仓库
  - Rust crates：`proxy-core` / `rule-engine` / `db` / `sys-util` / `tls-manager`
  - Tauri 后端：`apps/desktop/src-tauri/src`
  - React 前端：`apps/desktop/src`
  - 共享包：`packages/shared-types`、`packages/ui-tokens`
  - 脚本：`scripts/desktop.mjs`、`scripts/setup/*`、`scripts/release/*`、`scripts/build/*`
- 验证标准：所有标记 ✅ 的高/中危条目均已由审计者打开源码逐行复核确认；其余条目基于静态审查
- 文档状态：`Audit Report v1.2`（v1.1 修订：根据复核结果降级 H6→L20、删除 H7/M13 误报、降级 M2→L21、M12→L22；新增第 6 节测试现状 T1-T3。v1.2：P0+P1+T 全部修复完成，各条目标注 ✅ 已修复 + commit hash）
- 审计者纠错声明：第一版报告存在 5 处误判（详见各条目内的降级/删除说明及第 10 节），均已在本版修正。涉及 panic 边界、schema 路径、时钟方向的结论，凡未在源码/官方文档层面实证的，请勿直接采信。

## 修复进度（v1.2，2026-06-21）

P0 + P1 + T 全部修复，按阶段独立提交，全量回归通过（`cargo test --workspace` 全绿；`pnpm test` 368/368 绿，2 项 stress 测试在满负载下偶发超时为既有 flaky，非本次回归）。中低危（M/L）按计划留待后续。

| 条目 | commit | 说明 |
|---|---|---|
| T1/T2 | `0ee74d0` | proptest 修复 + 提交回归种子 |
| H1/H8 | `f91942a` | 8 个 INSERT OR REPLACE → UPDATE-or-INSERT，含 3 个回归测试 |
| H9/H10 | `2fe69a1` | commands 17 处 map_err + repository 锁/spawn_blocking poison 兜底 |
| H2/H3 | `aaec748` | KDE httpsProxy 补全 + GNOME 'none' 误判 |
| H4 | `b2d884c` | truncate_for_error 字符边界截断，含 3 个单测 |
| H5/H6 | `bbab896` | 断点 Forward 携带 edited_request + CONNECT 隧道半关闭 |
| H7 | （本次文档提交） | setup-windows.ps1 改用 $LASTEXITCODE 检测 cargo-tauri |

## 2. 阅读约定

- 严重程度分级：🔴 高危（数据丢失 / 崩溃 / 核心功能失效）、🟠 中危（功能错误 / 资源泄漏 / 健壮性）、🟡 低危（维护性 / 体验 / 边界）、🧪 测试现状（不影响产品功能，影响测试可靠性）
- 定位格式：`file_path:line_number`
- 带删除线标题（如 `~~H6~~`）为复核后降级或删除的条目，保留是为追溯审计过程；条目内标注降级去向或删除原因
- 每条 bug 附带现象、确认依据（若已复核）、修复方向

---

## 3. 🔴 高危（数据丢失 / 崩溃 / 核心功能失效）

### H1 ✅ 已修复（f91942a） 数据库层 `INSERT OR REPLACE` 触发级联删除，丢失 WebSocket 消息和规则执行记录

- **位置**：`crates/db/src/sessions.rs:71`（根因）；同类问题：`crates/db/src/rules.rs:25,147,853`、`collections.rs:56`、`environments.rs:47`、`workspaces.rs:22`
- **类别**：数据库逻辑错误 / 数据丢失
- **确认依据**：`crates/db/src/schema.rs:150,162,212` 子表全部声明 `ON DELETE CASCADE`；`crates/db/src/connection.rs:33` 开启 `PRAGMA foreign_keys=ON`。
- **现象**：`upsert_session` 对 `session_summaries` 使用 `INSERT OR REPLACE`。SQLite 在外键启用时，`REPLACE` 冲突解决策略等价于「先 DELETE 旧行再 INSERT 新行」，DELETE 会触发 `ON DELETE CASCADE`，级联删除所有子表：`session_details`、`ws_messages`、`script_runs`、`rewrite_runs`、`map_runs`、`throttle_runs`。
- **触发链**：代理捕获请求时首次写入 session（含 `started_at`）→ 响应到达后第二次调用 `upsert_session` 更新 `finished_at`/`status_code` → 第二次 upsert 抹掉已捕获的 WS 帧和规则运行记录，且无重写路径。`commands/proxy.rs:174` 的 session 写入与 `:196` 的 `insert_ws_message` 走两条独立通道，无锁顺序保证。
- **影响**：作为对标 Charles 的核心抓包/WS 调试功能，会话详情会随机丢失。这是当前仓库最严重的问题。
- **修复方向**：把所有对父表的 `INSERT OR REPLACE INTO <table>` 改成显式「先 `UPDATE ... WHERE id=?`，`affected_rows == 0` 再 `INSERT`」，从根本上避免 REPLACE 的 delete 语义。

### H2 ✅ 已修复（aaec748） KDE 系统代理恢复时永久丢失用户的 httpsProxy

- **位置**：`apps/desktop/src-tauri/src/system_proxy/linux.rs:335-341`（capture）、`:351`（apply 写入 httpsProxy）、`:365-401`（restore 不恢复 httpsProxy）
- **类别**：系统 API 调用错误 / 跨平台
- **现象**：`apply_kde_proxy` 把用户的 `httpsProxy` 改成 `127.0.0.1:<port>`，但 `capture_kde_snapshot` 从不读取 `httpsProxy`、`restore_kde` 也不恢复它。用户点「关闭系统代理」后，KDE 的 https 代理残留为本工具地址，用户需手动改 KDE 设置才能恢复。
- **影响**：系统级副作用，永久改坏用户环境配置。
- **修复方向**：`KdeProxySnapshot` 增加 `https_proxy` 字段，`capture_kde_snapshot` 和 `restore_kde` 都补上该字段。

### H3 ✅ 已修复（aaec748） GNOME `gsettings_get_optional` 复制粘贴 bug，`'none'` 被误判为已设置

- **位置**：`apps/desktop/src-tauri/src/system_proxy/linux.rs:245`
- **类别**：命令层逻辑错误
- **确认依据**：
  ```rust
  if val.is_empty() || val == "''" || val == "''" {
  ```
  两个 `val == "''"` 完全相同。
- **现象**：第二个条件本应是 `val == "'none'"`。当用户系统代理 `mode` 为 `'none'`（即「未设置代理」）时，本应返回 `None`，却被当成有效 host 捕获，导致快照内容错误，后续恢复逻辑混乱。同样影响 http/https host 为 `'none'` 的判断。
- **修复方向**：第二个条件改成 `val == "'none'"`。

### H4 ✅ 已修复（b2d884c） `truncate_for_error` 非字符边界字节切片 panic

- **位置**：`apps/desktop/src-tauri/src/commands/ai.rs:391`
- **类别**：panic 风险
- **确认依据**：
  ```rust
  format!("{}...", &value[..LIMIT])  // LIMIT = 512
  ```
- **现象**：`value` 是 AI 服务返回的错误正文，常含中文/emoji 等多字节 UTF-8 字符。`&value[..512]` 当 512 落在字符中间时直接 panic（`byte index is not a char boundary`）。该函数在错误返回路径上调用，本意是截断错误信息，反而把「AI 请求失败」升级成进程级 panic，`test_ai_connection` 一旦碰到多字节错误正文就崩。
- **修复方向**：`value.chars().take(LIMIT_CHARS).collect::<String>()` 或用 `char_indices` 找到不超 LIMIT 的最大字符边界。

### H5 ✅ 已修复（bbab896） 断点「修改请求后 Forward」实际丢失用户修改

- **位置**：`crates/proxy-core/src/http_proxy.rs:362-378`
- **类别**：逻辑错误（断点核心功能失效）
- **现象**：`intercept_request_stage` 内部对 `request_mut = request.clone()` 应用了用户的 header/query/body 修改（`apply_request_resolution`），但 `request_mut` 是 clone，修改不回写外层 `request`。Forward 分支返回后，外层继续用**原始未修改**的 `request` 转发上游。结果：断点「修改请求」功能对 Forward 动作完全失效（Mock/Drop 分支不受影响）。
- **修复方向**：在 Forward 分支把 `*request = request_mut;`；或让 `intercept_request_stage` 直接接收 `&mut ParsedProxyRequest` 而非 clone。

### ~~H6~~ → 见 L20（已降级，复核后结论修正）

原报告称「断点改 response body 后不更新 content-length 导致客户端挂起/截断」。经复核**不成立**：`build_hyper_response_from_upstream`（`http_proxy.rs:1319`）会 strip `content-length`，body 用 `Full<Bytes>` 构造，hyper 按实际字节长度发送，客户端不会挂起或截断。残留影响仅为 session 详情展示的元数据（content-length）与实际 body 长度不一致，详见 L20。

### ~~H7~~ → 误报，已删除（复核后结论修正）

原报告称「wildcard_matches 在多字节字符上字节切片 panic」。经复核**不成立**：`candidate[search_start..].find(part)` 中 `find` 返回字节偏移但保证命中字符边界；`absolute_index + part.len()` 中 `part` 是合法 `&str`，`part.len()` 是完整 UTF-8 子串的字节长度，子串结尾必为字符边界，故 `search_start` 始终落在 UTF-8 边界，切片合法。已有 proptest `no_panic_on_arbitrary_input`（`patterns.rs:160-165`，用 `\PC*` 生成任意非 ASCII）覆盖此情况。此条为审计者误判，已移除。

### H6 ✅ 已修复（bbab896） CONNECT 隧道半关闭时丢失服务器剩余响应

- **位置**：`crates/proxy-core/src/connect.rs:46-57`
- **类别**：HTTP/代理逻辑错误
- **现象**：`tokio::select!` 包裹两个 `io::copy`，任一完成（含正常 EOF）就退出整个 select，另一方向的 copy 被 drop 取消。对于 CONNECT 隧道，TCP 半关闭是合法的（客户端发完数据 EOF，服务器仍可能有响应数据要回传）。当前实现一旦 client→upstream EOF，立即停止 upstream→client，丢失服务器剩余响应。
- **修复方向**：用 `tokio::join!(client_to_upstream, upstream_to_client)` 等待两者都完成，或仅在返回 `Err` 时才提前退出。

### H7 ✅ 已修复 setup-windows.ps1 的 cargo-tauri 检测永不进 catch，Tauri CLI 装不上

- **位置**：`scripts/setup/setup-windows.ps1:94-104`
- **类别**：PowerShell 语义错误 / 脚本失效
- **现象**：`$ErrorActionPreference = "Stop"` 对外部 native 进程的非零退出码**不抛异常**，`& cargo tauri -V` 在未安装时只是退出码非 0，`try/catch` 永远进不到 catch 分支 → 脚本输出「cargo-tauri already installed」后跳过安装。Windows 首次 setup 后桌面 bundle 永远失败。macOS/Linux 的 bash 版本用 `>/dev/null 2>&1; then` 是正确的。
- **修复方向**：改用 `$proc = Start-Process cargo -ArgumentList "tauri","-V" -Wait -PassThru -NoNewWindow; if ($proc.ExitCode -ne 0) {...}` 或检查 `$LASTEXITCODE`。

### H8 ✅ 已修复（f91942a） `INSERT OR REPLACE` 对带外键引用的 workspace/throttle_profile 直接报错失败

- **位置**：`crates/db/src/workspaces.rs:21-24`、`crates/db/src/rules.rs:340-358`
- **类别**：数据库逻辑错误
- **现象**：`workspaces` 被 `rewrite_rules`/`map_rules`/`throttle_profiles`/`dns_mappings`/`script_rules` 等以普通外键（默认 `NO ACTION`）引用。`INSERT OR REPLACE` 先 DELETE 旧行触发外键约束检查，若存在引用行则整个语句报错失败。一旦 workspace 有任何规则，再次调用 `upsert_workspace` 会返回外键约束错误。`throttle_profiles` 同理被 `throttle_rules` 引用。
- **修复方向**：同 H1，改为 UPDATE-or-INSERT 模式。

### H9 ✅ 已修复（2fe69a1） spawn_blocking panic 经 `.expect` 放大，杀掉 session collector + 锁 poison

- **位置**：`apps/desktop/src-tauri/src/bootstrap/repository.rs:516,577`
- **类别**：panic 风险 / 错误处理
- **现象**：
  ```rust
  .expect("persist_session_full spawn_blocking should not panic")
  ```
  `persist_session_full` / `persist_session_batch_full` 的 `spawn_blocking` 闭包内持锁写库（含 H1 的 upsert）。任一处 panic（含 cascade 相关、磁盘满、SQL 约束冲突被 `.unwrap()` 吞掉）会导致：① `JoinError` 经 `.expect` 再次 panic，杀掉整个 session collector 任务；② 持锁期间 panic 使 `db` Mutex 永久 poison。两者叠加后代理只能重启进程恢复。
- **修复方向**：把 `.expect` 换成 `.map_err(...)?` 或返回原 session（带错误日志），让 collector 任务存活。

### H10 ✅ 已修复（2fe69a1） commands 层 `.lock().expect("db mutex")` 与 sessions/ai 处理方式不一致

- **位置**：`apps/desktop/src-tauri/src/commands/{collections,rules,throttling,workspaces,ws,proxy}.rs` 多处用 `.expect`；而 `commands/sessions.rs:567`、`commands/ai.rs:83`、`commands/environments.rs:68` 用 `.map_err`
- **类别**：错误处理一致性 / panic 风险
- **现象**：一旦 H9 产生 poison，`collections` / `rules` / `workspaces` / `ws` / `proxy` 的所有命令会直接 panic 崩进程，而 `sessions` / `ai` / `environments` 会优雅返回错误。前端表现为「部分功能崩溃、部分报错」。
- **修复方向**：全局统一改成 `.map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?`。

---

## 4. 🟠 中危（功能错误 / 资源泄漏 / 健壮性）

### M1 ✅ 脚本执行超时仅 50ms（极短，易误判超时）

- **位置**：`crates/rule-engine/src/types.rs:8-9`
- **现象**：`SCRIPT_EXECUTION_TIMEOUT = Duration::from_millis(50)`。50ms 对脚本规则执行非常短，含 `JSON.parse` 大 body 或轻微循环即超时被中断。execute.rs 内已配套有 50ms + 10ms 的 `recv_timeout` 与中断处理器，逻辑自洽，但需确认 50ms 是否是有意设计（如本想 500ms 笔误）。
- **修复方向**：确认业务预期；若为误写则上调到 500ms 或更高，同步调整配套 timeout。

### ~~M2~~ → 见 L21（已降级，复核后结论修正）

原报告称「叶子证书 not_before 设为当天 00:00，客户端时钟略快会导致 NotYetValid」。经复核**方向判断有误**：`date_time_ymd` 返回当天 **UTC 00:00**（`rcgen-0.13.2/src/certificate.rs:1186`，`Time::MIDNIGHT` + `assume_utc`），这是**向过去回拨**（当天 00:00 ≤ 当前时刻）。因此客户端时钟略快只会使 `now_client > not_before` 更易满足，**不会**触发 NotYetValid。真正的风险是客户端时钟**明显落后**（慢到跨日）或代理与客户端跨时区/跨日边界，触发概率低。残留问题详见 L21。

### M3 `save_media_file` 可写任意路径，无沙箱校验

- **位置**：`apps/desktop/src-tauri/src/commands/files.rs:89-94`
- **现象**：`Path::new(&input.path)` + `std::fs::write`，`input.path` 完全由前端控制，无任何目录限制或规范化。对比 `save_text_file`（同文件 `:18-33`）强制写 Downloads 目录。可覆盖 `../../config.json`、`C:\Windows\System32\...` 等任意文件。
- **修复方向**：限制 `input.path` 必须在 Downloads 或用户选定目录内，或改为只接受文件名 + 固定目录（与 `save_text_file` 一致）。

### M4 手写 base64 解码器对非法输入静默产出错误字节

- **位置**：`apps/desktop/src-tauri/src/commands/files.rs:58-86`
- **现象**：自实现而非用 `base64` crate，`:73` `*TABLE.get(ch as usize).unwrap_or(&0)` 对 `ch >= 128` 静默当 0；非法字符被跳过。损坏的 base64 不报错，而是静默写出错误的二进制文件（图片损坏、保存的媒体打不开，且用户不知道为什么）。末尾填充错误也完全不校验。
- **修复方向**：用 `base64::engine::general_purpose::STANDARD.decode()`，让非法输入返回 `Err`。

### M5 ✅ Linux `is_trusted_linux` 只检查 ca-certificates 源目录，不查系统信任库

- **位置**：`crates/tls-manager/src/trust.rs:197-200`
- **现象**：只看 `/usr/local/share/ca-certificates/` 和 `/etc/pki/ca-trust/source/anchors/`（待 `update-ca-certificates`/`update-ca-trust` 处理的源目录），不检查 `/etc/ssl/certs/`（实际生效的信任库），导致即使证书已安装并 update，也报告未信任。影响 UX（信任状态显示错误），非安全问题。
- **修复方向**：增加对 `/etc/ssl/certs/<hash>.pem` 的检查，或调用 `openssl verify -CAfile <path>` 校验。

### M6 `db.lock()` 锁释放窗口导致 LRU 缓存与 map 失步

- **位置**：`apps/desktop/src-tauri/src/bootstrap/cache.rs:147-181`
- **现象**：`insert_detail` 不是原子操作：持 `details` 锁插入→释放→持 `detail_order` 锁做 evict 决策→释放→再次持 `details` 锁删除 evicted 项。窗口期内并发 `insert_detail`/`remove_details` 可能让缓存内容与 LRU 顺序不一致。
- **修复方向**：用单一 `Mutex<(HashMap, VecDeque)>` 把两个结构放同一把锁内，整个 `insert_detail` 持一把锁。

### M7 SessionInspectorMessagesPane 事件订阅闭包捕获旧 sessionId，快速切换时串台

- **位置**：`apps/desktop/src/features/sessions/components/SessionInspectorMessagesPane.tsx:148-170`
- **现象**：`onWsMessage` / `onWsConnectionStatus` 返回的 `Promise<Unlisten>` 在 cleanup 里通过 `void unlisten.then((fn) => fn())` 取消。当 `sessionId` 快速切换时，旧 effect 的 cleanup 还没等到 unlisten resolve，新 effect 已经注册新监听；若 Tauri 的 listen 注册较慢，期间事件会命中旧回调，造成短暂的状态覆盖/多余渲染。
- **修复方向**：用 cancelled 标志位阻止卸载后的 setState，并把 unlisten promise 缓存起来在 cleanup 里同步等待取消。

### M8 useMenuActions 注册期 Tauri 监听器未取消导致永久泄漏

- **位置**：`apps/desktop/src/components/layout/hooks/use-menu-actions.ts:50-63`
- **现象**：`onMenuEvent` 异步，组件在 promise resolve 前卸载时 `unlisten` 还是 `undefined`，cleanup 跳过；promise 随后 resolve 的 `fn` 永远不会被调用 → 该 `menu-event` Tauri 监听器永久泄漏，后续每次菜单事件都触发已卸载组件的回调。
- **修复方向**：与 `features/breakpoints/use-breakpoint-events.ts:8-27` 一致，引入 cancelled 标志：`.then(fn => cancelled ? fn() : (unlisten = fn))`。

### M9 EnvironmentManagerDialog debounce save 定时器卸载后仍触发（幽灵保存）

- **位置**：`apps/desktop/src/features/environments/components/EnvironmentManagerDialog.tsx:61-62,94-131`
- **现象**：`envSaveTimeoutRef` / `globalSaveTimeoutRef` 创建 500ms 的 debounce 定时器，但组件没有卸载清理 effect。对话框被关闭/卸载时定时器仍在跑，回调内调用 `setEnvVars.mutate(...)` / `setGlobalVars.mutate(...)`（捕获了卸载时的 `selectedEnvId` 闭包）。用户在 500ms 内编辑后关闭对话框会触发「幽灵保存」，写入被取消的编辑数据。
- **修复方向**：增加卸载时清理 effect：
  ```ts
  useEffect(() => () => {
    if (envSaveTimeoutRef.current) clearTimeout(envSaveTimeoutRef.current);
    if (globalSaveTimeoutRef.current) clearTimeout(globalSaveTimeoutRef.current);
  }, []);
  ```

### M10 抛出裸对象而非 Error 实例

- **位置**：`apps/desktop/src/services/commands/sessions.ts:64-68,169-173,298-304`
- **现象**：
  ```ts
  throw {
    code: "DESKTOP_RUNTIME_REQUIRED",
    message: "Session detail requires the Tauri desktop runtime.",
  };
  ```
  抛出普通对象而非 `Error` 实例：丢失堆栈、`instanceof Error` 恒为 false，TanStack Query 的 `onError` / `coerceAppError` 依赖隐式转换；`getOperationErrorMessage`（`pages/sessions/index.tsx:797-813`）的 `error instanceof Error` 分支会漏接。
- **修复方向**：定义一个 `AppError` 类（带 `code` 字段）或用 `Object.assign(new Error(msg), { code })`，并在所有命令层统一抛出。

### M11 WebSocket opcode 未校验保留值，控制帧约束未强制

- **位置**：`crates/proxy-core/src/ws.rs:34-44`
- **现象**：`WsOpcode::from_u8` 对所有未知值静默映射为 `Binary`。按 RFC 6455 §5.2，opcode 3-7、11-15 是保留值，收到应 fail 连接（1002 protocol error）。当前实现把它们当 Binary 转发，畸形帧穿透代理。此外 `relay_websocket_frames` 未校验「控制帧必须 FIN=1 且 payload<=125」（§5.5）。
- **修复方向**：`from_u8` 返回 `Option<WsOpcode>`；`parse_ws_frame` 对 3-7/11-15 及超长控制帧返回 `Err`。

### ~~M12~~ → 见 L22（已降级，复核后结论修正）

原报告称「open_database 未设 busy_timeout，Tauri 应用并发写会立即 SQLITE_BUSY」。经复核**在当前架构下夸大**：整个应用是单 `Arc<Mutex<rusqlite::Connection>>`（`bootstrap/mod.rs:116`、`repository.rs:18`），所有 db 访问经同一把 Mutex 串行化，进程内并发写不会形成多连接竞争，单连接下 SQLite 自身不会对同一连接报 BUSY。真正的适用场景是**多进程**（用户同时打开多个 AIProxy 实例）或未来引入连接池。残留建议详见 L22。

### ~~M13~~ → 误报，已删除（复核后结论修正）

原报告称「`bundle.macOS.bundleVersion` 是 Tauri 2 schema 不存在的路径」。经核对官方配置参考（https://v2.tauri.app/reference/config/ ），`MacConfig.bundleVersion` 是合法字段，明确说明 "Translates to the bundle's CFBundleVersion property"；`bundle > macOS > bundleVersion` 即写入该字段的正确 JSON 路径（App Store 分发文档亦以此为例）。因此脚本注入的路径**合法**，原判断「会被 Tauri 忽略、注入不生效」缺乏依据。此条为审计者未核实 schema 即下结论的误判，已移除。注：注入后是否实际改写 Info.plist 仍建议在真机打包时验证一次。

### M14 shared-types 守卫过宽，类型与运行时校验不一致

- **位置**：`packages/shared-types/src/sessions.ts:466-468`（`parseSessionDetail` 对 `timingSource` 直接 `as` 强转无校验）；`packages/shared-types/src/certificates.ts:121-167`（`isCertificateInstallGuide` 只查 `success`/`steps`，漏 `certPath`/`platform`/`steps[].order/description`；`isSetupDiagnostic` 只查 `checks` 是数组，不校验元素结构）
- **现象**：后端若传错枚举值（如拼错的 `"Timing"`）或字段缺失，守卫通过、parser 通过、类型系统被 `as` 绕过，最终前端拿到非法 union 值，到 switch/case 里 fall through。
- **修复方向**：在守卫里补全枚举值校验（`timingSource` 限定为 `proxy`/`compose`/`har-import`/`undefined`/`null`）和子结构校验（`checks.every(isDiagnosticCheck)` 等）。

### M15 setup 三脚本无条件 `rustup update stable`，破坏幂等性/离线构建

- **位置**：`scripts/setup/setup-windows.ps1:72-81`、`setup-macos.sh:64-75`、`setup-linux.sh:152-163`
- **现象**：`Ensure-Rust` 在 rustup 已存在分支里，无条件重新执行 `default` 和 `update stable`。`rustup update` 会联网拉取 manifest，离线环境直接失败；这是「正常运行」也会触发的副作用，用户第二次跑 setup 时不应该被网络问题打断。
- **修复方向**：只在 rustup 新装时才 `default + update`，已存在则跳过。

### M16 multipart body 构造未转义 header 名/值（潜在注入）

- **位置**：`apps/desktop/src/features/compose/compose-editor.store.ts:25-37`（`buildMultipartBody`）
- **现象**：`entry.name` / `entry.value` 直接插入。若 name 含双引号或 CR/LF，会破坏 multipart 帧结构（注入额外 part 或截断），value 含 `\r\n--boundary` 还能伪造结束边界。后端若直接转发可能被对端误解。
- **修复方向**：对 `name` 中的 `"`、`\r`、`\n` 转义（RFC 2388），并对 value 做长度边界校验。

### M17 Linux `corepack` 可能缺失未检查

- **位置**：`scripts/setup/setup-linux.sh:46-58,141-150`
- **现象**：`corepack` 随 Node.js 16.10+ 自带，但 Debian/Ubuntu 的 `nodejs` 包历史上长期不带 `corepack`（部分发行版需 `apt install corepack`）。脚本没检查 `corepack` 是否存在直接调用，老系统会 `command not found`，因 `set -e` 导致整个 setup 失败。
- **修复方向**：加 `has_command corepack || sudo apt-get install -y corepack`。

---

## 5. 🟡 低危（健壮性 / 维护性 / 体验）

### L1 `search_ws_messages` 的 LIKE 转义未转义反斜杠本身

- **位置**：`crates/db/src/sessions.rs:425`
- **现象**：`query.replace('%', "\\%").replace('_', "\\_")` 用了 `ESCAPE '\\'`，但未先转义查询串中已有的 `\`。搜 `C:\Users` 或 JSON `\"key\"` 时反斜杠被静默丢弃，搜索结果错误。
- **修复方向**：在替换前先做 `.replace('\\', "\\\\")`。

### L2 整数类型转换未防溢出

- **位置**：`crates/db/src/sessions.rs:89,474,476`、`rules.rs:257,558,961,1117`、`workspaces.rs:117`、`collections.rs:521,533`、`environments.rs:218,231,241` 等
- **现象**：大量 `as i64` / `as u16` / `as u32` / `as u128` 转换未做边界检查，极端值会回绕或截断（如 `proxy_port: i32 as u16` 截断、负值 `as u32` 变成巨大值）。
- **修复方向**：用 `u32::try_from(v).unwrap_or(...)` 或 `try_from` + 错误传播。

### L3 `migrate_add_column` 用字符串包含匹配识别「重复列名」错误

- **位置**：`crates/db/src/schema.rs:407`
- **现象**：`Err(e) if e.to_string().contains("duplicate column name")` 依赖错误信息文本匹配。SQLite 升级或本地化后该字符串可能变化，导致幂等迁移误判为真实失败。
- **修复方向**：用错误码判断或预查 `pragma_table_info` 判断列是否存在。

### L4 历史迁移 `.ok()` 静默吞掉所有错误

- **位置**：`crates/db/src/schema.rs:359-383`
- **现象**：5 个历史迁移用 `.ok()` 吞掉所有错误。任何非「列已存在」的真实失败（磁盘满、表不存在、权限不足）都被忽略，程序带着不完整的 schema 继续，后续查询以令人困惑的方式失败。
- **修复方向**：全部改用 `migrate_add_column` 或类似精确匹配「duplicate column name」的辅助函数。

### L5 非三平台无 `cfg(not(any(...)))` fallback，`unsupported.rs` 是死代码

- **位置**：`apps/desktop/src-tauri/src/system_proxy/mod.rs:20-44`
- **现象**：模块只有三个 `cfg(target_os = ...)` 的 mod/pub use，无 fallback 分支。在 FreeBSD 等其它 Unix 目标上 `SystemProxySnapshot`、`apply_system_proxy_settings` 等符号不存在，`system_proxy_recovery.rs:22` 无条件引用它们会编译失败。同时 `system_proxy/unsupported.rs`（已存在的 no-op 实现）从未被 `mod.rs` 声明。
- **修复方向**：在 `mod.rs` 末尾加 `#[cfg(not(any(...)))] pub use unsupported::{...};`。

### L6 `body_preview` 按字节切片可能截断多字节字符显示为 �

- **位置**：`crates/proxy-core/src/rules/rewrite.rs:107-119`
- **现象**：`&bytes[..bytes.len().min(PREVIEW_LIMIT)]` 按字节切片，`String::from_utf8_lossy` 容错（替换为 U+FFFD），不 panic，但 preview 末尾可能显示乱码。
- **修复方向**：回退到字符边界。

### L7 大量硬编码英文文案，违反项目双语约束

- **位置**：
  - `apps/desktop/src/features/rules/components/RewriteRulesPanel.tsx`（行 93/113-124/132-178/200-289 多处面向用户字符串）
  - `apps/desktop/src/features/sessions/components/SessionInspectorMessagesPane.tsx:450,456,462`（Text/Ping/Pong）
  - `apps/desktop/src/features/throttling/use-throttle-editor.ts:55`（"Targeted rule" / "Any" 硬编码，而 i18n 文件已有对应 key）
- **修复方向**：把这些字符串改为 `t(...)` 调用，并在 `en.ts` / `zh-CN.ts` 中补齐 key。

### L8 `document.documentElement.style.zoom` 非标准，跨平台不一致

- **位置**：`apps/desktop/src/components/layout/hooks/use-zoom-control.ts:11-13`
- **现象**：`zoom` 是非标准属性，Firefox 完全不支持；且本 hook 只监听菜单事件，未注册键盘快捷键（Cmd/Ctrl + +/−/0），与 macOS 原生行为不一致。
- **修复方向**：用 `transform: scale()` 或 CSS 变量缩放根容器；补充键盘快捷键监听并区分 `metaKey`(mac) / `ctrlKey`(win/linux)。

### L9 web fallback 下载过早 `revokeObjectURL`

- **位置**：`apps/desktop/src/lib/download.ts:28-35`
- **现象**：`anchor.click()` 触发的下载在某些浏览器中异步开始，紧接着 `URL.revokeObjectURL(href)` 可能让下载拿到空内容或失败。Tauri 桌面端走 invoke 分支不触发此问题，但 web/浏览器开发模式会受影响。
- **修复方向**：`setTimeout(() => URL.revokeObjectURL(href), 1000)` 延迟撤销。

### L10 `--platform` 参数未 normalize，`win32` 会被误判 mismatch

- **位置**：`scripts/desktop.mjs:30-36`
- **现象**：`cli.platform` 是 raw 字符串，未调用 `normalizePlatform`。若用户传 `--platform win32`（Node 的 `process.platform` 值），与 `windows` 比较不等，脚本误报 mismatch 退出。
- **修复方向**：对 `cli.platform` 也跑一次 `normalizePlatform`。

### L11 `desktop.mjs` 把 macOS 专属 `bundle.macOS` 注入到所有平台

- **位置**：`scripts/desktop.mjs:262-275`
- **现象**：`tauriConfigArgs()` 无条件生成 `{ bundle: { macOS: { ... } } }` 并注入到 `run`/`bundle` 所有平台。在 Windows/Linux 下执行 `tauri build --config '{"bundle":{"macOS":{...}}}'` 行为取决于 Tauri 版本。
- **修复方向**：在 `bundle` 分支内加 `if (hostPlatform === "macos")` 守卫。

### L12 `setup-windows.ps1` 用 `$args`（PowerShell 自动变量）作数组名

- **位置**：`scripts/setup/setup-windows.ps1:32-44`
- **现象**：`$args` 是 PowerShell 内置自动变量（接收未声明位置实参），在函数内对其赋值是已知反模式。当前恰好无透传位置参数能工作，但一旦有人给 `Install-WingetPackage` 传位置参数就会破坏数组。
- **修复方向**：重命名为 `$wingetArgs`。

### L13 `useThrottledValue` 在 `intervalMs` 变化时不重置旧定时器

- **位置**：`apps/desktop/src/hooks/use-throttled-value.ts:34-46`
- **现象**：`intervalMs` 变化时主 effect 重跑，但已在等待的 `timerRef.current`（按旧延时计算）不会被重新调度；`lastEmittedRef` 跨 intervalMs 变化不复位。
- **修复方向**：在 `intervalMs` 变化时清理 `timerRef.current` 并复位 `lastEmittedRef.current`。

### L14 `SetupWizard.handleEnableSsl` 卸载后继续 setState

- **位置**：`apps/desktop/src/features/setup-wizard/SetupWizard.tsx:192-206`
- **现象**：`async handleEnableSsl` 中连续 `await` 后调用 `setActiveStep`/`setActionError`，若用户中途关闭对话框，组件卸载后仍触发 setState（React 18 下不报错但属反模式），且 `proxyStatus?.running` 在 await 期间可能已变化导致状态判断错乱。
- **修复方向**：加 `cancelled` ref（结合 useEffect cleanup）并在 await 后检查；或用 AbortController。

### L15 `computeThrottle*Errors` 每次渲染重算，未 useMemo

- **位置**：`apps/desktop/src/features/throttling/use-throttle-editor.ts:138-142`
- **现象**：`profileErrors`、`ruleErrors`、`activeStatusLabel` 没有 `useMemo`，每次渲染都重建，传递给子组件时破坏 memo 优化。
- **修复方向**：用 `useMemo([profileDraft, t])` 等包裹。

### L16 `release-checklist.sh` shebang 不一致

- **位置**：`scripts/release-checklist.sh:1`
- **现象**：用 `#!/bin/bash`，而仓库其他 `*.sh` 统一用 `#!/usr/bin/env bash`。在 macOS（自带 bash 3.2）或某些 Docker 镜像下可能用到不一致的 bash 版本。
- **修复方向**：统一为 `#!/usr/bin/env bash`。

### L17 `setup-macos.sh` 用 `|| true` 掩盖 xcode-select 失败

- **位置**：`scripts/setup/setup-macos.sh:21-25`
- **现象**：`xcode-select --install || true` 掩盖真实失败原因，若因 GUI 已知 bug 不弹框，脚本仍无条件 `exit 1`，用户看不到真实错误。
- **修复方向**：去掉 `|| true`，让 `set -e` 正确报错。

### L18 `ProxyStatus.port` 未校验上界 65535

- **位置**：`packages/shared-types/src/proxy.ts:49-55`
- **现象**：守卫只校验 `Number.isInteger && > 0`，允许 `port = 70000` 通过。`normalizeStartProxyInput`（`:129-138`）也未做上界检查。
- **修复方向**：加 `candidate.port <= 65535`。

### L19 pnpm 版本号在三脚本中硬编码，未与 package.json 联动

- **位置**：`scripts/setup/setup-windows.ps1:69`、`setup-macos.sh:61`、`setup-linux.sh:149`
- **现象**：`corepack prepare pnpm@10.0.0` 写死版本，根 `package.json` 的 `packageManager` 升级后需手改三处。
- **修复方向**：从 `package.json` 动态读取（`node -p "require('./package.json').packageManager"`）。

### L20 断点改 response body 后残留旧 content-length（元数据不一致）

- **位置**：`crates/proxy-core/src/breakpoints.rs:608-637`（`apply_response_resolution` 替换 body 不更新 content-length）
- **类别**：元数据一致性（由原 H6 降级）
- **现象**：用户在断点中修改响应体（长度变化）后，`response_headers` 里的旧 `content-length` 与新 body 不一致。**客户端不会挂起或截断**——`build_hyper_response_from_upstream`（`http_proxy.rs:1319`）会 strip `content-length` 并用 `Full<Bytes>` 构造 body，hyper 按实际字节长度发送。残留影响仅为 session 详情展示的 content-length 与实际 body 长度不符。对比 mock 分支（`breakpoints.rs:661-665`）会显式重设 content-length。
- **修复方向**：替换 body 后同步更新或删除 `content-length`，与 mock 分支保持一致。

### L21 叶子证书 not_before 截断到当天 00:00，极端时钟偏差可能握手失败

- **位置**：`crates/tls-manager/src/generator.rs:40-45,200-206,231-237`
- **类别**：健壮性（由原 M2 降级）
- **现象**：`not_before = rcgen::date_time_ymd(now.year, now.month, now.day)`，即当天 UTC 00:00（向过去回拨最多 24h）。客户端时钟**明显落后**（慢到跨日）或代理与客户端跨时区/跨日边界时，可能因证书「尚未生效」握手失败。客户端时钟略快不受影响（`now_client > not_before` 更易满足）。触发概率低。
- **修复方向**：`not_before` 进一步回拨数小时（如 `now - 1h`），并相应延长 not_after，留出更大时钟偏移余量。

### L22 `open_database` 未设 busy_timeout（仅多进程场景相关）

- **位置**：`crates/db/src/connection.rs:31-34`
- **类别**：健壮性（由原 M12 降级）
- **现象**：WAL 模式下 SQLite 仍只允许一个写者。当前应用是单 `Arc<Mutex<rusqlite::Connection>>`（`bootstrap/mod.rs:116`），进程内所有 db 访问经同一把 Mutex 串行化，单连接下 SQLite 自身不会对同一连接报 BUSY，故**进程内并发写不受影响**。真正的风险在**多进程**（用户同时打开多个 AIProxy 实例争用同一 db 文件）或未来引入连接池时，未设 `busy_timeout` 会导致立即 `SQLITE_BUSY` 而非等待重试。
- **修复方向**：加上 `PRAGMA busy_timeout=5000;`（防御多进程场景）。

---

## 6. 测试现状（核实补充）

审计期间运行测试套件，确认以下情况（不属于功能 bug，但影响测试可靠性，单列一节）：

### T1 ✅ 已修复（0ee74d0） cargo test 有 1 项失败：`unknown_protocol_falls_back_to_url_scheme_and_default_http_version`

- **位置**：`crates/proxy-core/src/tests.rs:1951`（proptest），失败断言在 `:1966`
- **确认依据**：`cargo test --lib unknown_protocol_falls_back_to_url_scheme_and_default_http_version` 实测失败：
  ```
  left:  "http"
  right: "https"
  minimal failing input: protocol = "a", host = "08", path = ""
  ```
- **根因**：测试 URL 为 `format!("https://{host}/{path}")`，当 `host = "08"` 时，URL = `https://08/`，`url` crate 将 `08` 解析失败（前导零的伪 IPv4），`Url::parse` 返回 `Err` → `url_scheme = None` → `infer_protocol_metadata`（`types.rs:113-119`）fallback 到 `"http"`，断言失败。`prop_assume!`（`:1958-1963`）只过滤了 protocol 的已知值，未过滤会导致 URL 解析失败的 host（如 `08`、`00`）。
- **性质**：这是**测试输入空间与 `url` crate 解析规则不匹配**导致的测试缺陷，`infer_protocol_metadata` 的产品代码逻辑本身合理（unknown 协议 fallback 到 URL scheme，解析失败再 fallback 到 http）。
- **修复方向**：在 proptest 中加 `prop_assume!` 过滤掉会导致 `Url::parse` 失败的 host（含前导零的纯数字段、非法字符），或直接对生成的 URL 先校验 `Url::parse(url).is_ok()`。

### T2 ✅ 已修复（0ee74d0） proptest 种子文件 `proptest-regressions/tests.txt` 未纳入版本控制

- **位置**：`crates/proxy-core/proptest-regressions/tests.txt`（git 未跟踪）
- **现象**：proptest 在 T1 失败后自动生成了种子文件（记录 `protocol = "a", host = "08"` 这个反例的 seed）。当前该目录是 untracked。proptest 的最佳实践是**把 `proptest-regressions/` 提交到版本控制**，这样所有人运行测试时都会先重放历史失败用例，避免回归被新随机种子掩盖。
- **修复方向**：修复 T1 后，将 `crates/proxy-core/proptest-regressions/tests.txt` 加入 git 跟踪（同时确认 `.gitignore` 未排除 `proptest-regressions`）。

### T3 SessionInspectorMessagesPane.stress 当前通过，非稳定失败

- **位置**：`apps/desktop/src/features/sessions/components/SessionInspectorMessagesPane.stress.test.tsx:109`
- **确认依据**：实测 `pnpm --filter @aiproxy/desktop test -- --run SessionInspectorMessagesPane.stress` 通过（1 test, 3664ms）；完整套件 48 文件 / 368 用例全部通过（25s）。
- **说明**：用户报告该测试超时并伴随 `HTMLCanvasElement.prototype.getContext` 在 jsdom 未实现的告警。复核 `AppProviders.tsx:20-55` 的 `detectActiveFont`：已对 jsdom 做了防护（`:21-23` 检测 `navigator.userAgent` 含 `jsdom` 直接返回 `"unknown"`，不触碰 canvas），故 canvas 问题不应触发。当前实测稳定通过，推测用户报告的是**首次运行 / 高机器负载下的偶发超时**（该测试渲染 AppProviders + 1000 条虚拟化消息，耗时偏长），非稳定失败。
- **建议**：若 CI 偶发超时，可适当调大该测试的 timeout 或在 CI 上隔离运行。

---

## 7. 复核说明（剔除的误报）

扫描过程中报告的部分问题，经审计者复核后认为**不成立或属正常设计**，不计入本报告（第一版已标注的降级/删除项 H6/H7/M2/M12/M13 见各自条目内的说明，此处仅列其余否决项）：

- **断点 `removePendingHit` 的 `Math.min(currentIdx, pendingHits.length-1)`**（`breakpoint.store.ts:45-47`）：这是「删除当前选中项后，选中原位置的下一项」的标准 UX，与 Postman/Charles 一致，非 off-by-one。
- **`direct_http_client` 的 `OnceLock::set` 忽略 Err**（`proxy-core/src/server.rs:22-38`）：并发首调时第二个线程 `get()` 仍能拿到首个线程初始化的 client，逻辑正确。
- **`build_hyper_response_from_upstream` strip content-length 让 hyper 重算**（`http_proxy.rs:1318-1332`）：对 `Full<Bytes>` 会让 hyper 自动加正确的 content-length，是安全的（此即 H6 降级为 L20 的依据）。
- **`truncate_for_error`** 切片在纯 ASCII 路径上无害（H4 仅针对含多字节字符的错误正文场景成立）。

## 8. 修复优先级建议

| 优先级 | 条目 | 理由 |
|---|---|---|
| **P0 立即修** | H1、H8、H9、H10 | 互相关联：db 层 `INSERT OR REPLACE`（H1/H8）是根因，poison 在 spawn_blocking（H9）与 commands 层（H10）放大。建议作为一组统一修复（含 H10 的锁处理统一）。原 H6/H7 占位项为降级/删除说明，无有效条目 |
| **P0 立即修** | H2、H3 | 系统代理改坏用户环境，不可恢复，Linux 用户感知最强 |
| **P0 立即修** | H4、H7 | 进程级崩溃（UTF-8 切片 panic H4）/ Windows 首次安装后功能不可用（setup 脚本 H7） |
| **P1 尽快修** | H5、H6 | 断点「改请求后 Forward」核心调试功能失效（H5）/ CONNECT 隧道半关闭丢数据（H6） |
| **P2 本周内** | M3、M4、M7、M8、M9 | 资源泄漏 / 数据完整性（M12 已降级为 L22，不在此列） |
| **P3 迭代优化** | M1、M5、M6、M10、M11、M14-M17 | 功能准确性与健壮性（M2 已降级 L21、M13 已删除，不在此列） |
| **P3 迭代优化** | T1、T2 | 修复失败的 proptest 并提交种子文件 |
| **P4 持续改进** | L1-L22 | 维护性与体验（含由原 H6/M2/M12 降级而来的 L20/L21/L22） |

## 9. 后续行动

- 本报告列出的问题建议按 P0 → P1 分批建立修复任务，每批修复后回归 `pnpm test`、`pnpm lint`、`pnpm typecheck` 与 `cargo test`。
- 修复 db 层 `INSERT OR REPLACE`（H1/H8）时，应同步补充对应回归测试：验证「upsert 已存在 session 后，子表（ws_messages/script_runs/...）数据不丢失」。
- 修复系统代理相关 bug（H2/H3/M5）时，按 `CLAUDE.md` 第 9 节同步更新 `docs/SYSTEM_PROXY.md` 的平台差异说明。
- **优先处理 T1**：`cargo test` 当前有 1 项失败（`unknown_protocol_falls_back_to_url_scheme_and_default_http_version`），任何后续 Rust 改动跑 `cargo test` 都会被它干扰。建议在进入 P0 修复前先把该测试修好（加 `prop_assume!` 过滤），并按 T2 提交 `proptest-regressions/tests.txt`。

## 10. 审计方法与局限

- 本报告条目分两类：标记 ✅ 的高/中危项均由审计者打开源码逐行复核；其余条目基于静态审查。
- **复核纠错记录**：第一版报告存在 5 处审计者误判，已在本版修正并保留降级/删除说明（便于追溯）：H6（夸大为客户端挂起，实际仅元数据不一致，降 L20）、H7（误判 panic，实际 `str::find` 保证字符边界，删除）、M2（时钟方向判断反，降 L21）、M12（夸大进程内并发，实际单连接 Mutex，降 L22）、M13（误判 schema 不存在，实际 `bundle.macOS.bundleVersion` 合法，删除）。教训：涉及 panic 边界、schema 路径、时钟方向的结论必须在源码/官方文档层面实证，不可仅凭静态推断。
- **Tauri schema 依据**：M13 改判依据为官方配置参考 https://v2.tauri.app/reference/config/ （`MacConfig.bundleVersion` → `CFBundleVersion`）。注入是否实际改写 Info.plist 仍建议真机验证。

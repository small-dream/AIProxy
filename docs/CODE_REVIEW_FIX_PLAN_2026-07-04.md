# AIProxy 第四轮评审修复计划

- 文档类型：修复执行计划（Bug 58 + 架构 12 = 70 项）
- 评审依据：`docs/CODE_REVIEW_2026-07-04.md`（v1.1）
- 制定日期：`2026-07-04`
- 状态：`v1.2 — 有条件通过后修订版`

> **v1.2 修订说明**（针对第一轮评审反馈）：
> - **H3**（上游 TLS 校验开关）正式纳入批次 3 作为独立条目，明确验收（HTTPS/WSS 双路径、workspace 设置、host allowlist、UI 明示信任状态），不再只在 A7 顺手提及。
> - **A8**（panic=abort 安全）重写：原「修 L8 即闭合」判断过乐观——panic=abort 下进程直接 abort，`RunEvent::Exit` 还原逻辑根本不运行，L8 原子写只解决快照文件损坏。现拆为产品决策（取消 panic=abort vs 接受「下次启动恢复」语义）+ 三层实现（panic hook / 启动恢复 / 落盘顺序测试）。
> - **M3** 技术方案更正：`http-body-util` 无 `ReaderStream`，需新增 `tokio-util`（`io` feature）用 `tokio_util::io::ReaderStream` + `http_body_util::StreamBody`；`build_hyper_response_from_upstream` 签名须从 `body: &[u8]` 改为 body/stream 模型。
> - **M18** 从正式批次与速查表移除（已在评审 v1.1 撤回），归入「可选补测」附录。
> - **H10** 安全边界明确化：定义允许根、symlink 策略、canonicalize 范围、错误码统一、以及「用户文件选择」证明机制。
> - **执行顺序调整**：新增批次 0「用户机器安全优先」；原批次 3 拆为 3a（运行时/网络热路径）与 3b（性能/DB/规则）两个 PR 组。

本计划基于对每个修复点的源码核实与可复用模式探查。按「安全优先 + 依赖关系 + 风险」分批，每批可独立合并、独立回归。预计总周期 8–12 周。

## 全局原则

- 每批结束跑全套质量门禁：`pnpm lint && pnpm typecheck && pnpm test && cargo fmt --check --all && cargo clippy --workspace -- -D warnings && cargo test --workspace`。
- 每个修复项必须带回归测试（Rust 用 `start_proxy_server` 集成模式或 `test_conn()` 单元模式；前端用 Vitest + testing-library）。
- 修复后在 `docs/CODE_REVIEW_2026-07-04.md` 对应条目末尾追加 `**状态：已修复 @ commit <sha>**`，并更新第 11 节修复进度。
- 所有跨 crate 的类型/接口变更同步 `docs/API_SPEC.md`（A2 完成后由 CI 强制）。

---

## 批次 0：用户机器安全优先（H10/H9/H11/M17/A8/L8/H1/H7）— 约 1.5 周

端用户信任底线优先于规则体验问题。系统代理接管与任意文件读是最危险的坑，必须最先闭合。

### H10 read_script_source_file 任意文件读 — 安全边界定义

**问题**：当前仅校验扩展名即 `std::fs::read`（`commands/rules.rs:603`），任意 IPC 调用方可读进程可读的任意文件。

**安全边界（必须明确，避免形式安全）**：

- **允许根**：脚本文件导入应限定为 **app_data 目录下的 script 导入暂存目录**（如 `<app_data>/script-imports/`），该目录由前端「打开文件」对话框选择后**先拷贝进来**再读取。不允许直接读用户任意绝对路径。
- **canonicalize 范围**：对**文件本身**做 `std::fs::canonicalize`（不仅 parent），防止 symlink 逃逸：`canon_path` 必须满足 `canon_path.starts_with(&canon_root)`，其中 `canon_root` 是允许根的 canonicalize 结果。
- **Symlink 策略**：canonicalize 后比对根即可天然拒绝指向允许根外的 symlink；额外拒绝 `canon_path` 中含 `..` 的组件（canonicalize 后应已无，作为 belt-and-suspenders）。
- **错误码统一**：所有路径不合法情况返回 `Err(app_error(ERR_INVALID_INPUT, ...))`，不泄露文件是否存在（用统一文案「unsupported script file path」）。
- **「用户文件选择」证明机制**：若产品坚持「导入任意路径脚本」体验，则需经 Tauri `dialog.open` 的文件选择器（返回的路径是 OS 级用户确认结果），前端拿到后**仍需拷贝到允许根**再调 read 命令；read 命令不接受裸任意路径。

**实现**：抽公共 `validate_confined_path(path, allowed_roots) -> Result<PathBuf, String>`，`read_script_source_file` 与 `save_media_file`（`files.rs:117-140`）都用。文件：`apps/desktop/src-tauri/src/commands/rules.rs:577-632`、`commands/files.rs:103-140`。

**测试**：
- `../../etc/passwd.js` → `Err(ERR_INVALID_INPUT)`；
- `/etc/shadow.mts`（即使存在）→ `Err(ERR_INVALID_INPUT)`；
- symlink 指向允许根外 → `Err(ERR_INVALID_INPUT)`；
- 合法拷入允许根的 `.js` → `Ok`。

### H9 Windows apply 写序 + 回滚

`windows.rs:51-78` 仿 `restore:80-114` 顺序——先写 ProxyServer/ProxyOverride/AutoConfigURL/AutoDetect，最后置 ProxyEnable=1；并仿 macOS `macos.rs:81-96` 加失败回滚（`restore_system_proxy(&snapshot)`）。当前 `_snapshot` 参数被忽略（`windows.rs:53`），必须使用。

### H11 enable/disable 系统代理阻塞 async

`proxy.rs:338-418` 两个 `async fn` 体内的 `capture/apply/restore_system_proxy*` 包进 `run_blocking_command`（`commands/common.rs:68-79`），仿 `port_manager.rs:17-25`；`start_proxy_impl:271` 的 reapply 同理。

### M17 enable/disable 无并发守卫

`AppState` 加 `system_proxy_op_lock: Arc<tokio::sync::Mutex<()>>`，enable/disable/restart 全程持锁（与 H11 同批实施，因为同一组函数）。

### A8 + L8 panic=abort 系统代理还原（**重写，需产品决策**）

**问题核实**：`Cargo.toml:21` release `panic="abort"`。任何线程 panic → 进程立即 abort，**无 unwinding** → `RunEvent::Exit` 的 `block_on` 还原逻辑（`main.rs:333-359`）根本不运行 → 系统代理永久指向死端口。`dev_logger.rs:74` 装了 panic hook，但 panic=abort 下 hook 执行后仍 abort，**不能用于运行还原逻辑**。L8 原子写只解决快照文件损坏，**不解决 abort 后无法运行还原**。

**这是产品决策，必须先选一条路**：

- **方案 A（推荐）：移除 release `panic="abort"`**。改回默认 unwinding，使 `Drop` guard 与 shutdown cleanup 可运行。代价：二进制略大（symbols 已 strip，影响有限）、需审计所有 `unwrap`/`expect` 在 unwinding 下的安全性（避免 Drop 期间二次 panic）。配合 M16（shutdown 路径 `.expect()` 改 `into_inner`）。
- **方案 B：保留 panic=abort，明确「下次启动恢复」产品语义**。文档化「崩溃后系统代理会短暂指向死端口，下次启动时自动还原」。实现：
  1. **L8 原子写**：`system_proxy_recovery.rs:46` `fs::write` 改 temp + rename（POSIX 近原子，Windows 用 `FILE_FLAG_REPLACE_ON_DATA_LOSS`）+ fsync 目录。
  2. **严格落盘顺序**：审计 `enable_system_proxy_impl`（`proxy.rs:360-366`）确保「persist snapshot → apply system proxy」顺序（已核实当前是此顺序），并在 apply **之后**再写一次「已应用」标记。
  3. **启动恢复**：`restore_pending_snapshot_on_startup`（`system_proxy_recovery.rs:78-168`）已存在，确保它在 UI 出现前同步运行，失败时醒目告警。
  4. **panic hook 增强**（方案 B 专属）：panic hook 内直接调用 `restore_system_proxy`（best-effort，子进程同步），而非只记日志——但注意 panic=abort 下 hook 仍可能被 SIGKILL 中断，不能作为强保证。

**决策记录**：在 `docs/DECISIONS/` 写 ADR-panic-strategy，记录选 A 还是 B 及理由。

**测试（两方案都需）**：
- 单元：snapshot 写入用 kill -9 / 任务管理器强杀进程模拟，重启后 `restore_pending_snapshot_on_startup` 能读未损坏文件并还原（方案 A 的 unwinding + 方案 B 的原子写都应通过）。
- 集成：故意在 apply 后注入 panic（debug 构造），验证下次启动还原。
- 顺序：断言 persist 发生在 apply 之前（日志/状态机检查）。

### H1 WS Close 未加掩码

`forward_raw_frame`（`ws.rs:544-550`）增加 `mask_output: bool` 参数；client→upstream Close 调用点（`ws.rs:796`）传 `true`，与 `:809` 非 Close 路径一致；server→client 路径（`:859/:870`）保持 `false`。测试：复用 `ws.rs` 集成测试，新增断言客户端 Close 帧转发上游时带 mask bit。

### H7 delete_throttle_profile FK 失败

改 `delete_throttle_profile`（`rules.rs:525-529`）为事务内先删子表：`unchecked_transaction` → `DELETE FROM throttle_rules WHERE profile_id=?1` → `DELETE FROM throttle_profiles WHERE id=?1` → `commit`，复用 `clear_script_runs`（`rules.rs:1218-1232`）模式；不改 FK（避免表重建）。测试：throttle 首个 db 单测，建 profile+rule，删 profile 应成功且 rule 一并清除。

---

## 批次 1：P0 核心正确性（H4/H5/H13）— 约 1 周

低风险、高确定性、改动面小。先建立测试基线。

- **H4** rewrite 单规则失败中止请求：`apply_request_rewrite_rules`/`apply_response_rewrite_rules`（`rewrite.rs:250-439/441-572`）每条规则 `?` 改 `match`：成功 push 成功 trace，失败 push 错误 trace（`outcome="error"`）后 `continue`，仿 `script.rs:252-265` 的 `invalid_trace`；仅 manager 锁失败才中止。测试：3 条规则第 2 条命中非 JSON body，断言第 3 条仍执行、请求不被 500。
- **H5** set_json_path_value 销毁标量：`json_path.rs:156-166`（parent Key 分支）与 `:179-188`（final Key 分支）：父 Key 节点存在且非对象时返回 `Err`（仿 `:167-174` Index 分支），仅 `Null`/缺失时自动建对象。测试：`set $.a.b` on `{"a":5}` 应 `Err`；on `{"a":null}` 应成功。
- **H13** throttle methods 字段不可编辑：`RuleEditor.tsx:94-107` 的 TextField 换 `Select multiple`，绑定 `draft.methods`，仿 `MapRulesPanel:307-320`；`renderValue` 空→`t("rulesPage.allMethods")`；从 `features/rules/rules.helpers.ts:14` 导入 `HTTP_METHODS`。测试：throttle 首个组件测试，选多个 method 后 `draft.methods` 含全部。

---

## 批次 2：P0 前端核心功能（H12/H14/H15/M26）— 约 1.5 周

依赖批次 1（H12 抽共享 hook 会触碰 H15/M26 同一组件）。

- **H12** Compose QueryParamsEditor 按键重建（**抽共享 hook**）：把 `BreakpointInterceptPanel.tsx:104-162` 的 `useStableKeyedRows` 提到 `apps/desktop/src/hooks/use-stable-keyed-rows.ts`（泛型 `<T>`），三处复用；`QueryParamsEditor`（`ComposeRequestSection.tsx:303-335`）改用：本地 `HeaderEntry[]` 草稿，失焦/防抖提交回 URL。
- **H15/M26** EditableKeyValueTable 空态源不一致：`EditableKeyValueTable.tsx:94` 的 `items.length===0` 改 `rows.length===0`（对齐 `BodyFieldsEditor:1211`），H12 抽 hook 时一并改。
- **H14** Rewrite 面板 + 会话右键 i18n：`i18n/messages/{en,zh-CN}.ts` 加键 `contextMenu.createThrottleRule`、`rulesPage.rewrite.tester.*`、`rulesPage.rewrite.invalidCombination.*`（6 条）；把 `RewriteRulesPanel.tsx:127-162/496/621/860-918` 与 `SessionContextMenu.tsx:257` 裸字面量改 `t()`。
- 测试：H12 Vitest 断言输入查询参数值不失焦（`fireError.change` + 检查 `document.activeElement`）；H14 加 vitest 全局测试断言 en/zh 键集相同。

---

## 批次 3a：运行时 / 网络热路径组（H3/H6/H8/M2/M3）— 约 1.5 周

**独立 PR 组**，失败回滚清爽。热路径重构，需充分集成测试。

### H3 上游 TLS 证书校验 opt-out 开关（**正式条目，独立验收**）

**问题**：`timing_connector.rs:40` 与 `ws_upgrade.rs:190-191` 硬接 `build_dangerous_tls_connector_with_alpn`，所有上游连接 TLS 校验无条件禁用，无开关。

**实现**（需铺设 config 管道，当前 `TimingConnector::new` 无 settings 参数）：
1. `tls-manager/src/client.rs` 新增 `build_client_config_with_alpn(alpn, verify: bool)`：`verify=true` 用 rustls 默认 `WebPkiServerVerifier`（+ 系统根证书），`verify=false` 保持 `NoOpVerifier`。
2. `proxy-core/src/timing_connector.rs:38-48`：`TimingConnector::new` 增加 `verify_upstream: bool` 与可选 `verify_allowlist: Arc<HashSet<String>>`（host 级白名单）。
3. 铺设 config：`ConnectionContext`（`connection.rs:47-62`）→ 两 upstream 调用点（`upstream.rs:329`、`upstream_pool.rs:176`）→ 新增 workspace 设置项 `verify_upstream_tls: bool` + `tls_verify_hosts: Vec<String>`。
4. 默认行为：保持当前 NoOp（兼容），但 UI 明示信任状态。

**验收（必须全部覆盖）**：
- HTTPS 路径：`verify=true` 时自签上游证书被拒（集成测试用自签 mock 上游）。
- WSS 路径：`ws_upgrade.rs` 同样生效。
- workspace 设置：切换 `verify_upstream_tls` 后新连接生效（已运行连接不强制断）。
- host allowlist：`verify_upstream_tls=false` 但 host 在 allowlist 内时仍校验。
- UI：Settings/Workspace 页明示「上游 TLS 校验：关闭（不安全）」状态，启用时给确认提示。

**测试**：新增 `tls-manager` 单测（verify on/off 两路径）+ proxy-core 集成测试（自签上游 HTTPS/WSS 各一）。

### H6 脚本 spawn_blocking

把 `execute_request_hook`/`execute_response_hook`（`execute.rs:161+`）调用移入 `tokio::task::spawn_blocking`；入参 owned/Clone-able、Send 兼容（已核实），需把 `&mut ParsedProxyRequest`/`&mut UpstreamResponse` 的 body/payload 调用前 clone 进 owned、结果回填；加全局脚本并发上限（已有 `SCRIPT_GATE`）。**注意**：clone body 进 owned 有内存开销——大 body 场景需评估（可与 M2/M3 body 处理一并优化）。

### H8 入站 MITM 动态证书签发去重

`resolver.rs:32-96` 用 per-host `OnceLock`/`HashMap<host, Arc<OnceLock<Cert>>>` dedupe in-flight 签发（**优先于持 `Mutex` 跨阻塞 crypto，避免死锁**）；冷主机名 N 并发→单次签发。

### M2 Drop 同步解压

`http_proxy.rs:1539-1595` 取消路径 `build_session_detail` 跳过 body 解码（body 传 `None`），或整段 offload `spawn_blocking`；该 detail 仅用于「客户端断开」trace，无需 body。

### M3 spool 整读入内存（**依赖与签名改动明确**）

**问题**：`http_proxy.rs:943-955` `tokio::fs::read` 整读 spool 文件入 `Vec<u8>`，`build_hyper_response_from_upstream`（`:1333-1356`）再 `Bytes::from(body.to_vec())` 二次拷贝。spool 本因 body 超 20 MiB 才落盘，可达数百 MiB。

**技术方案（更正）**：
- **新增依赖**：`crates/proxy-core/Cargo.toml` 加 `tokio-util = { version = "0.7", features = ["io"] }`（当前**无** tokio-util，已核实）。
- **流式实现**：`tokio::fs::File::open(spool_path)` → `tokio_util::io::ReaderStream::new(file)` → `http_body_util::StreamBody::new(stream)` → `.boxed()` 得 `BoxBody<Bytes, io::Error>`。**注意**：`http_body_util` 本身无 `ReaderStream`（反馈指出的落地错误），`ReaderStream` 在 `tokio_util::io`。
- **签名改动（隐藏成本）**：`build_hyper_response_from_upstream`（`:1333-1356`）当前签名 `body: &[u8]`，流式后须改为接收 `BoxBody<Bytes, E>` 或泛型 body；所有调用点（`:1349` spool 路径、其它内联 body 路径）需相应改为传 `Full::new(...).boxed()` 或 stream。**这是计划必须提前写清的隐藏改动**，否则执行时会牵出连锁修改。
- **spool 文件清理**：body EOF/drop 时删 spool 文件——用 `Body` 的 `map`/Drop 包装，或 `poll_frame` 返回 `None` 后在外层 task 删文件。

**测试**：集成测试构造 >20 MiB 上游响应，断言代理峰值内存 < 2× body（流式），客户端完整收齐。

---

## 批次 3b：性能 / DB / 规则组（H2/M9/M10/M11/M14/M15/M17）— 约 1.5 周

**独立 PR 组**，与 3a 解耦。注：M17 已在批次 0（与 H11 同函数组），此处不重复。

- **H2** 未剥 Connection 列出的逐跳头：`http_io.rs:146-160` 与 `http_proxy.rs:1311-1325` 新增 `strip_hop_by_hop_headers`：解析 `Connection` 头令牌列表按名剔除，并剔标准逐跳集合（`Keep-Alive/TE/Trailer/Upgrade/Proxy-Authenticate/Proxy-Authorization`），请求与响应路径都调用。测试：集成测试断言 `Connection: keep-alive, x-foo` + `x-foo: bar` 转发后两侧均无 `x-foo`。
- **M9** 响应 throttle 忽略 latency/丢包：`throttle.rs:92-116` `apply_response_throttle` 应用 `profile.latency_ms`（sleep）；丢包是否可丢响应（建议可，对称）；`build_throttle_trace(..., latency_ms, ...)` 用真实 latency 而非 `0`。测试：断言响应 trace `latency_ms` 非零。
- **M10** 每请求全量克隆规则：`managers.rs:13` `compiled_match: Option<Regex>` → `Option<Arc<Regex>>`；`rule-engine/types.rs:127` 同理并把 `compiled_code/source_map` 包 `Arc`；`compiled_rules()` 返回 `Arc<Vec<...>>` 浅拷贝，`set_rules`/`save_rule` 时重建快照。测试：单测断言 `compiled_rules()` 返回 `Arc` 引用相等。
- **M11** insights 缺索引：`schema.rs` 的 `CREATE_TABLES` 常量加 `CREATE INDEX IF NOT EXISTS idx_session_summaries_host_duration ON session_summaries(host, duration_ms);`（幂等）。测试：db 单测断言索引存在。
- **M14** delete_sessions_except 阻塞 IPC：`sessions.rs:139-142` 改 `async`；`AppState::delete_sessions_except`（`bootstrap/mod.rs:268-278`）把同步 `delete_sessions_by_ids` 换既有 `spawn_delete_sessions`/`delete_sessions_and_bodies_async`（`repository.rs:108-136`，已存在未用）；cache 更新与事件仍 inline。
- **M15** 多个同步 DB 命令阻塞：重查询命令（`list_ws_messages`/`search_ws_messages`/`list_api_collection_items`/`batch_execute_collection_items`）转 `async` + `run_blocking_command`；短查询保持同步但确保锁内不做文件 I/O。

---

## 批次 4：P2 健壮性/性能 中危剩余（M1/M4/M5/M6/M7/M8/M12/M13/M16/M19–M25/M27–M30）— 约 2 周

可并行分给多人。

- **M1** `ws_upgrade.rs:703-728` `refill_stream` 超时返 `Ok(false)` 而非 `Err`，对齐 `read_until_close_body`。
- **M4** `ws_upgrade.rs:753-777` `parse_upstream_response_head` 处理 obs-fold（前导空白续行并入上头），无 `:` 行拒绝/告警。
- **M5** `ws_upgrade.rs:358-362` 校验完整 101 握手（`Connection: upgrade`+`Upgrade: websocket`+`Sec-WebSocket-Accept`）。
- **M6** `ws_upgrade.rs:805-810` 用 `String::from_utf8_lossy` 替 `to_str().unwrap_or("")`。
- **M7** `execute.rs:373-378` 给 in-thread `finish` 加截止；确认 rquickjs 中断在 pending-job 循环触发；worker 可 join/可取消。
- **M8** `breakpoints.rs:120-133` 编辑头后回读 Host 进 `request.host`/`request.url`。
- **M12**（已收窄）`body_store.rs` 在 desktop 层（`repository.rs` 持 db Mutex）协调 clear/write，或 `write_body` 在 `NotFound` 重试。
- **M13** `linux.rs:140-223` capture/restore 完整 GNOME schema（`ftp`/`socks`/`use-same-proxy`）。
- **M16** shutdown 路径 `.expect()`（`bootstrap/mod.rs:367-405`）改 `.unwrap_or_else(|e| e.into_inner())`（对齐 `repository.rs`）。**与 A8 方案 A 协同**。
- **M19** `notification.store.ts:23-26` `push` 加上限（保留最近 K 条，如 5）+ 连续相同消息折叠。
- **M20** `BreakpointInterceptPanel.tsx:456-469` `handleModeChange` 不自动格式化，仅显式「Format JSON」动作格式化。
- **M21** `BreakpointInterceptPanel.tsx:1202-1240`（与 `pages/compose/index.tsx:183-219`）resize 监听改 `useEffect` cleanup 管理。
- **M22** 4 个规则面板（Script/Map/Dns/Rewrite）选择 effect 加 `lastSyncedRuleIdRef` 守卫，仿 `use-throttle-editor.ts:129,200-211`。
- **M23** `use-throttle-editor.ts:213-223` 临时启用超时回调核对当前激活 profile 是否仍为临时启用者。
- **M24**（已收窄）`EnvironmentManagerDialog.tsx:109-113` cleanup 由 `clearTimeout` 改「有 pending 则立即 flush 再清」。
- **M25** `ScriptRulesPanel.tsx:146-174` 导入与选择 effect 竞态——随 M22 id-aware 守卫一并修。
- **M27** `macos.rs:132-147` 多服务「先设后启用」+ 文档化部分失败语义。
- **M28** `EnvironmentManagerDialog.tsx:149` `window.confirm` 换 MUI Dialog（仿 `AppShellDialogs.tsx:158-175`）。
- **M29** `clear_all_sessions` 跨 DB+body 非原子——body 失败入背景重扫队列。
- **M30** `schema.rs` 加 `CREATE UNIQUE INDEX ... WHERE enabled=1` on throttle_profiles(workspace_id)，移除两路径手动去活。

---

## 批次 5：低危 L1–L14 — 约 1 周

批量清理，风险极低。逐项见 `docs/CODE_REVIEW_2026-07-04.md` 第 6 节。亮点：L7 原子写（temp+rename）；L6 API key 明文文档化或迁 keyring（评估后定）。**注**：L8 原子写已并入批次 0 的 A8 处理。

---

## 批次 6：架构治理 A1–A12 — 约 3–4 周（可与批次 4/5 部分并行）

### 6a. A2 API_SPEC CI 门禁（独立、低风险，先做）

新增 `scripts/check-api-spec.ts`（diff `main.rs` `generate_handler!` 注册名 vs `API_SPEC.md` 反引号命令标题），`.github/workflows/ci.yml` 加一步；先补 32 个未文档命令进 API_SPEC、4 个未注册 IPC 命令标题改「Event:/HTTP:」前缀或移除；事件/HTTP 标题用区分前缀避免与命令混淆。

> **A8 与 H3 已移到批次 0/3a**，不再在此节。

### 6b. A3 错误模型统一（约 1.5 周）

- 移除 `impl From<ProxyError> for String`（`proxy-core/src/error.rs:49-53`）——当前生产路径几乎未触发（已核实），移除安全。
- 新增 `AppResult<T> = Result<T, String>` 包装，`From<ProxyError>/From<DbError>` 统一映射 `app_error(ERR_*, ...)`；补 `ERR_*` 常量（`ERR_NOT_FOUND`/`ERR_CONSTRAINT`/`ERR_UPSTREAM`/`ERR_TLS`/`ERR_RULE`/`ERR_SCRIPT_TIMEOUT`）。
- 逐文件迁移：`compose.rs`(1)/`files.rs`(3)/`app.rs`(2) 三个 0-`app_error` 文件优先；其余 ~60 命令分批；proxy-core 内部 30+ `Result<_,String>` 迁 `ProxyError`。
- 前端 `coerceAppError` 无需改；新增 `packages/shared-types/src/error-codes.ts` 常量表（A1 codegen 后可自动同步）。

### 6c. A1 共享类型 codegen（约 1.5 周，最大单项）

- 选 **ts-rs**（每 crate 输出 `bindings/`，支持 `#[ts(skip)]`，已核实无 tagged union 阻塞）。
- 先重构 2 个手写 `impl Serialize`：`ProxyBodyReference`（`types.rs:342-384`）与 `ProxySessionDetail`（`types.rs:469-521`）——改 derive Serialize + `#[serde(skip_serializing_if)]`，或 `#[ts(skip)]` 保持手写。
- 给 ~95 个跨边界 struct/enum 加 `#[derive(TS)]` + `#[ts(...)]`（input/output 命令结构 ~74 + 域类型 ~20）；`r#match` 字段（`rules/types.rs:26`）需验证 ts-rs 处理。
- `apps/desktop/src-tauri/Cargo.toml` 加 `ts-rs` 为 `export-types` feature 下可选依赖；CI 加 `cargo test --features export-types` 生成 `bindings/`。
- `packages/shared-types/src/generated/` 接收生成类型；手写运行时校验器（~95 个 `isX`/`parseX`/`normalizeX`，codegen 不能替代）留 `*.ts` import 生成类型；移除 `WireTimingBreakdown` 双 case 兼容。
- 风险：rustls `ServerConfig`（`types.rs:589`）等非序列化 `pub` 字段需 `#[ts(skip)]`；DB `*Row` 不 derive Serialize 自动跳过。

### 6d. A4/A5/A6/A9/A10/A11/A12（收尾）

- **A4** 统一中毒策略——`panic=abort` 下中毒不可能，全改 `lock().unwrap()`（移除 `expect` 死代码与 `into_inner` 掩盖）；或评估迁 `r2d2-sqlite`（建议延后）。**与 A8 方案选择协同**：若 A8 选方案 A（取消 panic=abort），中毒策略按 unwinding 重新评估。
- **A5** proxy-core 去 reqwest：把 Compose `send_direct_request` 也走 hyper+TimingConnector，删 reqwest；或写 ADR（`docs/DECISIONS/`）论证双客户端。建议先写 ADR，迁移作后续 epic。
- **A6** 新增 `crates/proxy-core/tests/` 集成套件（随机端口起服务，断言请求经各规则阶段往返）；要么加 Playwright 要么删 ARCHITECTURE §14.3 声明。建议先加 proxy-core 集成测试。
- **A9** 新建 `services/query-keys.ts` 层级化键，替换 ~159 处内联字面量；可加 ESLint 自定义规则禁内联数组。
- **A10** 每 crate 建 `limits.rs`（或共享 config struct），合并 WS 帧/脚本堆/会话批等常量；用户相关项（捕获大小、端口）经 Settings 暴露。
- **A11** 重命名 `aiproxy-rule-engine` → `aiproxy-script-engine`（更新 Cargo.toml + 文档 §6.4）。
- **A12** updater 启用前写 key 轮换文档 + CI 签名流程；当前 `createUpdaterArtifacts:false`，无紧急性。

---

## 风险与缓解

- **A8 需先做产品决策**（方案 A 取消 panic=abort vs 方案 B 接受「下次启动恢复」）：决策前不要把 L8 单独标为「A8 已闭合」。方案 A 需审计所有 `unwrap`/`expect` 在 unwinding 下的安全性；方案 B 的 panic hook 还原是 best-effort，不能作强保证。
- **H3 需铺设 config 管道**：当前 `TimingConnector::new` 无 settings 参数，`ConnectionContext` 到 connector 无 verify 字段——改动跨 4 个文件（client.rs / timing_connector.rs / connection.rs / upstream*.rs）+ 新增 workspace 设置 + UI，非小改动。
- **A1（codegen）回归面最大**：先在分支跑通全链路（重构 2 个手写 Serialize → 加 derive → 生成 → 前端切换 import → 全套测试），确认零运行时差异后再合并；保留手写类型一个版本作回退。
- **A3 移除 `From<ProxyError> for String`**：当前生产路径几乎未触发（已核实），需 `cargo check --workspace` 全量验证 + 跑全部 `cargo test`。
- **M3 签名改动连锁**：`build_hyper_response_from_upstream` 从 `&[u8]` 改 body 模型会影响所有调用点，需在 PR 描述写清隐藏成本。
- **H6 spawn_blocking 内存**：apply 函数带 `&mut` 借用，clone body 进 owned 有内存开销——大 body 场景需评估（可与 M2/M3 body 处理一并优化）。
- **H8（TLS 签发去重）**：rustls I/O 线程持锁跨签发需确保不死锁——优先用 per-host `OnceLock` 而非持 `Mutex` 跨阻塞 crypto。

---

## 进度跟踪

每批合并后：

1. 更新 `docs/CODE_REVIEW_2026-07-04.md` 对应条目状态（追加 `**状态：已修复 @ commit <sha>**`）；
2. 第 11 节追加「批次 X 已完成 @ <date>，修复 N 项」；
3. 跑全套门禁确认绿。

批次全部完成后，报告整体状态改为 `已全部修复并验证`。

---

## 修复项 → 批次 速查表

| 批次 | 项 | 工作量 |
|---|---|---|
| 0（用户机器安全优先） | H10, H9, H11, M17, A8+L8, H1, H7 | ~1.5 周 |
| 1（P0 核心正确性） | H4, H5, H13 | ~1 周 |
| 2（P0 前端核心功能） | H12, H14, H15, M26 | ~1.5 周 |
| 3a（运行时/网络热路径） | H3, H6, H8, M2, M3 | ~1.5 周 |
| 3b（性能/DB/规则） | H2, M9, M10, M11, M14, M15 | ~1.5 周 |
| 4（P2 中危剩余） | M1, M4, M5, M6, M7, M8, M12, M13, M16, M19–M25, M27–M30 | ~2 周 |
| 5（低危） | L1–L7, L9–L14 | ~1 周 |
| 6（架构治理） | A1, A2, A3, A4, A5, A6, A9, A10, A11, A12 | ~3–4 周 |

> 速查表共 70 项（Bug 58：H1–H15, M1–M17, M19–M30, L1–L14；架构 12：A1–A12，其中 H3/A7 合并实现，A8 含 L8）。**M18 不在表内**（评审 v1.1 已撤回，归入附录）。

---

## 附录：可选补测（不计入 70 项）

- **M18 测试覆盖**（评审 v1.1 撤回的残留）：`apps/desktop/src/hooks/use-throttled-value.test.ts` 加一条测试——render 后改 `intervalMs` rerender，断言新 cadence 下首帧按新基线（`lastEmittedRef=0`）分类 leading/trailing。当前 hook 实现（`use-throttled-value.ts:48-60`）已正确处理 interval 变更，仅缺测试覆盖。可择机补，不阻塞任何批次。

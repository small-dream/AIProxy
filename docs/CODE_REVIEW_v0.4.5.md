# AIProxy 全面代码 Review 报告（v0.4.5）

> 审查日期：2026-11-22
> 审查基线：`4d31541` → `533a004`（master 快进合并 v0.4.5，3 个新提交）
> 审查方式：多智能体分域并行审查（9 个工作流 agent + 12 次子代理委托）+ 人工精读补审；critical/high 发现均经独立复核（high 发现由复核员编写临时回归测试实证复现）
> 发现总数：**34 条**（high 1 / medium 13 / low 20；经 2026-11-22 独立核实后为 high 1 / medium 12 / low 21，M-1 降级说明见文末附录）

---

## 一、代码更新内容

| 提交 | 内容 | 精读结论 |
|---|---|---|
| `9948755` | perf(sessions)：会话清理改为后台 GC 回收 body store（tombstone 机制） | **设计健全**。清理与抓包写入经 `session_lifecycle_lock` + generation 校验正确串行（`apps/desktop/src-tauri/src/bootstrap/mod.rs:573`）；tombstone 为兄弟目录 + 毫秒/pid/原子序号唯一命名，撞名只会失败并安全回退；`purge_gc_dir` 有路径校验防止任意目录删除；Windows 打开句柄导致 rename 失败有同步 `clear_all` 回退；启动时 `cleanup_stale_gc_dirs` 覆盖崩溃残留 |
| `1368b15` | test(mcp)：`since` 回看窗口改为从 fixture 日期推导 | 正确。`since_covering_fixture()` 消除了墙钟越过 2026-11 中旬后测试必然变红的脆弱性 |
| `533a004` | chore(release)：v0.4.5 | 五处版本号（根 `package.json`、`Cargo.toml`、`Cargo.lock`、`apps/desktop/package.json`、`apps/desktop/src-tauri/tauri.conf.json`）全部一致为 0.4.5；`docs/releases/v0.4.5.md` 双语发布摘要齐全 |

## 二、客观质量门禁（全绿）

| 门禁 | 结果 |
|---|---|
| `cargo test --workspace` | ✅ exit 0（含新增 GC 回归测试） |
| `pnpm typecheck` | ✅ exit 0 |
| `pnpm lint` | ✅ 0 错误（50 条 `no-feature-to-feature` 跨域依赖**警告**，见第五节架构债） |
| `pnpm test` | ✅ 933/933 通过（120 个测试文件） |
| 发布版本一致性 | ✅ 五处均为 0.4.5 |

## 三、审查覆盖面

- **Rust 核心**：`crates/proxy-core`（http_proxy / server / connect / stream / connection / ws / ws_upgrade / upstream 数据路径）、`crates/db`（body store 新 GC、schema、sessions、事务边界）、`crates/rule-engine`（compile / execute / QuickJS 沙箱）、`crates/tls-manager` 与 `crates/sys-util`、`crates/mcp-server`（脱敏、配置）
- **Tauri 后端**：`apps/desktop/src-tauri/src` 的 commands 层（对照 `docs/API_SPEC.md`）、bootstrap（GC 集成）、port_manager、system_proxy 三平台、automation、agent_* 模块
- **前端**：`apps/desktop/src` 全部 features / pages / components / services / hooks / i18n（中英文消息文件 **2194 个 key 逐一比对完全一致**，无缺失/多余/重复）、`packages/shared-types`、`packages/ui-tokens`

## 四、发现明细

### 🔴 High（1 条，已实证复现）

#### H-1 Throttling「新建自定义 Profile」被自动选择 effect 立即覆盖，保存会静默覆盖既有数据

- **位置**：`apps/desktop/src/features/throttling/use-throttle-editor.ts:220-226`（根因 effect）与 `:334-343`（`handleNewProfile`）
- **类别**：正确性 bug（状态管理）
- **描述**：点击「新建自定义」后 `handleNewProfile` 将 `selectedProfileId` 设为新草稿 uuid 并 `setProfileDraft(空草稿)`，但 L220-226 的自动选择 effect 无守卫：新草稿 id 不在 profiles 中，`profiles.some(...)` 为 false，effect 直接回退到 `activeProfile ?? presetProfiles[0] ?? customProfiles[0]`，把 `selectedProfileId` 与 `profileDraft` 一并改写。用户看到的不是空白表单而是既有 profile 的值；此时修改并保存，draft 携带的是该既有 profile 的 id，前后端按 id upsert（Rust `ThrottleManager::save_profile` 与 DB `save_throttle_profile`），会**静默覆盖既有 profile**（含可能正在启用的 profile）而非新建。
- **触发条件**（复核员实证修正）：profiles 非空时必触发——即用户保存过任意 profile 后的正常稳态；首次安装且从未保存过 profile 时不触发（Tauri 运行时后端不预置 preset，preset 仅是前端 local-store 回退）。`handleNewProfile` 设置的 `lastSyncedProfileIdRef` 只挡住了 L228-239 的草稿同步 effect，未挡住 L220-226 的自动选择 effect；对比 `handleNewRule`，其对 `rules[0]` 回退是有防护的，此处不对称。现有测试（L210-232）刻意清空 `profilesState` 才测此路径（注释自证），未覆盖非空场景。
- **建议**：在自动选择 effect 中识别未保存新草稿并跳过回退，沿用本文件既有 ref 模式（如 `selectedProfileId && lastSyncedProfileIdRef.current === selectedProfileId && !profiles.some(...)` 时 return）；补回归测试：profiles 非空（含一个启用的自定义 profile 覆盖 activeProfile 回退分支）时调用 `handleNewProfile` 并 flush effect，断言草稿为空且 id 不等于任何已有 profile id。

### 🟠 Medium（13 条）

#### 会话清理 / GC 回退路径（本次更新引入的边角）

**M-1 `spawn_body_rescan` 延迟重试无锁无 generation 校验，可误删新捕获会话的 body**

> **核实修正（2026-11-22）**：该重试当前只由 `Repository::clear_all_sessions` 触发，其调用方仅为启动清理与退出钩子（退出前代理运行时已停止）；UI「清空会话」走 `clear_all_sessions_result`，不会进入此处。故"误删新捕获 body"的路径在当前调用图下不可达，本条应按 Low（潜在健壮性隐患）处理，详见文末附录。
- **位置**：`apps/desktop/src-tauri/src/bootstrap/repository.rs:333-358`（触发点 :203-208、:189-198）
- **描述**：detach 与同步回退 `clear_all` 双失败后，500ms 后在裸线程中再次全量执行 `body_store.clear_all()`。该重试既不持有 `session_lifecycle_lock` 也不校验 `session_generation`：clear 命令已返回、代理继续抓包时，任何在重试落地前完成 spill + upsert 的新会话 body 会被一并删除，而其 DB 行已提交，形成「行存在但 body 丢失」的持久不一致（inspector/MCP 报 body unavailable）。当前暴露窗口较窄（双失败本身罕见），但 UI clear 命令路径同样会触发该重试。
- **建议**：重试不要全量 `clear_all`——在 fallback 失败时先快照 live 目录中已存在的 entry 名单，重试只删该名单；或让重试线程校验共享的 `session_generation`（不等则放弃）；或经 `session_lifecycle_lock` 串行。同时建议 `clear_all` 单条目失败时不提前 return，聚合错误继续尝试其余条目，降低进入 rescan 的概率。

**M-2 `cleanup_stale_gc_dirs` 单个 entry 读取失败即整体中止，违反自身契约**
- **位置**：`crates/db/src/body_store.rs:276-277`
- **描述**：循环里 `entry.map_err(DbError::Io)?` 在 read_dir 迭代的单个条目解码/IO 失败时直接中止整个清理，剩余 tombstone 全部不再尝试，与该函数 doc 注释「Every matching entry is attempted even when one fails, so a single locked directory does not strand the rest」不符（注释只覆盖了 remove 失败）。调用方收到 Err 后只打一条 warn，本次启动不再重试。
- **建议**：把 entry 读取失败也纳入 `GcCleanupOutcome`（failed += 1、填充 first_error 并 continue），仅保留 `read_dir(parent)` 本身失败的 Err 路径。

**M-3 `detach_all_for_gc` 回滚 rename 失败被静默吞掉**
- **位置**：`crates/db/src/body_store.rs:227-232`
- **描述**：重建 live 目录失败时用 `let _ = fs::rename(&tombstone, &self.base_dir)` 回滚且回滚失败无任何日志。双失败时：全部旧 body 滞留 tombstone、live 目录缺失，调用方随即的回退 `clear_all` 在空目录上返回 Ok，clear 向上层报告成功，磁盘空间整个运行期不回收且无日志可定位滞留目录，只能等下次启动清理。
- **建议**：回滚失败时把 tombstone 路径上下文并入返回的 `DbError`，让 `body_detach_failed_falling_back` 日志能定位滞留目录；文档注明该状态下旧数据要等下次启动清理。

#### TLS / 证书信任链路（影响三平台排障）

**M-4 macOS/Linux 信任检查静默吞错，与 Windows 侧日志不对称**
- **位置**：`crates/tls-manager/src/trust.rs:365-374`（macOS）、`:511-513`（Linux）
- **描述**：`is_trusted_macos` 对 `security verify-cert` 的 spawn 失败（`Err(_) => return false`）与命令非零退出均无日志，失败原因（未受信、已过期、策略不符、/usr/bin/security 被 EDR 拦截）完全不可见；Linux 侧对 `/etc/ssl/certs` 等 read_dir 失败同样静默返回 false。用户已正确安装证书但 UI 仍显示「未信任」时零排障线索。该检查还是 automation HTTPS 校验的前置门禁，误报会错误阻断验证。
- **建议**：对齐 `is_trusted_windows`（:250-269）的日志结构：spawn 失败记 warn + error；非零退出记 stderr；Linux 侧非 NotFound 错误记 warn 后再返回。

**M-5 thumbprint 提取把底层错误压成无信息静态串**
- **位置**：`crates/tls-manager/src/trust.rs:751-770`
- **描述**：`certificate_sha1_thumbprint` 把 io::Error / base64 错误压成 `"read certificate"` / `"decode certificate"`，无法区分文件不存在、权限不足还是被占用；该错误串最终进入 macOS/Windows 信任移除链路的 `TrustRemovalFailure.error` 展示给用户，排障无价值。
- **建议**：read 失败携带路径与 io::Error 详情，解码失败携带具体解析错误；调用点 warn 日志与 report 自然获得可排障上下文。

**M-6 async 上下文直接调用阻塞的证书信任检查**
- **位置**：`apps/desktop/src-tauri/src/automation.rs:3023`（外层为 `:2927` 的 `async fn verify_proxy`，已亲自确认）
- **描述**：在 tokio worker 上直接同步调用 `is_cert_trusted_on_platform`——Linux 上是全量扫描三个证书目录（Debian 700+ 文件 + 200KB bundle），Windows 上要起 PowerShell 进程，秒级阻塞 worker。`certificates.rs` 的同类调用都经 `run_blocking_command` 下放，此处漏了。
- **建议**：参照 `certificates.rs` 的模式将调用包进 `spawn_blocking` / `run_blocking_command`。

#### 前端契约与错误反馈

**M-7 Compose/Collections 发送请求硬编码 `workspaceId: "default"`**
- **位置**：`apps/desktop/src/pages/compose/index.tsx:189-196`（workspaceId 在 :190）；`apps/desktop/src/pages/collections/index.tsx:259-266`
- **描述**：违反 `docs/API_SPEC.md` `send_composed_request` 一节「前端仍应传当前激活预设 ID」的约定；同仓库 repeat 流程已专门修复过同类问题（`use-session-context-actions.ts:62-65` 改用 `proxyStatus.activeWorkspaceId`），此处未同步，行为不一致。
- **建议**：两页引入 `useProxyStatus()`，发送时传 `proxyStatus?.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID`。

**M-8 更新安装失败对用户完全不可见（两处）**
- **位置**：`apps/desktop/src/pages/settings/sections/UpdatesSection.tsx:34-40`（`handleInstall`）；`apps/desktop/src/features/updater/UpdateDialog.tsx:58-66`（`handleUpdate`）
- **描述**：下载/安装失败（网络中断、产物校验失败）后按钮静默恢复可点，无 toast/Alert，且 helper（`update-status.ts:42-45`）仅 `console.warn`——打包后用户既看不到也走不到结构化日志；UpdateDialog 中根本不存在安装失败状态（store 只有 `lastCheckFailed`）。
- **建议**：失败时像 `handleCheck` 一样展示错误提示（新增中英文案并同步 `en.ts`/`zh-CN.ts`）；`console.warn` 换 `logDevError`；在 app-shell.store 增加安装失败状态并在 Dialog 渲染 error Alert。

**M-9 HAR 导入解析错误文案硬编码英文绕过 i18n**
- **位置**：`apps/desktop/src/features/sessions/session-import.helpers.ts:164-170`、`:176`、`:241`、`:253`、`:257`
- **描述**：`"The selected file is not valid JSON."` 等错误文案直接经 snackbar 展示，中文界面用户看到英文报错，违反「用户可见文案必须走 i18n 双语」硬约束；`sessionsImport.messages` 下没有对应错误 key。
- **建议**：解析错误改为携带结构化错误码/参数，调用方经 `t()` 映射到新增的 `sessionsImport.messages.*` 双语键后展示。

**M-10 automation 变更列表加载失败渲染 `[object Object]`**
- **位置**：`apps/desktop/src/features/automation/AutomationChangesPanel.tsx:597-599`
- **描述**：`String(changesQuery.error)`——`listAutomationChanges` 抛的是 `coerceAppError` 返回的普通对象，结果为 `[object Object]`，丢失错误码与可读信息。
- **建议**：改用 `coerceAppError(changesQuery.error).message`（同文件既有写法），渲染 message 并考虑带 code。

**M-11 规则导出无 try/catch；导入错误提示是死代码 UI**
- **位置**：`apps/desktop/src/features/rules/components/RulesImportExportButtons.tsx:37-54`（handleExport）；`:78-82`（importError 渲染）
- **描述**：导出直接 `await downloadText_file` 且 `void handleExport()`，用户取消保存或写入失败即 unhandled rejection，无通知无日志；导入错误 `importError` 被渲染在零尺寸空 `<span />` 的 Tooltip 上，永远不可见，`unsupportedVersion` 与 `invalidFile` 的区分成为死代码。
- **建议**：handleExport 参照 handleImport 包 try/catch 并经通知队列反馈；删除空 span Tooltip，改渲染可见 Alert 或直接 push 通知。

**M-12 WS relay 抓包通道 send 无超时且静默吞错**
- **位置**：`crates/proxy-core/src/ws.rs:940`、`:1010`、`:1084`
- **描述**：relay 在 select! 循环内对每帧执行有界通道 `ws_sender.send(msg).await` 且无超时；抓包消费端一旦停滞，双向帧转发被整体冻结并长期占用连接 permit。发送失败被 `let _` 静默丢弃。
- **建议**：为 send 包短超时，超时/失败打 debug 日志并丢弃该帧（抓包是旁路功能，不应阻塞转发）。

**M-13 WS 非 101 拒绝路径抓包数据不完整**
- **位置**：`crates/proxy-core/src/ws_upgrade.rs:415-417`、`:447`、`:615`
- **描述**：非 101 拒绝路径先以空 body 构建 detail，随后读出的 `body_bytes` 只转发给客户端、从未回填会话记录，Inspector 中拒绝响应 body 恒为空；且 `response_mime_type` 在 :447 被无条件置为 websocket，真实 403/404 拒绝被误标。
- **建议**：读取 body 成功后回填 detail（或截断前缀）再发送会话；非 101 分支按 upstream Content-Type 设置或清空 mime。

### 🟡 Low（20 条，按主题归组）

#### 静默吞错 / 日志不一致（8 条）

- `crates/proxy-core/src/http_proxy.rs:937`、`:1029`、`:1094` —— 三处 `let _ = ctx.session_sender.send(detail).await` 失败未打 `session_send_dropped` debug 日志（同文件其余 17 处都有）。
- `crates/proxy-core/src/ws_upgrade.rs:714` —— 101 成功路径同样吞掉 send 失败，接收端断开时 WS 会话静默从抓包列表消失。
- `crates/proxy-core/src/ws_upgrade.rs:1015-1019` —— 状态行解析失败 `unwrap_or(502)` 静默回退，畸形上游在 Inspector 中表现为合成 502。
- `apps/desktop/src/features/sessions/use-session-context-actions.ts:389-397`、`:512-514` —— repeat / save-to-collection 的 catch 完全丢弃 error，无日志，用户只见通用失败提示。
- `apps/desktop/src/pages/sessions/index.tsx:577-592` —— 批量保存响应 catch 静默跳过，全部失败也只看到「已保存 0 个响应」。
- `apps/desktop/src/pages/sessions/index.tsx:819-821`、`:886-888` —— SSL 解密开关与 Include 列表两处 catch 丢弃 error，涉及 updateWorkspace + 代理重启两条命令的失败原因不可见。

#### 事件订阅 Promise 链缺 catch（2 条，链路安全敏感）

- `apps/desktop/src/features/agent-access/AgentGrantApprovalHost.tsx:66-87` —— 授权请求/变更监听注册失败即静默失效，授权审批弹窗不可达意味着请求方永远 pending。
- `apps/desktop/src/components/layout/hooks/use-menu-actions.ts:59-80` —— 菜单事件监听是原生菜单唯一桥接，注册失败即整菜单静默死亡。
- **建议**：均补 `.catch((error) => logDevWarn(...))`，与 `use-agent-control-events.ts:119-123` 模式一致。

#### 正确性小缺陷（5 条）

- `apps/desktop/src/pages/compose/index.tsx:377-379` —— URL 输入框 Enter 发送不检查 `sendMutation.isPending`，请求进行中连按 Enter 绕过按钮 disabled 守卫并发重发。
- `apps/desktop/src/pages/compose/index.tsx:213-214` 与 `apps/desktop/src/features/insights/use-insights-data.tsx:129-135` —— 两处剪贴板 `void writeText` 浮动 promise + 无条件成功提示，失败时未处理 rejection 且反馈失真（sessions 侧同类 P2 4.3-9 已修复，未同步）。
- `apps/desktop/src/features/rules/rules.helpers.ts:268-279` —— IPv6 校验正则放行 `":1:2"`、`"::::"` 等非法输入（空 hextet 重复），无效 targetIp 随 DNS 映射落库。
- `apps/desktop/src/components/layout/hooks/use-adb-actions.ts:61-62` —— ADB 快捷菜单固定取 `getLocalIp()[0]`，多网卡/VPN/虚拟化环境下会把手机代理配到不可达地址（证书中心面板已有 IP 选择器逻辑，此处绕过）。

#### 性能 / 资源（3 条）

- `apps/desktop/src/features/sessions/use-session-events.ts:33`（:97、:123、:142 只增不减）—— `removedSessionIds` 墓碑 Set 随历史会话总数单调增长，长时间高频抓包 + 多次 Clear 下无界增长。建议设上限（如 5000 条按插入序淘汰）。
- `crates/tls-manager/src/trust.rs:479-547` —— Linux 信任检查每次全量扫描三个目录（Debian 700+ 文件 + 200KB bundle 逐张指纹），被 UI 刷新反复触发且无缓存。建议按指纹缓存结果或以目录 mtime 做失效判断。
- `crates/tls-manager/src/generator.rs:39-44` —— 根 CA `notBefore` 取 UTC 当天零点，未像叶子证书（`leaf_not_before_ymd`）那样回拨一天；慢时钟客户端会全链判 NotYetValid 导致 MITM 握手失败且 UI 显示「已受信任」，极难排障。

#### 安全加固建议（2 条）

- `crates/tls-manager/src/storage.rs:59-65` —— Windows 上根 CA 私钥经 `dirs::data_dir()` 落在 **Roaming AppData**，启用漫游 profile 的域环境会把能劫持全部 HTTPS 的 CA 私钥同步到网络 profile 共享。建议 Windows 分支改用 `data_local_dir()` 并做旧路径迁移。
- `crates/tls-manager/src/storage.rs:253-262` —— `.cer` 安装副本用 `std::fs::write` 覆盖回写，未走同文件 `write_file_atomic`（M13 纪律）；进程中途崩溃留下截断 `.cer`，后续 adb/hdc 推送损坏证书到设备。

### 未发现问题的区域（审查确认干净）

- **proxy-core 核心生命周期**：`http_proxy.rs` / `server.rs` / `connect.rs` / `stream.rs` / `connection.rs` —— 守卫 disarm 语义、spool RAII 清理、hop-by-hop 剥离、HEAD/304 语义、accept 退避、idle-reset 半关闭中继均严谨。
- **rule-engine**：QuickJS 沙箱的并发闸门（毒锁恢复）、16MB 内存上限、中断处理超时分类、fail-open 语义、异步 hook 的微任务驱动均正确。
- **mcp-server 脱敏**（`redaction.rs`）：覆盖全面（宽 secret 名单含中文键、JWT/bearer/邮箱/手机号正则、引号 JSON 回退、SSE/NDJSON 行级处理、自定义模式 512 字符上限）。
- **crates/db 快扫**：无 SQL 字符串拼接注入面（唯一 `format!` 为常量列名拼接）；非测试代码无裸 `unwrap()`。
- **files.rs 信任模型**：渲染层只传本地化标题不传路径；附件走一次性能力令牌（canonical path + 15 分钟过期 + 持久化校验）。
- **automation 资源路径**：`ensure_approved_path` / `path_is_within` 提供穿越防护。

## 五、总体评价

**这是一套质量显著高于平均水平的代码**。代理核心有系统性的超时矩阵（P1-3 / H4 / M29 等编号注释贯穿）、新 GC 的锁与 generation 串行化设计正确、QuickJS 沙箱边界完整、脱敏多层覆盖、前端事件订阅普遍正确清理且带取消守卫，测试以回归守护型为主。i18n 双语 key 完全一致，契约与 `docs/API_SPEC.md` 抽查未发现错位。

问题集中在两类：

1. **错误可观测性**（约 20 条）：静默吞错、失败无用户反馈、平台间日志不对称——违反仓库「关键链路结构化日志、失败不可观测禁止」的自定基线。
2. **少数状态管理 / 回退路径竞态**：throttling 新建草稿（high）、`spawn_body_rescan` 无锁重试。

无安全高危发现（无 SQL 注入、无路径穿越、无命令注入面）。

### 架构债备注

`pnpm lint` 报 50 条 `no-feature-to-feature` 跨域依赖警告（0 错误），集中在 compose/collections/breakpoints/certificate-center → sessions/environments 的组件与 helpers 复用。不阻塞发布，但长期看 `sessions` 正在成为事实上的公共层，建议后续把跨域复用的 helpers 下沉到 `components/` 或 `lib/`。

## 六、建议处理顺序

1. **立即修复**：H-1（用户数据覆盖风险）、M-1（本次更新引入的竞态）
2. **短期**（排障刚需）：M-4 / M-5 / M-6（证书信任链路日志对称化与阻塞下放）、M-8（更新失败反馈）、M-7（workspaceId 契约）
3. **批量清理**：low 级吞错与订阅链 catch，可一次 PR 扫清
4. **规划**：Windows 私钥目录迁移（涉及存量路径迁移，需三平台验证并同步帮助文档）

---

## 附录：独立核实验证记录（2026-11-22）

验证方式：逐条比对正文引用的 `file:line` 与代码（H-1、M-1~M-13、20 条 low 全覆盖）；复跑客观门禁；i18n key 用脚本独立计数；H-1 用临时 vitest 用例独立复现（复现后已删除该临时文件，工作区无残留）。

### 结论：34 条中 33 条事实成立，1 条需降级改写；门禁数据基本复现

| 项目 | 核实结果 |
|---|---|
| H-1 | **成立**。临时用例实证：`profiles` 非空（含一个 `enabled: true` 的 profile `p1`）时 `handleNewProfile()` 后 `profileDraft` 变为 `{ id: "p1", name: "P1" }`、`selectedProfileId` 回退为 `p1`；行号 `:220-226` / `:334-343` 精确；`handleNewRule` 经 `lastSyncedRuleIdRef` 受保护的不对称性属实；现有测试 `use-throttle-editor.test.tsx:210-232` 确实先 `profilesState.current = []`。`save_throttle_profile`（`crates/db/src/rules.rs:400-455`）为按 id 先 UPDATE 后 INSERT，"保存即静默覆盖"链路属实。 |
| M-1 | **代码事实成立、触发路径描述不成立**。`spawn_body_rescan`（`repository.rs:333-358`）确无锁、无 generation 校验；但其唯一调用点是 `Repository::clear_all_sessions`（`:203-208`），而该方法只被 `AppState::clear_session_storage` 调用——即启动 `init_from_db`（`bootstrap/mod.rs:236`）与退出钩子（`main.rs:538`）。退出前代理运行时已停止（`shutdown_proxy_runtime_stopped`，`main.rs:490-495`），启动时抓包尚未开始；UI「清空会话」走 `clear_all_sessions_result`（`mod.rs:393`），**不会**触发该重试。故"UI clear 命令路径同样会触发""代理继续抓包时误删新捕获 body"不成立。建议降为 **Low**，描述改为"潜在健壮性隐患：若未来有热路径复用 `clear_all_sessions`，该重试缺少串行化保护"。 |
| M-2 ~ M-13 | **全部成立**，引用行号与代码一致（个别漂移 ≤1 行：M-10 实为 `:597-598`；M-8 helper 为 `update-status.ts:42-46`）。M-13 另经核对确认 `detail` 的 body 在该文件内从未回填（无 `detail.response_body` 赋值）。 |
| Low 20 条 | **全部成立**，行号准确。两处计数偏差：`http_proxy.rs` 三处 `let _ = ctx.session_sender.send(..)` 确为静默点，但同文件带 `session_send_dropped` 日志的站点是 **10 处**，非"其余 17 处"；"条目读取失败中止清理"一条已在 `cleanup_stale_gc_dirs`（`body_store.rs:276-277`）确认。 |
| 版本一致性 | ✅ 五处均 0.4.5（根 `package.json`、`Cargo.toml`、`Cargo.lock` 全部 crate、`apps/desktop/package.json`、`tauri.conf.json`），tag `v0.4.5`；`docs/releases/v0.4.5.md` 含 `更新内容` / `What's new`。 |
| `pnpm typecheck` | ✅ exit 0。 |
| `pnpm lint` | ✅ 0 error；但除 **50 条** `no-feature-to-feature` 外还有 **3 条** `react-hooks/exhaustive-deps` 警告（`use-adb-actions`、`use-menu-actions`、`AgentGrantApprovalHost`），正文只列了前者。 |
| `pnpm test` | ✅ 933/933、120 个测试文件（与正文一致）。注：一次与 cargo test 并发的高负载运行中该命令以 exit 1 结束但 933 全过，空闲复跑 exit 0。 |
| `cargo test --workspace` | ✅ exit 0。注：并发高负载下 `byte_by_byte_slow_loris_is_reaped_by_the_total_header_budget` 曾失败一次（2s 读超时内未收到 400），单独复跑 3/3 通过——该用例时间窗偏紧，属可复现性风险，建议在报告中注明或放宽读超时。 |
| i18n | ✅ en/zh-CN 叶子 key 各 **2194** 个，集合完全一致（脚本独立计数，非仅依赖既有测试）。 |
| `crates/db` 洁净度 | ✅ 脚本核对非 `#[cfg(test)]` 代码无 `.unwrap()`；SQL `format!` 虽多处存在，但均为常量片段/占位符拼接，注入面结论成立（"唯一 format!" 的表述不准）。 |
| automation 路径防护 | ⚠️ 只有 `path_is_within`（`automation.rs:4231`，用于 `:4217`）；报告中 `ensure_approved_path` 不存在，属笔误。 |
| 内部一致性 | ⚠️ 第五节称"契约与 `docs/API_SPEC.md` 抽查未发现错位"，与 M-7（`send_composed_request` 违反 `API_SPEC.md:1134-1135` 约定）自相矛盾，应改为"除 M-7 外未发现错位"。 |

### 净结论

High 1 条成立；Medium 12 条成立、M-1 应降为 Low 并改写触发路径；Low 20 条成立。客观门禁除 lint 警告计数（需补 3 条 `react-hooks`）外与正文一致；新增两条复现性备注（lint 警告构成、slow-loris 用例时序敏感）。建议按"High 1 + Medium 12 + Low 21"重新标注总数（34 条不变）。

## 附录二：修复状态（2026-11-22 当日，同会话执行）

按第六节计划完成阶段 1–3 全部修复；验证门禁全绿：`cargo test --workspace` exit 0、`cargo clippy --workspace --all-targets` exit 0、`pnpm typecheck` exit 0、`pnpm lint` 0 error（50 条存量 `no-feature-to-feature` + 3 条存量 `react-hooks` 警告，均非本次引入）、`pnpm test` **956/956**（122 个测试文件，含本次新增回归）。

- **H-1**：`use-throttle-editor.ts` 新增 `draftIsNewProfileRef` 守卫自动选择 effect，`selectProfile`/保存成功清除；新增非空 profiles（含启用 profile）回归测试。
- **M-1**（已按附录降级为 Low，仍按健壮性加固实施）：`spawn_body_rescan` 改为**快照式重试**——失败当下在锁内快照残留 entry，重试线程只删名单（新会话 UUID 目录名不可能碰撞）；`clear_all`/`cleanup_stale_gc_dirs` 改为聚合容错（单条目失败不再中止全部）；`detach_all_for_gc` 回滚失败把 tombstone 路径并入错误上下文。新增 `snapshot_entry_names`/`remove_snapshotted_entries` 两个 body_store API。
- **M-4/M-5**：macOS/Linux 信任检查补齐与 Windows 对称的 warn/debug 日志（含 verify-cert stderr、read_dir 失败区分）；`certificate_sha1_thumbprint` 错误改为携带路径与 io 详情的 String。
- **M-6**：`verify_proxy` 的证书信任探针整块下放 `tauri::async_runtime::spawn_blocking`。
- **M-7**：Compose/Collections 发送改传 `proxyStatus?.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID`。
- **M-8**：app-shell store 新增 `installError`；`installUpdateAndStore` 结构化日志（`logDevError`）并写入失败状态；UpdateDialog 渲染 error Alert；UpdatesSection 失败 toast；新增 `updateDialogInstallFailed` 双语文案；`zh-CN/en` settings 帮助文档同步失败提示说明。
- **M-9**：HAR 解析失败改结构化 `HarImportError`（kind + entryIndex），调用方经 `sessionsImport.messages.*` 双语键渲染；新增 invalidJson/invalidHar/invalidEntry/invalidUrl/noEntries 五组文案与测试。
- **M-10/M-11**：automation 面板改用 `coerceAppError(...).message`；规则导出补 try/catch + 通知；导入错误改推**区分后**的消息（删除永不可见的空 span Tooltip 死代码）。
- **M-12/M-13**：新增 `TimeoutKind::WsCaptureSend`（2s），`send_capture_message` 限时发送 + 失败/超时 debug 日志，三处调用点替换；WS 非 101 拒绝路径把 body 回填进会话（含 size/mime 修正，malformed-101 除外）并按 upstream Content-Type 设置 mime。
- **Low 批量**：`http_proxy.rs` 三处与 `ws_upgrade.rs` 两处（101 成功路径 send、状态行解析回退）补 `session_send_dropped`/warn 日志；`AgentGrantApprovalHost` 与 `use-menu-actions` 订阅链补 `.catch(logDevWarn)`；Compose Enter 加 `isPending` 守卫、cURL 复制改 await + 失败提示；Insights 复制主机同理；repeat/保存到集合/SSL 开关/Include 列表/批量保存五处 catch 补 `logDevWarn`（批量保存含失败计数新双语文案）；IPv6 校验改严格实现（8 组全写或单次 `::` 压缩，含边界测试）；ADB 快捷菜单新增 `pickPhoneReachableLocalIp` 过滤助手（排除回环/链路本地，优先 192.168/10.x，含测试）；`removedSessionIds` 墓碑上限 5000 FIFO 淘汰（含测试）；根 CA `notBefore` 复用 `leaf_not_before_ymd` 回拨一天；`.cer` 安装副本改 `write_file_atomic`。
- **未实施（按计划保留为阶段 4 规划项）**：Windows 根 CA 私钥 Roaming→Local AppData 迁移（涉及存量安装迁移与三平台验证）；Linux 信任检查指纹缓存（性能优化项）。
- **验证备注**：`plain_http_upstream_timeout_emits_a_completed_gateway_timeout_session` 在与 clippy 并发的高负载下曾失败一次（与附录记录的 slow-loris 用例同类时序敏感），单独复跑 3/3、空闲全仓复跑 exit 0，与本次改动无关。

## 附录三：二次核实的修复处理（2026-11-22 当日）

对附录二所列全部修复做逐条二次核实后，处理结论如下：

| 编号 | 核实结论 | 处理 |
|---|---|---|
| N-1（高） | **成立，为附录二修复引出的回归**：保存新 profile 时 `useSaveThrottleProfile` 仅 invalidate 不写缓存，`draftIsNewProfileRef` 清除后自动选择 effect 立即回退到 activeProfile | 按推荐方案修复：`useSaveThrottleProfile`/`useSaveThrottleRule` 的 mutation 级 `onSuccess` 先 `setQueryData` upsert 再 invalidate（同时消除规则编辑器同类窗口）；新增 mutation 层直测（真实 QueryClient，断言缓存即时含新 id）与 editor 层「保存后选中态保持」回归测试 |
| N-2（中） | 成立：`body_store.rs:309` 超宽行导致 `cargo fmt --check` 必红 | `cargo fmt --all`，复验 `--check` exit 0 |
| N-3（中） | 成立：`parseRulesExportFile` 抛 `coerceAppError(value)` 恒为 UNKNOWN_ERROR，`includes("unsupported")` 永不命中 | shared-types 新增 `UNSUPPORTED_RULES_VERSION_CODE`，识别 format 匹配但版本不符时抛结构化 AppError（含 details.version）；调用方按错误码分支；新增两条分类断言 |
| N-4（中低） | 成立：M-1/M-12/M-13 核心保护无测试 | 新增 `snapshot_entry_names`/`remove_snapshotted_entries` 两条 body_store 测试（含「快照后新写入不被误删」）；ws.rs 新增 `send_capture_message` 停塞超时/接收端断开两条测试；扩展 `ws_upgrade_non_101_forwards_full_body_beyond_leftover` 断言会话 body 回填、summary size 与 mime 修正 |
| N-5（中低，存量） | 成立：并发高负载下 `byte_by_byte_slow_loris...` 曾失败一次（got ""） | 加固断言：以「收到 400 **或** 连接被掐断时重置（零字节）」为通过条件（掐断本身即预算生效的证明），读窗口 2s→3s；空闲复跑 exit 0 |
| N-6（低） | 全部成立 | ws.rs：重组文档注释归位 `assemble_ws_message`、删除重复注释行；ws_upgrade.rs：删除 malformed-101 分支冗余 mime 赋值；AutomationChangesPanel：合并重复 import；UpdateDialog：挂载时清除上一轮残留 `installError`；PAGE_BLUEPRINTS.md：补 UpdateDialog 安装失败错误态说明；repository.rs：快照为空分支补 debug 日志 |

处理后再验证：`cargo fmt --check --all` ✅、`cargo clippy --workspace --all-targets -- -D warnings` ✅ exit 0、`cargo test --workspace` ✅ exit 0、`pnpm check:api-contract` ✅（118 命令 / 14 事件）、`pnpm typecheck` ✅、`pnpm lint` ✅ 0 error（存量警告无新增）、`pnpm test` ✅ **961/961**（123 个测试文件；shared-types 75/75 含新增用例）。三个新增源文件与两个新增测试文件均已 `git add`。

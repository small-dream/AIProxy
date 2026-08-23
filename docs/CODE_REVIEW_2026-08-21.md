# AIProxy 全面代码审查报告

> 审查日期：2026-08-21  
> 版本基线：v0.1.x（master 前 1fd7b56d）  
> 审查范围：Rust crates（proxy-core / db / rule-engine / tls-manager / sys-util / src-tauri）+ apps/desktop 前端 + packages/shared-types + docs 事实源  
> 方法：5 个方向并行深度 review + clippy/typecheck/tests 客观信号 + 关键发现手工 spot-check

---

## 0. 总体结论

AIProxy 当前代码库整体质量高于同类桌面代理工具平均水平。优点非常明显：crate 依赖图干净无环、命令三层同构基本成立、共享契约有运行时校验、安全细节（权限、原子写、symlink 防护）有体系化设计，测试与回归注释文化良好。

主要债务集中在三条热路径：

1. **代理连接生命周期管理**：超时矩阵碎片化、错误路径资源泄漏、WS 升级全链路漏超时。
2. **会话主链路渲染经济学**：后端 100ms 批次优化被前端整页订阅 + 全量派生数组 + 10Hz detail refetch 完全吃掉。
3. **用户反馈与守卫类交互**：全局缺少 MutationCache、批量删除/脏检查/取消语义等关键位置缺失，导致“用户以为成功实则失败/丢失/被修改”。

以下按 **P0 / P1 / P2** 分级，每条均给出 **最优解决方案**。

> **核验说明**：报告完成后，已由人工对关键条目在当前代码基线上二次复核。P0 全部成立；P1 大部分成立；少量条目已有修复痕迹、描述过时或方案需要调整，文中已用 🔄 标记并给出修正后的方案。完整核验结论见第 9 节。

> **修复进展（2026-08-22 更新）**：第一阶段（P0 止损）与第二阶段（P1 稳定性与性能）已全部完成并整体验证通过，共 20 个修复 commit。逐条状态与对应 commit 见第 10 节；已修复条目在标题处标注 ✅。剩余项归第三阶段 / backlog。

---

## 1. 客观质量信号

| 检查项 | 结果 | 备注 |
|--------|------|------|
| 前端 `pnpm typecheck` | ✅ 通过 | `tsc --noEmit` 无错误 |
| 前端 Vitest | ✅ 通过 | 80 文件 / 547 测试 |
| `cargo clippy --workspace --all-targets` | ❌ 失败 | `commands/files.rs:1792` 恒真断言触发 `clippy::overly_complex_bool_expr` deny（详见 P0-7） |
| 架构 agent 反馈 | ✅ | 命令注册 97/97 对齐、crate 无环、文档-代码对应度较高 |

---

## 2. P0 — Critical（立即修复，影响功能正确性或造成静默损失）

### P0-1 限流页 Apply preset 启用错误的限流配置 ✅ 已修复
- **位置**：`apps/desktop/src/pages/throttling/index.tsx:236-238`
- **问题**：`ProfileList` 的 `onApply={() => ed.handleTemporaryEnable()}` 没有把当前点击行的 profile 传进去，实际启用的是 `selectedProfileId` 对应的 profile。用户点击未选中行的 Apply 时，会静默启用另一套配置。
- **最优解法**：`onApply` 改为接收行 profile id，调用 `ed.handleTemporaryEnable(profile.id)`；在 `use-throttle-editor.ts` 里让 `handleTemporaryEnable` 支持传入 profile id，否则 fallback 到 selectedProfileId。

### P0-2 规则编辑器缺失脏检查守卫，未保存修改静默丢失 ✅ 已修复
- **位置**：`features/rules/components/RewriteRulesPanel.tsx:440-445`；`pages/rules/index.tsx:120-123`
- **问题**：`selectRule` 直接覆盖 draft，无任何 dirty 判断；四个规则面板用条件渲染 `{tab === "rewrite" && <RewriteRulesPanel />}`，切换 tab 即卸载组件、草稿销毁。`PAGE_BLUEPRINTS.md` §6.4 与 `UI_GUIDELINES.md` §11.3 均要求脏检查守卫，但仓库内 `useUnsavedChangesGuard` 0 匹配。
- **最优解法**：实现 `useUnsavedChangesGuard`（比较 draft 与已保存规则）；在 `selectRule`、切换 tab、关闭页面/应用前弹 ConfirmDialog；或把 tab 切换改为保持挂载并缓存各 tab 草稿。

### P0-3 Sessions 页面整库无 selector 订阅，每 100ms 全页重渲染 ✅ 已修复
- **位置**：`apps/desktop/src/pages/sessions/index.tsx:108-122`；`features/sessions/session-container.store.ts:24-31`
- **问题**：`const store = useSessionContainerStore; ... = store()` 解构全部字段，任何字段变化触发整页重渲染。`deriveActiveData` 每次 `set` 都新建 `activeSessionIds` / `activeSessionSummaries` 数组身份，导致即使数据未变也触发订阅者重渲染。与后端 100ms 批次叠加，高流量下整页 10Hz 全树重绘。
- **最优解法**：
  1. `pages/sessions/index.tsx` 用多个细粒度 selector 订阅，例如 `useSessionContainerStore(s => s.activeContainerId)`，每个字段只订阅一次。
  2. `deriveActiveData` 在 `ids` 内容未变时复用旧引用；或改用 shallow selector + 稳定派生。
  3. `buildSessionHostGroups` 按 host 分桶并增量缓存，避免每批次 O(n) 重建。

### P0-4 WS 消息窗格每帧直接 setState 且全量重过滤 ✅ 已修复
- **位置**：`features/sessions/components/SessionInspectorMessagesPane.tsx:148-160`；`:182-196`
- **问题**：每收到一帧直接 `setMessages(prev => [...prev, msg])`，`filtered` memo 每次对最多 10,000 条消息全量重跑过滤并逐条 `payloadText.toLowerCase()`。大 payload 下每帧产生 MB 级字符串操作，主线程卡顿。
- **最优解法**：
  1. 批量接收帧：用 requestAnimationFrame 或 50ms 微批次合并追加，减少 setState 频率。
  2. 维护双缓存：`messages`（原始）+ `lowerCasePayloads`（一次 lowercase 后缓存），过滤只在搜索词变化时重算。
  3. 搜索使用虚拟化列表的 `rangeExtractor`，避免对全部消息逐一转换。

### P0-5 Windows CA 信任检测恒为 false，移除操作实际不删除 ✅ 已修复
- **位置**：`crates/tls-manager/src/trust.rs:110-177`；`:219-286`
- **问题**：脚本以 `param([string]$Thumbprint)` 开头，调用方式为 `powershell -NoProfile -NonInteractive -Command <script> <thumbprint>`。PowerShell 的 `-Command` 不会把尾部参数绑定到 `param()`，而是把所有参数拼接到命令文本后执行。后果：
  - `$Thumbprint` 永远为空 → 检测恒返回 false；
  - 移除拿不到 thumbprint/location → 实际不撤销系统信任；
  - 检测脚本末行 `'False' <thumbprint>` 被解析为调用名为 `'False'` 的命令，抛 `CommandNotFoundException`。
- **最优解法**：改用 `-File script.ps1 -Thumbprint <value>`；或在 `-Command` 下显式用脚本块 `& { param([string]$Thumbprint) ... } '<value>'`（严格转义单引号）。脚本内部 `param` 为空时以明确错误码退出，不要静默走完。

### P0-6 组合请求附件构成任意文件读取并外发原语 ✅ 已修复
- **位置**：`apps/desktop/src-tauri/src/commands/multipart.rs:29-76`；`compose.rs:18-60`
- **问题**：renderer 传入的 `file_path` 只做 `canonicalize` + `is_file` + 64MB 上限校验，**无任何根目录约束**。被入侵/XSS 的 renderer 可读取用户任意可读文件（如 `~/.ssh/id_rsa`）并 POST 到任意 URL。代码注释把它对齐到 MapRule local targetValue 的信任模型，与同仓库 H3/H10/D1“后端持对话框、renderer 不传路径”的加固方向不一致。
- **最优解法**：
  1. 首选：附件路径必须落在已登记的安全根目录（复用 `commands/files.rs` 的 `allowed_media_save_roots` 集合），否则拒绝。
  2. 更彻底：引入服务端附件 token 登记表——`save_media_file`/对话框挑选后由 Rust 侧签发 token，IPC 只传 token 不传路径，发送时按 token 解析 canonical 路径。

### P0-7 Clippy `--all-targets` 编译失败：恒真测试断言 ✅ 已修复
- **位置**：`apps/desktop/src-tauri/src/commands/files.rs:1792`
- **问题**：`assert!(sanitize_path_segment("\u{200D}").contains('\u{200D}') || true);` 因 `|| true` 永远为 true，该测试不验证任何行为；同时触发 `clippy::overly_complex_bool_expr` deny，导致 `cargo clippy --workspace --all-targets` 失败。
- **最优解法**：删除 `|| true`，改为 `assert!(sanitize_path_segment("\u{200D}").contains('\u{200D}'));`。若原意是测试零宽连接符不被过滤，则断言应为 `assert!(!sanitize_path_segment("\u{200D}").is_empty())` 或类似语义。

---

## 3. P1 — Major（近期修复，影响稳定性、性能或用户信任）

### 3.1 代理引擎（proxy-core）

#### P1-1 WebSocket 空闲 30 秒被强制断开 ✅ 已修复
- **位置**：`crates/proxy-core/src/ws.rs:16`；`:168-175`；`:785,855`
- **问题**：`parse_ws_frame` 对每次读都套 30s 超时，帧头静默 30s 即报错终止 relay。心跳间隔 >30s 或业务静默期的长连接（推送、行情）会被周期性掐断。
- **最优解法**：区分“帧内分片读超时”与“帧间空闲超时”。帧头等待改为可配置的空闲上限（分钟级），或仅在半关闭状态下启用；帧体分片读仍保留较短超时防止恶意对等端拖死。

#### P1-2 WS upgrade 上游链路全程无超时，任务可无限挂起 ✅ 已修复
- **位置**：`crates/proxy-core/src/ws_upgrade.rs:240`；`:271`；`:315`；`:333`；`connect.rs:351-380`；`upstream_proxy.rs:389-399`
- **问题**：dial→TLS 握手→写 upgrade 请求→读响应头均无线程/整体超时。上游 TCP 半开/TLS 卡死/只回部分数据时，future 永久 Pending，一直占用 1024 连接许可之一，只有客户端主动断开才释放。CONNECT 盲转发路径有 30s 包裹，WS 路径漏掉了。
- **最优解法**：为 dial→TLS→写→读响应头整段套一个整体 `tokio::time::timeout`（如 30s），复用现有 `upstream_request_timeout` 语义；body 已有的 10s idle 超时保留。

#### P1-3 hyper serve_connection 未安装 Timer，默认 header 读超时失效 ✅ 已修复（按 🔄 修正后方案）
- **位置**：`crates/proxy-core/src/server.rs:477-481`；`connect.rs:541,556`；`:421`
- **问题**：初始探测有 30s 超时，但交给 hyper 后请求头读取、keep-alive 空闲、MITM TLS 握手全部无界。恶意/异常客户端批量建连后不发数据可占满 1024 信号量，新连接全被拒。
- **最优解法**：先对照当前使用的 Hyper 1.x API 确认 `http1::Builder::timer` / `header_read_timeout` / `keep_alive_timeout` 的可用形态（不同小版本 API 有差异）；在 `serve_connection` 配置中安装 `TokioTimer` 并显式设置 header 读超时与 keep-alive 空闲超时；`tls_acceptor.accept(stream)` 外层套 `tokio::time::timeout`。修改后补充 slow-loris 回归测试。

#### P1-4 大响应 spool 文件在错误路径永久泄漏 ✅ 已修复
- **位置**：`crates/proxy-core/src/upstream.rs:640-651`（reqwest 版）；`:724-735`（hyper 版）
- **问题**：创建 spool 文件后，读帧失败、写失败、flush 失败等任一错误提前返回 Err 时，spool path 随 Err 丢失。`UpstreamResponse` 的 Drop 清理拿不到 path，文件永远留在 `/tmp/aiproxy-response-spool/`。M1-6 的 120s 超时中止时也会触发。
- **最优解法**：spool 文件用 RAII guard 持有 path，成功 `take` 后交给 `UpstreamResponse` 消费；任何 Err/Drop 即删除。或在 `forward_request` 内用 `scopeguard`/`defer` 保证清理。

#### P1-5 120s 上游超时覆盖整个响应体下载，大文件/慢链路必被截断 ✅ 已修复
- **位置**：`crates/proxy-core/src/http_proxy.rs:773-786`；`upstream.rs:392,519`
- **问题**：超时是总时长语义，不是“首字节/空闲”语义。>20MiB 触发 spool 流式回传本意支持大文件，但下载超过 120s 即被砍成 504，客户端拿不到任何部分内容也无法续传；慢速 SSE 流必然失败。
- **最优解法**：把超时改为覆盖到响应头到达；body 阶段改用逐 chunk idle 超时（如 30s 无数据才算超时）。可配置总时长上限作为可选项，默认不启用。

#### P1-6 断点编辑请求头时多值头合并、非法值头静默丢弃
- **位置**：`crates/proxy-core/src/breakpoints.rs:255-263`；`upstream.rs:213,260`
- **问题**：正常路径用 `append` 保留重复头；断点编辑后用 `insert` 重建 HeaderMap，多个 `Cookie`/`Set-Cookie`/`Via` 被合并成一个，含 obs-text 等非法 UTF-8 值的头被 `if let` 跳过——请求数据静默变更。
- **最优解法**：改用 `append` 重建；解析失败时记录 trace 并返回错误（让 UI 提示该头非法），而不是跳过。

#### P1-7 通配符匹配贪心算法存在假阴性 ✅ 已修复
- **位置**：`crates/proxy-core/src/rules/patterns.rs:49-76`
- **问题**：按首次出现位置推进，末段要求恰好结束于候选串末尾，但首现未必是能对齐末尾的那次。例：`foo*bar` 匹配 `foobarXbar` 返回 false；`*.log` 不匹配 `a.log.b.log`。影响 rewrite/map/throttle/dns 所有 wildcard 规则静默失配。
- **最优解法**：末段改从尾部 `rfind` 对齐；或实现带回溯的分段匹配。同步补充回归用例：`foo*bar` 应命中 `foobarXbar`、`*b*c` 应命中 `abcbc`。

#### P1-8 会话通道背压可阻塞全部代理流量，且单条会话内存上限过高 🔄
- **位置**：`crates/proxy-core/src/server.rs:60`；`http_proxy.rs:689,821,905,970`
- **问题**：`mpsc::channel(4096)`，UI 停止消费时通道填满，所有在途请求阻塞在 `.send().await` 上；每条 `ProxySessionDetail` 可携带 20MiB 内存 body，4096 条理论上限约 80GiB。
- **最优解法**：
  1. 将会话 body 与 metadata 分离：超过阈值时只传 `FilePath` 引用，前端按需拉取，降低单条内存峰值。
  2. 在 metadata 通道上改为 `try_send`，满时生成 `session-dropped` 计数事件并通知 UI（状态栏提示“已丢弃 N 条会话”），而不是阻塞代理流量。
  3. 若必须保留阻塞语义，则限制通道**总字节权重**（而非条数），并保证大 body 走文件引用。
  4. 任何丢弃策略都必须在 UI 显式提示，避免调试数据“静默消失”。

### 3.2 安全与平台（tls-manager / db / src-tauri）

#### P1-9 根 CA 状态指纹与磁盘证书指纹不一致（重签名导致 serial 漂移）✅ 已修复（按 🔄 修正后方案）
- **位置**：`crates/tls-manager/src/generator.rs:75-94`；`apps/desktop/src-tauri/src/commands/certificates.rs:279`
- **问题**：`load_from_pem` 用 `CertificateParams::from_ca_cert_pem` 解析磁盘 PEM 后调用 `params.self_signed(&key_pair)` 重新签名，rcgen 重签名会生成新的随机 serial，产出的 DER 与原证书不同，`compute_fingerprint` 因此不等于系统信任库里的真实指纹。用户按 UI 指纹去 Keychain/certutil 比对必然不匹配。
- **最优解法**：
  1. 从磁盘 PEM 直接解码原始 DER 计算指纹（x509-parser 或 base64 解码 PEM body）并持久化/缓存，用于 UI 展示和系统信任比对。
  2. 保留 `load_from_pem` 重建 rcgen `Certificate` 的逻辑，因为该对象仍用于签发叶子证书，不能简单删除。
  3. 在 `TlsManager` 中同时持有“原始 DER（用于指纹）”和“rcgen Certificate（用于签名）”两个字段，避免重签名改变身份。

#### P1-10 `save_media_file` 缺最终组件符号链接防护 ✅ 已修复
- **位置**：`apps/desktop/src-tauri/src/commands/files.rs:371-403`
- **问题**：`reject_unsafe_write_path` 只校验父目录属于安全根目录，若最终文件名本身是指向任意位置的符号链接，写入会跟随链接落到目标。同文件 `save_response_files` 已有 `O_NOFOLLOW` 加固与符号链接攻击测试，此处不一致。
- **最优解法**：复用 `overwrite_export_file` 的 `O_NOFOLLOW` / `create_new_export_file` 的 `O_EXCL` 打开方式；补上针对 `save_media_file` 的 symlink 攻击单测。

#### P1-11 `ai_settings.api_key` 明文存 SQLite
- **位置**：`crates/db/src/schema.rs`；`apps/desktop/src-tauri/src/commands/ai.rs`
- **问题**：API key 以明文存在工作区 SQLite。DB 文件若随工作区目录同步/备份外泄即泄漏密钥。UI 已做掩码只露末 4 位，但落盘仍是明文。
- **最优解法**：OS keychain（macOS Keychain / Windows Credential Manager / Linux secret-service）存储密钥，DB 只存引用/句柄；或至少用 `keyring` crate 封装，回退方案用 libsodium 密封后存 keychain 保护的密钥。

#### P1-12 JS 脚本并发闸毒锁时 permit 泄漏
- **位置**：`crates/rule-engine/src/execute.rs`（`ScriptPermitGuard::drop`）
- **问题**：acquire 端有毒素恢复逻辑，drop 端在 Mutex 中毒时直接丢弃 guard 不归还 permit → 并发容量永久减一，多次后脚本执行彻底饿死。
- **最优解法**：drop 的中毒分支同样执行 `add_permits(1)`；或改用 `Semaphore` 的 `forget` 计数方式，确保任何路径都归还。

#### P1-13 IP 直连 HTTPS 时叶子证书生成 DnsName SAN 而非 iPAddress SAN
- **位置**：`crates/tls-manager/src/generator.rs:179`
- **问题**：以 IP 访问的 HTTPS 站点签出的证书 SAN 类型错误，客户端主机名校验必失败，MITM 对 IP 目标不可用。
- **最优解法**：host 解析前判断是否为 IPv4/IPv6 字面量，IP 走 `SanType::IpAddress`，域名走 `SanType::DnsName`。

### 3.3 前端数据链路

#### P1-14 WS 消息窗格快照与实时事件竞态丢帧 + 加载失败静默 ✅ 已修复
- **位置**：`features/sessions/components/SessionInspectorMessagesPane.tsx:134-160`
- **问题**：effect 1 先清空并异步 `listWsMessages(sessionId)`，effect 2 立即订阅 `onWsMessage`。若消息在快照发出后、resolve 前到达，会被 append 进 state，随后快照整体覆盖导致丢失；`listWsMessages(...).then(...)` 无 `.catch`，命令失败时产生 unhandled rejection，窗格永远显示“无消息”。
- **最优解法**：先建立订阅并缓冲带序号的实时帧，快照 resolve 后按 `msg.id` 去重合并且排序；`.catch` 中展示错误态；用一次性 `isMounted` 或 AbortSignal 避免竞态。

#### P1-15 upsert 缓冲与 remove 即时生效破坏事件顺序一致性
- **位置**：`features/sessions/use-session-events.ts:57-109`
- **问题**：`session-upsert` 有 100ms 缓冲，`session-remove` / `sessions-removed` 即时生效。同一会话 id 在窗口内“先 upsert 后 remove”时，remove 先应用、flush 再把该会话复活进 store；`onSessionsRemoved` 不清扫 `upsertBuffer`。
- **最优解法**：remove/clear 同样进入缓冲队列按到达顺序回放；或 flush 时以 buffer 内最后一条事件为准做同 id 折叠；`onSessionsRemoved`/`onSessionsCleared` 同步 purge 缓冲。

#### P1-16 `useStableKeyedRows` 在 setState updater 内执行副作用 ✅ 已修复
- **位置**：`hooks/use-stable-keyed-rows.ts:82-113`
- **问题**：`update/remove/add` 把 `lastEmittedRef.current = stripped` 和 `onChangeRef.current(stripped)` 写进 `setRows` updater。StrictMode 下 updater 被双调用 → onChange 触发两次；updater 可能在 render 阶段被重放，触发父组件 setState 属于渲染期副作用。
- **最优解法**：updater 只算 next rows；`onChange`/`lastEmitted` 移到 `useEffect`（比较 prev/next）或在事件回调里先算好再 set。保持该 hook 对调用者 API 不变。

#### P1-17 `shouldFallbackToLocalStore` 字符串启发式可在桌面端吞掉真实保存错误
- **位置**：`services/commands/runtime.ts:50-65`；调用点 `services/commands/rules.ts:143,168,204`、`throttling.ts:118`
- **问题**：桌面端 `isTauriRuntime=true` 时，只要后端错误消息包含 `"not found"` / `"failed to invoke"`，`saveRewriteRule` 等就静默改写 localStorage 并返回成功。真实后端错误（如 "Workspace not found"、IPC 层 "failed to invoke"）会让规则只落在前端本地——代理不生效、重启即丢。
- **最优解法**：改为按结构化 `code`（如专用 `COMMAND_NOT_REGISTERED`）判断；桌面端完全不走 localStorage 回退、直接抛错；若必须保留 localStorage 模式，仅在明确离线/未注册时触发。

#### P1-18 流式会话 detail 以 ~10Hz 走 Tauri IPC refetch ✅ 已修复
- **位置**：`features/sessions/use-session-events.ts:49-54`；`services/commands/sessions.ts:73-105`
- **问题**：每批 flush 对每条 summary invalidate `SESSION_DETAIL_QUERY_KEY`，被选中的流式会话 detail 以约 10Hz 频率走 IPC refetch，使 Inspector 的 parse memo 失效。
- **最优解法**：流式响应期间用 `queryClient.setQueryData` 直接把 summary/partial body 合入 detail cache，而不是 invalidate；非流式场景保留 refetch。详情增量更新走 `session-upsert` payload 中的增量字段。

### 3.4 UI 交互

#### P1-19 全局缺少 MutationCache，mutation 失败普遍静默 ✅ 已修复
- **位置**：`app/providers/AppProviders.tsx:93-107`
- **问题**：只配置了 `QueryCache.onError`，没有 `MutationCache.onError`。因此所有 mutation 失败必须由页面自行渲染，否则只进 console。certificates、collections、compose、throttling 等大量 mutation 无 `onError`。
- **最优解法**：在 `QueryClient` 中补 `mutationCache: new MutationCache({ onError: (error, _variables, _context, mutation) => { if (!mutation?.meta?.suppressGlobalErrorNotification) notification.error(...) } })`，与现有 QueryCache 兜底机制对称；页面级仍可按 `meta.suppressGlobalErrorNotification` 豁免。

#### P1-20 四个规则面板的批量删除均无确认对话框
- **位置**：`features/rules/components/RewriteRulesPanel.tsx:539-556`；`MapRulesPanel.tsx:257-274`；`DnsMappingsPanel.tsx:145`；`ScriptRulesPanel.tsx:269`（经 `RulesSharedUi.tsx:490-539` 的 RuleBatchBar）
- **问题**：多选后点 Delete 立即 `Promise.allSettled` 全部删除，仅事后 toast。单条删除四个面板都有 ConfirmDialog，批量路径漏掉了，违反 `UI_GUIDELINES.md` §11.4。
- **最优解法**：`RuleBatchBar` 的 `onDelete` 先触发统一确认框（展示将删除数量），确认后再执行；把确认逻辑提到 `pages/rules/index.tsx` 统一封装，避免四面板重复实现。

#### P1-21 断点拦截展开对话框的 Cancel 不丢弃修改
- **位置**：`features/breakpoints/components/BreakpointInterceptPanel.tsx:648-653`
- **问题**：Cancel 与 Apply 实现完全相同，都只 `setExpanded(false)`；而编辑经 `onChange` 实时提交到待转发状态。用户点 Cancel 预期放弃修改，但改动仍生效，随后 Resume 会把修改后的内容转发给真实服务器。
- **最优解法**：打开对话框时保存快照（deep clone 当前请求/响应状态），Cancel 恢复快照；或取消 Cancel 按钮只留 Done，明确语义。

#### P1-22 会话树键盘导航不把目标行滚动进可视区 🔄
- **位置**：`features/sessions/components/SessionExplorerPane.tsx:234-239`
- **问题**：导航后用 `requestAnimationFrame` + `querySelector('[data-session-id=...]')` + `scrollIntoView`，但列表经 `useVirtualizer` 虚拟化，虚拟窗口外的行不在 DOM，`querySelector` 落空。
- **最优解法**：删除 `querySelector` + `scrollIntoView` 方案；键盘导航时直接计算目标行在**可见行数组** `visibleRows` 中的索引（注意不是原始 session 索引），然后调用 `virtualizer.scrollToIndex(visibleIndex, { align: "auto" })`。同步验证 Home/End/Arrow 与过滤后的可见行一致。

#### P1-23 ConfirmDialog 立即关闭不等结果（删除限流规则 / collections 删除）✅ 已修复
- **位置**：`pages/throttling/index.tsx:416-429`；`pages/collections/index.tsx:612-640`；`use-collection-tree.ts:336,345`
- **问题**：`onConfirm` 里直接关闭对话框，不等 mutation settle；`deleteRuleMutation.error` / collection 删除错误全文件未消费，删除失败无提示。
- **最优解法**：`onConfirm` 里保留对话框开启并显示 `isPending` 状态，mutation 成功后再关闭；失败时展示 Alert / Snackbar，并保持对话框开启让用户可重试。

#### P1-24 Collections / Compose 保存失败完全静默或重复提交 ✅ 已修复
- **位置**：`pages/collections/index.tsx:260-286`；`pages/compose/index.tsx:235-261`；`SaveToCollectionDialog.tsx:117`
- **问题**：保存/upsert 只传 `onSuccess`；`isPending` 未用于禁用提交按钮，可双击重复创建；失败无提示。
- **最优解法**：补 `onError` 展示 Alert/Snackbar；提交按钮绑定 `isPending`；成功后重置表单；新建集合时按名称去重或后端加唯一索引 + 错误提示。

#### P1-25 envVars / globalVars 查询失败被 `?? []` 吞掉
- **位置**：`pages/compose/index.tsx:101-106,403`；`pages/collections/index.tsx:390`
- **问题**：变量查询失败 fallback 为空数组，变量替换静默失效；collections 页三处合并逻辑与 compose 行为不一致。
- **最优解法**：变量查询失败时展示 Alert，并在变量替换处保留原始占位符（让用户知道替换未发生）；统一提取 `useVariablesForScope` hook 供两页复用。

#### P1-26 Insights 后端查询失败静默回退前端计算
- **位置**：`features/insights/use-insights-data.tsx:213-222`
- **问题**：`useQuery` 的 `isError` 未解构未处理，失败时静默 fallback 到前端计算，最终显示 `noData` 而非错误。
- **最优解法**：解构 `isError` / `error`，在面板顶部展示 Error Alert 与重试按钮；明确告诉用户“后端聚合不可用，展示的是本地近似值”或完全回退到空态并提示错误。

#### P1-27 Certificates 生成/安装失败无任何页面反馈 ✅ 已修复
- **位置**：`pages/certificates/index.tsx:174-188`；`DesktopCertificateTab.tsx:246-331`
- **问题**：`generateMutation` / `installMutation` 无 `onError`，error 从未渲染；DiagnosticsCard 的 `isError` 未处理，诊断失败后回到 hint 文案。
- **最优解法**：补 `onError` 展示 Alert/Snackbar；DiagnosticsCard 失败态展示错误与重试按钮；把证书相关 mutation 错误统一到 i18n key `certificates.*.error`。

#### P1-28 `setActiveMutation`（15min 启用/全局禁用）失败完全无展示 ✅ 已修复
- **位置**：`features/throttling/use-throttle-editor.ts:196-201,437-442`
- **问题**：hook 只暴露 `saveProfileError` / `ruleSaveError`，切换 active profile 的 mutation 错误未被消费。
- **最优解法**：在 throttling page 的状态栏或 profile 列表旁消费 `setActiveMutation.isError` / `error`，失败时展示 inline Alert；或把错误纳入 `useThrottleEditor` 返回的 `editorState.error`。

### 3.5 架构与契约

#### P1-29 前端 features 网状依赖，存在循环依赖风险 🔄
- **位置**：`features/sessions/session-compose.helpers.ts:8` / `use-session-context-actions.ts:12` ↔ `features/compose/use-compose-request.ts:8-10`；`features/throttling/components/RuleEditor.tsx:20-22` ↔ `features/rules/components/RulesImportExportButtons.tsx:16`
- **问题**：跨 feature import 共 37 条边，sessions↔compose、rules↔throttling 存在明显互相引用。`ARCHITECTURE.md` 声称 features 按业务聚合、边界清晰，实际边界被大量跨 feature import 打破。
- **最优解法**：
  1. 先用 dependency-cruiser 或 `madge` 生成精确依赖图，确认是否真的形成模块级循环（而非单纯跨 feature 调用）。
  2. 把 `SessionInspectorShared`/inspector 组件族、`rules.helpers` 的编辑原语下沉到 `components/shared` 或独立 `packages/rule-ui` 模块。
  3. 用 eslint `no-restricted-imports` 把“禁止 feature→feature 内部 import”固化进 CI；分 2-3 个 PR 迁移，避免大爆炸重构。

#### P1-30 services 层反向依赖 features 状态
- **位置**：`services/commands/sessions.ts:25`；`rules.ts:29`；`throttling.ts:16`
- **问题**：命令客户端（基础设施层）`import ... from "@/features/sessions/imported-sessions.store"`，依赖上层业务 zustand store，在 `listSessions`/保存路径里做 HAR 导入会话合并。
- **最优解法**：把 `imported-sessions` 抽象为 `services/session-source` 模块（或 repository），合并逻辑上移到 hook/use-case 层；`services/commands/*` 只依赖 `shared-types` 与 `services/*`。

#### P1-31 契约漂移：死事件 + 部分命令文档缺失 🔄
- **位置**：`apps/desktop/src-tauri/src/commands/proxy.rs:542`；`docs/API_SPEC.md`
- **问题**：`"system-proxy-warning"` 事件 Rust 侧 emit，前端 0 处监听，用户永远看不到系统代理 reapply 失败告警。`show_log_file`、`list_map_session_trace` 两条命令在 `API_SPEC.md` 中未提及；`set_menu_locale` 已有文档。
- **最优解法**：前端状态栏订阅 `system-proxy-warning` 并展示警告图标/提示；补录 `show_log_file` 与 `list_map_session_trace` 或删除；把“命令/事件清单 vs generate_handler/emit”做成 CI grep 断言脚本。

#### P1-32 规则匹配语义在前后端双实现
- **位置**：`features/rules/rules.helpers.ts:304`；`crates/proxy-core/src/rules/patterns.rs:3`
- **问题**：同一契约（exact/regex/wildcard/contains）两份手写实现，规则测试器判定与代理热路径可能分叉。
- **最优解法**：短期建立共享 fixture 表（同一批 pattern/candidate/expected 在 Vitest 与 cargo test 两端跑同一数据集）；长期把 matcher 收敛进 `aiproxy-rule-engine` 作为唯一语义源，前端规则测试器调用 command 复用 Rust 实现。

#### P1-33 测试缺口集中在命令编排层与持久化边界
- **位置**：`src-tauri/src/bootstrap/converters.rs`（574 行）；`repository.rs`（919 行）
- **问题**：converters/repository 是三层契约转换枢纽，出错即 IPC 契约破坏，却零回归保护。22 个 Tauri 命令文件、前端 `services/commands/` 19 文件仅 2 个测试。
- **最优解法**：优先给 `converters.rs`（纯函数，成本最低收益最高）和 `repository.rs` 补测试；命令层至少覆盖 payload 解析与错误映射分支；前端 services/commands 用 mock Tauri invoke 覆盖成功/失败/解析失败路径。

---

## 4. P2 — Minor（迭代消化）

### 4.1 代理引擎

1. **每请求无条件深拷贝整个请求**  
   位置：`crates/proxy-core/src/http_proxy.rs:419`、`:691`。20MiB body 场景单请求 2-3 次全量拷贝。  
   解法：`intercept_request_stage` 改为按需返回编辑副本，guard 持 `Arc`。

2. **响应 Content-Length 一律丢弃**  
   位置：`crates/proxy-core/src/http_proxy.rs:1723-1739`。仅 spool 流式路径补回；HEAD 响应变成 `content-length: 0`，304 语义受损。  
   解法：HEAD/304 透传原长度。

3. **DNS 只取首个解析地址**  
   位置：`crates/proxy-core/src/timing_connector.rs:279-288`。双栈网络 AAAA 优先且无 IPv6 路由时，h1/h2 转发全失败。  
   解法：顺序尝试全部地址或实现 Happy Eyeballs。

4. **h2 连接池三处竞态/陈旧**  
   位置：`crates/proxy-core/src/upstream_pool.rs:17-21`、`:74`、`:312-322`。快路径写锁全局串行；evict_key 可能误删刚重建的健康连接；池键无 DNS 维度而 `DnsManager` 运行时可变。  
   解法：快路径读锁+双重检查；evict 带 `last_used` 校验；键加 override 维度或规则变更时清池。

5. **eviction timer 任务不可取消**  
   位置：`crates/proxy-core/src/upstream_pool.rs:283-292`。无限 loop，代理服务器重启即泄漏一个 task 和整个旧池。  
   解法：关联 shutdown token，stop 时 cancel。

6. **Map/Throttle/Dns 规则表每请求深拷贝 + regex 每请求重新编译**  
   位置：`crates/proxy-core/src/rules/mod.rs:120-132,219-243,51`；`patterns.rs:8`。  
   解法：与 Rewrite/Script 对齐，使用 `Arc` 快照缓存 regex。

7. **WS 消息重组超 20MiB 静默丢弃且不置截断标记**  
   位置：`crates/proxy-core/src/ws.rs`（组装器）。  
   解法：超限时设置 `truncated: true` 并返回前端可见标记。

8. **响应 body rewrite 整份克隆做变更检测**  
   位置：`crates/proxy-core/src/rules/rewrite.rs:725`。20MiB body 每条命中规则多一次全量拷贝。  
   解法：比较 replace 前后指针/长度，或延迟 strip 判定。

9. **ws_tls_server_name 解析失败静默回退 127.0.0.1**  
   位置：`crates/proxy-core/src/ws_upgrade.rs:147-152`。SNI 错误导致上游证书校验失败或路由错乱。  
   解法：显式报错，让 UI 提示无法建立 WS 连接。

10. **trailers 静默丢弃**  
    位置：`crates/proxy-core/src/upstream.rs:711-714`。`Err(_) => continue` 让 gRPC/OCSP 类 trailer 语义丢失。  
   解法：记录 trailer 读取失败日志，或把 trailer 帧转发给客户端。

11. **ProxyBodyReference::Serialize 内阻塞 fs::read + base64**  
    位置：`crates/proxy-core/src/types.rs:375-390`。序列化发生在会话发送链路，大文件会卡住 async 执行器线程。  
   解法：预读为 FilePath 引用传元数据，由前端按需拉取。

### 4.2 安全与平台

1. **Linux 信任检测每次全量哈希 CA 目录**  
   位置：`crates/tls-manager/src/trust.rs:447`。每次状态查询读取并对 `/etc/ssl/certs` 数百个文件做 SHA1。  
   解法：缓存目录 mtime，未变化直接返回上次结果。

2. **Insights 分位数全量载入内存 + `LOWER(host)` 使索引失效**  
   位置：`crates/db/src/insights.rs`。大会话量下内存峰值与全表扫描。  
   解法：SQL 内用窗口函数/排序取行法算分位数；host 匹配改大小写不敏感 collation 列。

3. **脚本校验正则与运行时改写不一致**  
   位置：`crates/rule-engine/src/compile.rs:60-89` vs `:155-173`。`detect_entrypoints` 用 `\s+`，`build_runtime_module` 用字面单空格 replace。  
   解法：改写也用正则，或校验阶段归一化空白。

4. **`list_sessions` 同步全量克隆最多 15k 条 summary 过 IPC**  
   位置：`apps/desktop/src-tauri/src/commands/sessions.rs:163`；`bootstrap/cache.rs`。大会话量下列表刷新卡 IPC 线程。  
   解法：分页 + 游标，或改 `run_blocking_command` 并增量下发（已有 `session-upsert` 事件可做基础）。

5. **adb 设置代理时 host 未验证即拼入 shell 参数**  
   位置：`apps/desktop/src-tauri/src/commands/certificates.rs:932-964`。  
   解法：校验 `host[:port]` 格式后再拼接，保持纵深防御一致性。

6. **强制重新生成根 CA 前不撤销旧 CA 的系统信任**  
   位置：`commands/certificates.rs`（`generate_root_certificate_impl` 旋转分支）。  
   解法：覆盖旧 CA 文件前对旧指纹执行一次 best-effort 撤信任并记录结果。

7. **`clear_all_sessions` 毒锁跳过 DB 清理但 body 清理照跑**  
   位置：`bootstrap/repository.rs`。失败后仅 500ms 重试一次，极端情况下残留孤儿 body 文件。  
   解法：失败时把 body 清理也跳过，或引入补偿任务定期扫描孤儿 body。

8. **`port_manager/mod.rs` 文档与实现工具不一致**  
   文档称 Unix 用 netstat/ss，实际 unix.rs 用 lsof。  
   解法：修订文档。

9. **system_proxy Linux KDE 分支仅支持 kwriteconfig6**  
   位置：`crates/proxy-core/src/system_proxy/linux.rs`。kf5 系统静默落入 unsupported 兜底。  
   解法：同时探测 kwriteconfig5 / kreadconfig5 路径。

10. **`window_state.rs:464` 窗口几何写盘非原子**  
    损坏仅丢窗口位置，可接受；建议改 temp+rename 保持一致性。

### 4.3 前端数据链路

1. **`ws.ts` 错误信息丢失**  
   位置：`packages/shared-types/src/ws.ts:32-40`。数组入参 `throw coerceAppError(value)` 只会得到 "An unexpected error occurred."。  
   解法：返回结构化 `INVALID_WS_MESSAGES` code 并携带原始诊断信息。

2. **部分事件处理器静默丢弃畸形 payload**  
   位置：`services/events/index.ts:105-110,127-132,139-144,153-157`（session-remove/sessions-removed/ws-*）。  
   解法：统一打 `logDevWarn`，与 session-upsert 等通道一致。

3. **`useThrottledValue`/`useDebouncedValue` 依赖数组身份导致 insights debounce 永不结算**  
   位置：`use-insights-data.tsx:196`。持续流量下 `activeSessionIds` 每 100ms 都是新数组。  
   解法：debounce 基于 ids 内容签名（sorted join）而非引用。

4. **常驻轮询偏多 + 日志开销**  
   位置：`use-proxy-status.ts:29-30`（2s 且后台也轮询）；`use-session-filters.ts:63`（即使未开启 showOnlyThrottled 也轮询）。  
   解法：后者加 `enabled: showOnlyThrottled`；前者日志降为 debug。

5. **`insights` queryKey 含完整 ids 数组导致缓存条目线性增长**  
   位置：`features/insights/use-insights-data.tsx:218`。  
   解法：对 ids 做稳定哈希/长度+尾部分片作 key。

6. **Updater install 成功路径不清 `isInstalling`、双击安装无并发防护**  
   位置：`features/updater/update-status.ts:36-47`；`services/updater/app-updater.ts:8,47-75`。  
   解法：install 入口加 in-flight 守卫；check 失败时清空 pendingUpdate。

7. **批量删除仅改本地 store，措辞与持久化预期不符 + 死代码**  
   位置：`pages/sessions/index.tsx:482-495`；`services/commands/sessions.ts:256`。  
   解法：若设计为“仅清除视图”则把 snackbar 文案改为“已清空视图”；若应删后端则接通后端命令。删除 `deleteSessionsExcept` 死包装。

8. **`buildInlineBodyReference` 用字符数冒充字节数**  
   位置：`features/sessions/session-cache.helpers.ts:175`。多字节 UTF-8 下低估体积。  
   解法：用 `new Blob([bodyText]).size` 或 `TextEncoder.encode(bodyText).length`。

9. **上下文菜单复制类 async handler 未捕获拒绝**  
   位置：`use-session-context-actions.ts:156-249`；`SessionContextMenu.tsx:104-107`。  
   解法：包装 `try/catch` 并在失败时 snackbar 提示。

10. **`useSessionDetail` 重试策略 + 高频 invalidate 叠加**  
    位置：`use-session-detail.ts:14`。  
   解法：流式场景用 `setQueryData` 直接合入 summary；非流式保留默认 retry 但加节流。

### 4.4 UI 交互

1. **Rewrite 无效组合不阻止保存**  
   位置：`RewriteRulesPanel.tsx:465-477`、`:506`、`:668-672`。`UI_GUIDELINES.md` §9.4 要求无效组合须阻止保存。  
   解法：把 `invalidCombination` 纳入保存门槛。

2. **断点面板复制无反馈**  
   位置：`BreakpointInterceptPanel.tsx:501`。  
   解法：copy 后显示 snackbar，与 sessions 复制行为一致。

3. **端口输入清空即回填默认值**  
   位置：`pages/settings/index.tsx:306-310`。`Number(event.target.value) || DEFAULT_PROXY_PORT`。  
   解法：允许空字符串草稿态，失焦/提交时再校验回退。

4. **视觉一致性：文档与实现 token 漂移**  
   位置：`docs/UI_GUIDELINES.md:90` vs `packages/ui-tokens/src/index.ts:3`。实现内部一致，文档过期。  
   解法：以 `ui-tokens` 为准修订 `UI_GUIDELINES.md`。

5. **会话树叶子行信息密度不足**  
   位置：`SessionExplorerPane.tsx:451` 起。未展示 status/duration，与 UI_GUIDELINES 要求不符。  
   解法：在叶子行追加 status 图标、duration、size 等（受列宽限制时截断 + tooltip）。

6. **硬编码英文 aria-label**  
   位置：`features/rules/components/RulesSharedUi.tsx:393`：`aria-label={`select ${item.name}`}`。  
   解法：改走 i18n，例如 `t('rules.selectRuleAriaLabel', { name: item.name })`。

7. **i18n 值未翻译抽查**  
   位置：`i18n/messages/en.ts` 与 `zh-CN.ts`。`sessionExplorer.unfocused`、`settingsPage.aboutCommitHash` 等 en/zh 值相同。  
   解法：复核这些 key 是否应为双语；技术名词可保留，但“Unfocused”建议补中文。

8. **平台兜底不一致**  
   位置：`pages/certificates/index.tsx:334` 兜底 `"windows"`；`SetupWizard.tsx:264` 兜底 `"macos"`。  
   解法：统一从 `osType()` 读取，无兜底；若必须兜底，取 `"macos"`（开发主力平台）并文档化。

9. **MobileSetupTab useLocalIp isError 丢弃**  
   位置：`pages/certificates/MobileSetupTab.tsx:95`。  
   解法：失败时展示 Alert 与重试按钮。

10. **docs/index.tsx content undefined 渲染空白**  
    位置：`pages/docs/index.tsx:206-217`。  
   解法：content 未加载/失败时展示 empty/error 提示。

11. **throttling 硬编码 `${...} min` 英文**  
    位置：`pages/throttling/index.tsx:95`。  
   解法：走 i18n 带插值，例如 `t('throttling.durationMinutes', { minutes })`。

12. **compare 页 detailState.error 无重试、URL 失效 id 不清除**  
    位置：`pages/compare/index.tsx:145-147`。  
   解法：错误时展示带重试按钮的 Alert；URL 中无效 id 清除或替换为提示。

13. **compare 页 summaryMutation.isPending 未传入面板**  
    位置：`pages/compare/index.tsx:225-231`。生成中面板仍显示 idle 提示。  
   解法：把 `isPending` 传给 `AiSummaryPanel` 展示 loading。

### 4.5 架构与工程

1. **三层同构不完整：shared-types 缺部分域文件**  
   位置：`services/commands/files.ts:8,40,69,103,117`；`menu.ts:7`；`rules.ts:185,191`。8 个命令 payload 类型散落在命令客户端内。  
   解法：把 payload 类型上收到 `packages/shared-types/src/commands/{files,menu,rules}.ts`。

2. **两条命令绕过命令客户端层**  
   位置：`SessionInspectorMediaPreview.tsx:179` 直接 `invoke("save_media_file")`；`lib/download.ts:18` 直接 `invoke("save_text_file")`。  
   解法：统一走 `services/commands/files.ts` 封装，便于集中校验与 mock。

3. **`isTauriRuntime` 定义 4 处**  
   位置：`services/commands/runtime.ts:28`（canonical）；`components/layout/hooks/helpers.ts:20`；`use-window-controls.ts:3`；`lib/download.ts:7`。  
   解法：全部从 `services/commands/runtime.ts` 导入。

4. **巨型文件/组件**  
   位置：`BreakpointInterceptPanel.tsx` 1921 行；`RewriteRulesPanel.tsx` 1720 行；`pages/settings/index.tsx` 1682 行；`SessionInspectorShared.tsx` 1549 行；`proxy-core/src/tests.rs` 5626 行；`crates/db/src/rules.rs` 2366 行。  
   解法：按 UI 子域/测试模块拆分；`tests.rs` 按测试目标拆到各模块 `#[cfg(test)]` 子模块。

5. **页面实现位置不一致**  
   位置：`pages/certificates/` 含 11 个组件但 hooks 在 `features/certificate-center/`；`pages/settings/index.tsx` 无 feature 模块。  
   解法：certificates 拆出 `features/certificates-settings`；settings 拆分为 `features/settings/*` + 薄 page。

6. **i18n 单文件超大**  
   位置：`i18n/messages/en.ts` 2112 行；`zh-CN.ts` 2016 行。违反 `ARCHITECTURE.md` §5.1.1“按领域分组”。  
   解法：按域拆分为 `messages/sessions.ts`、`messages/rules.ts` 等，保留 `messages/index.ts` 合并导出以维持现有 `t()` 类型。

7. **文档漂移（ARCHITECTURE.md 内部）**  
   §12 目录树缺 `crates/sys-util`、缺 src-tauri 7 个顶层模块、shared-types 树缺 `rules-export.ts`；§13 漏 `aiproxy-sys-util`；§7.3 事件清单缺 `breakpoint-released`；§9.2 workspace 实体缺字段。  
   解法：以当前代码为准批量修订 ARCHITECTURE.md 目录树与字段清单。

8. **CI format:check 覆盖不全**  
   位置：`.github/workflows/ci.yml`。仅 desktop 与 shared-types 跑 format:check，`packages/ui-tokens` 有 format 脚本但 CI 不检查。  
   解法：CI 改 `pnpm -r format:check`。

9. **db crate 泄漏驱动类型**  
   位置：`crates/db/src/lib.rs:17` `pub use rusqlite;`。  
   解法：隐藏 `rusqlite` 类型，只暴露 `ConnectionPool`/事务句柄；同时评估把全局 DB Mutex 改成读写锁或连接池。

10. **shared-types 无类型生成机制**  
    Rust serde 结构、DB row、TS 类型三份手写同步。  
   解法：短期在 ADR 中显式记录取舍；长期引入 `ts-rs`/`specta` 生成 TS 类型，减少 converters.rs 人肉转换。

---

## 5. 架构级建议（非缺陷，但影响长期演进）

1. **错误类型以 `String` 为主**：`ProxyError` 各变体携带 `String`，协议错误靠字符串前缀二次分类，跨层判断脆弱。建议引入结构化错误（`kind + source`）。
2. **巨型上下文与位置参数**：`handle_connect_mitm` 约 19 个位置参数，`ConnectionContext`/`ProxySessionDetail` 字段庞大且贯穿管线 clone。建议拆分子上下文（网络层/规则层/会话层）。
3. **h1 无上游连接复用**：`upstream.rs` h1 路径每请求新建 TCP+TLS，高 QPS 下延迟与对端压力显著。建议补齐 h1 连接池。
4. **同一协议双实现并存**：手工 httparse 探测 + hyper 服务、手工 WS upgrade 握手 + hyper upgrade 两套路径长期共存，行为易漂移。建议明确 hyper 为唯一权威、手写层只做字节级补位。
5. **测试专用全局量渗入生产结构**：`lib.rs` 中 test-only `AtomicU64` 超时覆盖及 RAII guard 使生产代码承载测试形态；超时常量散落多处（30s/120s/10min/5min/5s/10s），缺乏统一的“超时矩阵”定义点。建议把超时矩阵集中到 `config` 或 `consts` 模块。
6. **统一附件路径信任模型**：`multipart.rs` 与 `files.rs` 的信任模型不一致，应全局确立“后端持对话框 / renderer 不传路径 / 附件用 token”原则。
7. **前端 feature 边界固化**：建议在 CI 引入 dependency-cruiser，禁止 feature→feature 内部 import；把共享 inspector/规则编辑原语下沉。

---

## 6. 做得好的方面

- **Rust 依赖图干净**：crate 间无环、无反向依赖、`src-tauri` 正确依赖全部 crate。
- **命令注册零漂移**：97 个 `#[tauri::command]` 与 `generate_handler` 一一对应，前端 invoke 95/97 对齐。
- **共享契约与运行时校验**：`packages/shared-types` 被 162 个前端文件引用，parse/coerce 失败时 `logDevWarn` 而非静默吞；自带契约测试。
- **安全基线扎实**：私钥 0600/目录 0700 权限、原子写（temp+rename）、`save_response_files` 的 `O_NOFOLLOW`+`O_EXCL`+symlink 攻击测试是教科书级实现。
- **系统代理跨平台对称**：macOS 多服务原子回滚、Windows server-first 写序、Linux 多 DE 分支、崩溃快照 schema 校验链路健壮。
- **测试文化**：proptest 实际用于 `rules/patterns.rs` 与 `db/body_store.rs`；CI 覆盖 lint/format/typecheck/test/build/clippy/cargo test；注释中 H#/M#/D# 编号显示长期安全迭代纪律。
- **i18n 机制健壮**：en/zh-CN 1600 个 key 零偏差，缺 key 运行时抛错，`TranslationKey` 由 en 文件类型派生。
- **对话框键盘行为**：15 处 Dialog 均未破坏 MUI 默认 Esc/焦点陷阱/焦点还原行为。

---

## 7. 建议修复顺序（已按核验结果调整）

### 第一阶段（当周，P0 止损）— ✅ 已完成（2026-08-22）
1. P0-1 限流 Apply preset 传参修复。（`b14f48e1`）
2. P0-5 Windows PowerShell 参数绑定修复（**必须**在真实 Windows 环境实测后合并）。（`ac06b1be`）
3. P0-6 组合请求附件路径根目录约束（安全加固，注意不能破坏正常附件场景，长期应走 token 方案）。（`561e1de0`）
4. P0-7 Clippy 恒真断言修复，使 `cargo clippy --workspace --all-targets` 通过。（`561e1de0`，同 commit 移除 `|| true`）
5. P0-2 规则编辑器脏检查守卫（避免用户数据丢失）。（`fd0871c9`）

### 第二阶段（两周内，P1 稳定性与性能）— ✅ 已完成（2026-08-22）
6. P0-3 / P1-14 / P1-18 会话页 selector 化 + detail 增量更新 + WS 消息窗格批处理。（`fce819d3` / `3c3c2a02` / `023a6c02`）
7. P1-1 / P1-2 / P1-3 代理超时矩阵统一（WS 帧间空闲与帧内读分离、upgrade 整体超时、hyper Timer + TLS accept 限时；另含 relay 取消保留半读帧的关联加固）（`9d1a3edf` / `206f51bc` / `e1d6fb07` / `8f11d092`）
8. P1-4 / P1-5 spool 文件 RAII 清理 + head 相位限时 + 响应体逐 chunk idle 上限。（`fb6c651c` / `06d881e8`）
9. P1-7 通配符匹配假阴性修复（显式回溯 + 与等价 regex 对齐的 proptest）。（`1bd537d0`）
10. P1-19 全局 MutationCache 兜底 + 各页面 mutation 反馈补齐（含 P1-23 / P1-24 / P1-27 / P1-28：删除对话框等结果、防双击、证书页本地化错误、setActive 错误浮出）。（`5de4803b`）
11. P1-9 CA 指纹直接由原始 DER 计算（保留 rcgen 对象用于签名）。（`790fc8b0`）
12. P1-16 `useStableKeyedRows` updater 副作用移除。（`3c2b4fc4`）

### 第三阶段（一个月内，架构与债务）— 待开始
13. P1-29 / P1-30 前端 feature 边界重构 + services 反向依赖解除。
14. P1-31 / P1-32 契约清单 CI 断言 + 规则 matcher 共享 fixture。
15. P1-33 converters/repository 补测试。
16. P1-6 断点头编辑多值头/非法值处理修复。
17. 第四节 Minor 项作为专项 backlog，**不建议与 P0/P1 同批大规模修改**。

---

## 8. 核验与勘误

报告初稿完成后，由人工在当前代码基线上对关键条目做了二次复核。结论如下：

### P0 核验

| 条目 | 结论 | 方案评价 |
| --- | --- | --- |
| P0-1 限流 Apply 错 profile | ✅ 确认 | `ProfileList` 已传入行 profile，父组件忽略参数；应改为 `handleTemporaryEnable(profile.id)` 并保留无参 fallback。 |
| P0-2 规则脏检查缺失 | ✅ 确认 | 文档要求 `useUnsavedChangesGuard`，代码没有；切 tab 会卸载面板。优先统一实现守卫，不能只依赖保持挂载。 |
| P0-3 Sessions 全量订阅/派生数组 | ✅ 确认 | 页面使用 `store()` 全量订阅，`deriveActiveData` 每次创建新数组。selector 和稳定引用方案正确；增量 host 缓存属后续优化。 |
| P0-4 WS 每帧更新并全量过滤 | ✅ 确认 | 微批处理和 lowercase 缓存正确；虚拟化只能减少渲染，不能自动减少 `filter` 成本。 |
| P0-5 Windows CA 检测/移除失效 | ✅ 确认 | PowerShell `param()` 与 `-Command` 尾部参数用法不匹配；`-File` 或脚本块参数绑定方案正确，必须补空参数校验和 Windows 集成测试。 |
| P0-6 multipart 任意文件读取 | ✅ 确认 | 当前只 canonicalize、检查文件和大小，没有根目录限制；仅限制固定目录可能破坏正常附件场景，长期应采用 Rust 文件对话框 + token。 |
| P0-7 Clippy 恒真断言 | ✅ 确认并复现 | `cargo clippy -p aiproxy-desktop --all-targets` 在 `files.rs:1792` 失败；断言应表达“保留零宽连接符”的实际语义。 |

### P1 核验

以下条目经当前代码检查确认仍存在：

- 代理链路：P1-1、P1-2、P1-3、P1-4、P1-5、P1-6、P1-7、P1-8。
- TLS/安全：P1-9、P1-10、P1-11、P1-12、P1-13。
- 前端数据链路：P1-14、P1-15、P1-16、P1-17、P1-18。
- UI 反馈与守卫：P1-19、P1-20、P1-21、P1-22、P1-23、P1-24、P1-25、P1-26、P1-27、P1-28。
- 架构与测试：P1-30、P1-32、P1-33。

### 已修正方案的条目（见 🔄 标记）

- **P1-3**：Hyper timer/`header_read_timeout` 需要结合当前 Hyper API 验证，不能只添加 `TokioTimer` 就认为完成。
- **P1-8**：`try_send` 丢弃会话会造成数据损失，必须同时设计丢弃计数、UI 提示和大 body 引用策略。
- **P1-9**：指纹应从原始 PEM DER 计算；但重建的 rcgen issuer 仍用于签发叶子证书，不能简单删除重建逻辑。
- **P1-22**：虚拟列表滚动应使用 `visibleRows` 中对应的行索引；不能直接把 session index 当作 virtualizer index。
- **P1-29**：跨 feature 依赖确实存在，但“形成模块循环”还应通过 dependency graph 工具最终确认。
- **P1-31**：`set_menu_locale` 已在 `API_SPEC.md` 中补录；`show_log_file`、`list_map_session_trace` 仍缺文档，`system-proxy-warning` 确实没有前端监听。

### 已有修复或描述过时的条目

代码中已有明显修复痕迹的包括：

- WebSocket 关闭握手、连接驱动 RAII 清理等部分历史问题。
- 证书删除流程已有 `onError` 和部分错误反馈。
- `shouldFallbackToLocalStore` 已收窄启发式，但报告指出的根本风险仍存在。
- 前端测试和 Rust 规则/TLS 测试均通过，说明已有不少回归修复。

### 验证结果

- `pnpm --filter @aiproxy/desktop typecheck`：通过。
- 前端测试：80 个文件、547 个测试全部通过。
- Rust wildcard tests：10 个通过。
- Rust TLS manager tests：54 个通过。
- Clippy：仍因 P0-7 失败。

## 9. 记录说明

- 所有 file:line 均基于 v0.1.x 当前工作区（1fd7b56d 及其 tree）。
- Critical / Major 发现均已由 reviewer 打开完整相关代码确认，非推测。
- 本报告应同步更新：若修复其中任一项导致 `docs/API_SPEC.md`、`docs/ARCHITECTURE.md`、`docs/UI_GUIDELINES.md`、`docs/PAGE_BLUEPRINTS.md` 过时，请在同一 PR 内同步文档。

---

## 10. 修复进展（2026-08-22）

第一、二阶段已在 `v0.1.x` 分支完成，共 20 个修复 commit。下表 hash 为改写后的当前值（commit 信息已统一为英文，见 `AGENTS.md` §5 语言约定）。已修复条目在正文标题处同步标注 ✅。

### 10.1 第一阶段：P0（全部完成）

| 条目 | 状态 | commit | 修复方式 |
|---|---|---|---|
| P0-1 限流 Apply preset 传错 profile | ✅ | `b14f48e1` | 行 profile 显式传参，无参 fallback 保留 |
| P0-2 规则编辑器脏检查缺失 | ✅* | `fd0871c9` | 草稿守卫；一期仅 RewriteRulesPanel，其余面板见 §10.3 余项 |
| P0-3 Sessions 整库订阅 + 派生数组 | ✅* | `fce819d3` | 细粒度 selector + 引用稳定；upsert 仍每次重建订阅字段，10Hz 渲染仅部分消除（§10.3） |
| P0-4 WS 窗格每帧 setState 全量过滤 | ✅ | `3c3c2a02` | 快照/实时竞态修复 + rAF 微批 + lowercase WeakMap 缓存 |
| P0-5 Windows PowerShell 参数绑定 | ✅ | `ac06b1be` | `param()` 显式绑定 thumbprint/location |
| P0-6 附件任意文件读取 | ✅ | `561e1de0` | allowed-roots 收口 + Content-Type 校验 |
| P0-7 Clippy 恒真断言 | ✅ | `561e1de0` | 删除 `\|\| true`，断言表达真实语义并带失败消息 |

### 10.2 第二阶段：P1（12 个工作项全部完成）

| 条目 | 状态 | commit | 修复方式 |
|---|---|---|---|
| P1-1 WS 帧间空闲 30s 误断 | ✅ | `9d1a3edf` | 帧间空闲（300s）与帧内分片读（30s）分离 |
| （关联加固）relay 取消丢半读帧 | ✅ | `8f11d092` | relay 取消时保留半读帧，跨 read 重入不丢数据 |
| P1-2 WS upgrade 链路无超时 | ✅ | `206f51bc` | dial→TLS→写请求→读 head 整体超时包裹 |
| P1-3 hyper 无 Timer / TLS accept 无界 | ✅ | `e1d6fb07` | 三处 serve_connection 装 TokioTimer + header_read_timeout；TLS accept 外层限时；slow-loris 回归 |
| P1-4 spool 文件错误路径泄漏 | ✅ | `fb6c651c` | RAII guard：任何早退/取消路径删除临时文件 |
| P1-5 120s 总时长截断大响应 | ✅ | `06d881e8` | 超时语义收敛到 head 相位；body 改逐 chunk idle 上限（30s） |
| P1-7 通配符假阴性 | ✅ | `1bd537d0` | 显式回溯匹配 + 与等价 regex 对齐的 proptest |
| P1-9 CA 指纹漂移 | ✅ | `790fc8b0` | 指纹从磁盘原始 DER 计算（按 🔄 修正后方案，保留 rcgen issuer） |
| P1-10 save_media_file symlink 防护 | ✅ | `561e1de0` | O_NOFOLLOW 写入 + symlink 攻击测试（随 P0-6 同 commit） |
| P1-14 WS 窗格快照竞态丢帧 | ✅ | `3c3c2a02` | 先订阅后快照、按 id 去重合并 + loadError 重试态 |
| P1-16 keyed rows updater 副作用 | ✅ | `3c2b4fc4` | 副作用移出 setState updater，StrictMode 不再双发 onChange |
| P1-18 detail 10Hz invalidate | ✅ | `023a6c02` / `929973a7` | setQueryData 原地合并；首版回归（in-flight body 永不更新）已在完成转换点补单次 invalidate 修复 |
| P1-19 全局 MutationCache 缺失 | ✅ | `5de4803b` / `7123983e` | MutationCache.onError 兜底 + meta 豁免；首版仅证书页豁免产生双重提示，已为全部本地渲染错误的 mutation 补齐 meta |
| P1-23 ConfirmDialog 不等结果 | ✅ | `5de4803b` | 成功才关对话框，失败 inline Alert 留守可重试 |
| P1-24 collections/compose 静默失败 | ✅ | `5de4803b` | isPending 防双击 + 错误反馈 |
| P1-27 证书页无失败反馈 | ✅ | `5de4803b` | 本地化错误通知 + DiagnosticsCard 错误态与重试 |
| P1-28 setActive 错误无展示 | ✅ | `5de4803b` | setActiveError 暴露 + throttling 页 inline Alert |

### 10.3 剩余项

- **第三阶段候选**：P1-6、P1-8、P1-11、P1-12、P1-13、P1-15、P1-17、P1-20、P1-21、P1-22、P1-25、P1-26、P1-29 ~ P1-33。
- **backlog**：第 4 节 P2 全部条目。
- **复核新增（2026-08-22，见 §10.5）**：
  - P0-2 草稿守卫目前仅覆盖 RewriteRulesPanel，其余规则面板（断点、集合等编辑入口）待补齐。
  - P0-3 upsert 每次都重新分配订阅字段，缺少内容相等性 bail-out，Sessions 列表 10Hz 重渲染仅部分消除。
  - P1-3 h2 连接未配置 keep-alive 探活（`connect.rs` h2 builder 未传 `keep_alive_interval`），长静默连接可能被中间设备静默断开。
  - P1-5 spool 目录无容量上限，长期运行的磁盘增长为已知取舍；是否加 cap 待决策。
  - `save_text_file` 用普通 `fs::write` 写文件，会跟随指向不存在目标的符号链接（与 P0-4 加固同类，建议统一走 O_NOFOLLOW）。
  - P0-5 的 Windows 行为仍待真机手动验证（fail-closed 分支）。

### 10.4 整体验证（2026-08-22）

- `cargo clippy --workspace --all-targets`：通过。仅剩 4 个修复前已存在的告警（items_after_test_module ×3、server.rs too many arguments），已在 `da104ff2` 记录为范围外。
- `cargo test -p aiproxy-proxy-core`：306 通过；`cargo test -p aiproxy-tls-manager`：58 通过（报告基线时为 54）。
- 前端：typecheck 通过；Vitest 582 测试通过（基线 547）；format:check 通过；i18n en/zh-CN parity 5/5 通过。

### 10.5 复核（2026-08-22）

对基线 `1fd7b56d`..HEAD 共 20 个修复 commit 做了全面复核（多代理并行审查 + 逐项人工核验），结论：13 项完全修复，另发现并当场修复三个回归/缺口：

- **R1（P1-18 回归）** in-flight 会话完成时 body/detail 不再刷新 — `929973a7`：仅在 `statusCode <= 0 → > 0` 完成转换点补一次 invalidateQueries，恢复后端 `refresh_detail_if_cached` 的数据通路；回归测试锁定 exactly-once。
- **R2（P1-19 首版缺口）** 本地已渲染错误的 mutation 仍会弹全局 toast 造成双重提示 — `7123983e`：为全部本地渲染错误提示的 mutation 补 `meta.suppressGlobalErrorNotification`，并在 SetupChecklistCard 补本地 onError 兜底。
- **R3（P1-24 同类）** Compose 附加文件被拒绝时无任何反馈 + hint 未披露允许目录 — `4edb6c6a`：handleAttach try/catch 推送通知，hint 文案披露 Downloads/Pictures/Videos/Desktop/Documents 限制（en/zh-CN 同步）。

复核验证信号：前端 typecheck ✓、Vitest 584/584 ✓、eslint 0 error、format:check ✓；受影响 Rust 路径自基线以来未被改动。

### 10.6 P2 第一梯队（2026-08-23）

对第 4 节全部 54 条 P2 做了逐条核实（多代理并行 + 人工复核）：**0 条被基线后的修复顺带完全修复，49 条原样存在，4 条部分缓解，1 条实质已解决**。第一梯队（正确性/安全 × 小成本）当批修复如下：

| 条目 | 状态 | 修复方式 |
|---|---|---|
| P2 4.2-5 adb host 未校验拼 shell 参数 | ✅ | `is_safe_proxy_host` 白名单（主机名/IPv4/IPv6 字符）+ 单测；`adb shell` 在设备端拼接参数，元字符可执行设备侧命令 |
| P2 4.2-6 强制重签 CA 不撤旧信任 | ✅ | 覆盖旧文件前对旧证书 best-effort `remove_cert_trust_on_platform`，失败仅告警不阻塞签发 |
| P2 4.2-3 脚本校验与运行时改写不一致 | ✅ | `build_runtime_module` 复用校验器同形正则（`\s+` 宽容），补 odd-whitespace JS 执行级测试 |
| P2 4.4-1 Rewrite 无效组合不阻止保存 | ✅ | `handleSave` 增加 `invalidCombination` 门槛（UI_GUIDELINES §9.4），面板测试锁定 |
| P2 4.3-7 批量删除措辞与行为不符 + 死代码 | ✅ | snackbar 如实改为“已从当前容器移除”；删除死代码链 `deleteSessionsExcept` 包装 + `useDeleteSessionsExcept` hook（后端命令保留） |
| P2 4.1-2 Content-Length 一律丢弃 | ✅ | `build_hyper_response_from_upstream` 捕获上游声明长度，HEAD/304 重发原长度；GET 仍由 hyper 推导；回归测试锁定四类情形 |
| P2 4.1-5 eviction timer 不可取消 | ⛔ 误报 | `ProxyServerHandle::shutdown` → `pool.shutdown()` 自连接池引入时即会 abort eviction task 并清池（[proxy.rs](../apps/desktop/src-tauri/src/commands/proxy.rs) stop/restart 均走此路径）；原文与首轮核实均漏看 |
| P2 4.1-9 WS SNI 静默回退 127.0.0.1 | ✅ | `ws_tls_server_name` 改返回 `Result`，解析失败以明确错误终止升级并进入既有 502 路径；补拒绝用例 |

验证信号：`cargo clippy --workspace --all-targets` 无新增告警（5 条均为基线已有）；`cargo test` proxy-core 319 / desktop 121 / rule-engine 31 全过；前端 typecheck ✓、Vitest 595/595 ✓、format:check ✓。

第二、三梯队（引擎热路径性能、低成本 UI/一致性 polish）与 backlog 维持第 4 节原状，其中 4.1-11 建议直接放弃（生产路径已不走该序列化）、4.3-10 视为已解决（setQueryData 合并已落地）、4.3-5 前提不成立（react-query 对数组 key 结构化哈希且 gcTime 回收）。

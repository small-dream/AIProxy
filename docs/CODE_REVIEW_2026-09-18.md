# AIProxy 全仓代码审查报告（2026-09-18）

审查方式：7 个只读审查子代理并行深入扫描，覆盖 proxy-core（核心链路 + 规则/TLS 子系统）、rule-engine、tls-manager、db、sys-util、desktop 前端（接入层/状态层 + UI 层）、跨区契约一致性（shared-types / src-tauri / API_SPEC / 脚本）。所有条目均基于实际代码核实，附 `文件:行号`。

上一期报告 `docs/CODE_REVIEW_2026-08-21.md` 的【严重】P0 全部 7 条已确认修复；P1 抽查大部分已修复，仍遗留条目见 §8。

> **修复状态（2026-09-18，第二轮）**：第一轮 Top 10 已修复提交（026c6d79）。第二轮已修掉 §3/§4 中全部"简单低风险、改动小"的条目，要点：
> - **proxy-core**：手写 Serialize 补 `rewriteTraces`/`scriptTraces` 且 field_count 动态化；Transfer-Encoding 复合值按逗号拆分匹配；断点改请求 body 移除陈旧 content-length、编辑头部改 `append` 保留同名多头、`should_break` 复用 `find_matching_rule_id`、删除与 rewrite 重复的 strip helpers；响应头 set 先校验后修改；stage 词汇统一为共享 `rule_stage_matches`（"both"/"either" 均兼容）；DNS override 跳过解析失败规则并对齐 tie 语义；throttle 延迟饱和转换；ssl_proxying 新版结构加 `#[serde(default)]`；bench 改测 crate 自身解压路径。
> - **rule-engine / tls-manager**：脚本 permit 中毒泄漏与超发修复、TimedOut 误判改按中断标记判定、`JSON.stringify` 不可序列化兜底 `[unserializable]`；多证书 PEM bundle 指纹复用分块解析。
> - **db**：insights `GROUP BY LOWER(host)` 口径统一、session_ids IN 分批（500/批）、LIKE 通配符转义共享 helper；`column_exists` 传播解码错误；行解码加 clamp；两处排序补 tiebreaker；四处 `INSERT OR REPLACE` 改 UPDATE-or-INSERT。
> - **src-tauri**：compose/show_log_file 命令边界错误统一 `app_error()` 包装；`get_local_ip` 改 async（Windows PowerShell 走 spawn_blocking）。
> - **前端**：`reportCommandFailure` 改 `context` 具名字段；`AppCommandError` 统一（errors.ts）；localStore 三件套去重；updater 失败清 `pendingUpdate`；设备扫描超时就地化；死 barrel/重复 helper/冗余 effect 清理；`confirmLeave` 重入与卸载兜底；shared-types 错误 details 改 120 字符截断样本；两处 resize 监听器卸载清理；环境编辑器 lastSynced 守卫 + 卸载 flush；compare scope 内容签名比对；节流规则名/伪标头/兜底文案 i18n；Repeat 注入当前工作区；headers 编辑器唯一 id；zoom 步进取整；环境列表键盘可达性；rewriteSeed 走 unsaved-guard；spring-load 定时器清理。
> - **契约/工程**：API_SPEC 补 `systemProxyRecoveryWarning`、`commitHash`、binary 注入编码、workspace_id 预留标注、api_key 存储安全说明，事件命名规范改为连字符风格；release-checklist 新增五处版本一致性校验（AGENTS.md §13、ENGINEERING_GUIDELINES §9.4 已同步）；clean.mjs/desktop.mjs 小修；**CI 与 release-checklist 的 clippy 均已升级为 `--all-targets`**（三处 `items_after_test_module` 与一处 `too_many_arguments` 已修复，门禁转绿）。
>
> **仍遗留（复杂或需专项决策，建议后续单独处理）**：中 #6 WS 非 101 响应转发截断（需改流式转发）、#7 zip bomb 输出上限、#8 map-local 异步化/限容、#10 serde_json preserve_order、#11 SNI 复核、#12 compile.rs 入口点正则改 AST、#15 证书签名 spawn_blocking、#16 上游校验默认值决策、#2 请求阶段断点 Drop 补 session、#34 services→features 反向依赖下沉；旧报告 P1-8（session channel 无权重上限）、P1-11（api_key keychain）、P1-13（IP SAN）、P1-20/21/22/25/26、P1-29/32；db 迁移事务化；Windows 原子写 fsync；私钥 zeroize。

---

## 1. 结论概览

- 【严重】：0 条
- 【高】：7 条
- 【中】：约 30 条
- 【低】：约 40 条

整体工程质量较高：历史 bug 普遍有编号注释 + 回归测试钉死，并发/取消/资源清理的关键链路（PendingConnectGuard、spool RAII、事件监听清理、原子写入、PEM 校验）设计到位，SQL 全参数化无注入风险，i18n 双语键完全对齐（各 1642 键）。主要债务集中在三类：

1. **资源核算边界**：WS relay 逃逸连接上限、抓包上限误用于转发路径、解压无输出上限、accept 热自旋。
2. **契约三方漂移（代码/文档/shared-types）已形成真实 bug**：`ws-connection-status` 事件后端从未发射、`viaUpstreamProxy` 在 payload 层丢失、`system-proxy-warning` 死发射。
3. **既有修复模式漏套用**：多处问题属于"crate/代码库内别处已修复、此处遗漏"（resize 监听器清理、draft 同步守卫、LIKE 转义、IN 分批等）。

---

## 2. 【高】问题清单（全仓汇总）

| # | 位置 | 问题 |
|---|------|------|
| H1 | `crates/db/src/body_store.rs:125-133` | `relative_body_path` 在 Windows 产出 `\` 分隔路径，随后被 `checked_resolve_body_path` 拒绝：Windows 上所有 >256KB 落盘 body 静默不可读，退化为 `__invalid_body_path__` 哨兵且无报错。修法：用 `components()` 逐段以 `/` 拼接，补往返测试 |
| H2 | `crates/proxy-core/src/rules/map.rs:248`（+`http_proxy.rs:1283`） | map-local 规则失败（文件缺失/不可读）直接 `?` 冒泡 → hyper 断连，无响应、无 session，与 rewrite 已确立的"降级为 trace"原则（rewrite.rs:299-308 注释）直接矛盾。修法：降级为 trace + 继续转发，或生成带 session 的 502 |
| H3 | `services/commands/runtime.ts:60-64` | `shouldFallbackToLocalStore` 的 `"not found"` 启发式会匹配后端真实实体错误（db/error.rs:19 正是 `"{entity} not found"`），规则保存静默改写 localStorage 并返回成功，两端数据永久分叉。修法：只匹配命令未注册的精确错误形态 |
| H4 | `apps/desktop/src/pages/sessions/index.tsx:501-514,460-465` | 批量删除 / Clear Others 只删前端本地状态，后端 `delete_sessions_except` 命令零调用：进行中会话会被下一条 upsert 事件复活，重启后"已删"会话重现。修法：补前端命令封装，删除走后端并以 `sessions-removed` 事件驱动本地移除 |
| H5 | 后端全仓（事件从未发射） | `ws-connection-status` 事件：API_SPEC §7.3 标注"已实现"、前端有订阅、shared-types 有类型，但 Rust 侧从未发射（历史上从未存在）。WS 断开后 UI 永远显示活跃绿点。修法：在 `crates/proxy-core/src/ws.rs:714-722` 状态翻转处发射，或改轮询并修正文档 |
| H6 | `apps/desktop/src-tauri/src/commands/sessions.rs:43-90,399-443` | `SessionDetailPayload` 缺 `via_upstream_proxy` 字段：`get_session_detail`（Inspector 主路径）下 `viaUpstreamProxy` 恒 undefined，"经上游代理"指示永远 N/A。修法：payload 补字段透传 + converters 回归测试 |
| H7 | `apps/desktop/src-tauri/src/commands/proxy.rs:550-554` | `system-proxy-warning` 已发射但前端零订阅、API_SPEC 零记录：系统代理接管失效时用户无感知。修法：前端状态栏订阅 + API_SPEC §7 补录 |

另：接入层多处 `throw { code, message }` 普通对象字面量（rules.ts:393、files.ts:22,51,82,140、ai.ts:87），与 sessions.ts:31-43 自己的 M10 决议（保留真实 Error 栈）矛盾，定为高优先级风格/可排障性问题，统一改 `AppCommandError`。

---

## 3. 【中】问题清单（按分区）

### proxy-core 核心链路
1. `ws_upgrade.rs:633` — WS relay 任务逃逸 `MAX_CONCURRENT_CONNECTIONS` 信号量与 shutdown 跟踪：大量 WS 长连接可绕过 fd 保护，停止代理时 relay 不受控。修法：relay 持有 permit 并注册进连接跟踪集
2. `http_proxy.rs:437-441` — 请求阶段断点 Drop 不发 session，被丢请求在会话列表无痕迹（响应阶段 Drop 会先发送）。修法：Drop 前发送标记 dropped 的 session
3. `server.rs:154-161` — accept 失败无退避热自旋，fd 耗尽时 CPU 100% + 日志洪泛。修法：连续错误计数 + 递增退避
4. `types.rs:517-572` — `ProxySessionDetail` 手写 Serialize 漏 `rewrite_traces`/`script_traces`，field_count(18) 与实际不符：潜伏契约地雷。修法：补字段或改 derive
5. `types_windows.rs:17-25` — Windows `get_local_ip` 同步 command 内 spawn PowerShell，主线程卡数百 ms。修法：改 async command 或 spawn_blocking
6. `ws_upgrade.rs:684` — 非 101 响应体转发被 20MB 抓包上限静默截断且重写 Content-Length，客户端收到"看似合法"的截断响应。修法：转发路径不设限，截断只用于抓包副本
7. `http_io.rs:625` — gzip/brotli 解压无输出上限，20MB 输入可解压出 GB 级内存（zip bomb）。修法：解码器外套 `Read::take`

### proxy-core 规则与 TLS 子系统
8. `rules/map.rs:146` — map-local 在 Tokio worker 上阻塞 `fs::read` 且无大小上限：大文件阻塞 worker / OOM 风险。修法：tokio::fs + spool/拒绝策略
9. `rules/rewrite.rs:670-680` — 响应头 set 先删后校验，非法值时静默丢头且 trace 记 success；remove+insert 折叠同名多头（Set-Cookie）。修法：先校验再改
10. `rules/rewrite.rs:237`（+`json_path.rs:124`）— 未启用 serde_json `preserve_order`，body 字段改写全量重排键序破坏签名类 API；number 走 f64，>2^53 整数丢精度。修法：启用 preserve_order + i64/u64 优先
11. `ssl_proxying.rs:56`（+`server.rs:348`）— 拦截策略只看 CONNECT authority 不复核 SNI：排除列表的 pinning 域名可被 CONNECT/SNI 不一致绕过而遭 MITM。修法：握手拿到 SNI 后复核

### rule-engine / tls-manager
12. `rule-engine/src/compile.rs:83,167` — 入口点检测/改写用正则处理原始源码：注释中的 `export function onRequest` 误判入口（hook 静默不触发）、字符串字面量被改写破坏脚本。修法：基于 deno_ast 解析结果
13. `tls-manager/src/client.rs:46-57` — `NoOpVerifier::supported_verify_schemes` 缺 RSA_PSS_SHA512 等方案：不校验模式下反而连不上使用这些签名方案的真实站点。修法：补全 rustls 全部变体
14. `tls-manager/src/trust.rs:706` — Linux 移除证书时 `update-ca-certificates` 未加 `--fresh`：报告成功但实际仍被信任（孤儿 symlink 与 bundle 残留）。修法：Debian/Ubuntu 路径加 `--fresh`
15. `tls-manager/src/resolver.rs:32-72` — 证书按需签名（ECDSA 生成+签名+std Mutex）在 executor 线程同步执行，冷主机突发拖慢整个运行时。修法：spawn_blocking 或预热
16. `tls-manager/src/client.rs:61-91` — 上游证书默认不校验属必要能力，但代理→上游链路默认可被第三方 MITM，属不安全默认值。修法：确认 UI 风险提示，考虑 workspace 级默认校验
17. `rule-engine/src/js_bridge.rs:273-275` — `response` 为 null 的阶段脚本对 `ctx.response` 的赋值被静默丢弃。修法：调整变更检测条件或文档明示

### db / sys-util
18. `insights.rs:238-246` vs `:294-301` — `by_host` 按 `GROUP BY host`（大小写敏感）但 P95 按 `LOWER(host)` 合并：同一行计数与分位数来自不同群组，指标自相矛盾且注释错误。修法：统一 `GROUP BY LOWER(host)`
19. `insights.rs:77-91` — `session_ids` IN 子句未分批（同 crate 其他两处已做 500/批），超变量上限时整个 insights 面板报错。修法：分批或入口截断
20. `insights.rs:93-101` — `host_keyword` LIKE 未转义 `%`/`_`（sessions.rs:472 已有正确先例）。修法：抽共享转义 helper + `ESCAPE '\'`

### 前端接入层/状态层
21. `reportCommandFailure` 第三参 `workspaceId` 被系统性滥用（rules.ts:408 传标题、certificates.ts 传设备 id、ws.ts 传 sessionId、collections.ts 各处），日志语义污染。修法：改 `context?: Record<string, unknown>`
22. `certificates.ts:230,298,431` — `withTimeout` 硬编码英文超时文案直接进 UI，违反 i18n 约定。修法：抛带 code 的错误，UI 映射本地化文案
23. `throttling.ts:23-58` 与 `rules.ts:38-73` — localStore 三件套逐字重复。修法：抽公共 helper
24. `updater/app-updater.ts:75-98` — 安装失败后 `pendingUpdate` 不清除，重试对已消费句柄再次 `downloadAndInstall`，行为未定义。修法：catch 中置空

### 前端 UI 层
25. `pages/collections/index.tsx:309-388` 与 `features/sessions/use-session-explorer-layout.ts:113-188` — 拖拽 resize 中途卸载泄漏 window 指针监听器（M21 修复模式漏套用，另两处已修）。修法：引入 `resizeCleanupRef`
26. `EnvironmentManagerDialog.tsx:90-116` — 自己保存触发的 refetch 覆盖防抖窗口内的新输入（M22/H1 模式漏套用）。修法：`lastSynced` 守卫
27. `use-env-vars-save-manager.ts:90-94` — 卸载时直接丢弃 pending 防抖保存，与同对话框全局变量的 flush-on-unmount 不一致。修法：卸载时 flush
28. `pages/sessions/index.tsx:345-354` — ~10Hz 向 localStorage 全量重写 compare scope（JSON.stringify + setItem + dispatch 事件）。修法：内容签名比对，变化才同步
29. `features/throttling/use-throttle-editor.ts:56,308` — 硬编码英文规则名（"Targeted rule"/"Any"/"copy" 后缀），`throttlingPage.defaultRuleName` i18n 键闲置成死键。修法：注入 `t()`
30. `use-session-context-actions.ts:318,347` — Repeat 请求硬编码 `workspaceId: "default"`，非默认工作区下重复请求落错工作区。修法：注入 `proxyStatus.activeWorkspaceId`

### 跨区契约/脚本
31. `show_log_file`（app.rs:40）与 `list_map_session_trace`（main.rs:257）两条已注册命令在 API_SPEC 零记录
32. `compose.rs:32,45`、`app.rs:52,59,63` — 命令边界透出裸字符串错误，违反 API_SPEC §4.2，前端只能得到 UNKNOWN_ERROR。修法：统一 `app_error()` 包装
33. `rule-engine/src/execute.rs:84-90` — 脚本并发闸 Mutex 中毒时 permit 永久泄漏（P1-12 确认未修），多次 panic 后脚本执行饿死。修法：`unwrap_or_else(|e| e.into_inner())`
34. `services/commands/sessions.ts:24`、`rules.ts:29`、`throttling.ts:16` — services 反向依赖 features store（P1-30 未修）。修法：imported-sessions 下沉为 services 层 repository
35. `bootstrap/converters.rs` 零测试（P1-33）——正是 H6 类 bug 的防空洞。修法：补字段级 round-trip 测试
36. `.github/workflows/ci.yml:80` 与 `scripts/release-checklist.sh:28` — clippy 未加 `--all-targets`，测试代码问题无法被 CI 拦截。修法：统一加 `--all-targets`
37. 版本五处一致性无自动化校验（当前实测均为 0.1.31，一致）。修法：release-checklist.sh 增加版本比对

---

## 4. 【低】问题摘要（按主题归并，详见各分区原文）

- **proxy-core**：timing 的 `request_send_ms` 恒 0（upstream.rs:838）；`Transfer-Encoding: gzip, chunked` 复合值漏判 framing（ws_upgrade.rs:27-41）；`send` 吞错风格不一致（http_proxy.rs:690）；`build_empty_response` 末尾 unwrap（:1809）；`WsOpcode::from_u8` 保留 opcode 回退 Binary（ws.rs:69-78）；UDP 路由探测硬编码 8.8.8.8（lib.rs:40）
- **规则/断点**：DNS override 解析失败不回退次优规则且 tie 语义与别处不一致（mod.rs:59-60）；map/throttle/DNS 正则每请求现场编译（patterns.rs:8）；throttle/map/dns manager 未快照化（mod.rs:219-220）；`should_break` 准死代码且与 `find_matching_rule_id` 重复（breakpoints.rs:389-418）；断点头部剥离函数与 rewrite.rs 逐字重复（breakpoints.rs:221-238）；断点改请求 body 未移除陈旧 content-length（:273-280）；断点编辑多头被 insert 折叠（:255-263，P1-6 未修）；stage 词汇 "both"/"either" 不一致（rewrite.rs:19-21 vs mod.rs:194-200）；map-remote `preserve_query` 丢弃目标 URL 自带 query（map.rs:34-36）；throttle stats 记录理论延迟与实际脱节（managers.rs:303）；throttle u128→u64 截断可回绕（throttle.rs:57-67）；ssl_proxying 新版 Deserialize 缺 `#[serde(default)]`（ssl_proxying.rs:127-132）；bench 测的是 flate2 而非自身代码（benches/body_decompress.rs:25-28）
- **rule-engine/tls-manager**：非法正则仅 warn 降级无 UI 反馈（compile.rs:12-28）；并发门二次中毒超发许可（execute.rs:62-68）；主线程 elapsed 误判 TimedOut（execute.rs:236-237）；过时注释（execute.rs:31-32）；条目上限 50 跨语言重复（js_bridge.rs:137）；`JSON.stringify` 循环引用冒泡为 RuntimeError（js_bridge.rs:165-185）；多证书 bundle 指纹计算错误隐患（trust.rs:730-743）；信任检查每次全量读 `/etc/ssl/certs`（trust.rs:510-535）；Windows 原子写缺 create_new/sync_all 且 .tmp 残留（storage.rs:412-418）；`RootCaPair` 私钥三份明文副本无 zeroize（generator.rs:17-26）；Windows 私钥 ACL 依赖继承（storage.rs:245-249，已注明取舍）
- **db**：`column_exists` filter_map 吞解码错误（schema.rs:571）；迁移整体无事务（schema.rs:371-541，当前步骤幂等风险低）；行解码裸 `as` 无 clamp（sessions.rs:529-531）；排序缺 tiebreaker 致分页行漂移（sessions.rs:230,435）；四处仍用 `INSERT OR REPLACE`（rules.rs:576,867、ai.rs:33、collections.rs:219，当前无 CASCADE 引用但属维护陷阱）；`api_key` 明文存 SQLite（ai.rs:12，命令层已 mask，需在 SECURITY 文档声明或改 keychain）
- **前端接入层**：三个死 barrel 文件（hooks/lib/types index.ts）；`isTauriRuntime` 重复实现（lib/download.ts:7、events/index.ts:36）；`getWsConnectionStatus` 吞错返回 closed（ws.ts:51-55）；全局错误兜底文案硬编码英文（AppProviders.tsx:104,118）；语言偏好联合类型两处定义；compose 完整 URL 进 dev log（compose.ts:23，建议 query 脱敏）；冗余卸载 effect（use-throttled-value.ts:62-69）；`savedRule!` 非空断言风格不一；`confirmLeave` 重入/卸载 Promise 悬置（use-unsaved-changes-guard.ts:50-60）
- **前端 UI**：`label="pseudo"` 未走 t()（SessionInspectorShared.tsx:744）；headers 编辑器重复 DOM id（BreakpointInterceptPanel.tsx:231）；zoom 浮点累积（use-zoom-control.ts:30-33）；环境列表行无键盘可达性、删除按钮仅 hover 显示（EnvironmentManagerDialog.tsx:252-295）；rewriteSeed 消费未走 unsaved-guard（RewriteRulesPanel.tsx:410-427）；spring-load 定时器卸载未清理（use-collection-tree.ts:457-461）
- **契约/脚本**：API_SPEC 数据模型小幅漂移（ProxyStatus 缺 `systemProxyRecoveryWarning`、AppBuildInfo 缺 `commitHash`、事件命名风格表述与实际连字符风格不符）；`inject_ws_message` binary payload 编码契约未定义；`delete_sessions_except` 成死命令但文档未标注；files/menu payload 类型未上收 shared-types（违反 §16）；`parseSessionSummaries` 错误 details 无界（sessions.ts:225-228）；clean.mjs 错误路径返回对象致 "NaN KB"（:96-103）；desktop.mjs bundle 前端构建跑两遍（:110-123）；release-checklist.sh:36 硬编码过期版本号；`send_composed_request.workspace_id` 仅装饰性存在不校验（compose.rs:7-8）

---

## 5. 各分区总体评价

- **proxy-core 核心链路**：取消安全、半关闭、WS 帧解析 cancellation-safe 缓冲、spool RAII、代理跳 TLS 强制验证等关键设计正确且注释清晰；短板在资源核算边界一致性与跨层契约细节。
- **规则与 TLS 子系统**：wildcard 回溯匹配有 proptest 交叉验证，断点并发控制（oneshot + 超时清理）到位；map 子系统是唯一会把规则错误升级为连接重置的规则类型，与同文件 rewrite/script 的降级哲学不一致。
- **rule-engine / tls-manager**：质量属仓库上乘（并发单飞、原子写入、PEM 校验、微任务驱动有成体系修复与回归测试）；短板在入口点正则处理未解析源码、Linux 移除缺 `--fresh`。
- **db / sys-util**：错误传播统一、事务使用基本正确、无注入风险、路径穿越防护完整；insights 模块集中了三处"别处已解决此处遗漏"。
- **前端接入层**：错误规约、事件清理、敏感字段脱敏、非 Tauri 降级都有体系化考虑；短板是约定局部被打破（错误对象双轨、workspaceId 滥用、helper 复制、not-found 启发式）。
- **前端 UI 层**：明显高于一般水平，历史问题修复到位、异步链路严谨、i18n 完整性好；弱点是少数页面漏套用已有修复模式，会话删除缺前端→后端闭环。
- **契约一致性**：97 个命令注册零漂移、96 个前端 invoke 全部命中、版本五处一致；但三处文档-代码漂移已是真实功能 bug，缺命令/事件清单 CI 断言。

---

## 6. 全仓最优先修复 Top 10

1. **H1** `body_store.rs:125` Windows 反斜杠路径 —— 核心功能在 Windows 静默损坏
2. **H5** `ws-connection-status` 事件后端发射 —— WS 面板假"活跃"状态
3. **H6** `SessionDetailPayload` 补 `viaUpstreamProxy` —— 一行级修复 + 补 converters 测试
4. **H3** `runtime.ts:60-64` not-found 启发式 —— 数据静默只写 localStorage
5. **H4** 会话删除补后端命令闭环 —— "删除"目前只是临时隐藏
6. **H2** map 规则失败降级为 trace —— 消除连接重置 + 会话空白
7. **中 #1** WS relay 持有 permit —— 长连接资源管控漏洞
8. **中 #14** `update-ca-certificates --fresh` —— 安全相关假阳性"已移除"
9. **中 #3** accept 失败退避 —— 一行修复消除 fd 耗尽级联故障
10. **H7 + 中 #31** 落地命令/事件清单 CI 断言 —— 一次性根治契约漂移类问题

---

## 7. 旧报告（2026-08-21）复核

- **P0 全部 7 条：已修复**（P0-2 实际修复范围比其自述更完整，文档可更新）。
- **P1 已修复（抽查确认）**：P1-2、P1-3、P1-4、P1-7、P1-9、P1-10、P1-15（文档仍列"第三阶段候选"，实际已修）、P1-19。
- **P1 确认未修**：P1-6（断点多头折叠）、P1-8（session channel 阻塞式 send）、P1-11（api_key 明文）、P1-12（permit 泄漏）、P1-13（IP 字面量 SAN）、P1-17（not-found 启发式）、P1-20（批量删除无确认框）、P1-21（断点 Cancel 与 Apply 相同）、P1-22（虚拟化列表 scrollIntoView）、P1-25（compose `?? []` 吞错）、P1-26（insights 不消费 isError）、P1-29/30/31/32/33。

建议：本报告修复完成后，同步更新旧报告中"实际已修但文档未更新"的条目状态（P0-2 范围、P1-15）。

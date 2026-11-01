# AIProxy 全仓代码审查报告（2026-11-01）

- **审查对象**：`v0.2.4`（commit `f5669bf`），工作区干净
- **审查范围**：`crates/*`（proxy-core、rule-engine、tls-manager、db、mcp-server、agent-control、sys-util）、`apps/desktop/src-tauri`、`apps/desktop/src`、`packages/shared-types`、`.github/workflows`、`scripts/*`
- **审查方式**：
  1. 主审先读上一轮报告（`docs/CODE_REVIEW_2026-10-31.md`）的已修复/已核查结论，避免重复；
  2. 两批共 28 个只读子代理按区域深审（16 + 12，结果落盘后由主审抽样复核）；
  3. 主审逐条回读所有 P1 与大部分 P2 的证据代码；
  4. 门禁：`tsc --noEmit` 通过；`cargo clippy --workspace --all-targets` 全绿（0 warning / 0 error，`dev` profile，2m51s）；`vitest` 因本机沙箱禁止 `child_process` 管道（Vite `spawn EPERM`）无法启动，未取得动态测试结果。
- **证据口径**：`复核 = ✓` 表示主审已回读代码/实测语义；`子代理` 表示由子代理给出逐字证据、主审未逐行复核（结论通常可靠，但按低一档置信度对待）。所有条目均给出触发条件，可直接转 issue 与回归用例。

---

## 1. 结论概览

| 级别 | 条数 | 说明 |
|---|---|---|
| P0（严重） | 0 | 未发现会无条件破坏核心链路的新问题 |
| P1（高） | 9 | 数据静默损坏、跨请求凭证泄漏、规则轨迹整批丢失、远端 DoS、跨平台代理残留 |
| P2（中） | 39（表格 40 行，含 1 行与 P1-9 同源） | 特定条件下功能失效或状态不一致（含 1 条远端可触发的内存耗尽） |
| P3（低） | 41 | 健壮性、可排障性、跨平台缺口、展示层不一致 |
| **合计** | **89（去重后）** | 无架构性返工需求；P1 均为局部可修 |

**总体评价**：v0.2.4 相比上一轮（v0.2.2）把上轮 P0/P1 全部修完，且新增的修复都带回归测试，工程质量稳定。本轮问题集中在四类**新暴露的横切缺口**：

1. **同一条链路上「写入一种表示、读取另一种表示」**：DB 写 `u32` / 读 `i32`；脚本侧 `bodyText` 与 `bodyBase64` 双表示；会话记录里的 body 文本与原始字节。
2. **超时与生命周期按「方向/单次操作」而非「连接/整批」判定**：WS 单向空闲、请求体读取、chunk-size 行读取、collector 双通道关闭。
3. **「内存态规则」与「DB 外键」冲突**：Agent 临时规则不落库，但规则轨迹表对 `rule_id` 有硬外键。
4. **React 组件状态没有和「当前被拦截请求」绑定**：断点草稿跨请求残留，属于最危险的一类（跨 host 泄漏凭证）。

---

## 2. P1：高优先级（建议本轮修复）

### P1-1 WebSocket relay 把「单方向 5 分钟静默」当成整条连接终止：健康的单向长连接必然被掐断

| 项 | 内容 |
|---|---|
| 位置 | `crates/proxy-core/src/ws.rs:311-315`（按方向 idle）、`ws.rs:970-991`（任一方向出错即 `done` 并 arm grace）、`ws.rs:914-924`（grace 到期 break）、`crates/proxy-core/src/timeouts.rs:35`（`WsFrameIdle = 300s`、`WsCloseGrace = 5s`） |
| 复核 | ✓ |

`read_ws_frame` 的空闲超时按「每次调用」计时，而 relay 对两个方向各调用一次；任一方向 300s 没读到字节就返回 `ProxyError::Other("ws frame idle timed out ...")`。该错误不带协议错误标记，因此走到 `ws.rs:983-990`：`client_done = true` 并 arm 5s grace，grace 到期后整个 relay `break`，两个 socket 一起关闭——另一方向即使一直在正常收发帧也无法阻止。

**触发**：只有单向流量的 WS，例如服务端每秒推送、浏览器从不发送；或客户端只上报、服务端从不回帧。浏览器不会因服务端 ping 以外的原因主动发帧，服务端若不做 ping 保活则客户端→服务端方向永远静默。

**影响**：健康连接在 5 分钟后被代理断开（客户端侧表现为 1006/重连），日志只有 debug 级 `ws_relay_close_grace_expired`，用户无法归因。与用户指南明确承诺相反：`apps/desktop/user-guides/zh-CN/websocket-inspector.md:132,167` 写的是「连续 5 分钟没有收到**任何**帧」且「**任意一方**发送 ping 保活即可避免空闲断开」。

**修复建议**：改为连接级空闲——两侧共享「最后一次收到帧」时间戳，任一方向收到帧即刷新；只有两侧都超时（或双方都已结束）才 arm grace。若目标只是回收死连接，单侧超时应只停止该方向读取。回归测试：一侧持续发帧、另一侧静默超过 idle 上限时 relay 不得结束。

---

### P1-2 断点面板的编辑草稿不随被拦截请求切换而重置：会把上一个请求的修改发给另一个请求

| 项 | 内容 |
|---|---|
| 位置 | `apps/desktop/src/features/breakpoints/components/BreakpointInterceptPanel.tsx:1149-1159`（草稿 state）、`:1237-1256`（`navigateHit` 才清空）、`:1347-1357`（`resetDrafts` 仅 resolve 成功后调用）、`apps/desktop/src/features/breakpoints/breakpoint.store.ts:49-64`（active hit 被移除时自动切到下一条） |
| 复核 | ✓ |

`editedReqQueryParams / editedReqHeaders / editedReqBody / editedResp*` 只在两个时机清空：用户点「上一条/下一条」（`navigateHit`）或当前 hit 成功 resolve（`resetDrafts`）。当 active hit A 因后端 `BreakpointWait`（5 分钟）超时、客户端断开（`senderDropped`）或 `breakpoint-released` 事件被移除时，store 会把 `activeHitId` 直接切到仍存在的 B（`breakpoint.store.ts:54-58`），面板组件并不卸载；草稿仍属于 A。随后在 B 上点 Forward，`resolve` 组装（`:1318-1344`）会用 `sessionId: activeHit.sessionId`（B）配上 A 的 Header/Body/状态码。

**触发**：同时存在 ≥2 条待处理断点，在 A 上做过编辑，A 被超时/掉线释放。

**影响**：B 的请求头被替换成 A 的头（跨 host 时把 A 的 `Authorization`/`Cookie` 发给 B 的服务器），B 的 body 被 A 的正文覆盖；面板无任何提示。属于跨请求凭证泄漏 + 请求体损坏。

**修复建议**：用 `useEffect` 以 `activeHit.sessionId` 为依赖重置全部草稿（或把草稿按 `sessionId` 存进 store）；更稳妥的做法是草稿与 `receivedAt` 一起绑定，切换 hit 时丢弃。补一条「A 释放后 B 的 Forward 只带 B 原始内容」的回归测试。

---

### P1-3 脚本直接赋值 `bodyBase64` 时改动被丢弃并写回旧 body（非 UTF-8 时变 U+FFFD 乱码），P1-4 修复不完整

| 项 | 内容 |
|---|---|
| 位置 | `crates/proxy-core/src/rules/script.rs:115-129`；`crates/rule-engine/src/js_bridge.rs:123-130`（`setBase64` 会清空 `bodyText`）、`:280-297`（直接字段写入也整体回传）；文档 `apps/desktop/user-guides/zh-CN/script-rules.md:183` 明确允许「直接赋值 `bodyText` / `bodyBase64`」 |
| 复核 | ✓ |

`script_body_update` 只在「`bodyText` 等于 `bodyBase64` 解码后的 lossy 文本」时认为 body 未改；否则取 `bodyText`。如果脚本按文档写法直接 `ctx.response.bodyBase64 = ...` 而没有动 `bodyText`，两个字段同时存在且不再满足上述等式，于是落入 `_` 分支，取的是**旧 body 的 lossy 文本**：base64 编辑被静默丢弃；若原 body 是 GBK/Latin-1，则写回的是含 U+FFFD 的乱码。`unchanged=false` 还会剥离 `content-encoding`/`etag`，trace 仍记 Success。

**触发**：文本型 body（text/*、json、xml 等，bridge 会同时给出两个字段）+ 脚本直接赋值 `bodyBase64`（非 `setBase64()`）。

**影响**：脚本改动无效（用户以为脚本没跑），非 UTF-8 页面被二次损坏；`setBase64()` 等价写法正常，因此极难归因。

**修复建议**：JS bridge 已在 `serializeResult` 里做快照比较，可再回传显式的 `bodyTextChanged` / `bodyBase64Changed` 标记，Rust 侧据此选源；或在 Rust 侧把「`bodyBase64` 与原始 base64 不同」判定为 base64 编辑。补「只赋 `bodyBase64`、`bodyText` 保持原值」的回归测试。

---

### P1-4 Agent 临时规则命中后，`rewrite_runs`/`map_runs` 的 `rule_id` 外键必然失败，整会话规则轨迹被静默丢弃

| 项 | 内容 |
|---|---|
| 位置 | `crates/db/src/schema.rs:250-265`、`:280-298`（`FOREIGN KEY (rule_id) REFERENCES rewrite_rules/map_rules(id)`）；`apps/desktop/src-tauri/src/agent_rules.rs:157-161`（id 为 `agent-<uuid>`，只进内存 manager，不写 DB）；`crates/db/src/rules.rs:1342-1408`（单事务逐条 INSERT，失败即整体回滚）；`crates/db/src/connection.rs:222`（`PRAGMA foreign_keys=ON`） |
| 复核 | ✓ |

Agent 注入的临时规则只调用 `save_rule_with_host_lock`，从不落 `rewrite_rules`/`map_rules` 表；但该规则命中后产生的 `RewriteTrace.rule_id` 就是 `agent-*`，会话落库时被原样写入带外键的 `rewrite_runs.rule_id`。`INSERT` 返回 `FOREIGN KEY constraint failed`，`replace_rewrite_runs_for_session` 的事务整体回滚——**该会话全部** rewrite/map 轨迹（包括用户规则那几条）都不落库。已删除规则的历史轨迹同理。

**触发**：任意一条 Agent 规则（或已删除规则）命中该会话。这正是「create_agent_rule → 重放 → wait_for_sessions → 查看规则是否生效」的验证闭环。

**影响**：桌面端「Rule Runs」为空、MCP `session_detail` 的 rewrite/map 为空，Agent 会误判规则未命中并重复注入；用户侧无任何提示（仅日志）。map_runs 同样中招。

**修复建议**：规则轨迹表不要把 `rule_id` 作为硬外键（历史数据本就允许规则被删）；改为普通列（或 `ON DELETE SET NULL`），并在读取时容忍缺失规则名。若坚持外键，则 Agent 规则必须先落库再注入。

---

### P1-5 MCP 脱敏的文本回退无法识别 JSON 字面量：NDJSON/SSE/带 BOM 的 body 明文返回密钥，却仍标记 `redacted=true`

| 项 | 内容 |
|---|---|
| 位置 | `crates/mcp-server/src/redaction.rs:163-173`（整段 `serde_json::from_str` 失败即回退文本）、`:734-736`（文本规则要求键名后紧跟 `:`/`=`，不接受 JSON 的 `"key":` 形式）；`crates/mcp-server/src/tools/body.rs:559,595`（`RedactedText` 模式无条件把 `ToolMeta` 的 redacted 置 true） |
| 复核 | ✓（用等价正则逐例验证） |

`redact_text` 只在整段文本是**单个 JSON 文档**时走结构化脱敏；否则调用 `redact_string_inner`，它唯一的键名规则是 `\b(token|password|...)(\s*[:=]\s*)(值)`。JSON 的键名后先有引号再冒号，规则不匹配。主审实测：`{"password":"hunter2"}`、`data: {"access_token":"abc123"}`、`{"a":1}\n{"token":"xyz"}`、`{"user":{"password":"hunter2"}}` **全部原样输出**，只有 `user=a&password=hunter2` 被替换。

**触发**：`get_session_body`（默认 `redactedText`）或 `compare_sessions` 的 `includeBody` 读取 SSE/NDJSON/多文档拼接/带 UTF-8 BOM 的 JSON（这些 body 在流式接口中很常见）。

**影响**：Bearer token、密码、签名以明文交给本地 Agent 与外部 LLM，而 `meta.redacted=true`、`redactedFields=[]`，工具描述还写着默认会脱敏——审计与用户都无法发现泄漏，`redacted` 信号同时失去可信度。

**修复建议**：给文本回退增加「带引号键名」的专用规则（如 `"key"\s*:\s*"value"`），或对失败文本做「逐行 JSON 解析」再回退；若最终没有任何脱敏记录，不要标记 `redacted=true`。

---

### P1-6 Linux GNOME 恢复跳过「原本为空」的 host/port：关闭系统代理后仍指向 AIProxy 死端口

| 项 | 内容 |
|---|---|
| 位置 | `apps/desktop/src-tauri/src/system_proxy/linux.rs:215-243`（`if let Some(...)` 才写回）、`:298-328`（空串/`'none'` 被读成 `None`）、`:191-213`（apply 无条件把 http/https 都写成 AIProxy） |
| 复核 | ✓ |

快照把空 host/port 记为 `None`；`restore_gnome` 对 `None` 直接跳过，既不写回也不清空。`apply_gnome_proxy` 却已把 http、https 的 host/port 全部改成 `127.0.0.1:<port>`。因此当用户原本是 `mode='manual'`、只填了 http 或只填了 https（另一项为空）、`use-same-proxy=false` 时，disable 后 `mode` 被恢复为 manual，空的槽位仍指向 AIProxy；代理进程停止后该协议全部断网。恢复文件此时已被删除，下次启动无法自愈，且残留值会在下次 enable 时被当成「原始配置」再次快照，形成持久污染。

**影响**：UI 显示「系统代理已关闭」但整机对应协议不可用；与 `docs/SYSTEM_PROXY.md`「从快照恢复所有 gsettings 键值」的承诺矛盾，也让 P1-9 的 Linux 回滚（apply 失败 → restore）同样不完整。

**修复建议**：快照记录「键原本为空」这一状态，恢复时显式写入空值（host `''`、port `0`）；不要用 `None` 兼表「未设置」与「读取失败」。

---

### P1-7 MITM 叶证书只按 SNI 签发且 SAN 只写 DNS：IP 字面量目标（及不发 SNI 的客户端）HTTPS 必然失败

| 项 | 内容 |
|---|---|
| 位置 | `crates/tls-manager/src/resolver.rs:31-46`（`let hostname = client_hello.server_name()?;`，无 SNI 即返回 `None`）、`crates/tls-manager/src/generator.rs:188-192,248`（SAN 恒为 `SanType::DnsName`）、`crates/proxy-core/src/connect.rs:575`（所有 MITM 复用同一个 `server_config`） |
| 复核 | ✓ |

MITM 使用全局 `TlsAcceptor`，resolver 唯一的主机来源是 ClientHello 的 SNI；CONNECT 目标 host 没有传进来。客户端连 `https://192.168.1.10/` 或 `https://[2001:db8::5]/` 时不发 SNI（RFC 6066 禁止 IP 作为 SNI），`resolve()` 返回 `None` → rustls 无证书可用 → 握手失败。即使某些客户端把 IP 当 SNI 发来，SAN 也只写 `dNSName`，浏览器对 IP 目标只认 `iPAddress` SAN，同样报证书名不匹配。

**影响**：调试本地/内网 HTTPS 服务（Charles 的常见场景）时「用 IP 直连一律连不上」，日志却把它记成 `tls_handshake_failed` / 客户端拒绝证书，排障方向被引向证书信任。`ssl_blind_hosts` 默认为空、SSL 代理默认开启，用户不容易想到要手工排除。

**修复建议**：MITM 分支按 CONNECT 目标 host 构造/选择 resolver（或给共享 config 增加「无 SNI 时的默认证书」）；生成证书时对 IP 字面量使用 `SanType::IpAddress`。补两条测试：无 SNI 握手、IP 目标握手。

---

### P1-8 MCP sidecar 启动时一次性缓存 DB/schema 状态：文档承诺的「打开 AIProxy 迁移后重试」在同一进程里永远不可能成功

| 项 | 内容 |
|---|---|
| 位置 | `crates/mcp-server/src/context.rs:52-80`（`AppContext::new` 只探测一次）、`:142-144`（`with_db` 直接返回缓存错误） |
| 复核 | ✓（全仓无刷新点，`startup_error` 只有写入处） |

sidecar 由 MCP 客户端长驻拉起。若它先于 AIProxy 首次运行启动，或应用升级后先开 AI 客户端、后打开新版应用，`open_read_only_database`/`inspect_schema` 的失败会被永久缓存；用户按错误提示打开 AIProxy（迁移已完成）后重试，拿到的仍是同一条缓存错误。所有走 `with_db` 的读工具（search/wait/get/body/insights/compare/ws/workspaces）持续失败，`meta.latestSessionAt` 恒为 `null`。

**影响**：用户只能重启 AI 客户端才能恢复，而错误文案明确说「打开 AIProxy 后重试」，把排障方向带偏；表现为「Agent 永远说数据库没初始化 / schema 过期」。

**修复建议**：`with_db` 遇到 `startup_error` 时按需重新探测（带节流/缓存 TTL），schema 兼容后清空错误与 capabilities；或至少在错误文案中写明「需要重启 MCP 客户端」。

---

### P1-9 `priority` 写入按 `u32`、读取按 `i32` 解码：任一 > i32::MAX 的优先级让整表解码失败，启动加载 `if let Ok` 静默吞掉 → 该类规则全部消失

| 项 | 内容 |
|---|---|
| 位置 | `crates/db/src/rules.rs:123-154`（`row.get::<_, i32>(5)? as u32`）；写入路径 `rules.rs:50-73` 直接绑定 `u32`；`apps/desktop/src-tauri/src/bootstrap/mod.rs:217-241`（`if let Ok(rows)` 静默忽略错误）；`apps/desktop/src/features/rules/components/PriorityField.tsx:36-53`（无上下限） |
| 复核 | ✓ |

rusqlite 对 `INTEGER` → `i32` 越界返回 `OutOfRange` 错误，`collect::<Result<...>>()` 短路使整个 `load_all_*` 返回 Err；启动引导用 `if let Ok` 静默跳过，内存 manager 保持为空。用户重启后规则页为空、代理不再应用该类规则，规则仍完整躺在 DB 里。可写入 > i32::MAX 值的入口：规则编辑器 Priority 输入框（`type="number"`，只校验 `Number.isFinite`）与规则导入（原样保留 priority）。同一模式还存在于 `map_rules`、`throttle_rules`、`dns_mappings`、`script_rules` 的 priority，以及 `latency_ms`/`upload_kbps` 等列。

**触发**：输入/导入 `2147483648..=4294967295` 的优先级并保存（保存成功），随后重启。

**影响**：该类别全部规则在 UI 与代理层静默消失；用户只会看到「规则没了」，没有任何错误提示。

**修复建议**：读侧用 `i64` 读取后 `try_into()`/`clamp`，写侧对 priority 做上限校验；启动加载失败必须 `tracing::error!` 并让 UI 可见，而不是 `if let Ok`。

---

## 3. P2：真实缺陷（特定条件触发）

| # | 位置 | 问题 | 后果 | 复核 |
|---|---|---|---|---|
| P2-1 | `crates/proxy-core/src/http_io.rs:596-612` + `types.rs:331,471-497` | `text/*` 只按 MIME 判定可渲染文本，不做 UTF-8 校验；`encoding` 恒写 `"utf-8"`，序列化用 `from_utf8_lossy` | GBK/Shift-JIS/Latin-1 页面在 Inspector 显示 U+FFFD 乱码，HAR 导出写坏文本体（原始字节在 `base64Text` 中仍可恢复），与 `API_SPEC.md`「非 UTF-8 回退 base64」相反 | ✓ |
| P2-2 | `crates/proxy-core/src/http_proxy.rs:279-306` | 客户端请求体 `BodyExt::collect` 外没有超时，`timeouts.rs` 也没有「客户端请求体」这一档 | 半开/停滞上传永久占用 1024 个连接 permit 之一，不返回 408、不写会话、无日志；累积后表现为「代理突然抓不到流量，重启才好」 | ✓ |
| P2-3 | `crates/proxy-core/src/http_proxy.rs:1016-1026` | 响应断点 Drop 先发送已按上游 200 构建的 `session_detail`，再返回 204/断连；请求断点 Drop 则完全不写会话 | Inspector 显示 200+完整响应体，客户端实际收到 204/被断连；请求阶段被 Drop 的会话彻底消失，用户无法确认断点是否命中 | ✓ |
| P2-4 | `crates/proxy-core/src/upstream.rs:199-233` + `upstream_pool.rs:421-436` | DNS override 参与拨号，但不参与 `UpstreamKey`；命中池后直接 `try_acquire`。`dns_override_applied` 日志在池查询之前无条件打印 | 新增/修改 DNS 映射对「已热」主机不生效，删除映射后旧 IP 也可能一直复用；日志与实际行为相反 | ✓ |
| P2-5 | `crates/proxy-core/src/server.rs:338` + `:569-573` | CONNECT 用 `http://{authority}` 构造 URL，`url` crate 会把 `:80` 规范化成 `None`，随后 `unwrap_or(DEFAULT_HTTPS_PORT)` 得到 443 | `CONNECT example.com:80` 的盲隧道/MITM 实际连 443；隧道对端协议错配后卡死，会话记录 host:port 也错 | ✓ |
| P2-6 | `crates/proxy-core/src/server.rs:516-545` | 手动 header 探测按「每次 read」重置 30s 超时（hyper 是一次 deadline） | 每 25s 发 1 字节的慢速客户端可无限占用 permit；1024 条即打满，代理拒绝所有新连接且不回状态码 | ✓ |
| P2-7 | `crates/proxy-core/src/ws_upgrade.rs:872-896` + `:934-958` | chunk-size 行的读取循环没有行上限，也不受 body 20MiB 上限约束 | 恶意/故障上游持续发送不含 CRLF 的字节可让 `buf` 无界增长直至 OOM（访问一个恶意页面即可触发） | ✓ |
| P2-8 | `crates/proxy-core/src/rules/rewrite.rs:200-245` | Body Fields 重写解析成 `serde_json::Value` 后再 `to_vec`：缩进、数字字面量（`1.50`→`1.5`）、转义被规范化 | P1-8 只修了 key 顺序，签名类接口仍会因「只改一个字段、整份 body 变了」而验签失败；v0.2.3 发布说明的结论不成立 | ✓ |
| P2-9 | `crates/proxy-core/src/breakpoints.rs:598-607`、`:830-845` | 命中负载用 `to_str().unwrap_or("")` 取头值，回写用 `from_str` | `content-disposition` 等含非 ASCII 字节的响应头被清成空串；请求侧同类路径会把原值写成 U+FFFD | 子代理 |
| P2-10 | `crates/db/src/rules.rs:140` + `bootstrap/mod.rs:217` | 见 P1-9（同源） | 规则整类静默消失 | ✓ |
| P2-11 | `crates/db/src/insights.rs:331-357` | 错误数只统计 `status_code >= 400`；连接层失败存的是 `status_code=0`（`connect.rs:87`、`http_io.rs:453`） | DNS/连接/TLS 失败被算成「健康」，错误率低估，insights 结论失真 | ✓ |
| P2-12 | `crates/db/src/session_search.rs:511-530` | MCP 会话水位线用「插入 rowid」代表「已完成」，并发请求乱序完成时低 rowid 的会话在之后才完成 | 水位线已越过它，`wait_for_sessions` 永久漏掉这些会话 | 子代理 |
| P2-13 | `crates/mcp-server/src/redaction.rs:622-671` | 脱敏键名白名单漏掉 `sign`、`appKey`、`auth`、`X-Amz-Credential` 等常见变体 | header/query/JSON 键在脱敏模式下明文返回 | 子代理 |
| P2-14 | `crates/mcp-server/src/tools/compare.rs:391-408` | 脱敏模式仍返回原始 body 的 SHA-256（05491dc 的 hash 修复漏掉该路径） | 可被用来比对/确认敏感内容（已知明文攻击面），与「脱敏」承诺不一致 | 子代理 |
| P2-15 | `crates/mcp-server/src/tools/sessions.rs:526-549` | `wait_for_sessions` 的 watermark 取全库最大已完成 rowid，而非本轮已交付上界 | 未随 items 返回的新会话被永久跳过 | 子代理 |
| P2-16 | `crates/mcp-server/src/tools/sessions.rs:902-922` | `since`/`startedAfter` 用秒级 `Z` 字符串与库内 `...+00:00` 纳秒字符串比较 | 边界那一整秒的会话被静默丢弃 | 子代理 |
| P2-17 | `crates/mcp-server/src/config.rs:310-322` | Windows 替换 `agent-access.json` 是「先删后改名」，第二次 rename 失败 | 整份 Agent Access 配置消失 | 子代理 |
| P2-18 | `crates/rule-engine/src/execute.rs:347-360` | 16MB QuickJS 堆装不下 payload 中的多份 body 副本（约 2MB 以上 body 即 OOM） | 脚本规则 fail-open 静默失效，命中请求不受脚本控制 | 子代理 |
| P2-19 | `crates/tls-manager/src/generator.rs:75-103` | 加载 CA 不校验证书与私钥是否配对 | 中断的保存会留下「UI 显示已信任但所有 HTTPS 失败」的死局 | 子代理 |
| P2-20 | `crates/tls-manager/src/trust.rs:497-546` | Linux 只把文件拷进 anchor 目录就当成「已信任」，未检查 `update-ca-certificates` 是否生效 | UI 误报已信任，移动端/浏览器实际仍不信任 | 子代理 |
| P2-21 | `apps/desktop/src-tauri/src/commands/collections.rs:526-558` | 保存到集合用可空的 `inline_text()` 取 body | 二进制请求体被丢空、非 UTF-8 文本被写成乱码 | 子代理 |
| P2-22 | `apps/desktop/src-tauri/src/commands/certificates.rs:532-548` | 证书轮换/删除与代理启停无互斥 | start 进行中轮换根证书，运行中的代理继续用旧根/已删根签发，HTTPS 全量失败且 UI 报成功 | 子代理 |
| P2-23 | `apps/desktop/src-tauri/src/commands/proxy.rs:438-471` | collector 在任一通道 `recv()` 返回 None 时立即 break | 停止时一通道先关闭会丢弃另一通道已入队的会话/WS 帧（666386d 的排空意图未覆盖） | ✓ |
| P2-24 | `apps/desktop/src-tauri/src/bootstrap/mod.rs:371-389` | `delete_sessions_except` 的 DB 删除是 best-effort 且恒返回 Ok | 缓存已删、DB 行仍在，搜索/insights/MCP 仍能读到「已删除」会话 | 子代理 |
| P2-25 | `apps/desktop/src-tauri/src/system_proxy/linux.rs:477-502` | KDE 恢复先写 `ProxyType`（启用标志）再写代理地址 | 中途失败会留下「已启用但指向 AIProxy 死端口」的系统代理 | 子代理 |
| P2-26 | `apps/desktop/src/features/sessions/imported-sessions.store.ts:36-44` + `use-session-import-export.ts:111-127` | 导入详情只保留最近 100 条，但 summary 被永久写入 `["sessions"]` 查询缓存 | 第 101+ 条会话仍显示在列表，点开报错、整批导出失败、「清除其它会话」删不掉 | ✓ |
| P2-27 | `apps/desktop/src/features/sessions/components/SessionExplorerPane.tsx:205-243` | 虚拟化列表的键盘导航不调用 `scrollToIndex` | Home/End 后选中项在屏幕外，方向键只能盲移 | 子代理 |
| P2-28 | `apps/desktop/src/features/breakpoints/components/BreakpointInterceptPanel.tsx:1335-1345` | 断点面板把 body 当 UTF-8 文本回写 | 编辑 multipart/二进制 body 会把原始字节替换成有损文本 | 子代理 |
| P2-29 | `apps/desktop/src/features/rules/components/RewriteRulesPanel.tsx:753-779` | 批量删除直接调用 `deleteRule` 服务函数，绕过 `useDeleteManagedRule` 的缓存失效 | 已删除规则仍显示，再保存/切开关会把它「复活」 | ✓ |
| P2-30 | `apps/desktop/src/features/rules/components/RulesImportPreviewDialog.tsx:38-76` | 导入预览不列 DNS 规则，但 DNS 规则默认被导入且不可取消 | 用户看不到、也无法拒绝 DNS 映射被导入 | 子代理 |
| P2-31 | `apps/desktop/src/features/rules/rules-priority.helpers.ts:41-44` + `RewriteRule.priority: u32` | `nextAppendedPriority` 用 `min - 10`，两次连续新建（已有 11+ 条）会得到负数 | 后端 serde 拒绝 u32 负数，保存直接报错 | ✓ |
| P2-32 | `apps/desktop/src/features/environments/use-environments.ts:124-141` | `replaceAll(search, value)` 的替换串仍解释 `$$`/`$&`/`` $` ``/`$'` | 环境变量值含这些序列时被静默改写（如 `$$` 变 `$`），请求内容与用户配置不一致 | ✓ |
| P2-33 | `apps/desktop/src/features/environments/components/EnvironmentManagerDialog.tsx:110-122` | refetch 用服务端快照整体重建本地行 | 刷新窗口内的键入被永久丢弃 | 子代理 |
| P2-34 | `apps/desktop/src/pages/settings/sections/UpstreamProxySection.tsx:135-146` | 以整个 workspace 对象为 effect 依赖 | 外部变更（抓包、切换工作区）把未保存草稿整体重置 | 子代理 |
| P2-35 | `apps/desktop/src/services/updater/app-updater.ts:100-116` | 安装失败后 `pendingUpdate = null`，注释承诺的「下次尝试重新检查」不存在；对话框内重试只会报「No pending update」 | 同一对话框内重试永久静默失效，必须关闭重开/重新检查 | ✓ |
| P2-36 | `apps/desktop/src/components/layout/hooks/use-menu-actions.ts:284-309` | macOS 原生菜单 Cmd+1…6 与前端键盘映射、帮助文档三处顺序不一致 | 按文档快捷键会跳到另一个页面 | 子代理 |
| P2-37 | `apps/desktop/src/components/layout/AppShell.tsx:90-95` | `onSnackbarMessage` 上报的失败一律渲染成 info 级 Snackbar，丢失「查看日志」入口 | 失败提示弱化/无排障入口；清空会话失败还会被全局 MutationCache 再弹一次 | 子代理 |
| P2-38 | `apps/desktop/src/components/layout/hooks/use-menu-actions.ts:337-350` | Windows/Linux 菜单标注 Ctrl+F / Ctrl+R，但没有任何键盘绑定；Edit ▸ Find 依赖 WebKit 专有的 `window.find` | 菜单快捷键不可用，WebView2/Linux WebKit 行为不一致 | 子代理 |
| P2-39 | `apps/desktop/src-tauri/tauri.conf.json:26` | 生产 CSP 无 `media-src`（回落到 `default-src 'self'`），`connect-src` 也不含 `data:` | Inspector 音频/视频 `data:` 预览必然被拦（`SessionInspectorMediaPreview.tsx:260,273,291`），复制图片的 `fetch(data:)` 恒失败 | ✓ |
| P2-40 | `.github/workflows/release.yml:234-237` | `latest.json` 的 version 取自 tag，流水线不校验 tag 与 `tauri.conf.json`/`Cargo.toml` 版本一致 | 版本错配时 updater 无限循环提示同一版本 | ✓ |

> 说明：`P2-10` 与 `P1-9` 同源，保留编号便于交叉引用；P2 合计 40 行，其中 1 行为同源重复，去重后 39 条。

---

## 4. P3：低危 / 健壮性 / 可排障性

### 代理核心

- `crates/proxy-core/src/ws.rs:246-250`：单帧 16–20MiB 的合法消息被 `Close(1002)`，与文档「20MiB 消息上限、超限仅截断录制」不一致（分片发送则正常）。
- `crates/proxy-core/src/ws_upgrade.rs:582-608`：非 101 拒绝响应的会话记录仍是上游原始 framing 头（含 `Transfer-Encoding`、缺合成 CL），且 `responseMimeType` 恒为 `websocket`。
- `crates/proxy-core/src/upstream_pool.rs:14,455,487-500`：每 key 仅 4 条 h1 + 租约等待 5s 硬失败；同源第 5 个慢请求会被 502 打死。
- `crates/proxy-core/src/http_proxy.rs:853,944,1009,1019`：四处会话发送失败是裸 `let _ =`，缺少同文件其它发送点的 `session_send_dropped` 日志。
- `crates/proxy-core/src/http_proxy.rs:1041-1080`：响应断点只改头/状态时，h2 的 `:status` 伪头丢失、MIME 未重算。
- `crates/proxy-core/src/rules/rewrite.rs:173-198`：`rebuild_request_runtime_state` 把连接级 protocol 覆盖成 URL scheme，h2 会话被记成 HTTP/1.1。
- `crates/proxy-core/src/rules/map.rs:96-108`：Windows 未过滤盘符段，`PathBuf::push` 的前缀替换语义可让 Map Local 逃出映射目录。
- `crates/proxy-core/src/rules/json_path.rs`（上轮 P2-21）：`remove` 忽略返回值，路径不存在也记 success（上轮遗留，未修）。
- `crates/proxy-core/src/rules/script.rs:103-113`（上轮 P2-19）：非法头名/值静默跳过（上轮遗留，未修）。
- `crates/rule-engine/src/js_bridge.rs:78-94`：`setHeader(name, value)` 在 value 非字符串时静默删除同名头（含已存在的头）。
- `crates/rule-engine/src/js_bridge.rs:27-49`：base64 解码逐字节拼接 + `split/map/join`，读大二进制 body 会 O(n²) 或 OOM。

### 数据库 / MCP

- `crates/db/src/session_search.rs:206-215`：`path_contains` 大小写敏感，与同一查询里 host/mime/keyword 的大小写不敏感语义不一致。
- `crates/db/src/session_search.rs:364-396`：Rust 侧 Unicode 小写化 vs SQLite ASCII-only `LOWER()`，非 ASCII 大写字母永不命中。
- `crates/db/src/environments.rs:110-137`：同环境两个同名 key 的变量在保存时被静默合并，先写入的 value/enabled 丢失。
- `crates/db/src/rules.rs:856-879`：断点规则依赖无 `ORDER BY` 的查询顺序表达优先级，SQL 未定义该顺序。
- `crates/mcp-server/src/tools/diagnostics.rs:341-370`：诊断证据脱敏丢掉 URL 的 `?`，path 与第一个 query 参数粘连。
- `crates/mcp-server/src/tools/body.rs:1029-1042`：urlencoded 表单值 lossy 解码成 U+FFFD 却仍标 `valueType=text`（与 multipart 的 binary 判定不一致）。
- `crates/mcp-server/src/control_client.rs:113-131`：控制描述文件读取/解析失败被压平成「AIProxy 未运行」，与心跳状态和 API_SPEC 的降级契约矛盾。

### 桌面端命令层 / 系统代理

- `apps/desktop/src-tauri/src/commands/files.rs:302-329`：HAR/规则 JSON 导入不剥离 UTF-8 BOM，带 BOM 的合法文件被判「不是有效 JSON」。
- `apps/desktop/src-tauri/src/commands/files.rs:219-239`：`save_text_file`/`save_media_file` 是同步命令，整份写盘 + reveal 子进程压在命令线程。
- `apps/desktop/src-tauri/src/commands/certificates.rs:262-281`：证书状态同步跑平台子进程，generate/remove 两条 async 命令直接在 worker 上调用。
- `apps/desktop/src-tauri/src/agent_rules.rs:336-364`：Agent mock 响应体文件跨重启泄漏（清理只依赖内存注册表）。
- `apps/desktop/src-tauri/src/agent_status.rs:55-72`：心跳线程不会被停止，`write_shutdown` 之后仍可能把 `appRunning/capturing` 写回 true。
- `apps/desktop/src-tauri/src/system_proxy_recovery.rs:158-192`：启动恢复无条件应用 pending 快照，陈旧文件会覆盖用户之后手动改的系统代理设置。
- `apps/desktop/src-tauri/src/system_proxy/linux.rs:503,529,551`（上轮 P3）：只调用 `kwriteconfig6`/`kreadconfig6`，Plasma 5 不可用；`kread_config` 把执行失败当空值，restore 会 `kdelete_config` 删用户配置（上轮遗留）。
- `apps/desktop/src-tauri/src/system_proxy/recovery`（上轮 P3）：recovery pending 文件不清理、`write_atomic` 未 fsync（上轮遗留）。

### 前端

- `apps/desktop/src/features/sessions/components/SessionExportDialog.tsx:65-80`：effect 依赖整个 `selectedSession`，抓包更新会把导出范围重置、错误提示清空。
- `apps/desktop/src/features/sessions/components/SessionInspectorJsonTree.tsx:523-533`：用「父路径.键名」拼 React key，含点号的键与嵌套同名对象路径冲突，行被复用/同时展开。
- `apps/desktop/src/features/insights/use-insights-data.tsx:48,55-66,184`：输入框读持久化 store，实际过滤用组件内 state → 离开再回来输入框有词但不过滤。
- `apps/desktop/src/features/insights/use-insights-data.tsx:255-264`：实时结果为空时回退旧后端快照，与注释的「实时优先」相反。
- `apps/desktop/src/features/throttling/use-throttle-editor.ts:79-103`：节流/映射/DNS/脚本规则选 Regex 时完全不校验，非法正则保存后静默永不命中。
- `apps/desktop/src/features/rules/rules.helpers.ts:340-372`：Body Fields 的 `valueType` 不做类型校验，number/json/boolean 填错也能保存，之后每个命中请求都失败。
- `apps/desktop/src/features/rules/components/RulesImportExportButtons.tsx:56-72`：导入「不支持的版本」分支不可达；v2 文件被报成「不是合法的导出文件」。
- `apps/desktop/src/features/rules/rules.helpers.ts:309-320`：前端用 JS 正则校验，Rust regex 不支持的前瞻/反向引用会被判合法并静默失效。
- `apps/desktop/src/pages/settings/settings-search.ts:100-127`：设置搜索结果多数指向不存在的锚点，脱敏条目指向默认未挂载的面板。
- `apps/desktop/src/features/compose/curl-export.ts:38-63`：带 body 的 GET/HEAD 省掉 `-X`，导出的 curl 实际变成 POST。
- `apps/desktop/src/features/updater/update-status.ts:12-30`：一次失败的更新检查会清掉已确认的可用更新，更新入口消失。
- `apps/desktop/src/components/layout/hooks/helpers.ts:1-15`：`getErrorMessage` 的本地化兜底串对非 Error/非字符串拒绝值不可达，注入硬编码英文。
- `apps/desktop/src/components/layout/hooks/use-proxy-lifecycle.ts:45-55`：两处 `StartProxyInput` 的 `enableSsl` 默认值相反（false vs true），与「两处参数保持一致」的注释矛盾。
- `apps/desktop/index.html:10-24`：CSP `script-src 'self'` 拦掉无 nonce 的内联主题引导脚本，暗色主题首帧防闪烁失效。
- `apps/desktop/src-tauri/tauri.conf.json:26`：CSP `connect-src` 缺 Windows 的 `http://ipc.localhost`，Windows 首个 invoke 可能被拦后降级到 postMessage。

---

## 5. 已核查、确认无问题的部分

为避免后续重复排查，以下区域经主审或子代理逐行核对（含对既有设计意图的确认），未发现新缺陷：

- **HTTP/1 与体传输**：hop-by-hop 剥离（含 `Connection` 列表 token、WS 握手豁免、伪头清理）、20MiB 请求体上限与 413 降级、gzip/br/deflate 解压上限（zip-bomb）、spool 文件生命周期与 `Content-Length` 复算、HEAD/304 保留上游 CL、取消安全（`PendingRequestCancellationGuard` 各终止路径）。
- **并发与池**：CONNECT 隧道双向半关闭、空闲超时按「读完成时刻」续期、`PendingConnectGuard`/`H1Lease` 身份判定、accept 失败退避、连接信号量核算（含 WS relay 额外 permit）、h1 忙连接不被驱逐、WS relay permit 持有至结束。
- **上游代理**：HTTP CONNECT（含 1xx 上限）、SOCKS5（RFC 1928/1929）、IPv6 authority、代理跳 TLS 强制验证、域名透传。
- **WebSocket 帧层**：7/16/64 位长度、控制帧 FIN/125 字节、保留 opcode、掩码与解掩码、重组上限与 `truncated`、`Sec-WebSocket-Accept`、扩展剥离（P0-1 修复无残留路径）、101 构建不额外插 CL。
- **DB**：迁移幂等（`pragma_table_info` 预检）、`LIKE` 转义、动态 SQL 白名单、批量删除事务与分批、upsert 规避 REPLACE 级联、游标 base64 对偶、`session_details` 唯一约束与原子 body 写（上轮 D1/D3 修复有效）。
- **规则引擎**：QuickJS 微任务驱动、`respond()` 二次调用告警、permit 中毒恢复、trace 条数上限。
- **前端**：`tsc --noEmit` 通过；事件监听器清理、`sessions-removed` 墓碑机制、body 大小按 UTF-8 字节计算等既有修复到位。
- **门禁**：`cargo clippy --workspace --all-targets` 0 warning / 0 error（含 tauri 全目标）。

---

## 6. 建议修复顺序

| 批次 | 内容 | 理由 |
|---|---|---|
| 第 1 批 | P1-2、P1-3、P1-4 | 三条都是「用户无法归因的静默错误」：跨请求凭证泄漏、脚本改动丢失、规则轨迹整批丢失；改动局部且可测 |
| 第 2 批 | P1-1、P1-5、P1-6 | WS 断连与脱敏泄漏影响面大；GNOME 残留属于整机断网，需要 Linux 实机验证 |
| 第 3 批 | P1-7、P1-8、P1-9 | TLS IP/无 SNI 与 MCP 启动缓存需要产品决策（fallback 方式、重试策略）；P1-9 是 DB 位宽一致性 |
| 第 4 批 | P2-1、P2-2、P2-6、P2-7 | 展示损坏与两个 DoS 面；P2-2/P2-6 可合并为「客户端连接超时矩阵」专项 |
| 第 5 批 | P2-23、P2-26、P2-29、P2-31、P2-35 | 用户可感知的状态不一致（漏会话、幽灵规则、保存报错、更新重试失效） |
| 后续 | 其余 P2/P3 | 按迭代收敛；建议把「系统代理跨平台一致性」「MCP 脱敏规则集」各合并成一次专项 |

---

## 7. 审查方法与局限

- **证据分级**：本轮区分「主审复核 ✓」与「子代理」。所有 P1 与约 20 条 P2 已由主审回读代码；P3 多数为子代理证据（均带逐字代码与行号），按低一档置信度对待。
- **门禁**：`tsc --noEmit` 通过；`cargo clippy --workspace --all-targets --offline` 全绿。`vitest` 在本次沙箱内因 Vite 的 `windowsSafeRealPathSync` 调用 `execFile` 被沙箱拒绝（`spawn EPERM`）无法启动，未取得动态测试结果；建议在 CI 或非沙箱环境复跑 `pnpm --filter @aiproxy/desktop test`。
- **未覆盖/抽查**：`crates/mcp-server/src/tools/body.rs` 的中段字段提取、前端 200+ 组件中的纯展示组件、`scripts/*.sh` 的平台分支仍以抽读为主；P3 中标注「上轮遗留」的条目在上一轮报告中已有详细证据，本轮未重复展开。
- **可复现性**：所有 P1/P2 条目均给出「文件:行号 + 触发条件 + 期望行为」，可直接转为 issue 与回归测试用例。

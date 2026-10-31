# AIProxy 全仓代码审查报告（2026-10-31）

- **审查对象**：`v0.2.2`（commit `6fe4308`），工作区干净
- **审查范围**：`crates/*`（proxy-core、rule-engine、tls-manager、db、mcp-server、agent-control、sys-util）、`apps/desktop/src-tauri`、`apps/desktop/src`、`packages/shared-types`、`scripts/*`
- **审查方式**：
  1. 主审人工通读代理核心链路（请求管线、HTTP 解析、上游/TLS 隧道、WebSocket、断点、规则、DB 迁移、系统代理）
  2. 4 个只读子代理并行深审：WebSocket 子系统、规则引擎、数据库层、Tauri 命令与系统代理层
  3. 现有门禁验证：`tsc --noEmit`、`vitest`、`check-api-contract`、`cargo test -p aiproxy-db`
- **证据口径**：每条均给出 `文件:行号` 与触发条件。「复核」列 `✓` 表示主审已逐行回读确认；`子代理` 表示由子代理核实（部分带 SQLite 实测 / `EXPLAIN QUERY PLAN` / git 历史对照证据）。
- **说明**：`cargo clippy --workspace --all-targets` 在本机因多个 cargo 进程争抢 registry/target 锁未能跑完，故本报告结论全部来自代码审读，而非 lint 输出。

---

## 1. 结论概览

| 级别 | 条数 | 说明 |
|---|---|---|
| P0（严重，立即修） | 3 | 核心功能被破坏，且对用户表现为「莫名失败」 |
| P1（高） | 7 | 数据静默损坏、整机流量黑洞、凭证/配置丢失、文档与实现矛盾 |
| P2（中） | 15 | 特定条件下功能失效或状态不一致 |
| P3（低） | 18（其中 1 条与 D7 同源） | 健壮性、跨平台缺口、可排障性 |
| DB（`crates/db` 专章） | 14 | 其中 2 条为「中」，其余为中低/低 |
| **合计** | **57（去重后 56）** | 无架构性返工需求，P0 三条均为局部可修 |

**总体评价**：这个仓库的工程质量明显高于同类项目——历史 bug 几乎都带编号注释与回归测试，并为「取消安全」「半关闭」「spool RAII」「原子写」「证书 pinning 排除」「连接池 pending 泄漏」等硬问题留下了成体系的设计与说明。本次发现的问题集中在四类**模式缺口**：

1. **同一语义在前后端/跨平台之间单位或格式不一致**（丢包率百分比 vs 比例；KDE 代理值格式；`packetLossRatio` 预设值）——这类问题单测都过，因为两侧各自自洽。
2. **协议能力声明与实际实现不一致**（WS 把 `Sec-WebSocket-Extensions` 原样转发，但帧解析器拒绝任何 RSV 位）——注释甚至写「AIProxy 不协商扩展」，但没人负责「不协商」这件事。
3. **既有修复模式漏套用**（请求侧 `append` / 响应侧 `insert`；Windows/macOS 有回滚 / Linux 没有；`kwriteconfig6` 未回退 `5`；`read_body` 未走硬化路径）。
4. **依赖对象身份导致 React 副作用失效**（`useMutation` 每次渲染返回新对象，把 autostart effect 的 `cancelled` 变成「必然为真」）。

---

## 2. P0：会直接破坏核心功能

### P0-1 WebSocket 协商 permessage-deflate 后，第一帧压缩消息就被判协议错误并 Close(1002)

| 项 | 内容 |
|---|---|
| 位置 | 请求转发 `crates/proxy-core/src/ws_upgrade.rs:1122-1133`；101 响应构建 `ws_upgrade.rs:636-642`；帧解析 `crates/proxy-core/src/ws.rs:191-200`；错误处理 `ws.rs:974-991` |
| 复核 | ✓ |

**现象**：WS 升级请求转发时只跳过 `Host`，把客户端带来的 `Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits` 原样发给上游；上游 101 响应只过滤 `connection` / `transfer-encoding`，把 `Sec-WebSocket-Extensions: permessage-deflate` 原样回给客户端。而帧解析器不实现任何扩展：任何 RSV1/RSV2/RSV3 置位都返回 `ws_protocol_error`，relay 随即向该方向写 Close(1002) 并停止读取。

全仓 `grep -i 'permessage|sec-websocket-extensions'` **零命中**——没有任何环节负责「不声明扩展」，也没有任何解压实现。

**触发条件**：客户端与服务端都支持压缩即可。Chrome / Firefox 默认 offer permessage-deflate；Node `ws`（server 端 `perMessageDeflate` 默认开启）、Socket.IO、Python `websockets` 等都会接受。

**影响**：握手成功、但上游（或客户端）发出的第一条压缩消息即被当作协议违规 → 连接被掐断。日志还会把它记成「客户端协议错误」，把排障方向引错。这对「浏览器 WS 抓包」这一核心场景是致命的。

**修复建议**：在 `build_ws_upgrade_request` 与 101 响应构建两处都跳过 `sec-websocket-extensions`（不声明扩展，上游就不会协商）。若要支持压缩，则必须在 `try_parse_ws_frame` 放行 RSV1、按协商结果 inflate/deflate，并把「是否自定义 `Connection` token」的剥离逻辑一并复核。

**回归测试**：构造「客户端带 `Sec-WebSocket-Extensions` → 假上游回 101 并带该响应头」的用例，断言转发给上游的请求头与回给客户端的 101 头中都不含该字段；再加一条「上游发 RSV1 帧时 relay 不因协议错误关闭」的用例（若选择不转发扩展，此条不适用）。

---

### P0-2 节流「丢包率」单位不一致：填 1（%）实际丢弃 100%

| 项 | 内容 |
|---|---|
| 位置 | 归一化 `crates/proxy-core/src/rules/throttle.rs:37-45`；使用 `throttle.rs:47-55`；UI 单位 `apps/desktop/src/features/throttling/components/ProfileEditor.tsx:109-118`；校验 `apps/desktop/src/features/throttling/use-throttle-editor.ts:88`；内置预设 `apps/desktop/src/services/commands/throttling.ts:33,45,57` |
| 复核 | ✓ |

**现象**：后端把 `packet_loss_ratio` 做双语义解释——`<= 1.0` 当作 0..1 的**比例**，`> 1.0` 当作**百分数**除以 100。而前端只有一个百分比输入：`unit="%"`、`max={100}`、`step={1}`，校验条件是 `> 100` 才非法；三个内置预设值 `0.2 / 1.2 / 3.5` 也全是百分数语义。

**触发与后果**：

| 用户输入 | 用户本意 | 实际行为 |
|---|---|---|
| `1` | 丢 1% 的包 | `rand() < 1.0` 恒真 → **命中规则的请求/响应全部被 drop（504）** |
| `0.5` | 丢 0.5% | 丢 **50%** |
| `0.2`（「Fast 4G」预设） | 丢 0.2% | 丢 **20%** |
| `1.5` | 丢 1.5% | 丢 1.5%（正确） |

即语义在 `1.0` 处发生跳变：`1.0` = 100%，`1.5` = 1.5%，`0.99` = 99%。用户按 UI 提示填 1 会看到「所有请求都超时」，且没有任何日志说明这是丢包策略导致的。

**修复建议**：只保留百分比语义 `(v / 100.0).clamp(0.0, 1.0)`（`v <= 0` 表示不丢包），并把 `packet_loss_ratio` 的文档注释改成「百分比」。若担心存量数据，可在 DB 读取层做一次性归一。

**回归测试**：`normalize(1.0) == 0.01`、`normalize(0.2) == 0.002`、`normalize(100.0) == 1.0`、`normalize(150.0) == 1.0`、`normalize(0.0) == 0.0`（现有测试 `throttle.rs:454-458` 断言的是旧语义，需同步改写）。

---

### P0-3 自动启动时「恢复系统代理」几乎必然被跳过（effect 取消竞态）

| 项 | 内容 |
|---|---|
| 位置 | `apps/desktop/src/components/layout/hooks/use-proxy-lifecycle.ts:127-158`（依赖数组 `159-171`）；`useMutation` 返回新对象 `apps/desktop/node_modules/@tanstack/react-query/build/modern/useMutation.js:40`；后端仅在已启用时 reapply `apps/desktop/src-tauri/src/commands/proxy.rs:522-559` |
| 复核 | ✓ |

**现象**：

```ts
const startedStatus = await startProxyMutation.mutateAsync(initialStartProxyInput);
if (cancelled || startedStatus.systemProxyEnabled || !shouldRestoreSystemProxy) {
  return;                                  // ← 这里
}
await enableSystemProxyMutation.mutateAsync(undefined);
```

`cancelled` 只在 effect 的 cleanup 中置 `true`，而该 effect 的依赖数组包含 `startProxyMutation` / `enableSystemProxyMutation`。React Query 的 `useMutation` 每次渲染都返回**新对象**（源码 `return { ...result, mutate, mutateAsync: result.mutate }`），因此：

1. `mutateAsync` 启动时会同步把 `isPending` 置 true → 订阅该 mutation 的 AppShell 重渲染；
2. 重渲染让依赖变化 → React 先执行上一次 effect 的 cleanup → `cancelled = true`；
3. IPC 返回后，`await` 之后的续体读到 `cancelled === true` → **跳过 `enable_system_proxy`**；
4. 由于 `autoStartAttemptedRef.current` 已置 true，effect 重跑只会早退，**永不重试**。

`useProxyStatus` 每 2s 轮询也会周期性触发同类重渲染，进一步放大命中概率。

**影响**：工作区里 `systemProxyEnabled === true` 的用户，冷启动后代理进程正常启动，但系统代理不再被接管（后端只在内存状态 `system_proxy_enabled` 已为真时才 reapply，而冷启动时它是 false）。表现为「开机后抓不到任何流量，手动关再开一次才正常」。这类问题用户几乎无法自行归因。

**为什么现有测试没发现**：`use-proxy-lifecycle.autostart.test.tsx` 用 `vi.mock` 替换了 `useStartProxy`，其 `mutateAsync` 立即 resolve 且不产生任何状态更新，因此不会触发重渲染与 cleanup——测试恰好绕过了真实链路。

**修复建议**：
- 用「是否已卸载」的 ref（在独立 `useEffect(() => () => { unmountedRef.current = true }, [])` 中置位）代替依赖驱动的 `cancelled`；
- 把 mutation 对象移出依赖数组（改用 ref 持有最新的 `mutateAsync`，或直接调用 `useProxyStatus` 暴露的稳定函数）；
- 把「已尝试自动启动」与「是否被取消」分开表达，避免一次性 guard 与可取消标志互相污染。

**回归测试**：mock 的 `mutateAsync` 在 resolve 前触发一次重渲染（例如内部 `await Promise.resolve()` 并让 hook 消费一个会变化的 query 数据），断言 `enableSystemProxy` 仍被调用一次。

---

## 3. P1：功能静默错误 / 跨平台缺陷

### P1-4 脚本规则即便只改 header，也会把非 UTF-8 的 body 写成乱码

| 项 | 内容 |
|---|---|
| 位置 | `crates/proxy-core/src/rules/script.rs:86-101`（`bytes_from_script_body`）；`crates/proxy-core/src/types.rs:414-420`（`inline_text` 用 `from_utf8_lossy`）；`crates/proxy-core/src/http_io.rs:596-612`（`should_render_body_as_text`）；JS 侧 `crates/rule-engine/src/js_bridge.rs:91-125` |
| 复核 | ✓ |

`bytes_from_script_body` 优先取 `body_text`，而 `body_text` 是 `String::from_utf8_lossy` 的产物；`should_render_body_as_text` 对 `text/*`、json、xml 等**直接返回 true，不校验字节是否为合法 UTF-8**。JS 桥里 `setText` 会清空 `bodyBase64`、`setBase64` 会清空 `bodyText`，因此「两者同时存在」恰好表示 body 未被脚本改动——此时 base64 才是精确值。

**触发**：响应 `content-type: text/html; charset=gbk`（或 Latin-1 页面）且含非 UTF-8 字节；`onResponse` 脚本只调用 `ctx.response.setHeader(...)`。Rust 侧把 lossy 文本重新编码写回 → 整份 body 变成含 U+FFFD 的乱码，同时 content-encoding 被剥离（`strip_plain_body_edit_headers`）。**请求侧 `apply_script_request_to_runtime` 同样受影响。**

**修复建议**：base64 优先（仅在 `body_base64` 为 None 时才用 `body_text`）；或在 `render_as_text` 为 true 但字节非法 UTF-8 时不产出 `body_text`。

---

### P1-5 Wildcard 匹配实现与文档/产品内提示不一致：文档示例永不命中

| 项 | 内容 |
|---|---|
| 位置 | `crates/proxy-core/src/rules/patterns.rs:71-96`；候选串 `crates/proxy-core/src/rules/mod.rs:114-123`；文档 `apps/desktop/user-guides/zh-CN/rewrite-rules.md:90-105`；UI 提示 `apps/desktop/src/i18n/messages/zh-CN.ts:851` |
| 复核 | ✓ |

实现把「未以 `*` 开头的首段」当作必须锚定在**候选串起点**（`candidate.starts_with(head)`），而候选串是完整绝对 URL（`https://host/path`）。但文档与提示教的正是：

- 文档表格：`Match Type = Wildcard`，Pattern `api.example.com/v1/*`，匹配 `https://api.example.com/v1/users` → 标为 **✓**
- UI 提示：`用 * 作为占位符。api.example.com/v1/* 匹配 /v1/ 下所有路径。`

实测语义：`"https://api.example.com/v1/users".starts_with("api.example.com/v1/")` = `false` → **永不命中**。用户必须写 `*api.example.com/v1/*` 才生效，且没有任何提示。

**影响**：按文档配置的 wildcard 规则全部静默失效；用户会误以为「规则没生效是代理的 bug」。

**修复建议**：二选一并保持三方（实现/文档/i18n）一致——(a) 非首段 wildcard 改为不锚定起点（等价「contains + 段序约束」），(b) 修改文案并在保存时对「未以 `*` 开头的 wildcard」给出可操作告警。

---

### P1-6 DNS 映射规则默认 `contains` 子串匹配，命中范围过大

| 项 | 内容 |
|---|---|
| 位置 | `crates/proxy-core/src/rules/mod.rs:52-60`；默认 `crates/proxy-core/src/rules/patterns.rs:3-11`；前端模型 `apps/desktop/src/features/rules/rules.helpers.ts`（`createEmptyDnsMappingRule` 无 `matchType`） |
| 复核 | ✓ |

DNS 规则走 `pattern_matches(&r.host_pattern, hostname, r.match_type)`，默认 `"contains"`；而前端 DNS 规则模型没有 `matchType` 字段，因此**所有 DNS 规则都是子串匹配**。

**触发**：只映射 `example.com`，则 `notexample.com`、`myexample.com`、`example.com.evil.tld` 全部被解析到覆盖 IP（`crates/proxy-core/src/upstream.rs:199` 用 `request.host` 查覆盖）。用户完全无感，流量被导向非预期主机。

**修复建议**：DNS 规则改走 host 语义（精确 host + `*.` 前缀），直接复用 `host_pattern::matches_any`；确有子串需求时再单独提供 matchType。

---

### P1-7 压缩响应的「Body Fields」重写必然失败（与脚本路径能力不一致）

| 项 | 内容 |
|---|---|
| 位置 | `crates/proxy-core/src/rules/rewrite.rs:204-207`；请求侧同类 `rewrite.rs:488-492` |
| 复核 | ✓ |

`apply_body_field_rewrite` 直接对线上原始字节做 UTF-8 + JSON 解析，而代理全程不处理 `Accept-Encoding`（`grep -i accept-encoding` 在 proxy-core 零命中），因此 gzip/br 响应的 `response_body` 就是压缩字节。脚本路径相反：`build_body_reference` 会先 `decode_body_bytes` 再交给 JS。

**影响**：任何 gzip JSON 接口上 Fields 模式永久报 `body field rewrite requires valid JSON body`；用户只能改用脚本规则。replace 模式不受影响，因此很容易被误判为「这条接口不支持字段改写」。

**修复建议**：解析前 `decode_body_bytes(body, content_encoding)`，写回后按需剥离 content-encoding（`strip_plain_body_edit_headers` 已存在）。

---

### P1-8 JSON Body Fields 重写会重排整份 JSON 的 key（破坏签名）

| 项 | 内容 |
|---|---|
| 位置 | `Cargo.toml:36`（`serde_json = "1"`，未开 `preserve_order`）；`crates/proxy-core/src/rules/rewrite.rs:206,233` |
| 复核 | ✓ |

`serde_json` 默认 `Map` 是 BTreeMap，`to_vec` 时 key 全部按字典序重排，数字表示也会被规范化。

**影响**：只改 `$.user.name` 也会让 `{"b":1,"a":2}` 变成 `{"a":2,"b":1}`；对「对原始 JSON 串签名」的回调（微信/支付宝/部分 SDK）验签失败；用户看到「我只改了一个字段，整份 body 都变了」。

**修复建议**：开启 `serde_json = { version = "1", features = ["preserve_order"] }`（会引入 `indexmap`，需评估所有 crate 的影响面与二进制体积）。

---

### P1-9 Linux 应用系统代理失败时无回滚，且内存无快照 → 整机流量卡在死端口

| 项 | 内容 |
|---|---|
| 位置 | `apps/desktop/src-tauri/src/system_proxy/linux.rs:135-143`；对照 `windows.rs:74-100`、`macos.rs`；调用方 `apps/desktop/src-tauri/src/commands/proxy.rs:677-696` |
| 复核 | ✓ |

`apply_system_proxy_settings_with_pre_snapshot` 直接 `match` 到 `apply_gnome_proxy` / `apply_kde_proxy`，参数 `snapshot` **完全没用于回滚**；Windows 在 `apply_result` 失败时会 `restore_system_proxy(&snapshot)`，macOS 同样有 rollback——只有 Linux 缺失。

调用方把「捕获 → 持久化 → 应用 → 存内存快照」放在一个闭包里，`apply` 的 `?` 会在 `store_system_proxy_snapshot` 之前返回。

**触发**：GNOME 下 `http host` 写成功、`https host` / `ignore-hosts` / `mode` 失败（dconf 只读、DBus 会话异常、schema 缺失、策略锁定）；KDE 下 `ProxyType=1` 成功、`httpProxy` 失败。

**影响**：系统代理处于「半应用」状态，且内存里没有快照 → 用户点「关闭系统代理」时 `take_system_proxy_snapshot()` 返回 None，直接跳过 restore → **整机流量持续指向 AIProxy 端口**，只能等下次启动靠 recovery 文件恢复。

**修复建议**：在 Linux 该函数里包一层，失败时先 `restore_system_proxy(&snapshot)` 再返回聚合错误（与 Windows 的错误聚合风格一致）。

---

### P1-10 断点编辑响应头会把重复头（Set-Cookie 等）合并成一条

| 项 | 内容 |
|---|---|
| 位置 | 响应侧 `crates/proxy-core/src/breakpoints.rs:830-841`；请求侧对照组 `breakpoints.rs:240-248`；前端提交 `apps/desktop/src/features/breakpoints/components/BreakpointInterceptPanel.tsx:1809-1816` |
| 复核 | ✓ |

请求侧用 `append` 并专门写了注释（「repeated header names (e.g. multiple Cookie lines) must survive the edit」），响应侧却用 `insert`：

```rust
for entry in headers {
    if let (Ok(name), Ok(value)) = (...) {
        new_headers.insert(name, value);   // ← 同名后者覆盖前者
    }
}
```

**触发**：断点面板打开「响应头」tab（`HeaderEditor` 以当前全部头为初值），做任意改动后 Forward，前端提交整份头列表。多个 `Set-Cookie` / `Link` / `WWW-Authenticate` / `Warning` 只剩最后一个。

**影响**：多 Cookie 登录态丢失、`Set-Cookie` 覆盖导致会话串号；用户会以为「断点只是改了个 header，怎么登录掉了」——极难归因。

**修复建议**：与请求侧一致改用 `append`。

---

## 4. P2：真实缺陷（特定条件触发）

| # | 位置 | 问题 | 后果 | 复核 |
|---|---|---|---|---|
| P2-11 | `crates/proxy-core/src/rules/rewrite.rs:430-448` | Query 重写把**所有**参数解成 `query_pairs` 后再 `append_pair` 重编码 | 在 `?sig=abc%20def&x=1` 上改一个参数 → `%20` 变 `+`、非法转义被二次转义 → AWS SigV4 / OSS / 微信等签名接口 403；未命中参数也被改写，用户无法解释 | ✓ |
| P2-12 | `crates/proxy-core/src/rules/rewrite.rs:436` | Query 参数名按大小写不敏感匹配（`eq_ignore_ascii_case`） | `?id=1&ID=2` 上 remove/set `id` 会同时影响 `ID`（Query 名按规范大小写敏感） | ✓ |
| P2-13 | `crates/proxy-core/src/rules/rewrite.rs:413-424` + `187-191` | 请求级 header rewrite 设置 `Host` 记 success，随后 `rebuild_request_runtime_state` 用 URL host 覆盖，转发时 host 又被剥离 | 想改 Host 做虚拟主机调试时**零效果**，trace 却显示改成功了（before/after 也在 rebuild 前采集） | ✓ |
| P2-14 | `crates/proxy-core/src/ws_upgrade.rs:467-504` | 非法 101 被改写成 502 时，仍按 `parse_response_body_framing` 的结果读 body；101 无 CL/TE → `ReadUntilClose` | 上游返回 101 但 `Sec-WebSocket-Accept` 不匹配且不关连接时：客户端等约 10s（`WsUpstreamBodyReadIdle`）才拿到 502，且这期间上游 WS 帧被当作「错误页 body」（上限 20MB）塞进响应体 | ✓ |
| P2-15 | `crates/proxy-core/src/ws.rs:940,1010,1084` | 每帧先在 select! 分支体内 `await` 有界录制通道的 `send`（容量 4096），消费者要做 DB 写 | 慢 DB 写时通道填满 → 转发停摆（双向背压），5s 关闭宽限期也无法触发（循环本身被挂起） | ✓ |
| P2-16 | `crates/mcp-server/src/tools/sessions.rs:873-901` | `parse_since` 对 `amount` 无上界，直接 `Duration::days/hours/...` 与 `Utc::now() - duration` | `sessions.list` / `insights.*` 传 `since: "100000000d"` → chrono 越界 panic（工具调用直接挂掉），应改为参数校验错误 | ✓ |
| P2-17 | `apps/desktop/src-tauri/src/commands/proxy.rs:187`（start）、`:574`（stop） | start/stop 主体无互斥；`system_proxy_op_lock` 只保护收尾 | start 期间点 Stop：`take_runtime()` 为 None 直接返回「已停止」，随后 start 又把 running 置 true；落在窗口边缘时 running=true 但监听器已关闭、无句柄可再停 | 子代理 |
| P2-18 | `apps/desktop/src-tauri/src/commands/files.rs:315,376`；`commands/rules.rs:681` | 文件大小上限在 `fs::read` **整读之后**才检查 | 选一个 5GB 的 `.har` 会先分配 5GB 再报「超过 64MB」；应用应 `metadata().len()` 预判或 `File::take(limit+1)` | 子代理 |
| P2-19 | `crates/proxy-core/src/rules/script.rs:103-113` | `header_map_from_script_headers` 对非法名/值静默跳过 | 如 `content-disposition: attachment; filename=报告.pdf`（`HeaderValue` 拒绝非可见 ASCII）→ 头被丢弃，outcome 仍 Success、无 trace | ✓ |
| P2-20 | `crates/proxy-core/src/rules/script.rs:378-385` | onResponse 阶段只消费 `result.response`，从不看 `response_override` | `onResponse` 里调 `ctx.respond()` 无任何效果也无提示（用户指南只说用于 onRequest，但静默度太高，排障成本大） | 子代理 |
| P2-21 | `crates/proxy-core/src/rules/json_path.rs:284-291` | `object.remove(key)` 的返回值被忽略，恒返回 Ok | 路径写错/字段已不存在也记 success，before/after 均为空，用户以为删掉了 | 子代理 |
| P2-22 | `apps/desktop/src/services/commands/sessions.ts:286-304` | `deleteSessionsExcept` 先 `keepOnlyImportedSession` 再调后端 | 后端失败时导入会话已从内存 store 移除（与 `deleteSessions` / `clearSessions` 的「成功后再删」约定相反），需重新导入 | ✓ |
| P2-23 | `apps/desktop/src-tauri/src/system_proxy/windows.rs:29` | `proxy_enable: key.get_value("ProxyEnable").unwrap_or(0)`，同结构其它字段都用 `read_optional_dword`（会传播错误） | 该值被写成 REG_SZ 或读取失败 → 快照记 0 → restore 写入 `ProxyEnable=0`，永久关掉用户原本开启的代理且无提示 | ✓ |
| P2-24 | `apps/desktop/src-tauri/src/system_proxy/windows.rs:112-136`；`macos.rs:211-229` | restore 先写 server 后写 enabled，且全程 `?` 短路；注释声称「ProxyEnable 仍是 apply 前的 disabled 值」，但 apply 已把它置 1 | 写 `ProxyServer` 失败时 `ProxyEnable` 仍为 1 → 整机流量指向已死的 AIProxy 端口（正是注释声称不会发生的黑洞）。应先置 0，再写回原值，最后恢复原启用标志；macOS 应逐步收集错误而非短路 | ✓ |
| P2-25 | `apps/desktop/src-tauri/src/commands/sessions.rs:566-577` | `raw_request_deferred` / `raw_response_deferred` 只要 `include_*` 为真就置 `Some(false)`，与 `raw_request_text()` 是否为 Some 无关 | `raw_request` 为 None 时前端仍认为「已内联完整」→ 不再触发二次拉取 → 详情页 raw 面板空白 | ✓ |

---

## 5. P3：低危 / 健壮性与工具链

### 代理核心

- **节流子块精度**：每 16KiB 子块 `transfer_delay_ms` 用 `div_ceil` 取整到毫秒（`crates/proxy-core/src/rules/throttle.rs:57-69`），高带宽档明显偏慢（100Mbps 约慢 36%，1Gbps 约慢 8 倍）。应改为累计预算（记录已发字节与应到时刻）而非逐块取整。
- **`https://` 绝对形式的 WS 升级**：`ws_needs_tls` / `ws_default_port` 只认 `wss`（`crates/proxy-core/src/ws_upgrade.rs:131-149`），与普通请求路径（`timing_connector` 把 `https` 与 `wss` 同等对待）不一致 → 明文代理端口收到 `GET https://host/ws` 会以明文连 80。
- **101 头的 obs-text**：响应头经 `from_utf8_lossy` 后再 `HeaderValue::from_str`（`ws_upgrade.rs:365-371`、`636-642`），任一非可见 ASCII 值会让整个升级变 502——`connect.rs:496-503` 特意避免的问题在构建层被重新引入。
- **被拒绝的升级响应体不进会话**：detail 在 `ws_upgrade.rs:407-428` 用空 body / size=0 构建，实际 body 到 `:504` 才读出，从不回填 → 403/401 页面在 Inspector 里 body 为空。
- **101 会话发送失败静默**：同文件其它发送点都有 `session_send_dropped` 日志，只有 `ws_upgrade.rs:689` 是裸 `let _ =`。
- **`host_pattern` 只支持少数形态**：`crates/proxy-core/src/host_pattern.rs:51-60` 只识别 `*.` / `.` 前缀，`*apple.com`、`api.*.com`、中文域名（未做 IDN→punycode）都静默不命中；用在 SSL 排除列表上时「不命中 = 照常 MITM」，反而破坏证书固定的 App。

### 系统代理（跨平台）

- **KDE 只调用 `kwriteconfig6` / `kreadconfig6`**（`apps/desktop/src-tauri/src/system_proxy/linux.rs:503,529,551`）：Plasma 5（Kubuntu 22.04/24.04）只有 `*5`，系统代理完全不可用；且 `kread_config` 把「二进制不存在/执行失败」与「键为空」都返回 `None`（`:563-573`），capture 仍 Ok，restore 时会对 `None` 键执行 `kdelete_config`（`:478-479`），删掉用户原有 `kioslaverc` 配置。
- **KDE 代理值缺 scheme**（待 KDE 环境实测）：写入 `settings.endpoint()` = `host:port`（`linux.rs:441` + `system_proxy/mod.rs:15-17`），而 `kioslaverc` 的 `httpProxy` 期望 `http://host port` 形式；KIO 若无法解析为代理 URL，KDE 下系统代理实际不生效。
- **GNOME 快照伪造默认值**：`linux.rs:280` / `:361` 读取失败返回 `"'none'"`、`:332` 返回空列表 → 快照「看起来合法」，restore 会清空用户配置。快照阶段失败必须返回 Err。
- **recovery pending 文件不清理 / 无 fsync**：`apps/desktop/src-tauri/src/system_proxy_recovery.rs:158-170` 平台/schema 不匹配只告警不删文件 → 每次启动重复告警且永不恢复；`:71-92` 的 `write_atomic` 未 `sync_all`，注释里「掉电也不会半写」不成立。

### 桌面端命令层

- **证书删除失败路径丢报告**：`apps/desktop/src-tauri/src/commands/certificates.rs:706-718`，此时证书/信任/持久化/系统代理交还都已完成，重启失败却整体返回 Err，`trustRemoval` 等字段全丢。
- **Agent 配置替换是「先删后改名」**：`commands/agent_access.rs:1391-1400`（rename 失败且目标存在 → `remove_file(to)` 再 rename，第二次仍失败只回传旧错误），`:1479-1501` 还会残留 `.tmp` 且原文件已删。建议先写 `.bak-<ts>` 再替换。
- **集合/环境 upsert 覆盖 `created_at`**：`commands/collections.rs:315,412`、`commands/environments.rs:89`（与 D7 同源，DB 层也写该列）→ 重命名即丢失创建时间。
- **multipart 不覆盖 Content-Type**：`commands/compose.rs:38-48`（注释与行为相反），手写 `application/json` 后再加附件 → body/头 boundary 不匹配，服务端解析失败且无提示。
- **附件令牌注册表**：`commands/files.rs:84-139` 用 `data_local_dir()/AIProxy` 而非全局 `resolve_db_dir()`，Unix 下未收紧到 0600，且明文记录被附加文件的绝对路径；`save_media_file`（`:584`）全量 base64 解码无上限。
- **窗口状态二次恢复**：`apps/desktop/src-tauri/src/window_state.rs:62-69` 在启动 180ms 后再恢复一次，会覆盖用户刚做的拖动/缩放（`main.rs:335` 之前已恢复过一次）。

### 脚本引擎 / 工具链

- **脚本入口检测用正则扫原文**：`crates/rule-engine/src/compile.rs:83-89` 的 `\bexport\b` 会被字符串字面量或注释命中 → 函数体里出现 `"export ready"` 就会拒绝合法脚本。
- **`check-api-contract` 只识别 `commands::` 前缀**：`scripts/check-api-contract.mjs:75` 的正则漏掉 `agent_control::get_recent_agent_control_actions` / `agent_control::clear_agent_rules`，于是这两个**已注册**命令反而被报成「文档有、代码无」；更重要的是，任何非 `commands::` 模块的新命令都不会被「注册但未文档化」这条硬门禁拦住。

---

## 6. 数据库层（`crates/db/src`）专章

该层另跑了 `cargo test -p aiproxy-db`（131 项全绿），并用 SQLite 实测 / `EXPLAIN QUERY PLAN` / git 历史交叉验证。**无 critical**，两条「中」值得优先处理。

### D1 [中] `session_details` 的 1:1 关系没有 UNIQUE 约束 → 读取不确定、搜索分页漏 session

| 项 | 内容 |
|---|---|
| 位置 | `crates/db/src/schema.rs:168`（普通索引）；`crates/db/src/sessions.rs:170,196,328`；`crates/db/src/session_search.rs:446-450` |
| 复核 | ✓ |

`session_details(session_summary_id)` 只有非唯一索引；`upsert_session` 只按 `detail.id` 做 UPDATE/INSERT，而 `load_session_detail` 用 `query_row` 按 `session_summary_id` 取，`session_search` 还对其做 LEFT JOIN。

**影响**：一旦同一 summary 出现第二行（导入路径、不同 id 约定、未来新调用方），详情返回任意一行；LEFT JOIN 把 1 个 session 放大成 N 行并占用 `LIMIT` → 搜索结果漏 session（已用 SQLite 实测复现重复行）。

**修复**：先去重再建 `UNIQUE INDEX ... ON session_details(session_summary_id)`，upsert 改为按 `session_summary_id` 更新，load 加 `LIMIT 1` 兜底。

### D2 [中] 迁移没有版本门，破坏性 DML 每次启动重放

| 项 | 内容 |
|---|---|
| 位置 | `crates/db/src/schema.rs:374-568`（collapse 调用 `537/553/560`，实现 `613-656`） |
| 复核 | ✓ |

`run_migrations` 每次 `open_database` 全量执行，**全仓无 `PRAGMA user_version`**（`grep` 零命中）；其中 3 条 collapse 是改写/删除用户数据的 DML，且与随后的 `CREATE UNIQUE INDEX` 不在同一事务。

当前这些语句在首次执行后即幂等（重复行已被清掉），所以**不是立即的数据损坏**；真正的风险是：崩溃发生在「删除与建索引之间」时下次继续重放、版本回退后新逻辑认可的重复行会被静默删/禁用、以及永远缺少「已迁移到哪一版」的记号。

**修复**：读 `PRAGMA user_version`，`BEGIN IMMEDIATE` 包住 collapse + index，仅 `version < N` 时执行并写回 N。

### D3 [中低] `write_body` 非原子写；`read_body_range` 以文件长度当真实长度

| 项 | 内容 |
|---|---|
| 位置 | `crates/db/src/body_store.rs:58,65,66`（直接 `fs::write` 最终路径）；`:86,106`（用 `metadata.len()` 当真实长度并据此算 `truncated`）；双写来源 `apps/desktop/src-tauri/src/bootstrap/converters.rs:509` |
| 复核 | ✓ |

同一 `{session}/{kind}.body` 会被写两次（请求开始 spill 一次、结束 upsert 再 spill 一次），第二次先 truncate 再写：这段时间内 UI/MCP 读到的可能是空文件或前缀，且 `original_size_bytes` 取自这个短文件 → `truncated=false` → MCP `body_sizes` 把半截 body 当完整返回；进程崩溃在写中会永久留下半截文件。

**修复**：临时文件 + `sync_all` + `rename` 原子替换；或把期望长度落库并用它判定 truncated。

### D4 [中低] 一个请求命中 ≥10 条规则时，Rule Runs 顺序错乱

| 项 | 内容 |
|---|---|
| 位置 | `crates/db/src/rules.rs:1241`（script_runs）、`:1417`（rewrite_runs）；id 生成 `apps/desktop/src-tauri/src/bootstrap/repository.rs:518,528,594` |
| 复核 | ✓ |

`ORDER BY created_at ASC, id ASC`，而同一会话所有 run 的 `created_at` 都等于 `summary.finished_at`，排序退化为 id 字典序；id 是 `{session}-script-run-{index}` / `{session}-rewrite-run-{index}` → run-1、run-10、run-11、run-2。

**修复**：`ORDER BY rowid ASC`（replace 按 index 顺序插入）或增加整数 `seq` 列。

### D5 [低中] `ws_messages` 外键立即生效 + 父行异步落库 → 早期 WS 帧被丢弃

| 项 | 内容 |
|---|---|
| 位置 | `crates/db/src/schema.rs:180`（FK）、`crates/db/src/sessions.rs:475`（`INSERT OR IGNORE`）、`crates/proxy-core/src/ws_upgrade.rs:689` + `apps/desktop/src-tauri/src/bootstrap/mod.rs:519-534` |
| 复核 | ✓ |

`OR IGNORE` 只吞 UNIQUE 冲突，吞不了 FK 错误；WS 会话是「先 send 给 collector、异步批量 upsert」，首帧早于父行落库时插入失败，上层仅 `tracing::error!("insert_ws_message_failed")` → DB 永久缺帧。

**修复**：relay 启动前同步 upsert 父行，或外键声明 `DEFERRABLE INITIALLY DEFERRED`，或失败短暂重试。

### 其余（低危，多为一致性问题）

| # | 问题 | 位置 | 后果 |
|---|---|---|---|
| D6 | 负 `i32/i64 as u32` 未 clamp | `rules.rs:107,140,257,516-518,664,777`；`collections.rs:594,606`；`environments.rs:253,266,276`；`sessions.rs:348`（对比已加固的 `workspaces.rs:7`、`sessions.rs:715-717`） | `latency_ms=-100` 读成 4294967196 → 请求被挂约 49 天；负 priority 规则排到最前 |
| D7 | 集合/环境/条目 upsert 的 UPDATE 分支写 `created_at` | `collections.rs:70-86,225-253`；`environments.rs:50-63` | 每次保存都把「创建时间」改成当前时间（与 P3 命令层同源） |
| D8 | `read_body` 绕过符号链接/普通文件硬化 | `body_store.rs:74-77`（另两个读路径走 `checked_regular_body_file`） | 目前仅测试使用，属防御缺口：bodies 目录被放入指向任意文件的 symlink 即可读出 |
| D9 | `PRAGMA journal_mode=WAL` 失败被静默忽略 | `connection.rs:220-221`（`execute_batch`，SQLite 切换失败只返回旧模式不报错） | 只读目录/网络盘/被锁时误以为处于 WAL |
| D10 | `load_throttled_session_ids` 的 `DISTINCT + ORDER BY created_at` 顺序不确定 | `rules.rs:794-796`（实测最新被节流的 session 排最后） | 目前无调用方，属公开 API 语义错误；应改 `GROUP BY session_id ORDER BY MAX(created_at) DESC` |
| D11 | 变量 upsert 的 `ON CONFLICT DO UPDATE` 不更新 `id` | `environments.rs:118-135,195-205` | 调用方新传入的 id 被静默丢弃，随后按新 id 更新/删除 0 行命中 |
| D12 | 指向 `workspaces` 的外键无 `ON DELETE`，且 crate 内无删除 workspace 路径 | `schema.rs:29,46,61,77,195,218` | 将来实现「删除工作区」会被 `FOREIGN KEY constraint failed` 挡住；未开 pragma 的连接则留孤儿规则 |
| D13 | 4 个协议列只在 `CREATE TABLE`，无 `ALTER` 升级路径 | `schema.rs:119-122`（`scheme/http_version/transport_protocol/application_protocol`）；`connection.rs:61-75` 的检测也不含这 4 列 | 仅影响 v0.1.0 之前的开发期旧库：任何 summary 读取都会 `no such column: scheme`，而 `inspect_schema` 仍报 `core_sessions=true` |
| D14 | `idx_session_summaries_host_duration` 服务不了注释声称的查询 | `schema.rs:135-139` vs `insights.rs:392-401,429-431`（过滤/分组都是 `LOWER(host)`） | `EXPLAIN` 实测为全表 SCAN + TEMP B-TREE；应建 `(LOWER(host), duration_ms)` 或写入时规范化 host |

---

## 7. 已核查、确认无问题的部分

为避免后续重复排查，以下区域经过逐行核对（含对既有设计意图的确认），**未发现缺陷**：

- **HTTP/1 与体传输**：hop-by-hop 剥离（含 `Connection` 列表 token、WS 握手豁免、pseudo-header 清理）、20MiB 请求体上限与 413 降级路径、gzip/br/deflate 解压输出上限（zip-bomb 防护）、spool 文件生命周期与 `Content-Length` 复算、HEAD/304 的 content-length 保留。
- **代理核心并发**：CONNECT 隧道双向半关闭、空闲超时按「读完成时刻」续期、上游连接池的 `PendingConnectGuard`/`H1Lease`/驱逐任务、accept 失败退避、连接信号量核算（含 WS relay 额外持有的 permit）。
- **上游代理**：HTTP CONNECT（含 1xx 中间响应上限）、SOCKS5（RFC 1928/1929）协商、IPv6 authority、代理跳 TLS 强制验证、按域名透传而非本地解析。
- **WebSocket 帧层**：7/16/64 位长度、控制帧 FIN/125 字节约束、保留 opcode、掩码与解掩码、重组上限与 `truncated` 传播、`Sec-WebSocket-Accept` 计算与校验；解析采用「调用方持有缓冲 + 纯同步解析」的取消安全设计。
- **DB**：迁移幂等（`pragma_table_info` 预检）、所有 `LIKE` 均 `escape_like_pattern` + `ESCAPE '\'`、动态 SQL 拼接片段均为静态列/表白名单或已 clamp 整数（无注入）、三处动态 SQL 占位符编号与游标条件一致、批量删除均包事务并按 500 分批、upsert 统一 UPDATE-or-INSERT 规避 REPLACE 触发 CASCADE、游标 base64 对偶（`URL_SAFE_NO_PAD`）。
- **规则引擎**：QuickJS 微任务驱动（async hook 的 `await` 后逻辑不丢）、`respond()` 二次调用告警、permit 中毒恢复、trace 条数上限。
- **前端**：`tsc --noEmit` 通过；`vitest` 823 用例全绿；事件监听器清理、`sessions-removed` 墓碑机制、body 大小按 UTF-8 字节计算等既有修复到位。

---

## 8. 建议修复顺序

| 批次 | 内容 | 理由 |
|---|---|---|
| 第 1 批 | P0-1、P0-2、P0-3 | 三处都局部、可测。P0-1 是两处 header 过滤；P0-2 是一个归一化函数 + 测试；P0-3 是 ref 化 + 一条能触发重渲染的测试 |
| 第 2 批 | P1-4、P1-9、P1-10 | 分别是「数据静默损坏」「整机流量黑洞」「登录态丢失」，都属于用户无法归因的静默故障 |
| 第 3 批 | D1、D3 | 决定「看到的数据是不是真的」：DB 一致性与 body 原子写 |
| 第 4 批 | P1-5、P1-6、P1-7、P1-8 | 文档/实现一致性与重写语义；P1-5 需要产品决策（改实现还是改文案） |
| 第 5 批 | P2 中命中频率最高者：P2-14（10s 卡顿）、P2-16（panic）、P2-17（状态不一致）、P2-22（导入丢失） | 影响可观测但触发条件更窄 |
| 后续 | 其余 P2/P3/D 系列 | 按迭代逐步收敛；P3 中的跨平台项（KDE/Plasma 5、GNOME 快照、restore 顺序）建议合并成一次「系统代理跨平台一致性」专项 |

---

## 9. 附：审查方法与局限

- **证据分级**：本报告区分「主审逐行复核」与「子代理核实」。子代理条目中涉及 SQLite 行为的（D2 重放、D5 FK、D4 排序、D10 DISTINCT、D14 索引）均附有实测或 `EXPLAIN` 证据；涉及外部系统格式的（KDE `kioslaverc` 格式）标注为「待实测」。
- **未覆盖**：`crates/mcp-server` 的 `redaction.rs`（678 行，脱敏规则全集）、`crates/mcp-server/src/tools/body.rs` 的中段解析逻辑只做了抽查；前端 200+ 组件只抽查了会话/断点/规则/代理状态链路。这些区域若需要，建议单独安排一轮。
- **静态分析缺口**：`cargo clippy --workspace --all-targets` 未能在本机完成（多个 cargo 进程争抢 registry/target 锁），建议在 CI 或干净环境补跑，重点看 `clippy::cast_possible_truncation`、`clippy::cast_sign_loss`（与 D6 同源）与 `clippy::unwrap_used`。
- **可复现性**：所有 P0/P1 条目均给出了「触发条件 + 期望行为」，可直接转为 issue 与回归测试用例。

---

## 10. 修复进度

按 §8 的批次推进，每批独立提交（代码 + 回归测试 + 同批文档同步）。

| 批次 | 范围 | 状态 | 提交（subject） | 备注 |
|---|---|---|---|---|
| 第 1 批 | P0-1、P0-2、P0-3 | ✅ 已修复 | `fix(proxy-core,desktop): stop advertising WS extensions, fix packet-loss unit and autostart restore` | P0-1 抽出 `build_ws_upgrade_response` 便于断言；P0-2 同步 `API_SPEC.md` 单位约定；P0-3 新增「启动中重渲染仍恢复系统代理」回归测试（已确认在旧实现上为红） |
| 第 2 批 | P1-4、P1-9、P1-10 | ✅ 已修复 | `fix(proxy-core,desktop): script bodies, response headers, linux rollback` | P1-4 采用「base64 精确字节 + lossy 文本比对」而非简单 base64 优先，保留直接赋值 `bodyText` 的编辑语义；P1-9 本地无法编译 `linux.rs`（`cfg(target_os = "linux")`），仅经人工核对与 rustfmt 校验，需由 Linux CI 验证 |
| 第 3 批 | D1、D3 | ✅ 已修复 | `fix(db): enforce 1:1 session details and atomic body writes` | D1 迁移先收敛重复行（保留最早写入的一行）再建唯一索引，且以「唯一索引是否存在」做一次性门控，避免每次启动全表扫描；detail 写入改为 `ON CONFLICT(session_summary_id)` 单语句 upsert 以消除并发重复；D3 改为临时文件 + `rename` 原子替换（不 fsync，避免拖慢抓包热路径），并发读测试在旧实现上可稳定复现部分读取 |
| 第 4 批 | P1-5、P1-6、P1-7、P1-8 | ⏳ 待处理 | — | — |
| 第 5 批 | P2-14、P2-16、P2-17、P2-22 | ⏳ 待处理 | — | — |
| 后续 | 其余 P2/P3/D | ⏳ 待处理 | — | — |

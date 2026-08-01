# AIProxy 代码审查报告（第六轮 · 静态分析）

## 1. 文档信息

- 产品代号：`AIProxy`
- 文档类型：综合代码审查报告（Bug / 协议正确性 / UX）
- 审查日期：`2026-08-01`
- 审查范围：全仓库（以 `dev` 分支当前工作树为准）
  - Rust crates：`proxy-core`、`rule-engine`、`db`、`tls-manager`、`sys-util`
  - Tauri 后端：`apps/desktop/src-tauri/src`
  - React 前端：`apps/desktop/src`
- 审查方式：核心热路径逐行精读 + 高风险模块交叉核对 + 依赖源码验证（`http-body-util` 0.1.3）
- 前序文档：`docs/CODE_REVIEW_2026-07-11.md`（第五轮，52 项发现）

> 与前序审计的关系：本报告所有条目均为第五轮（及更早）已修复项之外的新发现或残留边界。
> 已排除第五轮已修复的 H1–H8 / M1–M20 / L1–L18 / A13–A18。
> 第四轮已记录并修复的"改写 payload 解析错误中止整条请求"，本轮复核发现其"状态重建失败"分支仍有残留边界（见 R6-3）。

---

## 2. 汇总

| 领域 | 🟠 中危 | 🟡 低危 | 小计 |
|---|---|---|---|
| 网络层（proxy-core） | 3 | 1 | 4 |
| 前端接入层 | 0 | 2 | 2 |
| **合计** | **3** | **3** | **6** |

> 另有 1 项极端边缘行为记录于第 7 节，不计入 Bug 总数。

---

## 3. 🟠 中危（3 项）

### R6-1 🔧 已修复 · `wss://` 请求走明文 HTTP 代理时用明文连接，且默认连到 80 端口

- **位置**：`crates/proxy-core/src/ws_upgrade.rs:140-142, 189-230`；同源判断另见
  `crates/proxy-core/src/upstream.rs:119`、`crates/proxy-core/src/timing_connector.rs:125`
- **类别**：协议正确性 / 安全（明文泄漏）
- **证据**：
  ```rust
  // ws_upgrade.rs
  let port = request.url.port().unwrap_or(match ctx.mode {
      ConnectionMode::PlainHttp => 80,
      ConnectionMode::MitmHttps { .. } => 443,
  });
  let mut upstream = match ctx.mode {
      ConnectionMode::MitmHttps { .. } => { /* TLS */ }
      ConnectionMode::PlainHttp => TlsOrPlain::Plain(ws_tcp), // 明文
  };
  ```
  TLS 决策依据 `ctx.mode`（连接模式）而非 `request.url.scheme()`。`wss` scheme
  在 `upstream.rs:119`（`scheme() == "https"`）与 `timing_connector.rs:125`
  （`uri.scheme() == Some(&Scheme::HTTPS)`）同样不被识别。
- **影响**：客户端经普通 HTTP 代理端口发送 absolute-form 的
  `GET wss://host/...`（未先 CONNECT）时，代理以明文 TCP 连接 URL 未显式端口时
  默认的 80 端口，握手必然失败；即便显式端口成功，WebSocket 流量也是明文发送。
  浏览器通常走 CONNECT 经 MITM 路径，恰好正确，故该入口为边缘但真实存在。
- **修复方向**：按 `request.url.scheme() == "wss"` 决定启用 TLS 与默认端口 443；
  `upstream.rs` / `timing_connector.rs` 的 scheme 判断需同步纳入 `wss`。
- **状态：已修复 @ 2026-08-01（工作树，未提交）** — `ws_upgrade.rs` 新增
  `ws_default_port`（wss→443）/ `ws_needs_tls`（MitmHttps 或 wss scheme）/
  `connect_ws_upstream_tls`，`handle_ws_upgrade_via_hyper` 改按 URL scheme 决策；
  `upstream.rs` 与 `timing_connector.rs` 的 `is_https` 均纳入 `wss`。
  验证：7 个新单测（`ws_default_port_*` / `ws_needs_tls_*`）通过；
  proxy-core 216 测试全绿；workspace `cargo check` 通过。

### R6-2 🔧 已修复 · 请求体超过 20MB 时整个请求直接失败，无响应无会话

- **位置**：`crates/proxy-core/src/http_proxy.rs:258-261`
- **类别**：功能缺失 / 静默断连
- **证据**：
  ```rust
  let limited_body = http_body_util::Limited::new(body, MAX_CAPTURED_BODY_BYTES);
  let body_bytes = BodyExt::collect(limited_body)
      .map_err(|e| ... "failed to read request body: {e}")?;
  ```
  已核对依赖源码 `http-body-util-0.1.3/src/limited.rs`：`Limited` 超限返回
  `LengthLimitError`（报错），并非截断。错误传播到 `handle_http_request` → hyper
  关闭连接：客户端收到连接重置，无任何会话记录。
- **影响**：任何 >20MB 的 POST/PUT（大文件上传、multipart 等）在代理侧直接失败。
  对比响应侧对同样上限是 spool 落盘并完整流式回写（`upstream.rs` M3 路径）。
  设计文档 `docs/PAGE_BLUEPRINTS.md:314` 明确"请求/响应 Body 在 20MB 处被截断"，
  请求侧未按设计实现。
- **修复方向**：请求体同样 spool 到磁盘后流式转发上游（镜像响应路径），
  或至少返回 413 并记录一条截断会话，避免静默断连。
- **状态：已修复 @ 2026-08-01（工作树，未提交）** — `stage_parse_request` 新增
  `Stage1Outcome::PayloadTooLarge` 分支：`BodyExt::collect` 报
  `LengthLimitError` 时（已核对 http-body-util 0.1.3 导出），构建最小请求并
  返回 413 + 会话记录，不再中止连接。其他 body 读取错误仍为硬失败。
  验证：集成测试 `request_body_over_limit_returns_413_and_records_session`
  通过；proxy-core 216 测试全绿。

### R6-3 🔧 已修复 · 请求改写规则"成功改写但状态重建失败"仍会整体中止请求

- **位置**：`crates/proxy-core/src/rules/rewrite.rs:276`
- **类别**：健壮性 / 静默断连（第四轮 H 系列修复的残留边界）
- **证据**：
  ```rust
  if outcome == "success" {
      rebuild_request_runtime_state(request).inspect_err(|_error| {
          traces.push(build_rewrite_trace(..., "error", ...));
      })?; // 错误直接传播
  }
  ```
  `?` 将 `Err` 一路传到 `apply_request_runtime_rules` →
  `ProxyError::RuleError` → `handle_http_request` 返回 Err → 连接直接关闭，
  无 4xx/5xx 响应、无会话。第四轮已把 payload 解析错误改为逐规则隔离
  （`apply_one_request_rule` 返回 `Err` 记录 error trace 后 continue），
  但"改写成功后重建运行时状态"失败仍整体中止。
- **触发条件**：请求头改写产生非法 header 名/值（`HeaderName::from_bytes` /
  `HeaderValue::from_str` 失败），或 redirect 改写后 URL 失去 host。
- **修复方向**：重建失败降级为 error trace（`outcome = "error"`）+ 返回 502/400
  会话，而不是中止整条请求；或将该规则标记为错误后继续后续规则。
- **状态：已修复 @ 2026-08-01（工作树，未提交）** — `apply_request_rewrite_rules`
  移除 `rebuild_request_runtime_state(...)?` 的传播，改为 per-rule error trace
  （outcome = "error"）并继续级联；请求保留最后一次成功重建的状态，非法改写
  不会上到线路（`request.headers` 仍为有效旧值）。
  验证：回归测试 `rebuild_failure_on_request_rewrite_does_not_abort_request`
  通过（坏规则降级 + 后续规则继续执行）；proxy-core 216 测试全绿。

### 修复记录（2026-08-01）

R6-1 / R6-2 / R6-3 三项中危均已于 `dev` 分支修复并通过 `cargo test -p
aiproxy-proxy-core`（216 项测试全绿，新增 9 项回归测试）。

- **R6-1**（`crates/proxy-core/src/ws_upgrade.rs`）：新增纯函数 `ws_default_port`
  与 `ws_needs_tls`，按 URL scheme（`wss` → 443 + TLS）而非 `ctx.mode` 决策端口
  与传输层；TLS 握手逻辑提取为 `connect_ws_upstream_tls`，MITM 与 wss-over-plain
  两条路径共用。`upstream.rs:119` 与 `timing_connector.rs:125` 的 scheme 判断同步
  纳入 `wss`（防御性对齐；WS 实际走独立路径，正常不会到达）。
  回归测试：`ws_upgrade::tests::ws_{default_port,needs_tls}_*`（7 项单元测试）。

- **R6-2**（`crates/proxy-core/src/http_proxy.rs`）：`stage_parse_request` 改返回
  `Stage1Outcome` 枚举，对 `http_body_util::LengthLimitError`（依赖源码
  `limited.rs` 超限即 `Err`）单独识别并降级为 `PayloadTooLarge`。`handle_http_request`
  Stage 1 据此返回 `413 Payload Too Large` + 记录会话（复用
  `build_session_detail` / `build_plain_text_response`），不再静默断连。Stage 4 的
  `cancellation_guard` 此时尚未创建，不会误触 499。采用 413 降级（而非完整 spool），
  与现有「请求体全量内存缓存供 inspect/rewrite/breakpoint/forward」的架构一致。
  回归测试：`tests::request_body_over_limit_returns_413_and_records_session`。

- **R6-3**（`crates/proxy-core/src/rules/rewrite.rs`）：`apply_request_rewrite_rules`
  中 `rebuild_request_runtime_state` 失败不再用 `?` 整体中止，而是降级为该规则的
  `error` trace 并 `continue`（镜像第四轮 payload 错误的逐规则隔离）。同时订正原
  `inspect_err` 注释——其 push 进局部 `traces` 的 error trace 随 `?` 被丢弃、从未
  进入会话，「session 中仍可见」的旧注释与实际不符，已重写。下游 forward 仍有既有
  502 兜底。
  回归测试：`tests::rebuild_failure_on_request_rewrite_does_not_abort_request`。

---

## 4. 🟡 低危（3 项）

### R6-4 ✅ 节流规则 URL 匹配用 URL **或** host 的 contains 匹配（第五轮 M4，仍未修）

- **位置**：`crates/proxy-core/src/rules/mod.rs:225-226`
- **类别**：规则匹配正确性
- **证据**：
  ```rust
  .filter(|rule| {
      pattern_matches(&rule.url_pattern, request.url.as_str(), None)
          || pattern_matches(&rule.url_pattern, &request.host, None)
  })
  ```
  默认匹配类型为 contains 且 OR 了 host。`url_pattern = "api"` 会误伤
  `capiche.io`、`foo-api.com` 等 host 含 "api" 的站点，而 rewrite/script 规则只
  匹配 URL。第五轮报告列为 P2 计划修复（`docs/CODE_REVIEW_2026-07-11.md` M4），
  当前代码仍保留该行为。
- **修复方向**：仅匹配 URL（与 rewrite/script 对齐）；如需 host 匹配，应显式
  使用独立字段或仅在 pattern 不含 `/` 时回退 host。

### R6-5 🔧 已修复 · "复制为 cURL" 生成 POSIX shell 语法，Windows 下不可直接运行

- **位置**：`apps/desktop/src/features/compose/curl-export.ts:9-31`
- **类别**：UX / 平台适配
- **证据**：单引号包裹参数、`'\''` 转义、` \` 换行续行，均为 bash/zsh 语法。
  在 Windows cmd 中单引号是普通字符；PowerShell 中 `'\''` 不是合法转义、
  `\` 不是续行符。本应用主目标平台为 Windows，复制到 cmd/PowerShell 均无法运行。
- **修复方向**：按平台输出；Windows 下用双引号 + `^` 续行（cmd）或
  PowerShell 兼容转义，或提供平台感知的生成函数。

### R6-6 🔧 已修复 · "禁用全局"节流与规则实际生效状态不一致（UX 误导）

- **位置**：`apps/desktop/src/features/throttling/use-throttle-editor.ts:375`
  （`handleDisableGlobal`）、`crates/proxy-core/src/rules/mod.rs:238-250`
- **类别**：UX / 状态一致性
- **证据**：`handleDisableGlobal` 仅清空 active profile
  （`setActiveProfile(None)` → 所有 profile `enabled=false`），但
  `active_throttle_selection_for_request` 的规则分支不检查 `profile.enabled`，
  只要规则本身 enabled 且引用该 profile 即生效。页面顶部 chip 显示 "off"，
  实际流量仍被规则限速。UI 虽显示 `activeRuleCount` 提示规则存在，但
  "Disable Global" 文案与 on/off 状态对用户有明确误导。
- **修复方向**：规则分支同样校验 `profile.enabled`；或将全局开关语义统一为
  "关闭全部限速"（禁用所有规则/配置），并在文案上明确区分。

### 修复记录（2026-08-01）

R6-5 / R6-6 两项低危均已于 `dev` 分支修复并验证（前端 `pnpm typecheck` +
`pnpm lint` + `pnpm test` 412 项全绿，含新增 cURL 8 项；后端
`cargo test -p aiproxy-proxy-core` 218 项全绿，含新增 R6-6 2 项）。

- **R6-5**（`apps/desktop/src/features/compose/curl-export.ts`）：`generateCurlCommand`
  内部按平台分流。复用现有 `detectBrowserPlatform()`（`services/commands/runtime.ts`，
  默认 windows）自动检测：Windows 输出**双引号包裹 + `""` 翻倍转义 + 单行**（cmd 与
  PowerShell 的最大公约数——二者无公共续行符故单行），macOS/Linux 保留原 POSIX 单引号
  + `\` 续行。两个调用点（compose 页、会话右键 `buildCurlCommand`）签名不变、零改动。
  新增可选 `options.platform` 参数供测试注入。
  回归测试：`apps/desktop/src/features/compose/curl-export.test.ts`（8 项，覆盖双引号转义、
  无续行、GET 省略 -X、POSIX 单引号转义等）。

- **R6-6**（`crates/proxy-core/src/rules/mod.rs` + 前端
  `use-throttle-editor.ts`）：采用「禁用全局=关闭全部」语义。规则分支的 profile 查找
  增加 `&& profile.enabled` 校验——规则生效 ⟺ 规则自身 enabled 且其引用的 profile enabled。
  这样「关闭弱网」（全部 profile `enabled=false`）真正接管所有节流，与状态 chip "off" 一致；
  与 profile 回退分支（`active_throttle_profile_for_workspace` 已有的 `profile.enabled` 门）
  对齐。前端 `activeRuleCount` 同步改为只计「规则 enabled 且其 profile enabled」，使子标题
  `activeStatusScope` 计数与后端实际生效一致（profile 全关时归零）。`handleDisableGlobal`
  行为不变（后端据此真正关闭规则）。
  回归测试：`tests::throttle_rule_selects_when_its_profile_is_enabled`、
  `tests::throttle_rule_does_not_select_when_its_profile_is_disabled`。

---

## 5. 修复优先级建议

**P1（尽快修，静默断连/协议错误）**

- R6-1：`wss://` scheme 判定（TLS + 默认端口）
- R6-2：大请求体 spool 流式化或 413 降级
- R6-3：改写状态重建失败降级为错误会话

**P2（计划修，匹配/UX）**

- R6-4：节流规则 URL 匹配对齐 rewrite/script
- R6-5：cURL 导出平台适配
- R6-6：全局节流开关语义统一

---

## 6. 复核排除说明

- 数据库层（SQL 级联、唯一约束、批量删除）、TLS 证书生命周期（原子写、有效期
  闰年、PEM 完整性）、平台系统代理（Windows 注册表顺序 + 回滚、WinINet 刷新）、
  连接池（watch 去重、超时驱逐）复核通过，未发现新问题。
- 前端会话缓存、断点面板、i18n key 完整性复核通过。
- 本轮未做动态运行验证；R6-1/R6-2 的结论基于依赖源码（`limited.rs`）与调用链
  静态确认，R6-3 基于错误传播链确认。

---

## 7. 附录：极端边缘行为（不计入 Bug 数）

- `crates/proxy-core/src/ws.rs` `assemble_ws_message`：当起始分片帧自身超过
  `MAX_REASSEMBLED_MESSAGE_BYTES`（20MB）时，起始分片不进重组缓冲，最终重组
  消息会丢失开头数据。正常流量基本不可达，仅记录。

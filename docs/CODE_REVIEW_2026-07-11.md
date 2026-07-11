# AIProxy 全盘代码评审报告（第五轮 · 技术专家 + 技术总监视角）

## 1. 文档信息

- 产品代号：`AIProxy`
- 文档类型：综合代码评审报告（Bug / 性能 / 规范 / 架构）
- 评审日期：`2026-07-11`
- 评审范围：全仓库（截至 `dev` 分支 `f0f1e8a`）
  - Rust crates：`proxy-core`（~18.8k LOC）/ `rule-engine`（~2.1k）/ `db`（~7.4k）/ `tls-manager`（~2.0k）/ `sys-util`
  - Tauri 后端：`apps/desktop/src-tauri/src`（~13.7k LOC）
  - React 前端：`apps/desktop/src`（~57k LOC TS）
- 评审方式：6 领域并行深度静态审查 + 高危项逐行人工复核 + 架构横向评估
- 前序文档：
  - `docs/BUG_AUDIT_2026-06.md`（v1.3）
  - `docs/BUG_AUDIT_2026-06-27.md`（Round 2 v1.6）
  - `docs/BUG_AUDIT_2026-06-28.md`（Round 3 v1.3）
  - `docs/CODE_REVIEW_2026-07-04.md`（Round 4 v1.1，70 项发现）
- 文档状态：`Code Review Round 5 v1.1`（**本轮共 52 项新发现（Bug 类 46 + 架构类 6），均经源码核实，均不与 Round 4 已记录项重复**）

> **与前序审计的关系**：本轮所有条目均为 Round 4（及更早）修复后的新发现。Round 4 的 H1–H15 / M1–M30 / L1–L14 / A1–A12 不再重复；对其中少数"已修复"项，本轮复核发现仍有**残留边界**，单列为「复核残留」类（R5-*），与全新发现分开编号。

---

## 2. 阅读约定

- **严重程度分级**：
  - 🟠 高危：核心功能失效 / 资源耗尽 / 数据丢失 / 协议正确性 / 安全漏洞 / 系统级副作用
  - 🟡 中危：边界条件下错误行为 / 数据一致性 / 性能可观测退化 / 误导性行为 / UX 缺陷
  - 🟢 低危：健壮性 / 维护性 / 代码规范 / 微小性能
- **置信度分级**：
  - ✅ **已复核**：已打开源码逐行确认，确信为真实缺陷
  - 🔶 **待复核**：逻辑链条成立，触发条件或频率需进一步确认
- **定位格式**：`file_path:line_number`（相对仓库根 `D:\AI\AIProxy`）
- **领域来源标记**：`[N]`网络层 `[R]`规则层 `[D]`DB/TLS `[T]`Tauri 后端 `[F]`前端 `[A]`架构

---

## 3. 汇总

| 领域 | 🟠 高危 | 🟡 中危 | 🟢 低危 | 小计 |
|---|---|---|---|---|
| 网络层（proxy-core 网络） | 1 | 2 | 0 | 3 |
| 规则层 + rule-engine | 1 | 5 | 5 | 11 |
| DB / TLS / sys-util | 4 | 6 | 6 | 16 |
| Tauri 后端 | 2 | 4 | 2 | 8 |
| 前端接入层 | 0 | 1 | 2 | 3 |
| 前端业务层 | 0 | 2 | 3 | 5 |
| **Bug 合计** | **8** | **20** | **18** | **46** |
| 架构与工程规范（A13–A18，第 9 节） | 2 | 3 | 1 | 6 |
| **含架构项总计** | **10** | **23** | **19** | **52** |

> 上表 Bug 类按"主要领域"归类，部分条目跨领域（如 H1 同时涉及 TLS 子系统与 MITM 握手热路径）。架构/工程类 6 项（A13–A18）单列第 9 节，不计入 Bug 总数。修复优先级见第 7 节。

---

## 4. 🟠 高危（8 项）

### H1 ✅ 证书有效期 `date_time_ymd(年+1/年+10, 月, 日)` 在 2 月 29 日必 panic（闰日触发，热路径） `[来源:D]`
- **位置**：`crates/tls-manager/src/generator.rs:41-45`（根 CA）、`:217-221`（`sign_host_certificate`）、`:249-253`（`sign_host_certificate_from_data`）
- **类别**：panic / 正确性（MITM 握手热路径）
- **证据**：
  ```rust
  params.not_after = rcgen::date_time_ymd(
      now.year() + ROOT_CA_VALIDITY_YEARS as i32,  // CA +10，叶子 +1
      now.month() as u8,
      now.day() as u8,
  );
  ```
  rcgen 0.13.2 的 `date_time_ymd` 内部对非法日期 `.expect("invalid or out-of-range date")` 直接 panic。当 `now` 为闰年 2 月 29 日、`ROOT_CA_VALIDITY_YEARS=10` / `DYNAMIC_CERT_VALIDITY_YEARS=1` 时，目标年（2029/2033/2037/2038/2039…）非闰年 → `(非闰年, 2, 29)` 不存在 → panic。
- **影响**：
  - **根 CA**：`generate_root_certificate` 命令在 2 月 29 日 panic，当天无法创建 CA。
  - **叶子证书（更严重）**：`sign_host_certificate_from_data` 由 `DynamicCertResolver::resolve`（`resolver.rs:88`）在 rustls I/O 线程**同步**调用，期间无 `catch_unwind`。2 月 29 日对任何冷主机名的 MITM 握手都会 panic，冷缓存突发即 panic 风暴。`TlsManagerError` / `?` 传播救不了——panic 在 `Err` 构造之前发生。
- **修复方向**：用真实日期算术（`not_before + Duration::days(365*N)` 并钳制非法日），或最简：`month==2 && day==29` 时退到 28。三处调用点都要改。补一个 mock `now`=Feb 29 的单测断言不 panic。
- **状态：已修复 @ batch 6（2026-07-11）** — 新增 `not_after_ymd(years)` 辅助（仿既有 `leaf_not_before_ymd` 的 chrono 模式），当目标年非闰年时把 Feb 29 钳为 Feb 28（`is_leap_year` 用格里高利规则）；替换根 CA / `sign_host_certificate` / `sign_host_certificate_from_data` 三处 `not_after` 的 `date_time_ymd` 调用。测试：`h1_not_after_ymd_clamps_feb_29_on_non_leap_target`、`h1_is_leap_year_gregorian_rule`、`h1_root_ca_generate_not_after_is_valid_date`。

### H2 ✅ 根私钥以进程 umask 创建（常 0644 全局可读），chmod 0600 在写之后才执行（暴露窗口 + 非原子写） `[来源:D]`
- **位置**：`crates/tls-manager/src/storage.rs:184-191`
- **类别**：安全 / 密钥泄露
- **证据**：
  ```rust
  std::fs::write(&self.root_key_path, key_pem)   // 按 umask 创建，Linux 桌面常 0022 → 0644
      .map_err(...)?;
  // 之后才：
  self.ensure_secure_permissions()?;              // chmod 0600
  ```
  `std::fs::write` 经 `OpenOptions::create+truncate`，遵从进程 umask。典型 Linux 桌面 umask 0022 → 文件以 0644 落地（group/other 可读），直到微秒后 `set_permissions(0600)` 才收紧。
- **影响**：
  1. **CA 旋转**时证书目录已存在，写与新 key 之间有真实暴露窗口。
  2. 若进程在 `write` 与 `set_permissions` 之间被 kill（SIGKILL/OOM/崩溃），私钥**永久**全局可读。Round 4 A8 去掉了 `panic=abort`，但外部 kill/OOM 仍可能。
  3. 非原子写——崩溃中途留半写/空 PEM。这是 MITM 根 CA 私钥，系统里最高价值的密钥。
- **修复方向**：Unix 下用 `OpenOptionsExt::mode(0o600)` 一开始就受限创建，或写临时文件（0600）后 `rename`（原子+受限）。
- **状态：已修复 @ batch 6（2026-07-11）** — 新增 `write_secret_file` 辅助（unix `OpenOptionsExt::mode(0o600)` 预设创建 + 写入；非 unix 回退 `std::fs::write`），替换 `save_root_cert` 中的根私钥 `std::fs::write`；`ensure_secure_permissions` 保留作纵深防御。测试：`h2_root_key_created_with_owner_only_permissions`、`h2_write_secret_file_creates_0600`（均 `#[cfg(unix)]`）。

### H3 ✅ `read_har_file` 仅校验 `.har` 后缀即 `read_to_string` 任意路径——与已修 H10 同类，但漏修 `[来源:T]`
- **位置**：`apps/desktop/src-tauri/src/commands/files.rs:72-86`
- **类别**：安全 / 路径穿越 / 渲染进程信任边界
- **证据**：
  ```rust
  pub fn read_har_file(input: ReadHarFileInput) -> Result<String, String> {
      let path = Path::new(&input.path);
      let extension = path.extension().map(|ext| ext.to_ascii_lowercase())...;
      if extension != "har" { return Err(...); }
      std::fs::read_to_string(path).map_err(...)
  }
  ```
  渲染进程提供原始 `path`，唯一校验是 `.har` 后缀。被入侵/XSS 的渲染进程可：读任意以 `.har` 结尾的文件；建软链 `secrets.har` 读任意可读文件（`read_to_string` 解析软链，无 canonicalize、无根约束）。Round 4 H10（`read_script_source_file`）正是同类，已用 `pick_and_read_script_file`（OS 选择器）修复——`read_har_file` 在那次清扫中被遗漏。
- **影响**：在 Tauri IPC 桥上暴露任意文件读原语（限于 `.har` 后缀名/软链）。
- **修复方向**：套用 H10 修复模式——OS 文件对话框让操作者选择路径，或 canonicalize 后 `starts_with` 限定导出/工作区根；复用同文件 `reject_unsafe_write_path` / `validate_export_basename` 模式。
- **状态：已修复 @ batch 6（2026-07-11）** — 新增 `pick_and_read_har_file`（后端经 `tauri-plugin-dialog` 驱动 OS 选择器 → `canonicalize` 解软链 → `is_har_extension` 校验 → `run_blocking_command` 读字节 + 64MiB 上限），渲染端只发标题；删旧 `read_har_file(path)`。`main.rs` 注册改 `pick_and_read_har_file`；前端 `files.ts` 改 `pickAndReadHarFile(title)` 返回 `{fileName,contents}|null`；`use-session-import-export.ts` 改调新命令（去掉前端 `open()` + `readHarFile`）。测试：`h3_is_har_extension_classifies_case_insensitively`、`h3_err_invalid_har_returns_structured_invalid_input_error`。

### H4 ✅ `start_proxy_impl` 在代理已监听、状态已置 Running、系统代理已变更之后才 `?` 返回 Err——孤立监听器残留 `[来源:T]`
- **位置**：`apps/desktop/src-tauri/src/commands/proxy.rs:297-329`
- **类别**：状态同步 / 部分失败
- **证据**：顺序为：`state.set_runtime(...)`（:297，注册运行时句柄）→ `state.start_proxy(...)`（:302，状态置 Running）→ 若 `system_proxy_enabled` 则 `apply_system_proxy_settings(...)`（:329）。若该 `apply` 失败（networksetup 非零、注册表 ACL 拒绝、gsettings schema 缺失），`?` 把 Err 透传给渲染进程。此时：代理服务器已绑定监听；`RuntimeHandles` 已注册为活动运行时；内存状态已是 Running。
- **影响**：UI 显示"启动失败"，用户以为代理已关——但代理实际在跑，系统代理可能已半应用态。渲染进程收到 Err 没有句柄可调 `stop_proxy`，孤立服务器一直监听到进程退出。
- **修复方向**：解耦 reapply 结果与启动结果——reapply 失败视为非致命警告（记日志 + emit 前端事件让 UI 显示 banner，但返回 `Ok(status)`）；或若必须中止，把 reapply 放在 `set_runtime`/`start_proxy` **之前**，失败时丢弃 `started_proxy_server`。

### H5 ✅ `delete_sessions_by_ids` 手删全部子表，与 `clear_all_sessions`（纯 CASCADE）策略相反——新子表必孤立 `[来源:D]`
- **位置**：`crates/db/src/sessions.rs:305-393`（手删 `script_run_entries/script_runs/rewrite_run_entries/rewrite_runs/map_runs/throttle_runs/ws_messages/session_details` 后删 `session_summaries`）vs `clear_all_sessions:396-412`（仅 `DELETE FROM session_summaries`，靠 `ON DELETE CASCADE`）
- **类别**：Schema 正确性 / 孤儿数据 / 维护陷阱
- **证据**：`clear_all_sessions` 的注释明确指出其前身"手写 child→parent DELETE 列表复制了级联图，新增子表会静默孤立"，故已改为纯 CASCADE。但 `delete_sessions_by_ids` 仍保留 8 条手删语句。在 `foreign_keys=ON` 且所有子表 FK 均 `ON DELETE CASCADE` 下，这些手删（a）完全冗余；（b）是 L9 刚移除的同款维护陷阱——下一个新增子表（如未来 `http2_frames`）会被 `delete_sessions_by_ids` 孤立，却被 `clear_all_sessions` 正确级联。
- **影响**：（1）性能：删 500 会话 = 9 语句 × 批次；（2）孤儿数据随新子表累积；（3）两条路径策略相反是经典漂移 bug 源。
- **修复方向**：把 `delete_sessions_by_ids` 折叠为每批单条 `DELETE FROM session_summaries WHERE id IN (...)`（与 `clear_all_sessions` 一致），删掉 8 条手删。
- **状态：已修复 @ batch 7（2026-07-11）** — 删掉 8 条手删子表语句（script_run_entries/script_runs/rewrite_run_entries/rewrite_runs/map_runs/throttle_runs/ws_messages/session_details），仅保留批量化 `DELETE FROM session_summaries WHERE id IN (...)` 循环（保留 `DELETE_SESSIONS_BATCH_SIZE=500` 分批），与 `clear_all_sessions` 纯 CASCADE 策略一致。测试：`h5_delete_sessions_by_ids_cascades_child_tables`（建 session + ws message + detail，删除后断言子表全空）。

### H6 ✅ `upsert_session` 不校验 `detail.session_summary_id == summary.id`——summary/detail 可静默交叉链接 `[来源:D]`
- **位置**：`crates/db/src/sessions.rs:60-201`
- **类别**：引用完整性 / 部分更新一致性
- **证据**：函数取 `&SessionSummaryRow` 与 `&SessionDetailRow` 为**独立**参数，一个事务内分别 UPDATE-or-INSERT，但从不断言 `detail.session_summary_id == summary.id`。`session_details.session_summary_id` 是指向 `session_summaries(id)` 的 FK（`schema.rs:155`），UPDATE 分支（`:134-163`）以 `detail.id` 的 `WHERE id=?1` 定位。若调用方传入 `session_summary_id` 错配的 detail（未来批量导入/会话复制场景），会静默把 detail 重链到另一个 summary。`load_session_detail`（`:261`）按 `session_summary_id` 查，交叉链接的 detail 会在错误的会话下显示且无错误。
- **影响**：当前唯一调用方传一致 id，故为潜在一致性洞；但 DB 层零校验，任何未来调用方（批量导入、fork session）都会静默错链。
- **修复方向**：在函数内从 `summary.id` 派生 `detail.id` 与 `detail.session_summary_id`（单一真源），或断言相等并返回 `DbError::Validation`。
- **状态：已修复 @ batch 7（2026-07-11）** — `upsert_session` 事务开头断言 `detail.session_summary_id == summary.id`，否则 `Err(DbError::Validation(...))`；不强制 `detail.id == summary.id`（detail 有独立 PK，测试用 `{summary_id}-detail` 约定）。测试：`h6_upsert_session_rejects_mismatched_session_summary_id`、`h6_upsert_session_accepts_detail_with_independent_id`。

### H7 ✅ `runtime_join_failure_trace` 在固定字节偏移切 String，多字节 UTF-8 越界即 panic `[来源:R]`
- **位置**：`crates/proxy-core/src/rules/script.rs:240-244`
- **类别**：panic / 热路径健壮性
- **证据**：
  ```rust
  let message = format!("script hook dropped by runtime: {join_error}");
  let message = if message.len() > MAX_MSG_BYTES {
      message[..MAX_MSG_BYTES].to_string()   // 原始字节切片，无 char 边界检查
  } else { message };
  ```
  `message[..MAX_MSG_BYTES]`（`MAX_MSG_BYTES=4*1024`）对 Rust `String` 按原始字节下标。若该偏移落在多字节 UTF-8 码点中间，索引 **panic**（"byte index is not a char boundary"）。`join_error` 是 `tokio::task::JoinError` 的 Display，其内容是 spawn 任务的 panic payload，可含任意 Unicode（如 `panic!("复杂错误")`）。同仓已有正确助手 `trim_to_byte_limit`（`rule-engine/src/execute.rs:424`，遍历 `chars()` 检查 `len_utf8()`）。
- **影响**：spawn_blocking 任务的 JoinError Display payload 含多字节字符且编码跨越字节 4096 时，在 async 代理任务内 panic（H6 的 spawn_blocking 包装下，panic 发生在 `.await` 续体，中止该请求）。概率低但对特定输入确定触发。
- **修复方向**：复用 `trim_to_byte_limit`（提升为 `pub(crate)` 或复制 char 遍历逻辑）。
- **状态：已修复 @ batch 6（2026-07-11）** — 把 rule-engine 的 `trim_to_byte_limit` 提为 `pub`、`MAX_LOG_ENTRY_BYTES` 提为 `pub`，经 `lib.rs` re-export；`script.rs::runtime_join_failure_trace` 改调 `aiproxy_rule_engine::trim_to_byte_limit(&message, MAX_LOG_ENTRY_BYTES)` 替换会 panic 的 `message[..MAX_MSG_BYTES]`，并删本地 `MAX_MSG_BYTES`（消除 4KB vs 8KB 漂移）。测试：`h7_trim_to_byte_limit_handles_multibyte_at_boundary`（"字"×10000 截到 100 字节断言不 panic 且 char 边界完整）、`h7_trim_to_byte_limit_returns_short_strings_verbatim`。

### H8 ✅ `commands/proxy.rs` WS 收集分支每条消息 `spawn_blocking(...).await` 串行化——高吞吐 WS 下接收循环背压 `[来源:T]`
- **位置**：`apps/desktop/src-tauri/src/commands/proxy.rs:241-274`
- **类别**：背压 / 异步并发
- **证据**：`select!` 的 WS 分支内 `spawn_blocking(move || insert_ws_message(...)).await` 被直接 await，循环无法在 DB 插入完成前 `recv()` 下一条消息。会话分支批处理（最多 `SESSION_BATCH_SIZE`），WS 分支严格逐条。DB 插入还要竞争全局唯一 `Connection` mutex（Round 4 A4）。
- **影响**：高频 WS 流（用户正在调试的 chatty WS）下，mpsc 接收端因插入串行而积压；若 channel 满则把背压传回代理 WS relay 路径，增加 UI 消息延迟。
- **修复方向**：解耦接收与持久化——spawn 插入但不 await（跟踪 JoinHandle），或推内部 channel 由专用 WS 持久化任务批量插入（镜像会话分支）；receive 后立即 emit 前端，不等待持久化。

---

## 5. 🟡 中危（20 项）

### M1 ✅ Map-Local 文件解析存在 TOCTOU 且透明跟随软链、target_value 无路径约束 `[来源:R]`
- **位置**：`crates/proxy-core/src/rules/map.rs:97-135`
- **类别**：路径安全 / TOCTOU
- **证据**：`target_value`（用户规则字符串）直接作文件系统路径，无 `canonicalize`、无根约束。`is_file()`（:103 stat）→ `fs::read`（:104，TOCTOU）；目录分支把请求 path 追加后 `is_file()`（:124）→ `read`（:125，TOCTOU）。`sanitize_request_path`（:29-41）只清洗请求 URL 的 `.`/`..`，不约束 `target_value` 本身；目录内软链被 `fs::read` 跟随。对比 H10 修复（`pick_and_read_script_file`）做了 canonicalize + 限定，map-local 一无所有。
- **影响**：误配/恶意 map-local 规则可把磁盘任意文件服务给任何被代理客户端；目录服务下软链逃逸未防。
- **修复方向**：canonicalize 解析路径并验证 `starts_with` 配置根；决定并文档化软链跟随策略；对齐 `files.rs::reject_unsafe_write_path`。

### M2 ✅ Map-Local 命中即向客户端泄露任意可达文件（target_value 无任何约束的具体化） `[来源:R]`
- **位置**：`crates/proxy-core/src/rules/map.rs:97-135`（与 M1 同位但聚焦泄露面）
- **类别**：安全 / 信息泄露
- **证据**：规则 `target_value = "C:\Windows\System32\drivers\etc\hosts"` 或 `/etc/passwd` 会被原样 `fs::read`。对调试工具（规则用户作者）属较低危，但路径零约束 + 软链逃逸并存。
- **影响**：被代理的任何客户端可经 map-local 规则读到磁盘任意可达文件。
- **修复方向**：同 M1；至少要求 target_value 在配置根下。

### M3 ✅ 响应 body rewrite 即使未实际改写也无条件 `strip_plain_body_edit_headers`（剥 content-encoding/etag） `[来源:R]`
- **位置**：`crates/proxy-core/src/rules/rewrite.rs:608-611`
- **类别**：改写正确性 / 一致性
- **证据**：`apply_one_response_rule` 的 `"body"` 分支总是执行 `response_headers.insert(CONTENT_TYPE, ...)` + `strip_plain_body_edit_headers(...)`，**不论** body 是否被 `fields` 改写或 `text` 等于现有 body。对比脚本路径（`js_bridge.rs:266-283`）用 `requestChanged`/`responseChanged` JSON diff 仅在真正变更时剥头。rewrite 路径无此守卫——仅**匹配**一条 body-rewrite 规则（即便所有字段操作都是 no-op）就剥 `content-encoding`/`etag`/`content-md5`/`digest`。
- **影响**：匹配但未改写 body 的规则仍剥响应 `content-encoding`/`etag`，对校验这些头的客户端损坏完整性。脚本路径已专门硬化（`no_op_script_reports_no_request_or_response_mutation`），rewrite 路径未跟进。
- **修复方向**：改写前快照 body 字节；若操作后未变则跳过剥头。

### M4 ✅ Throttle URL 匹配用 OR 匹配 url **或** host，宽 `url_pattern` 误伤远超预期主机 `[来源:R]`
- **位置**：`crates/proxy-core/src/rules/mod.rs:222-225`
- **类别**：Throttle 匹配正确性
- **证据**：
  ```rust
  .filter(|rule| {
      pattern_matches(&rule.url_pattern, request.url.as_str(), None)
          || pattern_matches(&rule.url_pattern, &request.host, None)
  })
  ```
  `pattern_matches(..., None)` 默认 **"contains"**。OR 使 `url_pattern="api"` 匹配任何 host 含 "api" 的请求（`api.foo.com`、`foo-api.com`、`capiche.io`）。rewrite/script 匹配（`mod.rs:96-101/158-163`）仅匹配 URL 不匹配 host，throttle 不一致且更宽。
- **影响**：Throttle 规则静默应用到非预期流量；调试工具里延迟/丢包 profile 锁错请求难以归因。
- **修复方向**：仅匹配 URL（与 rewrite/script 一致），文档化 host pattern 应写 `host.com`；或 pattern 无 `/` 时才退回 host 匹配。

### M5 🔶 响应阶段 throttle 在 body 全量缓冲**之后**才应用 latency/transfer，语义不对称 `[来源:R]`
- **位置**：`crates/proxy-core/src/rules/throttle.rs:92-144` vs `:46-90`；消费点 `http_proxy.rs:996`
- **类别**：Throttle 正确性 / 可观测性
- **证据**：`apply_request_throttle` 在请求体转发上游前 sleep（正确建模 client→upstream RTT）。但 `apply_response_throttle` 在 `upstream_response` 已全量读入内存/spool **之后**调用——`latency_ms` sleep 延迟的是缓冲 body 开始发往客户端的时刻（客户端观察的 TTFB），而非上游 RTT。`download_delay_ms` 也在同一点应用，二者叠加阻塞同一点，trace 却分列 `latency_ms`/`transfer_delay_ms` 暗示两个阶段。`download_kbps=256` 对 50MB 响应 sleep 满 60s 期间客户端收不到一个字节，之后一次性吐出。
- **影响**：`latency_ms` 模拟上游响应延迟的预期与 `download_kbps` 无法区分；大/流式 body 的真实带宽节流缺失。
- **修复方向**：在客户端回写期间逐块节流 `download_kbps`；或至少文档化响应 throttle 仅 TTFB。

### M6 🔶 `transfer_delay_ms` u128→u64 截断静默 wrap（极端 body），测试给假信心 `[来源:R]`
- **位置**：`crates/proxy-core/src/rules/throttle.rs:41-43`
- **类别**：整数溢出 / 正确性
- **证据**：`millis = bits*1000/bps` 为 u128，`millis as u64` 截断。`byte_count=usize::MAX`、`kbps=1` 时 `millis≈1.44e20 > u64::MAX(1.84e19)`，`as u64` 静默 wrap 成垃圾（可能很小）。测试 `transfer_delay_handles_huge_body_without_overflow`（:191-193）只断言 `>0`，wrap 成小值也通过。
- **影响**：真实 body 大小不可达（最大捕获/spool 20MiB），实际潜伏；但截断静默且测试假保证。
- **修复方向**：`u64::try_from(millis).unwrap_or(u64::MAX)` 饱和；测试断言 sane 下界。

### M7 ✅ `ai_settings.temperature`/`timeout_ms` 无 CHECK/范围校验（DB 层无防御，正常 IPC 路径已 clamp） `[来源:D]`
- **位置**：`crates/db/src/ai.rs:33-52`、`crates/db/src/schema.rs:353-362`；正常 IPC 路径已 clamp：`apps/desktop/src-tauri/src/commands/ai.rs:127-128`（`temperature.clamp(0.0, 2.0)`、`timeout_ms.clamp(5_000, 300_000)`）、`:245`（reqwest `.timeout(...)` 显式生效）
- **类别**：输入校验缺失 / 静默坏数据（仅 DB 层）
- **证据**：`ai_settings.temperature REAL NOT NULL DEFAULT 0.2`、`timeout_ms INTEGER NOT NULL DEFAULT 30000` 接受任意值，DB 层无 CHECK。`upsert_ai_settings` 绑定 `settings.temperature`（f64）与 `timeout_ms as i64` 无界检查。**说明（v1.1 修正）**：当前唯一调用方 `save_ai_settings` 命令已在 IPC 边界 clamp（`commands/ai.rs:127-128`），且 reqwest client 显式设 `.timeout(Duration::from_millis(settings.timeout_ms))`（`:245`），故**正常路径不会**出现"负 timeout→0→无超时→无限挂"。残留风险仅在于 DB 层零防御——任何**绕过命令层**直接调 `upsert_ai_settings` 的未来调用方（批量导入、迁移脚本、测试夹具）可写入越界值，而读路径 `timeout_ms.max(0) as u64`（`ai.rs:63`）会把负值变成 0。
- **影响**：DB 层无 CHECK 是真实缺口，但"无限挂"在正常 IPC 路径不可达；需绕过命令层 clamp 才触发。降级为"DB 防御缺失"而非"用户可触发挂起"。
- **修复方向**：schema 加 `CHECK(temperature BETWEEN 0.0 AND 2.0)` 与 `CHECK(timeout_ms BETWEEN 5000 AND 300000)`（与命令层 clamp 对齐），作为存储层最后防线；`upsert_ai_settings` 绑定前亦校验。

### M8 ✅ `compute_insights` 每次 8 次全表扫 + 重复取 (host,duration) + 未索引 group-by `[来源:D]`
- **位置**：`crates/db/src/insights.rs:168-437`
- **类别**：性能 / 无界查询成本
- **证据**：依次执行 overview COUNT/SUM/AVG（:181）、全局百分位 `SELECT duration_ms ORDER BY`（:214）、by_host GROUP BY（:236）、**又一次全表 `SELECT LOWER(host), duration_ms`**（:273，与步骤2同数据再取一遍）、by_status_code（:322）、by_method（:345）、slow_requests（:369）、largest_requests（:396）。200k 会话即 8 趟全表。by_status_code/by_method 的 group-by 无覆盖索引。M11 加的 `(host,duration_ms)` 复合索引仅惠及按 host 过滤的步骤。步骤4 是步骤2 数据的重复取。
- **影响**：长跑代理（M11 自述目标场景）的 Insights 刷新做 8 次全表扫 + 2 次内存排序，在全局 DB mutex 下（M15）阻塞所有其他 IPC 数秒。
- **修复方向**：(a) 步骤2 一次取 `host, duration_ms` 在 Rust 分桶，消除步骤4 并复用排序；(b) 考虑物化视图/预聚合；(c) 文档化 8 查询成本。

### M9 ✅ `update_workspace` 漏 `system_proxy_enabled`——跨重启状态失步（安全敏感设置回退） `[来源:D]`
- **位置**：`crates/db/src/workspaces.rs:91-127`；运行时 `proxy.rs:474/529`；启动读 `main.rs:134`
- **类别**：部分更新一致性 / 跨重启失步
- **证据**：`update_workspace` 入参与 UPDATE SET 都**不含** `system_proxy_enabled`。该列真实存在（`schema.rs:11`），被 `row_to_workspace`（:188）读回，运行时由 `proxy.rs:474/529` 的 `set_system_proxy_enabled(true/false)` 切换——但只更新内存 `BootstrapStatus`，**从不**写回 `workspaces` 行。IPC `UpdateWorkspaceInput`（`commands/workspaces.rs:121-145`）也无该字段。重启时 `main.rs:134` 从 DB 读 `ws.system_proxy_enabled`（seed/create 时值），toggle 回退。
- **影响**：启用系统代理→退出→重启，工作区显示系统代理为关（内存状态经 `system_proxy_recovery.rs` 另行恢复，但持久化行陈旧）。用户可见、安全敏感设置的真实跨重启失步。导出/导入工作区快照也捕获陈旧值。
- **修复方向**：两步缺一不可——(1) `update_workspace` 与 `UpdateWorkspaceInput` 加 `system_proxy_enabled: Option<bool>` 并入 UPDATE SET（提供持久化能力）；(2) **在两个实际 toggle 路径调用它**：`enable_system_proxy_impl`（`proxy.rs:474` `state.set_system_proxy_enabled(true)`）与 `disable_system_proxy_impl`（`:529` `state.set_system_proxy_enabled(false)`）在更新内存态后，同步把对应 `workspace_id` 的 `system_proxy_enabled` 写回 DB。仅做 (1) 不接 (2) 只增加能力但不改变现状。或者，若该字段有意仅运行时，则从 `WorkspaceRow`/`row_to_workspace`/`main.rs:134` 读路径移除该列，停止广告一个从不持久化的字段（消除"重启回退"的误导）。
- **状态：已修复 @ batch 8（2026-07-11）** — 采用专用 helper（避免改宽 `update_workspace` 签名）：`workspaces::set_workspace_system_proxy_enabled(conn, id, enabled)` 单列 UPDATE。在两个 toggle 路径接入：`enable_system_proxy_impl` 与 `disable_system_proxy_impl` 在内存态切换后用 `run_blocking_command` + `lock_db_for_ipc` 写回 DB（best-effort，持久化失败只 warn 不撤销已完成的 apply/restore）。`workspace_id` 取自 `status.active_workspace_id`（enable 路径已有 :424；disable 路径新增读取）。测试：`m9_set_workspace_system_proxy_enabled_round_trips`。

### M10 ✅ `throttle_runs.profile_id`/`rule_id` 无 FK——删 profile/rule 留孤儿 trace 永不清理 `[来源:D]`
- **位置**：`crates/db/src/schema.rs:81-99`、`crates/db/src/rules.rs:525-545`（`delete_throttle_profile`）、`:582-586`（`delete_throttle_rule`）
- **类别**：FK 约束缺失 / 孤儿数据
- **证据**：`throttle_runs` 仅声明 `FOREIGN KEY (session_id) ... ON DELETE CASCADE`（`schema.rs:98`），`profile_id`/`rule_id` 无 FK。对比 `script_runs`/`rewrite_runs`/`map_runs` 均有 `FOREIGN KEY (rule_id) ... ON DELETE CASCADE`。`delete_throttle_profile`（:535-539）只清 `throttle_rules` 不清 `throttle_runs`；`delete_throttle_rule` 是裸 `DELETE FROM throttle_rules`。`load_throttled_session_ids`（:727-746）只按 `workspace_id` 过滤，孤儿仍浮现指向已删 profile。
- **影响**：删 throttle profile 留孤儿 `throttle_runs`（profile 已删但 `profile_id` 仍指死 id，`profile_name` 去规范化故 UI 仍显示名）。随删/建循环累积死 trace。
- **修复方向**：加 `FOREIGN KEY (profile_id) ... ON DELETE SET NULL`（profile_id 需可空）+ `FOREIGN KEY (rule_id) ... ON DELETE SET NULL`；删除时清/置空引用。
- **状态：已修复 @ batch 7（2026-07-11）** — 应用层引用清理（避免表重建，profile_id NOT NULL 无法改 SET NULL）。`delete_throttle_profile` 在删 `throttle_rules` 前加 `UPDATE throttle_runs SET rule_id = NULL WHERE rule_id IN (SELECT id FROM throttle_rules WHERE profile_id = ?1)`；`delete_throttle_rule` 加 `UPDATE throttle_runs SET rule_id = NULL WHERE rule_id = ?1`（均在事务内）。profile_id 保留（profile_name 去规范化快照使运行历史仍有意义）。测试：`m10_delete_throttle_profile_nulls_orphan_run_rule_ids`、`m10_delete_throttle_rule_nulls_orphan_run_rule_id`。

### M11 ✅ 环境变量/全局变量无 UNIQUE 约束——重复 key 静默共存，解析非确定取一 `[来源:D]`
- **位置**：`crates/db/src/schema.rs:333-351`、`crates/db/src/environments.rs:110-129`（`upsert_environment_variable`）、`:183-192`（`upsert_global_variable`）
- **类别**：缺失 UNIQUE 约束 / 重复 key 数据分叉
- **证据**：`api_environment_variables` 的 `(environment_id, key)` 与 `api_global_variables` 的 `(key)` 仅非唯一索引。两个 upsert 用 `INSERT OR REPLACE` 按**行 id**（UUID）定位，非自然键。两条同 key 不同 id 的行共存。消费者返回两者，变量替换线性/首匹配非确定取一。批量 `set_*_variables`（DELETE-then-INSERT）避免，但单项 upsert 路径不避免。
- **影响**：UI bug 或导入造同 key（新 UUID）重复行；变量解析任意取一，用户"我设了 token 却解析到旧值"。非唯一索引掩盖问题（无约束错误）。
- **修复方向**：加 `CREATE UNIQUE INDEX ... ON api_environment_variables(environment_id, key)` 与 `... ON api_global_variables(key)`；或 INSERT OR REPLACE 按自然键。
- **状态：已修复 @ batch 7（2026-07-11）** — 镜像 M30 两步：(1) `run_migrations` 加 `collapse_duplicate_env_variables`（按 `(environment_id, key)` 保留 min(id)）+ `collapse_duplicate_global_variables`（按 `key` 保留 min(id)）去重存量；(2) `CREATE UNIQUE INDEX idx_api_env_vars_env_key ON api_environment_variables(environment_id, key)` + `idx_api_global_vars_unique_key ON api_global_variables(key)`；(3) 两个 upsert 从 id 键控 `INSERT OR REPLACE` 改为自然键 `ON CONFLICT(...) DO UPDATE SET ...`，否则新索引会破坏现有保存路径。测试：`m11_upsert_env_var_on_conflict_updates_existing_key`、`m11_env_var_unique_index_rejects_duplicate_key`、`m11_upsert_global_var_on_conflict_updates_existing_key`、`m11_global_var_unique_index_rejects_duplicate_key`。

### M12 ✅ macOS `is_trusted_macos` 把任何 `verify-cert` 成功当"已信任"，含"结构有效但未装信任域" `[来源:D]`
- **位置**：`crates/tls-manager/src/trust.rs:146-160`
- **类别**：信任检测正确性
- **证据**：
  ```rust
  let output = Command::new("/usr/bin/security")
      .args(["verify-cert", "-c"]).arg(cert_path).output()?;
  output.status.success()
  ```
  `security verify-cert -c <cert>` 无 `-r`/`-p` 时用默认策略，退出码粗粒度：某些 macOS 版本下结构有效但不在信任域的证书仍返回 0。UI 依赖此指示判断 OS 是否接受 MITM 证书。
- **影响**：Settings 页可能对"结构有效但未装信任域"报"已信任"（绿），客户端仍拒。误报是最坏方向（用户以为受保护）。
- **修复方向**：显式查信任设置——`security verify-cert -c <cert> -p ssl -r trustAsRoot`（或 `-r root`），或查 `security find-certificate`/`dump-trust`；注释文档化所选语义。

### M13 ✅ `save_root_cert` 用截断-写非原子（L8 的 write_atomic 模式未应用） `[来源:D]`
- **位置**：`crates/tls-manager/src/storage.rs:176-185`
- **类别**：健壮性 / 数据完整性
- **证据**：三条顺序 `std::fs::write`（cert、install-copy、key），各为截断-写。Round 4 L8 已为 `system_proxy_recovery.rs` 改 `write_atomic`，但 `CertStorage::save_root_cert` 未转。
- **影响**：崩溃/掉电在三次写之间留不一致（新 cert PEM 配空 key PEM；或 install-copy 写了 key 没写）。下次启动 `root_cert_exists()`（只查存在）返 true 但 key 不可解析，`load_from_pem` 隐晦失败。旋转被打断还可能 cert/key 来自不同代。
- **修复方向**：三次写均用 `write_atomic`（同目录临时文件 + fsync + rename）；先写 key 后写 cert 使"cert 存在⇒key 有效"不变式成立，或单代原子写 + marker 门控 `root_cert_exists`。
- **状态：已修复 @ batch 8（2026-07-11）** — 新增 `write_file_atomic(path, contents, secret)`（同目录临时文件 + unix `OpenOptionsExt::mode(0o600)` for secret + `sync_all` + `rename`，失败清 temp）；替换 `save_root_cert` 三条 `std::fs::write`（key 先、cert/install-copy 后）；H2 的 `write_secret_file` 合并为 `write_file_atomic(_, _, true)` 的薄封装后移除（dead code）。测试：`m13_save_root_cert_leaves_no_temp_files`。

### M14 🔶 `root_cert_exists` 只查存在不查有效性/配对 `[来源:D]`
- **位置**：`crates/tls-manager/src/storage.rs:95-97`
- **类别**：健壮性
- **证据**：`self.root_cert_path.exists() && self.root_key_path.exists()`。配合 M13（非原子写），被打断的旋转留零字节/部分文件"存在"但不可解析。该函数是 bootstrap 决定 generate-vs-load 的门控。
- **影响**：被打断旋转后，app 信 CA 存在并尝试 load，`load_from_pem` 失败，启动报错（而非干净重建）。
- **修复方向**：`root_cert_exists` 做廉价解析（或至少非空+有效 PEM fence），不可解析视为"不存在"走生成路径。
- **状态：已修复 @ batch 8（2026-07-11）** — `root_cert_exists` 从"只查 `exists()`"升级为读两文件 + 断言非空 + 含 `BEGIN CERTIFICATE`/`PRIVATE KEY` PEM fence；任一失败返 false（走 bootstrap 重建）。不做完整 `load_from_pem`（会重签，L7，过重）。测试：`m14_root_cert_exists_false_for_empty_files`、`m14_root_cert_exists_false_for_missing_pem_fence`、`m14_root_cert_exists_true_for_valid_pair`。

### M15 ✅ 同步证书命令在 IPC 线程 spawn 子进程 + 递归走文件系统 `[来源:T]`
- **位置**：`apps/desktop/src-tauri/src/commands/certificates.rs:102`（`get_certificate_status`）、`:117`（`open_certificate_install_guide`）、`:124`（`launch_certificate_installer`）、`:277`（`diagnose_certificate_setup`）
- **类别**：异步阻塞 / IPC 线程
- **证据**：`diagnose_certificate_setup`（:277）是裸 `#[tauri::command]`（非 async、无 `run_blocking_command`），同步在 IPC worker 线程调：`is_cert_trusted_on_platform`（spawn `security find-certificate`/`certutil`）、`resolve_adb_path`（spawn `adb --version`）、`resolve_hdc_path`（spawn `hdc -v` + 递归 FS 走查找二进制）、`ios_simctl_available`（spawn `xcrun simctl list`）。`get_certificate_status`/`open_certificate_install_guide`/`launch_certificate_installer` 各先调 `get_certificate_status_impl`（读 PEM + spawn 信任检测）。
- **影响**：每个阻塞 IPC worker 数十至数百 ms/子进程启动 + hdc 递归 FS 走。H11 已为系统代理修此模式，M14/M15 已为 DB 命令修，证书命令被两轮清扫漏。Certificates 页轮询信任状态可拖累 IPC 池。
- **修复方向**：转 async + `run_blocking_command("diagnose_certificate_setup", move || {...}).await`（DB 命令已用）；体已同步可调，机械包装。

### M16 ✅ `get_session_detail_content` 在 IPC 线程 base64 编码大 body（CPU 密集） `[来源:T]`
- **位置**：`apps/desktop/src-tauri/src/commands/sessions.rs:190-211`（`build_session_detail_content_patch` 调 `body.base64_text()`，~`:492-511`）
- **类别**：异步阻塞 / IPC 线程 CPU 密集
- **证据**：`get_session_detail_content` 是同步 `#[tauri::command]`，调 `build_session_detail_content_patch` 对请求/响应 body 调 `body.base64_text()`。body 可达 `BODY_FILE_THRESHOLD`+；溢出 body 从盘读回 + base64。多 MB body 的 base64 展开（~1.33x）在 IPC worker 同步跑。
- **影响**：UI 选大 session 卡住 IPC worker 整个编码时长，延迟其他命令。最坏是 spool 阈值下的大 inline body。
- **修复方向**：命令转 async，body 读 + base64 进 `spawn_blocking`；或专用 `get_session_body` 流式命令让渲染端增量解码。

### M17 ✅ `session_stats::record` 在调用方线程（含 IPC worker）同步文件 append `[来源:T]`
- **位置**：`apps/desktop/src-tauri/src/session_stats.rs:73-110`
- **类别**：异步阻塞 / 资源
- **证据**：`record` 内联调自同步 IPC handler（`get_session_detail_content`→`log_session_detail_content_stats`→`record`；`get_session_detail`→`log_session_detail_serialization_stats`→`record`）。每次 `create_dir_all`（每次 stat/mkdir）+ `OpenOptions.open`（每次同步 open）+ `writeln`（同步写，无 fsync 规避）。`WRITE_LOCK` 全局 `Mutex`，并发调用方（WS collector 线程 + IPC worker）逐 append 串行。
- **影响**：stats 开启（debug 默认、release env 可选）时每次 session-detail IPC 做一次无缓冲 open+append；无 channel/buffer。
- **修复方向**：stats 行推 `mpsc` 由单写任务 drain（开文件一次 + 批写 + 周期 flush）；至少把 `create_dir_all` 提到 `initialize` 一次性，文件句柄存 `OnceLock<File>`。

### M18 ✅ JSON 树列拖拽：window pointer 监听在拖拽中卸载泄漏（M21 模式，6 处之一） `[来源:F]`
- **位置**：`apps/desktop/src/features/sessions/components/SessionInspectorJsonTree.tsx:325-339`
- **类别**：内存泄漏（Round 4 M21 模式，该文件未修）
- **证据**：`startColumnResize` 挂 3 个 window 监听（:337-339），未存清理到 ref。卸载 effect（:117-123）只 `cancelAnimationFrame`。`stopResize`（:329-335）是唯一移除路径，仅在 pointerup/cancel 触发。拖拽中切 inspector tab / session 变化触发 value 重置 effect（:110-115）可重挂虚拟化内容，或导航离开 → 3 监听 + `document.body` cursor/userSelect 样式覆盖泄漏到下次别处 pointerup。
- **影响**：拖列中卸载泄漏 3 window 监听 + body 样式覆盖（重复累积）。Round 4 M21 已修 `BreakpointInterceptPanel.tsx`/`pages/compose/index.tsx`（`resizeCleanupRef`），此处漏。
- **修复方向**：加 `resizeCleanupRef` 存 `stopResize`，卸载 effect 调；`stopResize` 含 `releasePointerCapture`（try/catch）；卸载路径恢复 body cursor/userSelect。

### M19 ✅ `SessionContainerTabs` 滚动条拖拽 window 监听泄漏（M21 模式，更易触发） `[来源:F]`
- **位置**：`apps/desktop/src/features/sessions/components/SessionContainerTabs.tsx:227-236`
- **类别**：内存泄漏（M21 模式）
- **证据**：`startScrollbarDrag`（~:197）挂 3 window 监听（:234-236），`stopDragging`（:227-232）唯一移除，无 `resizeCleanupRef`、无卸载 effect 调 `stopDragging`。
- **影响**：关 container tab 同时拖其滚动条即卸载泄漏（比页面级 M18 更易触发）。泄漏 3 监听 + 闭包引用死 `tabList`/`scrollbarState`。
- **修复方向**：ref 跟踪清理，`useEffect(() => () => cleanupRef.current?.(), [])` 卸载调用。

### M20 ✅ `SessionInspectorAutomationPane` 大量硬编码英文 trace 标签/小节标题（H14 模式） `[来源:F]`
- **位置**：`apps/desktop/src/features/sessions/components/SessionInspectorAutomationPane.tsx:159-160, 337-341, 415-417, 523, 540, 554, 571`
- **类别**：i18n 缺口（Round 4 H14 模式）
- **证据**：组件 import `useI18n` 并对错误/空态用 `t()`（:490/510），但 trace 卡渲染全程硬编码英文：diff 标签 "Before"/"After"（:159-160）、Map 标签 "Original"/"Local Path"/"Mapped URL"（:337-341）、Throttle 指标 "Latency"/"Transfer"/"Body"（:415-417）、小节头 "Throttling"/"Map"/"Rewrite"/"Script"（:523/540/554/571）。`automationTab` i18n 命名空间存在但只含 `emptyDescription`/`loadFailed`，缺 trace 标签/标题。
- **影响**：中文用户看到完全本地化的 inspector 唯独 Automation tab 的 trace 卡是英文（"Before"/"After"/"Throttling"/"Latency" 等），与其余不一致。
- **修复方向**：补 `automationTab.*` 键（throttling/map/rewrite/script/before/after/original/localPath/mappedUrl/latency/transfer/body）到 en.ts/zh-CN.ts，替换字面量。

---

## 6. 🟢 低危（18 项）

### L1 ✅ WS 升级请求转发 `Connection` 头时保留被剥离的兄弟 token（如 `Upgrade, x-foo`） `[来源:N]`
- **位置**：`crates/proxy-core/src/http_io.rs:258-277`（WS 路径 `should_strip_hop_by_hop` 保留整个 `Connection` 值）
- **证据**：WS 升级路径保留 `Connection`/`Upgrade` 握手头值原样转发。若客户端发 `Connection: Upgrade, x-foo` 且 `x-foo` 头被剥（:269-271 排除 `connection`/`upgrade` 后 `x-foo` 在 strip 集内被剥），但 `Connection` 头值仍含 `, x-foo` 转发上游。上游据此期待 `x-foo` 头却收不到。
- **影响**：WS 升级请求向上游广告一个已被剥离的连接级头，严格上游可能困惑。WS 握手本身不受影响（Upgrade 仍在）。
- **修复方向**：转发前从 `Connection` 值移除已剥离的 token，仅保留 `upgrade`。

### L2 ✅ `set_header_entry` 的 `replaced` 标志为死代码（两分支都 `return false`） `[来源:R]`
- **位置**：`crates/proxy-core/src/rules/rewrite.rs:22-42`
- **证据**：`replaced` 在闭包内 set 但闭包外从不读；两分支都 `return false` 移除所有匹配。去重结果正确，但标志误导（似"保留首个"）。
- **修复方向**：删 `replaced` 与内 `if`，保留无条件 `return false`。

### L3 🔶 `normalize_packet_loss_ratio` 边界 `1.0` 反直觉：`1`=100% 丢包但 `5`=5% `[来源:R]`
- **位置**：`crates/proxy-core/src/rules/throttle.rs:14-22`
- **证据**：`<=1.0` 按比例（`0.5`→50%、`1.0`→100%），`>1.0` 按百分比（`5.0`→5%）。UI 字段义"百分比"，用户输 `1` 表"1%"却得 100% 全丢。
- **修复方向**：统一单位（百分比），或 UI tooltip 文档化双模。

### L4 🔶 `detect_entrypoints` 用正则扫源码——注释/模板串内的 `export function onRequest` 误判 `[来源:R]`
- **位置**：`crates/rule-engine/src/compile.rs:60-102`
- **证据**：`ON_REQUEST_RE` 等匹配原始源码文本。注释/模板串里的 `export function onRequest(` 被误判有入口点；转译成功但运行时 `__aiproxyScriptExports.onRequest` 为 undefined → bridge `skipped:true`（`js_bridge.rs:222-234`）静默跳过。
- **修复方向**：从 AST（deno_ast）检测入口；或文档化注释不得含 `export function onRequest/onResponse`。

### L5 ✅ JSONPath 解析拒绝括号字符串键——`$.a["b-c"]` 失败 `[来源:R]`
- **位置**：`crates/proxy-core/src/rules/json_path.rs:44-64`
- **证据**：`[...]` 分支只接数字索引（`usize` 解析）。`$.a["b"]`/`$.a['b-c']` 被拒。点路径键接受任意字符（除 `.`/`[`/`]`），故 `$.a.b-c` 可，但标准 JSONPath 的 `$["a.b"]` 不可。
- **修复方向**：`[...]` 支持单/双引号字符串键；文档化支持语法。

### L6 ✅ `body_preview` 每次 body rewrite 全量 lossy 解码整个 body 仅留 2KiB（热路径分配） `[来源:R]`
- **位置**：`crates/proxy-core/src/rules/rewrite.rs:117-138`（调于 :406/420/589/603）
- **证据**：`String::from_utf8_lossy(bytes)` 对整个 body 建 String/Cow，分支再 `.into_owned()`/切片。每 body 规则调 2 次（before+after），链式循环（`:258`）每规则跑。20MiB JSON body + 多条 body-field 规则 → 每规则 ~40MiB 瞬时分配。
- **修复方向**：仅解码前 `PREVIEW_LIMIT+4` 字节子切片（再对齐 char 边界）。

### L7 🔶 `load_from_pem` 重签 issuer，fingerprint 基于重签 DER 可能与盘上不符 `[来源:D]`
- **位置**：`crates/tls-manager/src/generator.rs:76-95`
- **证据**：`load_from_pem` 用 `params.self_signed(&key_pair)` 重签生成内存 issuer，`fingerprint()`（:82）基于重签 DER。rcgen 0.13.2 的 `from_ca_cert_der` 保 serial/SKI/is_ca，故 serial/SKI 匹配；但重签 DER 编码若与盘上非字节一致（未来 rcgen 改默认编码），UI 指纹与 `trust.rs` Windows thumbprint（独立算盘上 PEM，:315-341）可不一致，信任检查可错配。当前 rcgen 0.13.2 干净往返，故潜伏。
- **修复方向**：fingerprint/cert_der 直接从解析的 PEM 字节算（`x509_parser`），不从重签 `cert.der()`。

### L8 ✅ 叶子证书缺 Authority Key Identifier（RFC 5280 §4.2.1.1） `[来源:D]`
- **位置**：`crates/tls-manager/src/generator.rs:205-230`、`:237-262`
- **证据**：叶子 `CertificateParams` 不设 `use_authority_key_identifier_extension`（rcgen 默认 false）。RFC 5280 §4.2.1.1 要求 CA 签发的证书含 AKI（自签除外）。
- **影响**：多数 TLS 客户端容忍缺 AKI，但严格校验器（某些 MDM、cert-pinning 库、pedantic `openssl verify`）标记。对发证工具是潜伏互操作缺口。
- **修复方向**：两叶子签发函数 `signed_by` 前设 `params.use_authority_key_identifier_extension = true`。

### L9 ✅ 无 SNI 客户端无默认/回退证书（resolver 返 None 握手失败） `[来源:D]`
- **位置**：`crates/tls-manager/src/resolver.rs:32-34`、`generator.rs:122-140`
- **证据**：`resolve` 取 `client_hello.server_name()?`，无 SNI 返 None，rustls `NoCertResoluted` 失败握手。server config 仅 `.with_cert_resolver(...)` 无 `with_single_cert` 回退。
- **影响**：合法无 SNI 客户端（部分 Java/Python HTTP 库、`openssl s_client` 无 `-servername`、遗留 IoT、按 IP 连 HTTPS）握手被丢，丢失捕获可见性。
- **修复方向**：提供回退证书（如签 `aiproxy.local` 占位）；至少 log 无 SNI 握手。

### L10 ✅ `NoOpVerifier::supported_verify_schemes` 漏 `RSA_PSS_SHA512`（dangerous 路径协商面变窄） `[来源:D]`
- **位置**：`crates/tls-manager/src/client.rs:46-57`
- **证据**：返回 8 scheme 硬编码列表，缺 `RSA_PSS_SHA512`。dangerous 路径下代理广告更少签名算法，仅用 PSS-SHA512 签的上游（罕见）在签名校验步被拒。
- **修复方向**：委托 `rustls::crypto::ring::default_provider().signature_verification_algorithms`，或加 `RSA_PSS_SHA512`。

### L11 ✅ `load_native_root_store` 平台无根无错时静默返空 store（verify 全拒无日志） `[来源:D]`
- **位置**：`crates/tls-manager/src/client.rs:133-169`
- **证据**：错误日志仅在 `!result.errors.is_empty()` 时。若 `load_native_certs()` 返 `{certs:[], errors:[]}`（最小容器/沙箱可能），store 空，verify config 拒所有上游，无任何日志。
- **影响**：CI/headless/容器部署 verify=true 且无系统根时，所有校验上游失败且根因不可见。
- **修复方向**：load 后若 `store.len()==0` 显式 `error!`/`warn!` "no native roots loaded; verifying config will reject all upstreams"。

### L12 🔶 `body_store.relative_body_path` canonicalize 失败静默返 None（丢 body 引用） `[来源:D]`
- **位置**：`crates/db/src/body_store.rs:125-133`
- **证据**：`base_dir.canonicalize().ok()?` + `full_path.canonicalize().ok()?`。任一 NotFound 即 None。bodies 目录被外部 `rm` + `ensure_dir` 重建后 base dir 新 inode，旧绝对路径 `strip_prefix` 失败返 None，body 引用静默丢。对比 `resolve_body_path`（:119-122）优雅降级 sentinel——`relative_body_path` 返 Option 丢数据。
- **修复方向**：失败时退化为尽力字符串 strip（词典序），或文档化重建后不可用；更好：只存相对路径。

### L13 ✅ `env::set_var` 非线程安全，用于运行时（非仅测试） `[来源:T]`
- **位置**：`apps/desktop/src-tauri/src/dev_logger.rs:35`、`session_stats.rs:59`
- **证据**：`env::set_var(...)` 文档声明在他线程读环境时不安全（Unix `setenv` 改 `environ` 无读锁）。两处今在启动期跑，但无守卫，`session_stats.rs` 之后 `resolve_log_file_path()` 读回。未来 toolchain 收紧（部分 track 已 `unsafe`）可变硬编译错或潜伏数据竞争。
- **修复方向**：解析路径存 `OnceLock<PathBuf>`/static，`resolve_log_file_path` 读 OnceLock 而非 `env::var`。

### L14 ✅ `commands/ai.rs` 每次 chat-completion 新建 `reqwest::Client`（丢连接池/TLS 会话缓存） `[来源:T]`
- **位置**：`apps/desktop/src-tauri/src/commands/ai.rs`（`call_chat_completion` 内构造 Client）
- **证据**：`reqwest::Client` 文档明示 clone 廉价、构造昂贵（拥有连接池+TLS 会话缓存）。每次调用重建，丢对上游 LLM 端点的连接复用。
- **影响**：重复 AI 调用（多 session 解释/总结）每次重协商 TLS + 重解析 DNS，增延迟与 socket churn。
- **修复方向**：`AppState` 或 `OnceLock<Client>` 懒初始化并 clone。

### L15 ✅ `load_recent_summaries` 无 limit 钳制——`usize::MAX` 材质化全表 OOM `[来源:D]`
- **位置**：`crates/db/src/sessions.rs:204-226`
- **证据**：`load_recent_summaries(conn, limit: usize)` 绑 `limit as i64`，无钳制。`ORDER BY started_at DESC LIMIT ?1`。`usize::MAX` 经 `as i64` 截断为负→SQLite 视 -1 为无限制→返全表，材质化进 `Vec<SessionSummaryRow>`。500k 会话数百 MB。
- **影响**：当前调用方传 sane limit；但函数无防御，未来调用方（导出/同步/批）传大/无界 limit 即 OOM。
- **修复方向**：内钳 `limit.min(10_000)`，文档化上限。

### L16 ✅ Collections 页两个 resize handler window 监听泄漏（M21 模式） `[来源:F]`
- **位置**：`apps/desktop/src/pages/collections/index.tsx:331-367`（`startExplorerResize`）、`:369-410`（`startInspectorResize`）
- **证据**：各挂 3 window 监听（:364-366/405-407）无 `resizeCleanupRef`；卸载 effect（:187-196）只 `cancelAnimationFrame`。
- **影响**：顶层页组件少 mid-drag 卸载（仅路由切换），但导航离开拖 explorer/inspector 分割条泄漏 3 监听/拖。compose 页等价（`pages/compose/index.tsx:218-244`）已修。
- **修复方向**：套 `pages/compose/index.tsx` 的 `resizeCleanupRef` + 卸载清理。

### L17 ✅ `use-session-explorer-layout` 两个 resize handler window 监听泄漏（M21 模式） `[来源:F]`
- **位置**：`apps/desktop/src/features/sessions/use-session-explorer-layout.ts:137-150`、`:176-188`
- **证据**：`startExplorerResize`/`startInspectorResize` 各挂 window 监听无 `resizeCleanupRef`；卸载 effect（:199-208）只取消 rAF。
- **影响**：驱动 Sessions 页 explorer/inspector 分割条；导航离开或 host hook 卸载 mid-drag 泄漏。
- **修复方向**：套 `resizeCleanupRef`。

### L18 🔶 `collapse_duplicate_enabled_throttle_profiles` 用 `MIN(id)` 作 tiebreak——id 是 TEXT UUID，"最小"为词典序非插入序 `[来源:D]`
- **位置**：`crates/db/src/schema.rs:481-492`
- **证据**：`SELECT MIN(id) ... GROUP BY workspace_id`，id 为 TEXT UUID。`MIN()` 对 TEXT 词典序。app 用随机 UUID，故"赢家"是词典序最小（任意），非用户视角的"最老/首选"。若改前缀/顺序 id 偏离更远。
- **影响**：两启用 profile 状态（M30 collapse 场景）下赢家由词典序 id 定，对用户任意。低危（场景已是 bug 态 + 应用层通常阻止）。
- **修复方向**：保留 `MIN(id)` 并文档化词典序；或 tiebreak 加 `created_at`（throttle_profiles 无此列，可考虑加）。

---

## 7. 修复优先级建议

**P0（立即修，高危且影响核心功能/安全/系统副作用）**

| 编号 | 一句话 | 工作量 |
|---|---|---|
| H1 | 证书有效期 Feb 29 panic（三处调用点 + 单测） | XS |
| H2 | 根私钥 0600 预创建 / 原子写 | S |
| H3 | `read_har_file` 路径约束（套 H10 模式） | S |
| H5 | `delete_sessions_by_ids` 折叠为纯 CASCADE | XS |
| H7 | `runtime_join_failure_trace` 用 char 边界截断 | XS |
| M9 | `update_workspace` 加 `system_proxy_enabled` | S |
| M10 | `throttle_runs` profile_id/rule_id FK + 删除清理 | S |
| M11 | 环境变量/全局变量 UNIQUE 约束 | XS |

**P1（尽快修，高危但触发条件较窄，或中危里影响大的）**

- H4（start_proxy 部分失败回滚/降级）、H6（upsert_session summary/detail id 校验）、H8（WS 收集去串行化）
- M1/M2（map-local 路径约束 + 软链）、M3（响应 rewrite 仅变更才剥头）、M7（ai_settings CHECK）、M13/M14（cert 原子写 + 有效性门控）、M15/M16/M17（IPC 线程阻塞清扫）

**P2（计划修，中低危健壮性/性能）**

- M4/M5/M6（throttle 匹配/语义/溢出）、M8（insights 8 扫合并）、M12（macOS 信任检测）、M18/M19/M20（前端泄漏/i18n）
- L1–L18

**P3（架构治理，见第 9 节）**

- A13（删除策略统一）、A14（AI reqwest Client 复用）、A15（body 预览/IPC 大 body 流式化）、A18（删除策略漂移 CI 守卫）

---

## 8. 复核残留（Round 4 已修项的残留边界，不计入新发现计数）

> 以下为复核 Round 4"已修复"项时发现的残留边界，单列以便认领，**不计入**第 3 节计数。

- **R5-M2（响应 throttle 语义）**：Round 4 M9"已修复"指的是响应侧**应用**了 latency/丢包（与请求侧对称）。但本轮 M5 发现：响应侧 latency/transfer 都在 body 全量缓冲**之后**应用，语义上 `download_kbps` 对大 body 不做真实逐字节节流（一次性 sleep 满后吐）。这是 M9 修复之外的**独立语义缺口**，已计入 M5。
- **R5-H8（入站 MITM 证书签发）**：H8 的 inflight 去重 + LRU + 锁顺序统一均已确认正确。本轮无残留。但 H1（Feb 29 panic）发生在**同一** `sign_host_certificate_from_data` 路径上——这是 H8 未覆盖的、同函数内的独立 panic 类。
- **Round 4 D5（rcgen `from_ca_cert_pem` 不保 serial）**：本轮复核确认该顾虑对 **rcgen 0.13.2 已无效**（`from_ca_cert_der` 保 `serial_number`/`is_ca`/`key_usages`/SAN/SKI）。Round 4 文档的 D5 残留警告**已过时**，建议下次更新 ARCHITECTURE/审查文档时删除。真实残留是 L7（fingerprint 基于重签 DER）。

---

## 9. 架构与工程规范评审（6 项，A13–A18）

> 该部分为技术总监视角的横向评估，识别跨模块系统性问题与治理杠杆，不计入 Bug 总数。

### A13 🟠 🔶 删除策略双轨：CASCADE-only vs 手删全子表（H5 的架构面）
- **领域**：并发/一致性模型 / 维护性
- **证据**：见 H5。`clear_all_sessions`（L9 修复）信任纯 `ON DELETE CASCADE`；`delete_sessions_by_ids` 手删 8 子表。两路径策略相反。下一个新增 session 子表（`http2_frames`、未来 `ws_frames` 等）会被 delete_sessions 漏删而 clear_all 正确级联——**确定性的未来孤儿 bug**。
- **影响**：架构级一致性洞；每加一个 session 子表都需记得同步两处（实际只一处有 CASCADE 保证）。
- **建议**：统一为纯 CASCADE（H5 修复即达成）；加 CI 守卫脚本——扫 schema 所有 `FOREIGN KEY ... REFERENCES session_summaries` 确认均 `ON DELETE CASCADE`，防止未来 PR 引入 NO ACTION 子表。

### A14 🟡 ✅ AI 子系统无 `reqwest::Client` 复用 + 无超时/重试统一策略
- **领域**：资源/可维护性
- **证据**：见 L14（每次构造 Client）。`call_chat_completion` 内联构造，无 AppState 级 Client，无统一 timeout/retry 策略，错误直透传字符串（Round 4 A3 错误模型问题的 AI 域实例）。
- **影响**：AI 功能（Compare 总结、规则解释）每次调用丢连接复用；错误不透明（A3）；timeout 行为由 DB 列（M7）零散控制。
- **建议**：`AppState` 持 `OnceLock<reqwest::Client>`（统一 timeout/redirect 策略），clone 复用；AI 域错误转 `app_error(ERR_AI_*, ...)`。

### A15 🟡 ✅ 大 body 在 IPC 边界无流式通道（M16 + body_preview L6 的共同根因）
- **领域**：IPC 数据模型
- **证据**：M16（base64 大 body 在 IPC 线程）、L6（body_preview 全量解码）、Round 4 M3（spool 流式回写已修网络侧，但 IPC 侧仍整读）。session detail content 经 base64 单字符串过 IPC，多 MB body 卡 IPC worker。
- **影响**：大 body 的"网络侧流式、IPC 侧全量"不对称；选大 session 即 IPC 卡顿。
- **建议**：专用 `get_session_body(session_id, kind, range)` 流式/分块命令，渲染端增量解码；body_preview 只取前缀子切片。

### A16 🟡 🔶 TLS 子系统密钥处理无统一安全原语（H2 + M13/M14 的架构面）
- **领域**：密钥材料安全
- **证据**：H2（umask 暴露窗口）、M13（非原子写）、M14（只查存在）。Round 4 L8 已为 `system_proxy_recovery.rs` 引入 `write_atomic`，但 `tls-manager` 未采用，且密钥创建无 0600 预设。整个 TLS 子系统对"最高价值密钥"的处理比系统代理快照还弱。
- **影响**：CA 旋转/崩溃窗口的密钥暴露面；作为 MITM 工具的核心信任根，安全原语应最强。
- **建议**：`tls-manager` 内建安全写原语（`write_atomic_secret`：temp 0600 + fsync + rename），覆盖 cert/key/install-copy；`root_cert_exists` 升级为有效性校验。

### A17 🟢 前端 M21（window 监听泄漏）修复只覆盖 2/6 同模式实现
- **领域**：前端工程一致性
- **证据**：Round 4 M21 修了 `BreakpointInterceptPanel` + `compose/index`（`resizeCleanupRef` 模式）。但 M18/M19/L16/L17 共 4 处同模式（JSON 树列拖拽、SessionContainerTabs 滚动条、collections 两个 resize、session-explorer-layout 两个 resize）未跟进。
- **影响**：维护性——同一种泄漏 bug 散布，未来新增拖拽易复制未修版本。
- **建议**：抽 `useWindowDragListeners` hook（封装挂/卸载 + cleanupRef + body 样式恢复），6 处统一替换；ESLint 自定义规则或代码评审清单拦截裸 `window.addEventListener` 无配对 ref 清理。

### A18 🟠 ✅ schema FK 完整性无 CI 守卫（H5 + M10 + M11 的共同架构面）
- **领域**：DB schema 治理
- **证据**：H5（删除策略漂移）、M10（throttle_runs 缺 FK）、M11（环境变量缺 UNIQUE）。三个独立 bug 都是"schema 约束/策略不一致"类。仓库无脚本扫 schema 的 FK 完整性（每个 `*_id` 列是否声明 FK、ON DELETE 策略是否一致、唯一不变量是否有约束）。Round 4 A2 提议过"API_SPEC CI 门禁"，但 schema 层无对应守卫。
- **影响**：schema 约束靠人记，每次加表/列都可能引入孤儿/重复（本轮就发现 3 处）。
- **建议**：CI 脚本解析 `schema.rs` 的 `CREATE TABLE`/`CREATE INDEX`，校验：(1) 每个命名 `*_id` 列有对应 `FOREIGN KEY`；(2) 所有引用 `session_summaries` 的 FK 是 `ON DELETE CASCADE`；(3) 业务唯一不变量（throttle_profile per-workspace enabled、env var key）有 UNIQUE 约束。失配 fail build。

---

## 10. 评审方法说明与诚实声明

- **方法**：6 个领域（网络层 / 规则层 / DB / TLS / Tauri 后端 / 前端）并行深度静态审查，每个领域由独立 agent 逐文件阅读源码（非抽样），高危项由主审逐行复核证据真实性。
- **去重**：所有 agent 均先读 `docs/CODE_REVIEW_2026-07-04.md`，明确排除 H1–H15/M1–M30/L1–L14/A1–A12。第 8 节单列复核残留以区分"全新发现"与"已修项的残留边界"。
- **置信度标注**：✅ 已打开源码逐行确认；🔶 逻辑链成立但触发条件或频率待确认（如 L9 空native root store、L11 容器部署等依赖平台运行时行为的项）。注：H1 的 Feb 29 触发虽罕见但**确定性**（非概率性），故标 ✅ 而非 🔶。
- **未覆盖/未深入**：
  - 本轮聚焦 Rust 后端 + 前端逻辑；**未**对前端做全量逐文件审查（57k LOC TS，按风险优先采样约 40 个核心文件）。
  - **未**运行测试套件验证修复（本任务是发现，非修复）。
  - 部分 🔶 项（如 macOS `verify-cert` 语义、Linux 容器 native root）依赖平台运行时行为，建议在目标平台实测确认。
  - 性能类项（M8 insights 8 扫、M16 base64）未做 benchmark，成本基于 SQL/算法结构推断。
- **建议读者**：优先看第 4 节（高危）与第 7 节（优先级），再按领域认领中低危。

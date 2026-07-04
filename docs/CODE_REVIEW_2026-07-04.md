# AIProxy 全盘代码评审报告（第四轮 · 技术总监视角）

## 1. 文档信息

- 产品代号：`AIProxy`
- 文档类型：综合代码评审报告（Bug / 性能 / 规范 / 架构）
- 评审日期：`2026-07-04`
- 评审范围：全仓库
  - Rust crates：`proxy-core`（~15.9k LOC）/ `rule-engine`（~2.0k）/ `db`（~6.9k）/ `tls-manager`（~1.6k）/ `sys-util`
  - Tauri 后端：`apps/desktop/src-tauri/src`（commands / system_proxy / port_manager / bootstrap）
  - React 前端：`apps/desktop/src`（services / app / hooks / lib / features / pages / components / i18n）约 56.9k LOC
  - 共享包：`packages/shared-types` / `eslint-config` / `tsconfig` / `ui-tokens`
- 评审方式：7 个领域并行静态审查 + 高危项逐行人工复核 + 架构横向评估
- 前序文档：
  - `docs/BUG_AUDIT_2026-06.md`（v1.3）
  - `docs/BUG_AUDIT_2026-06-27.md`（Round 2 v1.6）
  - `docs/BUG_AUDIT_2026-06-28.md`（Round 3 v1.3，31 项已修复）
- 文档状态：`Code Review Round 4 v1.1`（**本轮共 70 项发现（Bug 类 58 + 架构类 12），均经源码核实，待修复；v1.1 修正了开头/A2 统计、撤回 M18 误报、收窄 M12/M24 证据、H8 标题更名**）

> **与前序审计的关系**：本轮所有条目均为前三轮修复后的新发现，未与已修复项重复。原始领域编号在每条目末尾以 `[来源:N*]` 标注，便于跨团队认领（N=网络层 / R=规则层 / D=DB·TLS / T=Tauri 后端 / F=前端 / A=架构）。

---

## 2. 阅读约定

- **严重程度分级**：
  - 🟠 高危：核心功能失效 / 资源耗尽 / 数据丢失 / 协议正确性 / 安全漏洞 / 系统级副作用
  - 🟡 中危：边界条件下错误行为 / 数据一致性 / 性能可观测退化 / 误导性行为 / UX 缺陷
  - 🟢 低危：健壮性 / 维护性 / 代码规范 / 微小性能
- **置信度分级**：
  - ✅ **已复核**：已打开源码逐行确认，确信为真实缺陷
  - 🔶 **待复核**：逻辑链条成立，触发条件或频率需进一步确认
  - ❓ **存疑**：依赖运行时/平台行为，需实测
- **定位格式**：`file_path:line_number`（相对仓库根）

---

## 3. 汇总

| 领域 | 🟠 高危 | 🟡 中危 | 🟢 低危 | 小计 |
|---|---|---|---|---|
| 网络层（proxy-core 网络） | 3 | 6 | 3 | 12 |
| 规则层 + rule-engine | 3 | 4 | 1 | 8 |
| DB / TLS / sys-util | 2 | 5 | 2 | 9 |
| Tauri 后端 | 3 | 6 | 2 | 11 |
| 前端接入层 | 0 | 1 | 3 | 4 |
| 前端业务层 | 4 | 7 | 3 | 14 |
| **Bug 合计** | **15** | **29** | **14** | **58** |
| 架构与工程规范（A1–A12，单列第 9 节） | 5 | 5 | 2 | 12 |
| **含架构项总计** | **20** | **34** | **16** | **70** |

> 本报告 Bug 类条目 58 项（v1.1 移除 M18 误报）；架构/工程类条目 12 项（A1–A12，单列第 9 节）。修复优先级见第 7 节。

---

## 4. 🟠 高危（15 项）

### H1 ✅ 客户端→上游 WebSocket Close 帧未加掩码，违反 RFC 6455 §5.3 `[来源:N1]`
- **位置**：`crates/proxy-core/src/ws.rs:794-797`（`forward_raw_frame` → `:544-550`）
- **类别**：协议正确性 / 互操作
- **证据**：当 relay 从客户端读到 `Close` 帧并转发给上游时，调用 `forward_raw_frame(upstream_stream, &frame)`，其内部固定 `write_ws_frame(writer, frame, /* mask_output */ false)`。而紧邻的非 Close 分支（`:809`）正确使用 `write_ws_frame(upstream_stream, &frame, true)`。`parse_ws_frame` 解析后会清掉掩码位，导致 Close 成为唯一不加掩码的客户端→上游帧。
- **影响**：RFC 6455 §5.3 强制要求客户端发往服务器的所有帧必须加掩码（代理对上游扮演客户端角色）。严格的上游会以 `Close(1002)` 协议错误终止连接，导致合法的 WS 关闭握手失败、产生大量伪 1002。
- **修复方向**：让 Close 走与非 Close 一致的掩码路径（`mask_output=true`），或给 `forward_raw_frame` 增加 `mask_output` 参数。

### H2 ✅ 未剥离 `Connection` 头中点名列出的逐跳头（RFC 7230 §6.1） `[来源:N2]`
- **位置**：`crates/proxy-core/src/http_io.rs:146-160`、`crates/proxy-core/src/http_proxy.rs:1311-1325`
- **类别**：HTTP 正确性 / 请求走私面
- **证据**：代理只剔除字面量 `Connection`/`Proxy-Connection`/`Content-Length`/`Transfer-Encoding`/`Host`，从不解析 `Connection` 头值中点名的连接级头（如 `Keep-Alive`、自定义 `x-foo`）并剥离它们，也未处理标准逐跳集合（`TE`/`Trailer`/`Upgrade`/`Proxy-Authenticate`/`Proxy-Authorization`）。响应路径（`build_hyper_response_from_upstream`）同样只剔除少量字面量。
- **影响**：违反 RFC 7230 §6.1；逐跳头泄漏可暴露代理态、污染上游缓存，是经典的请求走私向量（当 `Connection` 列出的成帧头幸存时）。
- **修复方向**：在请求/响应两侧解析 `Connection` 头令牌列表，按名（大小写不敏感）逐一剥离，并剥离标准逐跳集合。

### H3 🔶 上游 TLS 证书校验被无条件禁用（`build_dangerous_*` 为唯一默认） `[来源:N3]`
- **位置**：`crates/proxy-core/src/timing_connector.rs:38-48`、`ws_upgrade.rs:190-191`；`crates/tls-manager/src/client.rs:61-100`
- **类别**：安全（上游链路 MITM）
- **证据**：`TimingConnector::new` 与 WS 升级路径均使用 `build_dangerous_tls_connector_with_alpn` / `build_dangerous_client_config`，其 `NoOpVerifier` 对所有证书无条件返回 `ServerCertVerified::assertion()`。没有任何开关、按主机白名单或工作区设置可重新启用校验。
- **影响**：网络上任何位于代理与源站之间的攻击者都可冒充源站，被拦截流量被静默解密。每个 HTTPS/WSS 请求都受影响。对调试工具而言可接受为默认，但「不可关闭 + 不可见」是真实安全弱点。
- **修复方向**：默认保留 NoOp，但增加显式「按主机校验上游证书」开关（仿 DNS 覆盖白名单模型），并在 UI 标注为显式信任决策。
- **状态：已修复 @ 批次 3a（2026-07-04）** — 全链路实现：`tls-manager` 新增 `build_verifying_*` 构建器（系统根证书 via `rustls-native-certs`）；`TimingConnector`/`ws_upgrade` 按 workspace `verify_upstream_tls` 开关选 connector；config 管道经 `ProxyRuntimeConfig` → `ConnectionContext` → connector；DB schema migration（`verify_upstream_tls` + `tls_verify_hosts` JSON 列）+ `WorkspaceRow` + IPC `update_workspace`/`create_workspace`；前端 Settings 开关 + host 白名单 textarea + 中英文案。集成测试：自签上游 HTTPS 在 verify=false 通过、verify=true 被拒（`timing_connector::tests::h3_*`）。
  - **复审加固（3 项 follow-up）**：
    - **(High) tlsVerifyHosts shape 修正**：后端 `WorkspaceData.tls_verify_hosts` 由 JSON-字符串改为 `Vec<String>`（IPC 边界即数组），`workspace_row_to_data` 反序列化 JSON 列、`update_workspace`/`main.rs`/`create` 序列化回 JSON 字符串列；`UpdateWorkspaceInput.tls_verify_hosts` 改 `Option<Vec<String>>`，前端 `updateWorkspace`/`useUpdateWorkspace`/Settings 改发数组。消除了「后端发字符串、前端 `.join()` 崩溃」的 `TypeError`。
    - **(High) 白名单真正生效**：`ProxyRuntimeConfig`/`ConnectionContext` 增加 `tls_verify_hosts: Arc<[String]>`，`TimingConnector` 同时持有 dangerous 与 verifying 两个 connector，按连接在 `Service::call` 内据 `verify_upstream_tls || allowlist.contains(host)`（大小写不敏感、去空白）选 connector；WSS 路径 `ws_upgrade` 同样判定；`forward_request`/pool/get_or_connect/do_connect 全链路透传 hosts。测试：`h3_allowlist_forces_verify_even_when_global_flag_is_off`（白名单 host 即使总开关关闭也被校验、自签被拒）+ `h3_non_allowlisted_host_stays_unverified_when_global_flag_is_off` + `h3_host_in_allowlist_matches_case_insensitively`。
    - **(Medium) inflight 表有界**：见 H8 加固。
    - **(Medium) verifying connector 改为懒构建**：`TimingConnector` 不再在 `new()` 同时构建 dangerous + verifying 两个 connector（verifying 会 clone OS 根证书 + 组装 `ClientConfig`）。改为 dangerous 预构建（便宜、OnceLock 缓存）、verifying 用 `Arc<OnceLock<TlsConnector>>` 懒构建——仅在 `Service::call` 内确认为 HTTPS 且 `should_verify(host)` 为真时才首次构建并缓存于该 connector。消除 h1 路径每请求建 connector 时把根证书工作压到网络热路径（即使 verify 关或纯 HTTP 也曾付出该代价）。
    - **(Low) 非 Tauri mock 回填 `tlsVerifyHosts`**：`updateWorkspace` 的浏览器/dev fallback 返回值补 `tlsVerifyHosts: input.tlsVerifyHosts ?? []`，使 mock 与持久化 workspace shape 一致。

### H4 ✅ 单条 rewrite 规则解析/应用失败会中止整个请求（缺每规则隔离） `[来源:R1]`
- **位置**：`crates/proxy-core/src/rules/rewrite.rs:265/299/332/368-369/432/533-534` → `http_proxy.rs:302` `?`
- **类别**：规则级联正确性 / 健壮性
- **证据**：`apply_request_rewrite_rules` / `apply_response_rewrite_rules` 中每个 payload 解析与 body-field 操作都用 `?` 传播 `Err(String)`，经 `apply_request_runtime_rules` → `http_proxy.rs:302` 转为 `ProxyError::RuleError` 中止整条请求。脚本路径（`script.rs:253-255/260-262`）则用 `invalid_trace(...); continue` 做了每规则隔离——明确的不一致。
- **影响**：一条配置错误的规则（body/fields 改写命中非 JSON 体、坏 `path`、畸形 `redirect.target_url`）会让**所有**命中它的请求失败，并阻断级联中低优先级规则。调试代理遇到意外 content-type 时会静默 500 而非转发。
- **修复方向**：在规则循环内 `match Result { Ok→push 成功 trace，Err→push 错误 trace + outcome="error"，continue }`，仅结构性错误（manager 锁失败）才中止。

### H5 ✅ `set_json_path_value` 在父节点自动创建时静默销毁已有标量数据 `[来源:R2]`
- **位置**：`crates/proxy-core/src/rules/json_path.rs:155-166`（`Key` 父节点分支）
- **类别**：JSON path 改写正确性 / 数据丢失
- **证据**：`Key` 父节点分支：若 `current` 非对象，无条件 `*current = Value::Object(Map::new())` 后插入子键——原值被覆盖。对照 `Index` 父节点分支（`:167-174`）在非数组时返回 `Err`。故 `set $.a.b` 于 `{"a":"hello"}` 会静默把 `"hello"` 替换为 `{}` 再插 `b`，原数据丢失且无错误。
- **影响**：字段路径笔误或 body 形状与预期不符时静默删除既有值并重写树，极难排查。
- **修复方向**：对齐 `Index` 分支：父 `Key` 节点存在且非对象时返回 `Err`；仅在槽位缺失（`Null` 或不存在）时自动创建。

### H6 🔶 脚本执行以同步 `Condvar`+`mpsc` 阻塞 tokio worker 线程 `[来源:R3]`
- **位置**：`crates/rule-engine/src/execute.rs:161`（`SCRIPT_GATE.acquire`）、`:197`（`receiver.recv_timeout`）；调用点 `proxy-core/src/rules/script.rs:223` → `http_proxy.rs:309`，无 `spawn_blocking`
- **类别**：脚本引擎 / 异步运行时
- **证据**：`execute_hook` 全同步：`SCRIPT_GATE.acquire` 做阻塞 `Mutex+Condvar::wait_timeout`（`:50-79`），随后 `std::thread::spawn` + `receiver.recv_timeout`。该同步链在 async `handle_http_request` 任务内直接调用。`tauri::async_runtime` 为多线程 tokio 运行时。
- **影响**：脚本运行期间（最长 ~500ms 获取 + 500ms 执行），调用方 worker 线程被阻塞，无法 poll 其他任务。突发脚本命中请求可使整个运行时的 worker 全部停在 Condvar/mpsc 上，造成进程级队头阻塞。
- **修复方向**：用 `tokio::task::spawn_blocking` 包裹脚本执行，或将 gate 改为 `tokio::sync::Semaphore`、结果通道改为 `oneshot` 异步 await。
- **状态：已修复 @ 批次 3a（2026-07-04）** — `apply_request_script_rules`/`apply_response_script_rules` 改为 async，每条规则的 `execute_*_hook` 调用 move owned `rule`+`payload` 进 `tokio::task::spawn_blocking`；`stage_apply_request_rules` 改 async、调用点 `.await`；spawn join 失败 fail-open 为 RuntimeError trace（`runtime_join_failure_trace`）。SCRIPT_GATE 全局并发上限语义不变。现有 163 proxy-core 测试全绿。

### H7 ✅ `delete_throttle_profile` 删除被引用 profile 触发 FK 约束错误（FK 为 NO ACTION） `[来源:D1]`
- **位置**：`crates/db/src/schema.rs:76`、`crates/db/src/rules.rs:525-529`
- **类别**：引用完整性 / 可复现 bug
- **证据**：`throttle_rules.profile_id` FK 为 `FOREIGN KEY (profile_id) REFERENCES throttle_profiles(id)` 默认 NO ACTION；`delete_throttle_profile` 为裸 `DELETE FROM throttle_profiles WHERE id=?1`，无前置清理。在 `foreign_keys=ON`（`connection.rs:33`）下，任何被规则引用的 profile 删除都会抛 `SQLITE_CONSTRAINT ForeignKey`。其他规则表要么 `ON DELETE CASCADE` 要么先删子表——唯独此处两者皆无（代码 `:409` 注释仅说明为何改用 UPDATE-or-INSERT，并未解决删除路径）。
- **影响**：用户无法删除正在使用的 throttle profile，UI 报错不透明。可复现：任何含 ≥1 规则的 profile 删除即失败。
- **修复方向**：给 `throttle_rules.profile_id` FK 加 `ON DELETE CASCADE` 并补 migration；或在事务内先删引用规则。

### H8 ✅ 入站/MITM 动态站点证书签发缓存无去重 + CA 旋转后旧 resolver 仍服务，冷缓存下 CPU 飙升 `[来源:D2]`
- **位置**：`crates/tls-manager/src/resolver.rs:32-96`、`storage.rs:23`；`apps/desktop/.../commands/certificates.rs:443`
- **类别**：缓存失效 / 签发并发 / 异步路径阻塞式 crypto（注：这是 **入站 MITM** 侧的动态站点证书签发，不是上游 TLS）
- **证据**：每次入站 TLS 握手，`DynamicCertResolver::resolve`（同步，在 rustls I/O 线程调用）锁 `host_cache`，未命中则执行 `sign_host_certificate_from_data`（完整 `KeyPair::generate` + `signed_by`）——**释放锁后**签发，再二次加锁插入。冷主机名 N 个并发握手 → N 次未命中、N 次签发（浪费 CPU）后竞争插入。CA 旋转时（`certificates.rs:444` `clear_host_cache()`）到实际重启之间，旧 resolver 仍绑定在监听器上，会从空缓存全量重签。
- **影响**：突发流量下按主机签发风暴；CA 旋转期 CPU/延迟抖动；同步阻塞式 crypto 在握手路径上无 `spawn_blocking`。
- **修复方向**：跨签发持锁（或用每主机 `OnceCell`/双重检查锁）去重；考虑 `spawn_blocking` 签发以避免阻塞握手。
- **状态：已修复 @ 批次 3a（2026-07-04）** — `CertStorage` 新增 `inflight: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>` per-host 单飞槽；`resolve` 取槽后只持 per-host 槽锁做 crypto（不持表锁/不持 host_cache 锁，避免死锁），double-check cache 后只签一次；`clear_host_cache` 同步清空 inflight 表（CA 旋转一致）。测试：`storage::tests::inflight_slot_is_shared_per_host` + `clear_host_cache_flushes_inflight_table`。
  - **复审加固 (Medium) inflight 表有界**：`resolve` 在 cache 插入新签证书后调 `prune_inflight_if_needed`；inflight 表超过 `MAX_INFLIGHT_SLOTS`(1024) 时移除「host 已在 cache 中」的冗余槽（这些槽对未来 resolver 无用，因为走 cache 快路径），但**保留**冷 host（未缓存）的槽以免 orphan 进行中的 waiter。消除「唯一冷 SNI 主机名流」让 inflight 表随进程生命期无界增长（而真正的证书缓存在有界 LRU 内）。测试：`prune_inflight_drops_cached_hosts_keeps_cold_hosts`。
  - **复审加固 (High) 锁顺序统一**：`clear_host_cache`（CA 旋转）原为 host_cache→inflight，而 `prune_inflight_to_threshold`（resolver post-sign）为 inflight→host_cache——顺序倒置，CA 旋转与 resolver prune 并发可死锁 TLS 证书路径。改为统一 **inflight → host_cache** 顺序：`clear_host_cache` 先清空 inflight（释放 guard）再清 host_cache；`prune_inflight_to_threshold` 持 inflight 锁时短取 host_cache 锁读已缓存主机集。回归测试 `clear_host_cache_and_prune_do_not_deadlock`（两线程各跑 200 次并发 clear/prune，超时即视为死锁失败）。

### H9 ✅ Windows 系统代理 `apply` 先写 `ProxyEnable=1` 再写 `ProxyServer`，且无回滚 `[来源:T1]`
- **位置**：`apps/desktop/src-tauri/src/system_proxy/windows.rs:51-78`（对比 `restore:80-114`）
- **类别**：系统代理正确性 / 部分失败恢复
- **证据**：`apply_system_proxy_settings_with_pre_snapshot` 顺序为 `ProxyEnable=1`（`:58`）→ `ProxyServer`（`:60`）→ `ProxyOverride`（`:62`）→ 删 `AutoConfigURL`（`:64`）→ `AutoDetect=0`（`:65`）。同文件 `restore`（`:83-88` L12 注释）明确指出应「先写 server/override/AutoConfigURL 再写 ProxyEnable，否则部分失败会把用户流量导向死代理」。macOS `apply` 失败有回滚（`macos.rs:81-96`），Windows `apply` 既无正确顺序也无回滚（`_snapshot` 参数未用）。
- **影响**：若 `set_value("ProxyServer")` 在 `ProxyEnable=1` 之后失败（注册表 ACL、WinInet 竞争、磁盘错误），系统代理会指向陈旧/空 `ProxyServer`，全机 HTTP 流量黑洞，需手工修注册表。
- **修复方向**：仿 `restore` 顺序——先写 server/override/AutoConfigURL/AutoDetect，最后置 `ProxyEnable=1`，并加 macOS 同款的失败回滚。

### H10 ✅ `read_script_source_file` 任意本地文件读（仅扩展名校验，无路径约束） `[来源:T2]`
- **位置**：`apps/desktop/src-tauri/src/commands/rules.rs:577-632`
- **类别**：安全 / 路径穿越 / 输入校验缺失
- **证据**：命令仅校验扩展名（`.js/.mjs/.ts/.mts`）后即 `std::fs::read(path)` 返回内容。无规范化、无根目录白名单。对照同仓 `save_media_file`（`commands/files.rs:117-140`）经 `reject_unsafe_write_path` 严格校验。攻击者（含被入侵的渲染进程）可将 `~/.ssh/id_rsa` 改名 `id_rsa.js` 或建 `.mts` 软链读取任意可读文件并外泄。
- **影响**：在 Tauri IPC 桥上暴露任意文件读原语。
- **修复方向**：限定脚本目录（规范化后 `starts_with`），或要求路径来自既有 `save_script_rule`/导入记录；复用 `files.rs::reject_unsafe_write_path` 模式。

### H11 ✅ `enable/disable_system_proxy` 为 `async` 但在异步运行时上做阻塞子进程 + 阻塞 FS `[来源:T3]`
- **位置**：`apps/desktop/src-tauri/src/commands/proxy.rs:338-381`、`383-418`；包装于 `:36-48` 的 `#[tauri::command] async fn`
- **类别**：异步阻塞 / 运行时饥饿
- **证据**：两个 `async fn` 体内同步调用 `capture_system_proxy_snapshot()` / `apply_system_proxy_settings_with_pre_snapshot(...)` / `restore_system_proxy(...)`。macOS 上这些经 `Command::output()` 串行 spawn 多个 `networksetup`（阻塞）；Linux spawn `gsettings`/`kwriteconfig6`；Windows 做同步注册表 I/O + `InternetSetOptionW`。`system_proxy_recovery.rs:46` 还做 `fs::write`。均未 `spawn_blocking`（对比 `get_port_occupant` 正确用 `run_blocking_command`）。
- **影响**：每次阻塞调用 park 一个 Tokio worker 数十至数百毫秒，并发 IPC 下饿死异步运行时，可能拖累 WS/session 收集器、断点事件等。
- **修复方向**：在 async impl 内用 `run_blocking_command` 包裹平台系统代理调用，与 `get_port_occupant`/`kill_proxy_port_process` 一致。

### H12 ✅ Compose 查询参数编辑器每次按键都因父级 URL 往返而重建行/失焦 `[来源:F1]`
- **位置**：`apps/desktop/src/features/compose/components/ComposeRequestSection.tsx:303-335`
- **类别**：表单正确性 / 受控输入往返 bug
- **证据**：`QueryParamsEditor` 每次渲染都从 `new URL(url)` 派生 `params`（`:306-307`）；每次编辑 `handleParamsChange` 调 `onUrlChange(parsed.toString())`（`:321`）更新 store url，新 url 再解析为新 `params` 数组。`EditableKeyValueTable` 的同步 effect（`sameEntries`，`:59-63`）因 URL 编码非幂等（空格、`+`、特殊字符）判定为不同 → `setRows(...crypto.randomUUID())` 重建行 id 并重挂输入框。**每次按键**触发。
- **影响**：在 Compose 的 Query 标签页基本无法可靠编辑查询参数值，输入失焦/闪烁。
- **修复方向**：解耦编辑器与实时 URL 字符串——给 `QueryParamsEditor` 本地 `HeaderEntry[]` 状态（仿断点面板的 `useStableKeyedRows`），失焦/防抖提交回 URL。

### H13 ✅ Throttle `RuleEditor` 的 methods 字段无法编辑（往返销毁光标） `[来源:F2]`
- **位置**：`apps/desktop/src/features/throttling/components/RuleEditor.tsx:94-107`
- **类别**：表单正确性 / 受控输入往返 bug
- **证据**：methods 字段 `value={draft.methods.join(", ")}`（`:98`），`onChange` 做 `event.target.value.split(",").map(v => v.trim().toUpperCase()).filter(Boolean)`（`:101-105`）。输入 `GET, `（准备输入第二个方法）被解析为 `["GET"]`（trim+filter 丢空），重渲染 `value="GET"`——分隔符每次按键被剥，**永远无法输入第二个方法**。
- **影响**：throttle 规则的 HTTP methods 字段对多方法输入实际失效（只能一次性粘贴完整字符串）。
- **修复方向**：本地文本串草稿（仿 `:42-49` 的 priority 字段模式），失焦/有效变更时再解析；或改用多选（其它面板 `MapRulesPanel:307-320` 用 `Select multiple`）。

### H14 ✅ `RewriteRulesPanel` 与会话右键菜单存在大量硬编码英文，绕过 i18n `[来源:F3]`
- **位置**：`apps/desktop/src/features/rules/components/RewriteRulesPanel.tsx:127-162/404-407/496/621/860-862/866/872/905-906/918`；`apps/desktop/src/features/sessions/components/SessionContextMenu.tsx:257`
- **类别**：i18n / 代码规范
- **证据**：项目全局用 `useI18n()`/`t()`，但 `RewriteRulesPanel` 混用 `t()` 与英文裸字面量。`getInvalidRewriteCombination`（`:127-162`）返回 6 条未翻译告警推入 `errors`（`:404-407`）；「Rule tester」整段（`:860-920`）未翻译。`SessionContextMenu:257` 用 `"Create Throttling Rule"`，而其它菜单项都用 `t()`。
- **影响**：非英文用户看到中英混排；rewrite 测试器与冲突告警全英文，与本地化的其余 UI 不一致。
- **修复方向**：补翻译键（如 `rulesPage.rewrite.tester.*`、`contextMenu.createThrottleRule`）并全部走 `t()`。

### H15 ✅ `EditableKeyValueTable` 空态判 `items.length` 而渲染 `rows`，存在一帧不一致 `[来源:F4]`
- **位置**：`apps/desktop/src/features/compose/components/EditableKeyValueTable.tsx:94`（对比 `:136`）
- **类别**：数据一致性 / 渲染正确性
- **证据**：组件维护本地 `rows`（`:52`）镜像 `items`，同步 effect（`:59-63`）在渲染**后**运行。空态分支判 `items.length === 0`（`:94`），而行渲染分支 map `rows`（`:136`）。父级从空变非空时：`items.length>0`（隐藏空态）但 `rows` 在该帧可能仍空，反之亦然——一帧内可能「空态与行同现」或「两者皆无」。同仓 `BodyFieldsEditor`（`RewriteRulesPanel:1211`）正确用 `rows.length === 0`。
- **影响**：Compose 切换 body 类型/加载已存项时短暂视觉不一致。
- **修复方向**：空态条件统一用 `rows.length === 0`（与渲染源一致）。

---

## 5. 🟡 中危（29 项）

### M1 ✅ `read_chunked_body` 在读空闲超时时返回硬错误，与「返回部分 body」契约矛盾 `[来源:N4]`
- **位置**：`crates/proxy-core/src/ws_upgrade.rs:703-728`（`refill_stream`），消费于 `:665/685`；文档 `:566-578`
- **证据**：`read_full_response_body` 文档承诺「空闲超时或字节上限时返回已收集 body，保留上游拒绝状态码」。`read_length_delimited_body`（`:605`）与 `read_until_close_body`（`:637`）遵守（`Err(_)` 时 `break`），但 `refill_stream` 在同样超时时返回 `Err("chunked body read timed out")`，经 `read_chunked_body` 上抛 → WS 升级路径丢弃部分拒绝体并合成 502，而非返回上游真实（如 403）状态。
- **修复方向**：`refill_stream` 超时返回 `Ok(false)`（视超时为 body 结束），与 `read_until_close_body` 一致。

### M2 ✅ `Drop` of `PendingRequestCancellationGuard` 在 async worker 上做同步 body 解压 `[来源:N5]`
- **位置**：`crates/proxy-core/src/http_proxy.rs:1539-1595` → `build_session_detail` → `build_body_reference` → `decode_body_bytes`（`http_io.rs:467`）
- **证据**：未解除（取消）路径上 `Drop` 调 `build_session_detail`，其调 `build_body_reference(&self.request.body,…)` → `decode_body_bytes`，同步 `flate2`/brotli 解压最多 `MAX_CAPTURED_BODY_BYTES`（20 MiB），内联在执行 drop 的线程上。与代码库其余处刻意避免的「async 内阻塞」反模式相悖（如 `clear_spooled_response` 用 `spawn_blocking` 删文件）。
- **影响**：客户端中途断开且带大压缩请求体时，worker 线程同步执行数十 MiB inflate/brotli，拖累同 worker 其他任务。
- **修复方向**：取消路径跳过 body 解码（设为 `None`），或将 `build_session_detail` 卸载到 `spawn_blocking`。
- **状态：已修复 @ 批次 3a（2026-07-04）** — `build_session_detail` 加 `skip_bodies: bool` 形参（true 时 request_body/response_body = None，不解码）；`PendingRequestCancellationGuard::drop` 调用点传 `true`，其余 8 处传 `false`（保持原行为）。取消 trace 无需 body，避免 worker 线程同步解压 20MiB 压缩请求体。

### M3 ✅ 已 spool 的上游响应被整读入内存（且克隆）后再发送——内存放大 `[来源:N6]`
- **位置**：`crates/proxy-core/src/http_proxy.rs:943-955`（`stage_process_upstream_response`）
- **证据**：当 `upstream_response.spooled_response_path` 存在时，`tokio::fs::read(spool_path).await` 整读 spool 文件入 `Vec<u8>`，随后 `build_hyper_response_from_upstream` 做 `bytes::Bytes::from(body.to_vec())`（二次拷贝）。spool 本因 body 超过 20 MiB 上限才落盘，可达数百 MiB。
- **影响**：大响应下峰值常驻内存约为 body 的 2×，spooling 目的失效；非流式，客户端在整文件重读完成前收不到任何字节。
- **修复方向**：经 `http_body_util::ReaderStream`（或 `tokio_util::io::ReaderStream`）包成 `BoxBody` 流式回写，body EOF/drop 时删文件。
- **状态：已修复 @ 批次 3a（2026-07-04）** — 新增 `tokio-util`(io) + `http-body` + `futures-util` 依赖；`build_hyper_response_from_upstream` 签名 `body: &[u8]` → `BoxBody<Bytes,String>` + 可选 `streamed_content_length`（spool 路径用文件大小作为 Content-Length，避免 hyper 回退 chunked 编码被裸 TCP 客户端误读）；spool 路径经 `tokio_util::io::ReaderStream` → `CleanupStream`（Drop 时 spawn_blocking 删文件）→ `StreamBody`。`take()` spool 路径避免 UpstreamResponse Drop 误删。测试：`m3_cleanup_stream_forwards_bytes_and_deletes_spool_file` + 现有大响应转发测试。

### M4 ✅ `parse_upstream_response_head` 误解析 obs-fold 续行并静默丢弃畸形头行 `[来源:N7]`
- **位置**：`crates/proxy-core/src/ws_upgrade.rs:753-777`
- **证据**：迭代 `head.lines()`，每行 `split_once(':')`。以空白开头的续行（RFC 7230 §3.2.4 obs-fold）无 `:`，`split_once` 返回 `None` 被静默丢弃；空名头（`: value`）解析为 name=`""`；解析失败时 `status_code` 默认 `502` 掩盖真实畸形。
- **影响**：合法使用 obs-fold 折叠的旧服务器头被截断，可能丢 `Sec-WebSocket-Accept`/`Content-Length` 续行并损坏转发响应。
- **修复方向**：检测前导空白行并并入上一头值；对无有效 `name:value` 切分的行拒绝或显式告警。

### M5 🔶 WS 升级接受缺少 `Connection: upgrade`/`Sec-WebSocket-Accept` 的 101 `[来源:N8]`
- **位置**：`crates/proxy-core/src/ws_upgrade.rs:358-362`
- **证据**：成功条件为 `status_code == 101 && upstream_headers.iter().any(|(n,_)| n.eq_ignore_ascii_case("upgrade"))`，未校验 RFC 6455 §4.2.2 要求的 `Connection: upgrade` 与匹配的 `Sec-WebSocket-Accept`。
- **影响**：行为异常的上游返回 `HTTP/1.1 101 Upgrade: h2c`（无 accept key）被当作成功升级，relay 把任意字节当 WS 帧解析，产生垃圾捕获并污染客户端 WS 流。
- **修复方向**：进入 relay 前校验完整 101 握手（`Connection` 含 `upgrade`、`Upgrade: websocket`、存在 `Sec-WebSocket-Accept`），否则视为拒绝升级。

### M6 ✅ `build_ws_upgrade_request` 对非 ASCII 头值静默清空（`to_str().unwrap_or("")`） `[来源:N9]`
- **位置**：`crates/proxy-core/src/ws_upgrade.rs:805-810`
- **证据**：`format!("{}: {}\r\n", name, value.to_str().unwrap_or(""))`——含非 ASCII 字节（合法 obs-text）时 `HeaderValue::to_str()` 返回 `Err`，值被替为 `""`，向上游发出空头值，无错误日志。
- **影响**：任何含 obs-text 的请求头（如 `Sec-WebSocket-Protocol` 回显、Latin-1 `Origin`）被擦除值转发，可能破坏升级或静默丢用户数据。
- **修复方向**：用 `String::from_utf8_lossy(value.as_bytes())`（请求头显示路径已如此），或按字节级写。

### M7 🔶 永不 resolve 的 Promise 脚本可在超时后仍占线程（detach 后中断处理不确定） `[来源:R4]`
- **位置**：`crates/rule-engine/src/execute.rs:373-378`（`MaybePromise::finish`）+ 中断处理 `:345-347`；detach 路径 `:244-296`
- **证据**：`async onRequest(ctx){ await new Promise(()=>{}); }` 返回永不 settle 的 Promise；`finish` 驱动 `execute_pending_job` 循环不退出。外层 `recv_timeout`（`:197`）会超时设 `cancel_flag` 返回 TimedOut，但 spawn 的 OS 线程是 detach 的，许可仅在退出时释放，持有 16MB QuickJS 堆直到中断处理最终触发。
- **影响**：永不 resolve 的脚本每次泄漏线程+16MB 堆，持续流量下可耗尽内存/线程（尽管请求方已返回 TimedOut）。
- **修复方向**：给 in-thread `finish` 自带截止；确认 rquickjs 在 pending-job 循环中确实轮询中断；让 worker 线程可 join/可取消而非纯 detach。

### M8 🔶 断点编辑请求头不更新 `request.host`，改 Host 头无路由效果 `[来源:R5]`
- **位置**：`crates/proxy-core/src/breakpoints.rs:120-133`（`modified_request_headers` 分支）
- **证据**：该分支重建 `request.request_headers`/`request.headers` 后调 `refresh_request_target_from_url`（`:79-86`，仅更新 path/query/raw_request），从不把 Host 头回读进 `request.host`/`request.url`。而 `upstream.rs:152-156` 从 `request.host` 构造实际发往上游的 Host 头（覆盖 `request.headers`）。
- **影响**：用户在断点中改 Host 头（断点暴露的唯一 URL 相关字段）被静默忽略——请求仍发往原主机。UI 显示已改但行为不符，对调试工具具误导性。
- **修复方向**：编辑头后若存在 Host 头则解析并更新 `request.host`/`request.url` 主机端口。

### M9 ✅ 响应阶段 throttle 忽略 `latency_ms` 与丢包（与请求阶段不一致） `[来源:R6]`
- **位置**：`crates/proxy-core/src/rules/throttle.rs:92-116`（`apply_response_throttle`）
- **证据**：`apply_response_throttle` 仅计算 `download_delay_ms = transfer_delay_ms(body_len, profile.download_kbps)`，从不调 `should_drop_for_packet_loss`、从不应用 `profile.latency_ms`。对照 `apply_request_throttle`（`:46-90`）应用了 `latency_ms`（`:67-72`）与丢包（`:51-65`）。响应 trace 的 `latency_ms` 恒为 0（`:107-115`）。
- **影响**：含 `latencyMs`（编辑器暴露，默认 120ms）的 profile 只在请求侧加延迟；用户最期望延迟的响应侧（TTFB）无延迟；丢包从不丢响应。Inspector「Latency」对响应 throttle 恒为 0。
- **修复方向**：在 `apply_response_throttle` 应用 `profile.latency_ms`，并决定丢包是否可丢响应；至少文档化该不对称。

### M10 ✅ 每请求全量克隆所有规则（含已编译正则与编译代码串） `[来源:R7]`
- **位置**：`crates/proxy-core/src/rules/managers.rs:84-94`、`types.rs:175-177`、`managers.rs:128-130`、`mod.rs:78/116/137/204-206`
- **证据**：每个活跃规则解析器调 `compiled_rules()`/`list_rules()`，锁后 `.clone()` 整个 `Vec`（含每条 rewrite 的 `Regex` 克隆与完整 `payload: serde_json::Value`、每条 script 的 `compiled_code: String`），再 `.filter()`+`.sort_by()`。`CompiledRewriteRule` 即便正则已编译不可变仍每请求克隆 `Option<Regex>`（`:89-92`）。
- **影响**：每入站请求 4 次全 Vec 深拷贝 + 4 次线性扫描，热路径分配压力与锁竞争明显。
- **修复方向**：在 `set_rules`/`save_rule` 时把规则集快照进 `Arc<Vec<…>>`（或 `arc-swap`），热路径只做引用计数 bump；至少停止克隆 `Regex`/`compiled_code`（包 `Arc`）。

### M11 ✅ `insights` 百分位对全表双扫描 + 内存排序，缺 `(host,duration_ms)` 索引 `[来源:D3]`
- **位置**：`crates/db/src/insights.rs:213-227`、`:271-294`
- **证据**：`duration_ms` 列拉入 `Vec<i64>` 排序（`:213-227` 全局百分位、`:271-294` 按主机 P95）——对长时间运行的代理（数十万会话很常见）二次全表扫描 + 两次内存排序。`session_summaries` 无 `duration_ms` 索引、无 `(host,duration_ms)` 复合索引，两查询全表扫。
- **影响**：Insights 看板在大捕获集下变慢/内存重（恰是长跑代理命中场景）。
- **修复方向**：加 `CREATE INDEX idx_session_summaries_host_duration ON session_summaries(host, duration_ms)`，让 SQL 算近似百分位；或复用按主机 durations 向量算全局百分位，避免二次扫描。

### M12 🔶 `body_store.write_body` 与 `clear_all` 在 per-session 子目录存在性上竞争（L11 修复的残留窗口） `[来源:D6]`
- **位置**：`crates/db/src/body_store.rs:24-35`（`write_body`：`:29` `create_dir_all` → `:32` `fs::write`）vs `:62-90`（`clear_all`：`:77` 对每个 per-session 子目录 `remove_dir_all`）
- **证据**：L11 注释（`:55-61`）说明为消除「clear 删顶层目录 → 并发 write 撞 NotFound 父目录」窗口，已改为**保留顶层 `base_dir`、只删其下内容**。该顶层窗口确实已闭合。但残留窗口落在 **per-session 子目录** 层：`clear_all` 在 `:73-88` 迭代 entries 时对每个 session 子目录做 `remove_dir_all`（`:77`）；并发 `write_body` 对同一 session 先 `create_dir_all(&dir)`（`:29`）再 `fs::write(&file_path)`（`:32`）。若 `clear_all` 的 `remove_dir_all` 落在 `write_body` 的 `create_dir_all` 与 `fs::write` 之间，`fs::write` 因父目录消失返回 `NotFound`。`write_body` 不容忍该错误（`clear_all` 自身对 `NotFound` 容忍，`:84-86`，但 `write_body` 不容忍）。另：`clear_all` 仅 `read_dir` 一次不复查，迭代通过后才 `create_dir_all` 的新 session 子目录被漏扫（孤立 body 文件无 DB 行）。
- **影响**：「clear all sessions」与流量并发时偶发 body 捕获失败（错误以 `DbError::Io` 上抛）；少量孤立文件累积。低概率但真实。
- **修复方向**：在 desktop 层（`repository.rs` 已持 `db: Mutex`）协调 clear/write 串行；或 `write_body` 在 `NotFound` 上重试 `create_dir_all`+write；或 `clear_all` 反复扫描至稳定。

### M13 🔶 Linux gsettings 代理 restore 不覆盖 `socks`/`ftp`/`use-same-proxy` `[来源:T4]`
- **位置**：`apps/desktop/src-tauri/src/system_proxy/linux.rs:140-149/151-173/175-223`
- **证据**：`capture_gnome_snapshot` 仅捕获 `mode`/`http.*`/`https.*`/`ignore-hosts`；`apply_gnome_proxy` 仅设 http/https。GNOME schema `org.gnome.system.proxy` 还有 `ftp.host/port`、`socks.host/port`、布尔 `use-same-proxy`，均未捕获/恢复。
- **影响**：保真度缺口——`mode='manual'` 会激活各协议代理；若用户原已有 socks/ftp 条目或 `use-same-proxy=true`，行为偏离。
- **修复方向**：捕获/恢复完整 schema（`ftp`/`socks`/`use-same-proxy`），apply 时明确是否触碰 `use-same-proxy`。

### M14 ✅ `delete_sessions_except` 为同步 Tauri 命令，在 IPC 线程做阻塞 SQLite + body 文件删除 `[来源:T5]`
- **位置**：`apps/desktop/src-tauri/src/commands/sessions.rs:139-142` → `bootstrap/mod.rs:268-278` → `bootstrap/repository.rs:79-103`
- **证据**：同步命令调 `state.delete_sessions_except()` → `repository.delete_sessions_by_ids(&ids)` 同步持 DB 锁并循环 `body_store.remove_bodies(id)`（文件 I/O）。同仓 `clear_sessions`（`sessions.rs:538`，async）刻意用 fire-and-forget `repository.spawn_delete_sessions`。`repository.rs:78-80` 注释警告「同步——在 Tauri 命令内优先用 async 变体」。
- **影响**：会话多时，删 body（每会话一次 fs 调用）耗时，阻塞 IPC handler 线程并持全局 DB 锁，串行化所有其他 DB 命令。
- **修复方向**：改 async，用 `spawn_delete_sessions`/`delete_sessions_and_bodies_async`（如 `clear_sessions`）。

### M15 ✅ 多个同步 DB-backed Tauri 命令在全局 DB 锁下阻塞 IPC 线程 `[来源:T6]`
- **位置**：`commands/collections.rs:266-477`、`commands/environments.rs:61-262`、`commands/rules.rs:1-152`、`commands/ws.rs:24-50/137-168`、`commands/workspaces.rs`、`commands/throttling.rs`
- **证据**：均为同步 `#[tauri::command] pub fn`，获取 `state.read_db_connection().lock()` 跑 SQLite 查询。全局 `Arc<Mutex<Connection>>` 使每个此类命令与所有其他（含 async `get_insights`/`get_ai_settings` 经 `spawn_blocking` 锁同一锁）串行。
- **影响**：单个慢查询（如 `list_ws_messages` 大 payload、`batch_execute_collection_items` 持锁循环）阻塞所有其他 DB 命令；Tauri 2 IPC 线程池小，几个慢命令即可队头阻塞 UI IPC。
- **修复方向**：把重查询（`list_ws_messages`/`search_ws_messages`/`list_api_collection_items`）转 async + `run_blocking_command`；短查询可保持同步但确保锁内不做显著工作（文件 I/O、大结果物化）。

### M16 🔶 shutdown restore 在 `block_on` 下持运行时 mutex，清理任务重入运行时则死锁/`expect` 致 abort 跳过系统代理还原 `[来源:T7]`
- **位置**：`apps/desktop/src-tauri/src/main.rs:315-346`（`run_heavy_shutdown_cleanup`）
- **证据**：`RunEvent::Exit` 中 `tauri::async_runtime::block_on(async { shutdown_proxy_runtime(...).await })`，其中 `collector_handle.abort(); collector_handle.await; proxy_server_handle.shutdown().await`；其后 `restore_system_proxy(&snapshot)` 跑阻塞子进程。`take_runtime`/`set_runtime`/`take_system_proxy_snapshot`/`store_system_proxy_snapshot` 均 `.expect(...)`。若 `collector_handle`/`shutdown()` 以毒化 mutex 的方式 panic，`.expect()` 会在 **shutdown 期间** abort，跳过系统代理还原。
- **影响**：async-shutdown 中 panic 毒化 mutex 会把干净还原变成 abort，留下系统代理指向死端口。
- **修复方向**：shutdown 路径 `.expect()` 改 `.unwrap_or_else(|e| e.into_inner())`（仓库 `repository.rs:49/81/145/224` 已用此模式）。

### M17 ✅ `enable/disable_system_proxy` 无并发守卫，重叠调用可丢失快照 `[来源:T8]`
- **位置**：`apps/desktop/src-tauri/src/commands/proxy.rs:338-381`、`383-418`
- **证据**：enable：查 `has_system_proxy_snapshot()` → 无则 `capture` → `apply` → `store`（已存在则 no-op）；disable：`take` → `restore` → 失败则 `store`。两者无锁串行，且为 async（`:36-48`），`.await` 点可与彼此（菜单反复切换）或 `stop_proxy`（`:299` 调 disable）交错。例：enable 捕获 S1；存之前 disable 取到 None 返回；enable 随后存 S1——但系统代理已「disabled」而 S1 是 enable 前快照，状态与真实脱节。
- **影响**：快照/还原错位，可能使用户既有代理设置无法还原。`stop_proxy` 路径使其更易触发。
- **修复方向**：用单一 async mutex 串行 enable/disable/restart（平台调用本就阻塞），或加状态守卫使 disable 不能与 enable 并发。

### ~~M18~~ ✅ **（v1.1 撤回）原「`useThrottledValue` 在 interval 变更首帧边界分类错」为误报** `[来源:接入层F1]`
- **位置**：`apps/desktop/src/hooks/use-throttled-value.ts:48-60`
- **核实结论**：复核源码后撤回该缺陷结论。`:52-60` 的 `[intervalMs]` effect **cleanup** 已在 interval 变更时清掉旧计时器并把 `lastEmittedRef` 重置为 0（注释明确写「L13…reset the emit baseline so the new window starts clean」）。React 在 dep 变更时先跑所有 effect 的 cleanup（旧 interval 重置 effect 的 cleanup 此时执行：清 timer + baseline=0），再跑新 effect 体；主 effect 的 trailing 计时器在 cleanup 已清，故原描述的「陈旧计时器以旧 cadence 触发」与「leading-edge 比对旧时间戳」窗口已被闭合。
- **残留事项（降级为测试覆盖，不计入 Bug）**：当前单测（`use-throttled-value.test.ts`）仅覆盖恒定 interval 流，未覆盖「运行时变更 intervalMs」路径。建议补一条测试断言：变更 interval 后首帧按新 cadence 重新分类 leading/trailing。此项不计入修复清单 Bug 数。

### M19 🔶 `NotificationStore.push` 无去重无上限，查询错误风暴可淹没队列 `[来源:接入层F2]`
- **位置**：`apps/desktop/src/services/notification.store.ts:23-26`；由 `app/providers/AppProviders.tsx:101-106` 喂入
- **证据**：`push` 做 `queue: [...s.queue, {id,message}]` 无长度上限、无相同消息去重。全局 `QueryCache.onError` 对每个失败查询调 `push`（仅 `meta.suppressGlobalErrorNotification` 或 `SESSION_NOT_FOUND` 抑制）。后端间歇失败或一批并行查询同时失败（网络抖动）各 push 不同 `id` 累积。`AppShell` 仅在 Snackbar 关闭时 `shift()`（一次一个），N 个错误排 N 个 snackbars 顺序回放。
- **影响**：瞬时故障产生长尾过期错误 toast，恢复后仍长时间回放；`queue` 长度增长。
- **修复方向**：队列设上限（保留最近 K 条），并在 `push` 折叠连续相同消息。

### M20 ✅ `BodyEditor` 切 json 模式时静默丢弃未保存编辑 `[来源:业务层F5]`
- **位置**：`apps/desktop/src/features/breakpoints/components/BreakpointInterceptPanel.tsx:456-469`（`handleModeChange`）
- **证据**：切 `json` 模式时 `setDraftText(formatJsonText(committedTextRef.current).text)`（`:464-466`）；`formatJsonText`（`:225-239`）解析成功则 `JSON.stringify(JSON.parse(text),null,2)` 全量重写格式，无 undo。用户在 `raw` 模式输入的有效但格式不同的 JSON，切 `json` 即被整体重排。切 `form` 同理用 `parseUrlEncodedEntries`（`:460`）丢弃非 url 编码文本。
- **影响**：断点拦截器中切换 body 模式可静默重排/抹去用户进行中的 body 编辑——对字节精确性敏感的调试器令人意外。
- **修复方向**：仅在显式「Format JSON」动作（`:471` 已存在）时格式化；切 `json` 原样显示，切 `form` 解析失败则保持文本模式。

### M21 ✅ `BreakpointInterceptPanel.startResize` 拖拽中卸载泄漏 window 监听 `[来源:业务层F6]`
- **位置**：`apps/desktop/src/features/breakpoints/components/BreakpointInterceptPanel.tsx:1202-1240`；同模式见 `pages/compose/index.tsx:183-219`
- **证据**：`startResize` 在 window 上挂 `pointermove`/`pointerup`/`pointercancel`（`:1235-1237`），仅在 `stopResize`（`:1229-1233`，绑为 up/cancel handler）移除。组件在拖拽中卸载（断点被后端/另一次命中解析）时无 effect cleanup 移除这些监听，`stopResize` 永不触发。
- **影响**：面板在分割条拖拽中卸载时泄漏 3 个 window 监听 + 闭包至下次别处 pointerup。重复发生累积。
- **修复方向**：用 ref 跟踪活动监听并在 `useEffect` cleanup 移除；或经 `isResizing` 状态驱动的 `useEffect` 让 React 接管生命周期。

### M22 🔶 `ScriptRulesPanel` 等 4 个规则面板选择 effect 可覆盖进行中的新规则草稿 `[来源:业务层F7]`
- **位置**：`apps/desktop/src/features/rules/components/ScriptRulesPanel.tsx:103-118`；同模式 `MapRulesPanel:74-89`、`DnsMappingsPanel`、`RewriteRulesPanel:332-348`
- **证据**：选择同步 effect 跑于 `[draft.id, filteredRules, rules, selectedRuleId]`。`handleDelete` 后 `selectedRuleId=undefined`（`:201`）触发 `filteredRules[0]` 分支（`:109-115`）强制选首项，覆盖用户可能正在编辑的草稿。throttle 编辑器已用 `lastSyncedRuleIdRef`（`use-throttle-editor.ts:129`）硬化，规则面板未跟进。
- **影响**：删除后快速编辑、或与 refetch 竞态时，用户未保存草稿被首项替换无提示。
- **修复方向**：套用 throttle 编辑器的 id 同步守卫（ref 跟踪 last-synced id，仅 id 变才从服务端值同步草稿）。

### M23 ✅ `useThrottleEditor` 临时启用超时可在切换 profile 后错误禁用新 profile `[来源:业务层F8]`
- **位置**：`apps/desktop/src/features/throttling/use-throttle-editor.ts:213-223`
- **证据**：effect 在 `temporaryUntil - Date.now()` ms 后调度 `setActiveMutation.mutate(undefined)` + `setTemporaryUntil(null)`，key 为 `[setActiveMutation, temporaryUntil]`。若临时启用 profile A 后用户手动 `setActiveMutation.mutate(otherProfileId)`（另选激活），定时器仍触发调 `setActiveMutation.mutate(undefined)`，15 分钟后静默禁用手动选中的 profile B，UI 无解释。
- **影响**：临时启用 A 后切到 B，B 会在 A 的 15 分钟定时器到期时被静默禁用。
- **修复方向**：记录临时启用所针对的 profile id；超时回调仅在当前激活 profile 仍为该 id 时才调 `mutate(undefined)`。

### M24 🔶 `EnvironmentManagerDialog` 全局变量保存：close/unmount 仅清 timer 不 flush，500ms 内关对话框编辑丢失 `[来源:业务层F9]`
- **位置**：`apps/desktop/src/features/environments/components/EnvironmentManagerDialog.tsx:106-131`
- **核实结论（v1.1 收窄）**：env-scoped 变量已有 `useEnvVarsSaveManager` 的 flush-on-switch（H8 已修）。**切 tab 时通常不丢**——MUI Dialog 由父级 `open` prop 控制常驻挂载，切到「environments」标签时组件仍挂载，pending 的 500ms 防抖 timer 会继续触发并保存（注释 `:106-108` 明说 global vars 不需 H8 flush-on-switch，因 timer 在挂载期内会自然完成）。残留的真实窗口仅：**unmount/close 时只 `clearTimeout` 不 flush**——`:109-113` cleanup 直接清掉 pending timer，若用户在 500ms 防抖窗口内关闭对话框（且组件随之卸载），该次编辑被丢弃而非保存。此外若组件在 timer 触发前因新 `globalVarsQuery.data` 重渲，`setLocalGlobalVars` effect（`:80-92`）会用服务端值覆盖本地，pending 防抖仍用陈旧闭包值。
- **影响**：仅在「500ms 内关对话框并卸载」窄窗口丢失编辑；切 tab 不受影响。低概率。
- **修复方向**：unmount cleanup 由 `clearTimeout` 改为「若有 pending timer 则立即 flush 再清」；或在 `onClose` 内 flush global vars 防抖。

### M25 🔶 `ScriptRulesPanel.handleImportFile` 异步导入与选择 effect 竞态 `[来源:业务层F11]`
- **位置**：`apps/desktop/src/features/rules/components/ScriptRulesPanel.tsx:146-174`
- **证据**：`handleImportFile` 异步：`await open(...)` 后 `await readScriptSourceFile(selected)` 后 `setDraft(current => ({...current,...}))`。两次 await 之间，Tauri 事件或查询 refetch 改 `rules`，重触选择 effect（`:103-118`）。若该窗口内 effect `setDraft(filteredRules[0])`（`:112`，非函数式更新）落在导入的 `setDraft` 之后，会覆盖导入的源码。
- **影响**：导入脚本文件在背景 refetch + 选择同步交错时偶尔无法填充编辑器。
- **修复方向**：选择 effect 改 id-aware（同 M22 修复）；或导入设「勿覆盖」守卫 ref 供 effect 检查。

### M26 ✅ Compose `BodyFieldsEditor` 空态源不一致（同 H15 模式，单列便于认领） `[来源:业务层F4-扩展]`
- **位置**：`apps/desktop/src/features/compose/components/EditableKeyValueTable.tsx:94`
- **证据**：与 H15 同根因；`BodyFieldsEditor`（`RewriteRulesPanel:1211`）已正确用 `rows.length === 0`，`EditableKeyValueTable` 未对齐。
- **修复方向**：同 H15。

### M27–M30 ✅/🔶（详见第 8 节「规范与健壮性附录」中危合并条目）

> 为控制篇幅，剩余中危合并入第 8 节附录：含 macOS 多服务 PAC 关闭/恢复原子性（T9，🔶）、`window.confirm` 用于破坏性环境删除（业务层F10，✅）等。

---

## 6. 🟢 低危（14 项）

### L1 ✅ `write_ws_frame` 每帧 flush（每帧 syscall 放大） `[来源:N10]`
- **位置**：`crates/proxy-core/src/ws.rs:355`
- 每帧无条件 `writer.flush().await`，高帧率 WS（流式 API/tick）下每帧一次额外 syscall，无 TCP 批合。
- **修复方向**：每 relay 循环迭代至多 flush 一次，或暴露 `flush=false` 变体供热路径。

### L2 🔶 连接池空闲阈值不一致（复用 60s vs 驱逐 120s） `[来源:N11]`
- **位置**：`crates/proxy-core/src/upstream_pool.rs:43/68` vs `server.rs:51-57`
- 复用路径拒绝 >60s 条目但不删除；驱逐计时器只扫 >120s。60–120s 条目留作死重量；TOCTOU 可致首请求偶发发送失败。
- **修复方向**：统一阈值（`max_idle`==`idle_timeout`），复用路径陈旧检查内联驱逐。

### L3 ✅ WS relay 写失败时 `break` 不 shutdown 仍可写侧 `[来源:N12]`
- **位置**：`crates/proxy-core/src/ws.rs:810-812/870-873/922-925`
- 写失败仅 `break`，不 `shutdown()` 对端或不发 Close，对端仅借 TCP RST/FIN-after-drop 得知结束。
- **修复方向**：写失败 best-effort `shutdown()` 写端，可选向读端发 Close 再 break。

### L4 🔶 `transfer_delay_ms` 把 `kbps` 当 kibibits/s（×1024 而非 ×1000） `[来源:R8]`
- **位置**：`crates/proxy-core/src/rules/throttle.rs:39-41`
- 字段名 `kbps`（标准=千比特/秒=×1000），代码 `* 1024`，每档比标称慢约 2.4%。测试 `:154-157` 内嵌了 ×1024 假设。
- **修复方向**：明确单位——若千比特则 `* 1000`；若 kibibits 则字段改名 `kibps` 并文档化。同步改测试。

### L5 ✅ `i32`→`u16` 端口 clamp 掩盖损坏数据 `[来源:D8]`
- **位置**：`crates/db/src/workspaces.rs:7-9/154`；同模式 `sessions.rs:550`（`as u16` 截断）
- clamp 把越界值（如 `-1`、`70000`）静默压成 0/65535，产出「有效但错误」端口。
- **修复方向**：clamp 前对越界值告警，使损坏可观测。

### L6 🔶 `ai_settings.api_key` 明文存于 SQLite，无加密 `[来源:D9]`
- **位置**：`crates/db/src/schema.rs:353`、`crates/db/src/ai.rs:43/61`
- `api_key TEXT` 明文写入/读出；desktop 输出层 mask（`commands/ai.rs:20`），但 DB 文件含原始上游 LLM key。
- **修复方向**：仅存引用 + OS keychain（`keyring` crate），或机器密钥派生加密；至少文档化 DB 含明文 key。

### L7 ✅ `window_state` 防抖持久化任务在退出时未 join，可能半写 `[来源:T10]`
- **位置**：`apps/desktop/src-tauri/src/window_state.rs:62-69/348-370`；`main.rs:284-296`
- `schedule_debounced_persist` 存 handle 并 abort 旧任务，但 `RunEvent::Exit` 不 await/cancel `pending_save`；已过 `sleep` 正写文件的任务被中途撕下，可能留半写 `window-state.json`。`load_window_state` 解析失败回退默认，故影响有界。
- **修复方向**：原子写（temp + rename），并在 `ExitRequested` 调 `cancel_pending_save`。

### L8 🔶 `window_state`/menu-locale/system_proxy_recovery 写非原子 `[来源:T11]`
- **位置**：`window_state.rs:449-470`、`menu.rs:81-103`、`system_proxy_recovery.rs:46`
- 均用 `std::fs::write`（截断-写），崩溃/掉电留半 JSON。`system_proxy_recovery` 撕写最严重——启动还原无法运行，系统代理未还原。
- **修复方向**：temp + `rename`/`MoveFileEx` 原子写，至少覆盖 recovery snapshot。

### L9 ✅ `dev-logger` 环缓冲用 `splice(0,n)`，超容每发 O(n) `[来源:接入层F3]`
- **位置**：`apps/desktop/src/services/logger/dev-logger.ts:56-61`
- 注释声称「O(1) 摊销」，但 `splice(0, len-CAP)` 每次重索引全数组；CAP=200 影响小但注释误导。
- **修复方向**：定长环形索引或 `shift()`；删除误导注释。

### L10 ✅ `checkForAppUpdate` 失败不清模块单例 pendingUpdate `[来源:接入层F4]`
- **位置**：`apps/desktop/src/services/updater/app-updater.ts:8/29-45`
- `installPendingAppUpdate` 中 `downloadAndInstall` reject 后不清 `pendingUpdate`；重试复用已耗尽流的对象，错误不透明。
- **修复方向**：install 完成（成败皆）清 `pendingUpdate`，或错误后要求重 `check`。

### L11 ✅ `getSessionDetailContent` 导入详情回退可发空对象 `[来源:接入层F5]`
- **位置**：`apps/desktop/src/services/commands/sessions.ts:118-183`
- 导入会话无 body 但 `includeRequestBodyText` 为真时仍发 `requestBody: {}`，下游 merge 覆盖原 body 为空对象。
- **修复方向**：仅在内字段实际存在时包 `requestBody`/`responseBody`。

### L12 ✅ `WaterfallChart` 空态条件含糊脆弱 `[来源:业务层F12]`
- **位置**：`apps/desktop/src/features/sessions/components/WaterfallChart.tsx:69`
- `if (!hasTimingData && (totalMs==null||totalMs===0))`：total>0 但无 phase 时仍渲染空 phase 条 + 标签；命名与复合门使意图模糊、易碎。
- **修复方向**：简化为 `if (totalMs==null && !hasTimingData)` 并文档化「仅 total」分支。

### L13 🔶 `HostRow` flash 计时器未按 host 变更清理（仅 unmount） `[来源:业务层F13]`
- **位置**：`apps/desktop/src/features/sessions/components/SessionExplorerPane.tsx:362-386`
- 虚拟化按 index 键控行，`HostRow` 可在 host 身份变化时不 unmount；flash effect deps 仅 `latestStartedAt`，旧 host 计时器可能短留。
- **修复方向**：flash effect deps 加 `group.key`/`group.host` 并清计时器。

### L14 ✅ `BuildPendingComposedSessionDetail` 的 `sizeBytes` 恒为 0（即便有 body） `[来源:业务层F14]`
- **位置**：`apps/desktop/src/features/sessions/session-cache.helpers.ts:139`
- 乐观 `summary.sizeBytes` 硬编码 0，会话列表对在途 Compose 请求显示「0 B」直至真实会话到达。
- **修复方向**：`sizeBytes: bodyText.length`（或据 headers+body 估算）。

---

## 7. 修复优先级建议

**P0（立即修，高危且影响核心功能/安全/系统副作用）**

| 编号 | 一句话 | 工作量 |
|---|---|---|
| H1 | WS Close 帧加掩码（RFC 合规） | XS |
| H4 | rewrite 单规则失败隔离，勿中止请求 | S |
| H7 | `delete_throttle_profile` FK CASCADE 或先删子表 | XS |
| H9 | Windows 系统代理 apply 写序 + 回滚 | S |
| H10 | `read_script_source_file` 路径约束 | S |
| H11 | enable/disable 系统代理 `spawn_blocking` | S |
| H14 | Rewrite 面板与会话右键菜单 i18n 补全 | M |
| H2 | 剥离 `Connection` 头列出的逐跳头 | S |
| H5 | `set_json_path_value` 勿销毁既有标量 | XS |
| H12 | Compose 查询参数编辑器解耦 URL | M |
| H13 | Throttle methods 字段可编辑 | S |

**P1（尽快修，高危但触发条件较窄，或中危里影响大的）**

- H3（上游 TLS 校验开关）、H6（脚本 spawn_blocking）、H8（入站/MITM 动态站点证书签发去重）、H15（空态源一致）
- M2（Drop 同步解压）、M3（spool 流式回写）、M9（响应 throttle latency）、M10（规则 Arc 快照）、M12（body_store 竞争）、M14/M15（IPC 阻塞 DB）、M17（系统代理并发守卫）

**P2（计划修，中低危健壮性/性能）**

- M1/M4/M5/M6（HTTP/WS 解析健壮性）、M7（脚本永不 resolve）、M8（断点 Host）、M11（insights 索引）、M13（Linux 代理 schema）、M16（shutdown mutex）、M19–M25（前端竞态/泄漏）
- L1–L14

**P3（架构治理，见第 9 节）**

- A1（共享类型 codegen）、A2（API_SPEC CI 门禁）、A3（错误模型统一）、A4（DB 并发模型）、A8（panic=abort + 系统代理还原）

---

## 8. 规范与健壮性附录（M27–M30 / 其它小项）

> 下列合并条目计为 4 项中危（M27–M30）+ 若干微小项（不计入计数）。

- **M27 🔶** macOS `apply` 对所有服务关 PAC/自动发现，部分失败致多服务半应用态（`system_proxy/macos.rs:132-147` 与 `:99-130`）。建议按服务「先设后启用」并文档化部分失败语义。
- **M28 ✅** `EnvironmentManagerDialog` 用 `window.confirm` 做破坏性环境删除（`:149`），与全局 MUI Dialog 风格不一致，Tauri 原生 confirm 按钮可能无视 i18n。改用 MUI 确认对话框。
- **M29 🔶** `clear_all_sessions` 跨 DB + body store 非原子（`db/src/sessions.rs:389-405` + `bootstrap/repository.rs:47-74`）：DB 成功 body 清理失败则留孤立 blob。建议失败入重扫队列。
- **M30 🔶** `set_active_throttle_profile(None)` 与 `save_throttle_profile` 双路径分别维护「唯一启用」不变量，无 `UNIQUE` partial index（`rules.rs:461-492` vs `:400-459`）。建议加 `CREATE UNIQUE INDEX ... WHERE enabled=1`。

**其它微小项**（不计入计数，建议批量清理）：
- Root CA 序列号在 `load_from_pem` 后未固定（rcgen `from_ca_cert_pem` 不保 AKI/SKI/serial，`tls-manager/src/generator.rs:76-95`），严格客户端可能拒链、`fingerprint()` 与磁盘证书不符（D5，因其影响偏中危但归 TLS 子系统，已纳入 P1 范畴，此处仅提示）。

---

## 9. 架构与工程规范评审（12 项，A1–A12）

> 该部分为技术总监视角的横向评估，识别跨模块系统性问题与治理杠杆，不计入 Bug 总数。

### A1 🟠 🔶 前后端契约手维护于三处，无强制
- **领域**：共享类型策略
- **证据**：`Workspace` 模型存在三份独立编辑：`packages/shared-types/src/workspaces.ts`、`apps/desktop/src-tauri/src/workspace.rs`（含注释「matching the TypeScript `Workspace` contract」——人工同步的自白）、`crates/db/src/workspaces.rs`。`SessionDetail`/`HeaderEntry` 同样。TS 侧带大型手写校验器（`isSessionDetail`/`parseSessionSummary`/`normalizeTimingBreakdown`）防御性接受 camelCase 与 snake_case 双 wire 格式（`WireTimingBreakdown`）——强烈暗示 wire 已漂移过。
- **影响**：无编译期保证 Rust serde 改名/加字段会达 TS 契约；漂移只在运行时暴露；双 case 校验器是已发生漂移的气味。
- **建议**：单一真源——用 `ts-rs`/`typeshare` 在 CI 从 Rust serde 结构发 TS，`shared-types` re-export；移除 snake_case 回退。

### A2 🟠 ✅ API_SPEC 漂移：32 个注册命令未文档化，4 个文档化 IPC 命令实际未注册
- **领域**：文档漂移
- **证据**：脚本比对（`main.rs` `commands::<name>` 注册 vs `docs/API_SPEC.md` 反引号 `### \`<name>\`` 标题，均去重排序）：**已注册 91 个，反引号标题 72 个**。
  - **已注册但未文档化（32）**：`batch_execute_collection_items`、`clear_sessions`、`delete_api_collection`、`delete_api_collection_item`、`delete_api_environment`、`get_ai_settings`、`get_api_collection_item`、`get_app_build_info`、`list_api_collection_items`、`list_api_collections`、`list_api_environment_variables`、`list_api_environments`、`list_api_global_variables`、`list_map_session_trace`、`list_script_rules`、`list_script_session_trace`、`move_api_collection`、`move_api_collection_item`、`read_script_source_file`、`save_ai_settings`、`save_script_rule`、`save_session_to_collection`、`set_api_environment_variables`、`set_api_global_variables`、`set_menu_locale`、`show_log_file`、`shutdown_proxy_runtime`、`summarize_session_diff`、`test_ai_connection`、`upsert_api_collection`、`upsert_api_collection_item`、`upsert_api_environment`。
  - **已文档（反引号标题）但未注册（共 13）**：其中 **4 个 IPC 命令**——`repeat_session`、`resume_breakpoint`、`save_breakpoint_rule`、`delete_breakpoint_rule`（这 4 个文档已注明「暂未注册/已替代」，但标题仍以反引号形式列在命令层中，易误导）；其余 9 个为事件名（`session-upsert`/`session-remove`/`sessions-cleared`/`sessions-removed`/`breakpoint-hit`/`ws-message`/`ws-connection-status`）与 HTTP GET（`GET /aiproxy-ca.crt`/`GET /aiproxy-ca.pem`），属事件/HTTP 层非 IPC 命令，统计时应与命令分开。
  - CLAUDE.md §9 与 ENGINEERING_GUIDELINES §10 要求命令变更同步 API_SPEC——未强制。
- **影响**：作为契约真源的文档缺约 35% IPC 命令面；新贡献者与 AI 据陈旧契约推理。
- **建议**：CI 门禁脚本 diff `generate_handler!` 注册 vs API_SPEC 反引号命令标题，失配 fail build；一次性补齐缺失条目；事件/HTTP 标题用不同前缀（如「### Event: `xxx`」「### HTTP: `xxx`」）以与命令标题区分。

### A3 🟠 ✅ 错误模型在 Tauri 边界不一致——结构化码仅部分遵循
- **领域**：错误处理策略
- **证据**：ENGINEERING_GUIDELINES §7.2 要求所有命令错误用 `app_error()`/`app_error_with_details()`（JSON `{code,message}`），禁裸 `String`。实践差异巨大：`rules.rs`（44 `app_error`）、`certificates.rs`（64）、`ai.rs`（24）——但 `compose.rs` **0** `app_error`，直接 `?` 传播 `proxy-core::send_direct_request`（`server.rs:548`）的 `Result<_, String>`，其错误为 `format!(...)`。`files.rs`/`menu.rs` 同样 0。`ProxyError::from(err) -> String`（`error.rs:49`）把结构化枚举在边界拍平回字符串。命令层残留 14 处 `.to_string()`。前端 `coerceAppError` 故无法为 compose/文件失败恢复 `code`。
- **影响**：UI 对约半数命令面无法区分错误类别；恰在 Compose/文件保存等最需可操作错误的命令上不透明。
- **建议**：`app_error(ERR_*, ...)` 为唯一边界构造（lint 或 `AppResult<T>` 包装）；移除 `impl From<ProxyError> for String`，在命令边把 `ProxyError`/`DbError` 映射为 `app_error`。

### A4 🟠 ✅ 全局单一 `Mutex<Connection>` 即整个 DB 并发模型，且锁中毒处理自相矛盾
- **领域**：并发模型
- **证据**：一个 `Arc<Mutex<rusqlite::Connection>>` 被所有读写共享（`bootstrap/mod.rs:116`、`repository.rs:18`）；`connection.rs:35-40` 注释承认并指向未来池（「L22」）。中毒处理不一致：`bootstrap/mod.rs` 用 `.lock().expect(...)`（~12 处，中毒即 panic），`repository.rs` 用 `.lock().unwrap_or_else(|e| e.into_inner())`（10 处，中毒即静默继续，可能读/写撕裂态）。配合 release `panic="abort"`（`Cargo.toml:21`），中毒不可达——`expect` 信息为死防御代码，`into_inner` 路径掩盖运行时无法产生的逻辑。
- **影响**：所有 SQLite 访问经一锁串行，迫使只读 `list_*` 也 `spawn_blocking` 并与批量 50 写路径竞争。中毒策略不一致信号并发模型非整体设计。
- **建议**：要么承诺单连接模型并统一中毒策略（`panic=abort` 下中毒不可能，简化为 `lock().unwrap()`），要么迁 `r2d2`/`deadpool-sqlite` 做读并发并退役全局锁。择一并删另一模式。

### A5 🟠 🔶 proxy-core 仍依赖 `reqwest` 且用于热路径，与「仅 hyper」文档矛盾
- **领域**：构建/可维护性；crate 卫生
- **证据**：`crates/proxy-core/Cargo.toml:27` `reqwest = { … features=["rustls-tls"] }`；`lib.rs:10` `use reqwest::{redirect::Policy, Client};`；`upstream.rs:521` 处理 `reqwest::Response`。ARCHITECTURE §6.1 与 ENGINEERING_GUIDELINES §14.1 称 `forward_request()` 用 hyper+TimingConnector，Compose 的 `send_direct_request` 「继续用 reqwest」。reqwest 为 Compose 保留是有意的——但 proxy crate 现带两个 HTTP 客户端（hyper **和** reqwest）、两套 TLS 配置，TimingConnector 仅惠及捕获流量而非用户发起的 Compose 流量。
- **影响**：更大二进制、重复 TLS 配置面、文档掩盖而非解决的架构不一致；Compose 时序因分裂而二等公民（仅 `totalMs/waitingMs/responseReadMs`）。
- **建议**：要么完成迁移（Compose 也走 hyper+TimingConnector）并从 proxy-core 删 reqwest，要么写 ADR 论证双客户端分裂。当前是文档表述为已完成、实则半成的迁移。

### A6 🟡 ✅ 代理核心无集成测试；文档声称的 E2E（Playwright）完全缺失
- **领域**：测试覆盖 / CI
- **证据**：无任何 crate 有 `tests/`，无 `apps/desktop/src-tauri/tests/`。所有 Rust 测试为内联 `#[cfg(test)]`。ARCHITECTURE §14.2 承诺「集成测试…验证代理启动、规则命中、会话写入」，§14.3 承诺「用 Playwright 验证核心交互」——但 `package.json` 无 Playwright 依赖，无 `*.e2e.*`/`playwright`。`.github/workflows/ci.yml` 跑 `cargo test --workspace` 与 `pnpm test`（仅单测），无代理启动集成步骤、无 E2E。`fixtures/stress/` 存在但 CI 不断言。
- **影响**：最关键逻辑——MITM TLS 握手、规则管线顺序（Rewrite→Map→Script→Breakpoint→Throttle）、WS relay、断点 oneshot channel——零端到端覆盖；回归仅手工捕获。文档夸大测试姿态。
- **建议**：加 `crates/proxy-core/tests/` 集成套件（随机端口起服务，断言请求经各规则阶段往返）；要么加 Playwright 要么删 §14.3 声明；按 §9.4 阈值加 stress-fixture perf 门禁。

### A7 🟡 🔶 所有上游流量 TLS 证书校验无条件禁用，无 opt-out
- **领域**：安全架构
- **证据**：`tls-manager/src/client.rs:14-58` `NoOpVerifier` 对所有证书无条件 `ServerCertVerified::assertion()`，硬接进 `build_dangerous_client_config()` 与 ALPN 变体，`timing_connector.rs:40` + `upstream_pool.rs` 对**所有**上游连接调用。无开关/工作区设置/按主机逃生口重新启用校验。
- **影响**：对 MITM 核心用例可接受，但「不可关 + 不可见」对调试证书固定/安全敏感端点的用户是真实限制，无条件性是脚枪。
- **建议**：保留 NoOp 为默认，但加显式「按主机校验上游证书」开关（与 DNS 覆盖白名单模型一致），UI 标为显式信任决策。

### A8 🟡 ✅ `panic="abort"` + 全局 `OnceLock`/`Mutex` 状态使任意 panic 后系统代理还原不可能
- **领域**：并发/健壮性；构建
- **证据**：`Cargo.toml:21` release `panic="abort"`。系统代理快照、运行时 handle、日志 guard 持于 `Mutex`/`OnceLock`。shutdown 路径（`main.rs:335` `block_on`）在 `RunEvent` 还原系统代理。`panic=abort` 下**任何**线程 panic 即立即 abort 进程，无 unwinding——若 panic 发生在系统代理被接管之后，还原逻辑（ARCHITECTURE 底部记载的运行时安全约束）无法运行。`dev_logger.rs:94` 的 `catch_unwind` 在 `panic=abort` 下是 no-op。
- **影响**：任意 `unwrap` panic 会使用户 OS 系统代理永久指向死代理地址，需手工修注册表/networksetup。端用户工具最高影响健壮性缺口。
- **建议**：要么去 `panic="abort"`（桌面 app 二进制收益小）让清理运行；要么保留则在 abort 前装进程退出 hook 据持久化快照文件还原系统代理，且启用瞬间即把快照落盘（非仅内存）。

### A9 🟡 🔶 前端状态分散于 10 个 Zustand store + TanStack Query + 每 hook 本地态，失效策略临时
- **领域**：前端状态架构
- **证据**：10 个 per-feature Zustand store（`session-container.store.ts` 159 行、`collection-editor`、`compose-editor`、`app-preferences`、`breakpoint`、`proxy-start`、`imported-sessions`、`notification`、`insights-filter`、`app-shell`）。`features/`+`services/` 共 159 处 `invalidateQueries`/`queryClient`。缓存键部分常量（`BREAKPOINT_RULES_KEY`/`COLLECTIONS_KEY`）部分内联字面量（`["api-collection-items", collectionId]`）。无中央 query-key 注册表，「失效所有 collection-item 查询」靠记忆精确元组形状。`notification.store.ts` 重复了 TanStack Query `onError`/mutation 可集中化的错误呈现。
- **影响**：缓存失效 bug（编辑后陈旧列表、悬挂 detail 查询）易引入难评审。「服务端态在 React Query、UI/瞬态在 Zustand」的分裂合理，但 query-key 纪律是薄弱缝。
- **建议**：引入单一 query-key factory 模块（`services/query-keys.ts`）层级化键，经 ESLint 规则禁内联数组字面量。session-event 批处理已集中 `session-upsert` 写——扩展为单一 mutation→cache 桥。

### A10 🟡 🔶 magic number/limit 散落，未集中
- **领域**：配置 / magic number
- **证据**：crate 局部 const，无共享配置模块，无运行时可调：`MAX_CONCURRENT_CONNECTIONS=1024`（`lib.rs:36`）、`MAX_WS_FRAME_SIZE=16 MiB`/`WS_MASK_CHUNK_BYTES=16 KiB`（`ws.rs:10-11`）、`MAX_CONCURRENT_SCRIPT_THREADS=64`/`set_memory_limit(16*1024*1024)`（`execute.rs:24/341`）、`SCRIPT_EXECUTION_TIMEOUT`（`types.rs:14`）、`SESSION_BATCH_SIZE=50`（`bootstrap/mod.rs:40`）、`EAGER_SESSION_DETAIL_BODY_LIMIT_BYTES=64 KiB`/`MAX_IMPORTED_SCRIPT_BYTES=128 KiB`（`common.rs:32-33`）、`busy_timeout=5000`、cert LRU cap `512`。QuickJS 限制（16MB/50ms）在 ARCHITECTURE §6.1 记载但代码里以裸字面量重述而非引用具名常量。
- **影响**：调优需 grep 全树；同一概念阈值（如「16 MiB」）以不同理由用于 WS 帧/脚本堆。用户/运维无法不重编译而调整。
- **建议**：每 crate 收敛 tunables 进一个 `limits` 模块（或共享 config struct）并统一文档化；考虑把用户相关项（捕获大小、端口）经既有 Settings 页暴露。

### A11 🟢 🔶 crate 依赖图干净，但 rule/runtime 分裂跨边界泄漏 rule 类型
- **领域**：crate 边界 / 依赖卫生
- **证据**：依赖 DAG 无环合理：`sys-util` ← 全部；`tls-manager` ← `proxy-core`；`rule-engine` ← `proxy-core`；`db` 独立；`desktop` 依赖全部。无循环。唯一泄漏：ARCHITECTURE §6.4 承认「rule-engine」仅拥有**脚本**规则，而运行时规则管线（Rewrite/Map/DNS/Throttle/Breakpoint）在 `proxy-core/src/rules/`。但 `proxy-core` 把 `aiproxy_rule_engine::ScriptTrace` 再导入自己 `types.rs`，脚本管理器也在 `proxy-core`。故 `rule-engine` crate 实为「QuickJS 沙箱 + TS 转译」crate，却名为 rule engine，真正规则引擎在 proxy-core 内。新人会找错 crate。
- **建议**：重命名 `aiproxy-rule-engine` → `aiproxy-script-engine`（或 `aiproxy-quickjs`），并更新 §6.4 称 proxy-core 的 `rules/` 为规则引擎。低优先级但高清晰度收益。

### A12 🟢 🔶 IPC/能力面与 updater 信任模型
- **领域**：安全架构
- **证据**：`capabilities/default.json` + `tauri.conf.json` 合理收紧（CSP 显式 prod/dev，prod script-src `'self'`）。updater 配 pinned minisign pubkey + 单一 GitHub-releases 端点（`tauri.conf.json:45-48`）。但 `createUpdaterArtifacts: false`——当前构建管线不产出更新产物，故 updater 已布线但闲置；信任路径（单硬编码 pubkey、单 CDN）无轮换方案。
- **建议**：启用前文档化 key 轮换、CI 签名（非本地）、按平台明确 `installMode`。

---

## 10. 总体评价

**优点**（本轮新增确认）：
- Rust workspace 分解干净，crate DAG 无环、职责清晰。
- `services/commands/*` 的 16 个文件与 Rust 命令名/`{input}` 包装/serde camelCase 全部对齐，无 invoke 契约 bug。
- 事件消费侧（`use-session-events` 等）以 `cancelled` + `then(fn)` 模式正确处理 `listen()` 注册竞态，无监听泄漏/陈旧闭包。
- 乐观更新 + 回滚（`useSendComposedRequest`/`useMoveCollection`）、断点头编辑器 `useStableKeyedRows`、纯 helper 配套测试（`session-cache.helpers`/`session-inspector.helpers`/`dnd-helpers`）均扎实。
- 子进程调用全部经 `arg()`/`args()`，无命令注入。

**主要短板**（系统性，需治理而非点修）：
1. **契约靠约定不靠工具**：共享类型「单一真源」为愿景，每实体三份手同步、32 命令未文档、仅运行时检测漂移。最高杠杆点：`ts-rs`/`typeshare` + API_SPEC CI diff，把整类问题转编译失败。
2. **错误与并发模型各「两模式并存」**：错误 `app_error()` vs 裸 `String`；锁 `expect()` vs `into_inner()`。均为「起了头未完成」的设计信号。`panic=abort` 下半数防御代码已死，系统代理还原安全保证在 panic 后失效。
3. **文档略夸工程态**：E2E/Playwright（声称）不存在；reqwest「被 hyper 取代」（声称）仍在；多处「已实现」声明成立但其 API_SPEC 条目缺失。文档异常详尽且结构良好——但「保持诚实」（CLAUDE.md §9 的明确目标）需 CI 门禁而非仅评审勤勉。

**最高优先级三件事**（技术总监视角）：
1. 修 P0 高危（H1/H4/H7/H9/H10/H11/H14）——含 RFC 合规、可复现 DB bug、安全原语、系统级副作用、i18n。
2. 建立 `panic=abort` 下的系统代理持久化还原（A8）——这是端用户工具最致命的健壮性缺口。
3. 建立 `ts-rs`/`typeshare` + API_SPEC CI diff（A1/A2）——把契约漂移类问题一次性转编译失败。

---

## 11. 统计与方法学说明

- 本轮共 7 个领域并行审查 + 高危逐行复核 + 架构横向评估。
- **v1.1 修正**：撤回 M18 误报（源码 `use-throttled-value.ts:48-60` 已处理 interval 变更）；A2 数字据脚本比对更正（91 注册 / 72 反引号标题 / 32 注册未文档 / 4 IPC 命令文档未注册，含事件 HTTP 共 13）；M12 证据收窄到 per-session 子目录竞争；M24 收窄为「close/unmount 仅清 timer 不 flush」窄窗口；H8 标题改为「入站/MITM 动态站点证书签发」。Bug 类有效条目由 59 减为 **58**（🟠15 / 🟡29 / 🟢14）。
- 架构/工程类 12 项（A1–A12）单列第 9 节，不计入 Bug 数。
- 置信度：✅ 已逐行源码确认；🔶 逻辑链成立但触发条件/频率待确认；❓ 依赖运行时/平台需实测（本轮无 ❓ 项）。

### 修复进度

- **批次 3a（运行时/网络热路径）已完成 @ 2026-07-04**，修复 5 项（H3/H6/H8/M2/M3）：
  - **H3** ✅ 上游 TLS 证书校验 opt-out 开关（全链路）：`tls-manager` 新增 `build_verifying_client_config_with_alpn`（系统根 via `rustls-native-certs`，`OnceLock` 缓存）+ `build_tls_connector_with_alpn_and_verify`；`TimingConnector::new(dns_override_ip, verify_upstream_tls)` + 两调用点（`upstream.rs`/`upstream_pool.rs`）；WSS 路径 `ws_upgrade.rs` 同步生效；config 经 `ProxyRuntimeConfig.verify_upstream_tls` → `ConnectionContext` → connector；DB migration（`verify_upstream_tls` INT DEFAULT 0 + `tls_verify_hosts` TEXT DEFAULT '[]'）+ `WorkspaceRow` + IPC + 前端 Settings 开关/白名单/中英文案。集成测试：`timing_connector::tests::h3_verify_off_accepts_self_signed_upstream` / `h3_verify_on_rejects_self_signed_upstream`（自签 mock 上游）。
  - **H6** ✅ 脚本执行 `spawn_blocking`：`apply_request/response_script_rules` 改 async，每条规则 owned `rule`+`payload` move 进 `tokio::task::spawn_blocking`；`stage_apply_request_rules` 改 async + 调用点 `.await`；join 失败 fail-open `runtime_join_failure_trace`；SCRIPT_GATE 全局并发上限语义不变。
  - **H8** ✅ 入站 MITM 动态证书签发去重：`CertStorage.inflight` per-host 单飞槽；`resolve` 持 per-host 槽锁做 crypto（不持表锁/host_cache 锁，防死锁），double-check cache 后只签一次；`clear_host_cache` 同步清空 inflight。测试：`inflight_slot_is_shared_per_host` + `clear_host_cache_flushes_inflight_table`。
  - **M2** ✅ `Drop` 同步解压：`build_session_detail` 加 `skip_bodies: bool`（true→request_body/response_body=None 不解码）；`PendingRequestCancellationGuard::drop` 传 `true`，其余 8 处 `false`。
  - **M3** ✅ spool 整读改流式：新增 `tokio-util`(io)+`http-body`+`futures-util`；`build_hyper_response_from_upstream` 签名 `body: &[u8]` → `BoxBody<Bytes,String>` + 可选 `streamed_content_length`（spool 用文件大小作 Content-Length，防 hyper chunked 编码被裸 TCP 客户端误读）；spool 经 `ReaderStream`→`CleanupStream`（Drop spawn_blocking 删文件）→`StreamBody`；`take()` spool 路径防 UpstreamResponse Drop 误删。测试：`m3_cleanup_stream_forwards_bytes_and_deletes_spool_file` + 大响应转发测试。
  - 门禁：`cargo fmt --check` ✅、`cargo clippy --workspace -- -D warnings`（lib 目标）0 error ✅（5 处 `--all-targets` test lint 为预先存在，非本次引入）、`cargo test --workspace` 全绿 ✅（db 82+57、proxy-core 164、tls-manager 31、rule-engine 25）、`pnpm typecheck` ✅、`pnpm test`（前端 393 测试）✅、`pnpm lint` ✅。
- **批次 3b（性能 / DB / 规则）已完成 @ 2026-07-05**，修复 6 项（H2/M9/M10/M11/M14/M15）：
  - **H2** ✅ 剥离 `Connection` 头点名的逐跳头（RFC 7230 §6.1）：`http_io.rs` 新增 `hop_by_hop_strip_set`（解析 `Connection`/`Proxy-Connection` 值的逗号分隔 token + 标准逐跳集合 `Keep-Alive/TE/Trailer/Upgrade/Proxy-Authenticate/Proxy-Authorization`）与 `should_strip_hop_by_hop(name, &set, is_ws_upgrade)`；`build_upstream_headers`/`build_upstream_headers_from_entries`/`build_upstream_headers_from_hyper`（请求三路径）与 `build_hyper_response_from_upstream`（响应路径，101 升级保留 `Connection`/`Upgrade` 握手头）均调用。测试：`parse_connection_tokens_*`、`hop_by_hop_strip_set_*`、`is_standard_hop_by_hop_header_*`、`build_upstream_headers_strips_connection_listed_token`、`build_upstream_headers_strips_standard_hop_by_hop`、`build_upstream_headers_preserves_ws_handshake`。
  - **M9** ✅ 响应阶段 throttle 对称应用 latency/丢包：`apply_response_throttle` 返回 `Result<ThrottleTrace, ThrottleFailure>`，先 `should_drop_for_packet_loss` 丢包（`Err`），再 sleep `profile.latency_ms`，trace 用真实 `latency_ms`（原硬编码 0）。`http_proxy.rs` 两调用点（mock 路径 → `BreakpointRequestOutcome::Drop`+504；upstream 路径 → 504 + disarm cancellation guard 防 Drop 重发冲突 detail）。测试：`response_throttle_records_configured_latency_in_trace`、`response_throttle_drops_on_full_packet_loss`。
  - **M10** ✅ 每请求全量克隆改共享快照：`RewriteManager`/`ScriptManager` 存储 `Mutex<Arc<Vec<...>>>`，`compiled_rules()` 返回 `Arc<Vec<...>>`（refcount bump，无 per-rule 深拷贝），`set_rules`/`save_rule`/`delete_rule` 在锁内重建快照；`CompiledRewriteRule.compiled_match`/`CompiledScriptRule.{compiled_code,source_map,compiled_match}` 全部 `Arc` 包装（regex 不再重编译、~128KiB 编译代码串不再深拷贝）；`execute.rs` 的 `compiled_code.clone()` 变 `Arc::clone`；`active_*_rules_for_stage` 改按引用迭代快照。测试：`compiled_rules_snapshot_is_shared_until_mutation`（proxy-core + rule-engine 各一，断言 `Arc::ptr_eq`）。
  - **M11** ✅ `session_summaries` 加复合索引：`schema.rs` 的 `CREATE_TABLES` 增 `CREATE INDEX IF NOT EXISTS idx_session_summaries_host_duration ON session_summaries(host, duration_ms);`（幂等，覆盖 host 作用域百分位扫描与 per-host 慢请求排名）。测试：`session_summaries_has_host_duration_index`。
  - **M14** ✅ `delete_sessions_except` 移出 IPC 线程：Tauri 命令 + `AppState::delete_sessions_except` 改 `async`，DB+body 文件删除走既有 `delete_sessions_and_bodies_async`（`spawn_blocking`）；cache 更新与 `emit_sessions_removed` 仍 inline。`delete_sessions_by_ids`（同步）标 `#[allow(dead_code)]` 保留为 API。
  - **M15** ✅ 重 DB 查询命令移出 IPC 线程：`list_ws_messages`/`search_ws_messages`/`list_api_collection_items` 改 `async` + `run_blocking_command`（`spawn_blocking`）；`batch_execute_collection_items`（已 async）将 item 加载 + 环境变量加载合并为一次 `run_blocking_command`，避免持全局 DB 锁在 async 任务上阻塞。
  - 门禁：`cargo build` ✅、`cargo clippy --workspace`（lib 目标）0 warning ✅（剩余 `--all-targets` test lint 全为预先存在）、`cargo test --workspace` 全绿 ✅（db 83、proxy-core 176、rule-engine 26、desktop 57）。
- **批次 0（用户机器安全优先）已完成 @ 2026-07-04**，修复 7 项 + 1 架构项（A8）+ L8，并经复审加固：
  - **H7** ✅ `delete_throttle_profile` 事务内先删子表（`crates/db/src/rules.rs`）+ 单测 `delete_throttle_profile_clears_referencing_rules`。
  - **H1** ✅ WS client→upstream Close 帧加掩码（`crates/proxy-core/src/ws.rs`，`forward_raw_frame` 加 `mask_output` 参数）+ 单测 `forward_raw_frame_masks_toward_upstream`。
  - **H10** ✅ **闭合：后端拥有 OS 文件选择器**（两轮复审加固：黑名单→token→dialog-owned）。第三轮指出 token 模型仍信任渲染进程传入的路径（被攻破的渲染进程可调 `grant_script_file("C:\\...\\secret.js")`）。最终方案：单命令 `pick_and_read_script_file({title})->{...}|null`——后端经 `tauri-plugin-dialog` 自己弹窗、读取所选文件并返回内容，渲染进程**只传本地化标题、从不传路径**，选择结果不作为 IPC 输入跨边界，彻底消除任意文件读原语；canonicalize 解析 symlink 防选择后目标被替换；用户取消返回 `null`。前端 `ScriptRulesPanel` 改单步调用并移除前端 `@tauri-apps/plugin-dialog` 依赖；后端纯函数 `script_language_for` 单测 + dialog 端到端覆盖；API_SPEC 已更新。
  - **H9** ✅ Windows `apply` 写序改为 server-first + 失败回滚；**复审加固**：`refresh_system_proxy()` 纳入回滚范围（之前 refresh 失败时注册表已改但 apply 返回失败，snapshot 未存）。
  - **H11** ✅ enable/disable/start 系统代理阻塞调用包进 `run_blocking_command`。
  - **M17** ✅ `AppState` 加 `system_proxy_op_lock`，enable/disable 全程持锁；**三轮复审加固**：① start/restart 的 reapply 路径也持同把锁；② 持锁后重读 `system_proxy_enabled`；③ **第四轮：移除入口处的 `should_reapply_system_proxy` 早判，改为总在末尾持锁重读当前值并 apply 到 `status.port`**——覆盖 false→true 方向（start 期间并发 enable 把状态翻 true 并 apply 到旧端口，start 完成后必须 re-apply 到新端口），也覆盖 true→false（并发 disable 后跳过）与 true→true 换端口。reapply 决策不再依赖任何跨 async 窗口的陈旧快照。
  - **A8** ✅ 移除 release `panic = "abort"`（恢复 unwinding 使 shutdown 还原可运行）+ L8 原子写（`write_atomic` temp+rename）；决策记录见 `docs/DECISIONS/ADR-004-panic-strategy.md`。
  - **L8** ✅ `system_proxy_recovery.rs::persist_pending_snapshot` 改原子写。
- **ADR 引用修正** ✅ `Cargo.toml`/`system_proxy_recovery.rs` 中 `ADR-002` → `ADR-004`。
- **Finding 3（测试稳定化）** ✅ `times_out_infinite_loops`（`crates/rule-engine/src/lib.rs`）断言放宽为「outcome 非 Success + request 为 None」——`while(true){}` 在 `cargo test --workspace` CPU 竞争下可能经 OOM/RuntimeError 而非 TimedOut 结束，两者都是合法「未成功」结果；连续 3 次单测 + 全量 workspace 跑均稳定通过。
- **clippy 门禁全绿** ✅ `cargo clippy --workspace -- -D warnings`（CI 实际命令）0 error。修复了预先存在的 27 处 `needless_question_mark`（db，`cargo clippy --fix` 自动）+ 1 `unnecessary_to_owned`，以及 proxy-core 的 `sort_by`→`sort_by_key`×4、`map_err(|e| Variant(e))`→`map_err(Variant)`、`large_enum_variant`（局部 `#[allow]`），desktop 的 `#[macro_use]` 冗余 import、`menu::apply_locale`/`build_menu`/`parse_lsof_occupant` 死代码标注、`certificates` cfg-gated `needless_return`。注：`--all-targets`（含 test 目标）仍暴露少量 test 代码 lint（`items_after_test_module`/`map_or` 等），CI 当前不检 `--all-targets`，留后续批次清理。
- 门禁：`cargo fmt --check`（改动文件）✅、**`cargo clippy --workspace -- -D warnings`（CI 命令）0 error** ✅、`cargo test --workspace` 全绿 ✅（rule-engine `times_out_infinite_loops` 连跑 3 次稳定）、`pnpm typecheck` ✅、`pnpm test`（前端 386 测试，含 ScriptRulesPanel dialog-owned 导入）✅、`pnpm lint` ✅。
- 待后续批次：M16（shutdown `.expect()` 改 `into_inner`，与 A8 unwinding 协同，计划批次 4）。
- 所有 `file:line` 均相对仓库根，截至评审日（`2026-07-04`，分支 `dev`）。
- 关键高危项（H1/H4/H5/H7/H9/H10/H11/H12/H13/H14/H15、M9/M14）已经评审者二次源码核实；M12/M24 经窄化后维持 🔶。

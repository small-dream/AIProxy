# AIProxy 全仓代码审查报告（2026-11-05）

- **审查对象**：`master` / `v0.4.2`（commit `48d9b67`）。审查前已执行 `git fetch` + `git pull --ff-only`，工作区从 `e66a553`（v0.2.5 之后）快进 **17 个提交**（144 文件，+23079 / -1352），工作区干净。
- **审查范围**：`crates/*`（proxy-core、rule-engine、tls-manager、db、agent-control、mcp-server、sys-util）、`apps/desktop/src-tauri`、`apps/desktop/src`、`packages/shared-types`、`.github/workflows`、`scripts/*`、`docs/*` 与 `apps/desktop/user-guides/{zh-CN,en}`。
- **审查方式**：
  1. 主审先读 `docs/CODE_REVIEW_2026-11-01.md` 的修复进度与已核查结论，避免重复；
  2. 按 7 个领域并行只读子代理深审（proxy-core、desktop Rust automation/grants、DB/agent-control、MCP、前端 automation/rules、前端 agent-access、文档/CI 横切）；
  3. 主审逐条回读所有 P1 与约 70% 的 P2 代码；其余标注为子代理证据；
  4. 门禁：`typecheck` / `lint` / `cargo fmt` / `cargo test`（重建 sidecar 后）/ `shared-types test` 通过；`check:api-contract`、全量前端测试、Windows `clippy -D warnings` 未通过（见 §7）。
- **证据口径**：`复核 ✓` 表示主审已回读代码语义；`子代理` 表示由子代理给出逐字证据、主审未逐行复核，按低一档置信度对待；`待确认` 表示触发依赖环境或产品意图。

---

## 1. 结论概览

| 级别 | 条数 | 说明 |
|---|---|---|
| P0（严重） | 0 | 未发现无条件破坏核心链路的问题 |
| P1（高） | 3 | CI 契约门禁必红、授权额度策略可被客户端绕过、Windows Map Local 目录越界 |
| P2（中） | 31 | 特定条件下功能失效、证据失真、配置静默丢失、安全边界弱化 |
| P3（低） | 35（去重后） | 健壮性、可排障性、跨平台一致性、展示层与文档缺口 |
| **合计** | **69** | 无架构性返工需求；P1 均为局部可修 |

> 说明：P3 小节共 37 条 bullet，其中“verify 不持锁”与“授权列表隐藏状态”分别与 P2-31 / P2-21 同源，按去重后 35 条计。

**总体评价**：v0.4.2 把自动化实验（rewrite/map + 证据链）、Agent 限时授权、MCP 文本搜索三项大功能引入了主干，模块划分与类型契约总体清晰，新增代码普遍带测试。但本轮暴露出五类横切缺口：

1. **门禁与文档契约脱节**：代码已注册的 5 个 automation 命令在 API_SPEC 里不是契约脚本可识别的形式，`pnpm check:api-contract` 在 master 上直接失败；release checklist 又不跑这一步。
2. **安全策略“双端复核”只做了一半**：grant 的额度/审批选项仍由 sidecar 自报，桌面端没有按能力白名单收敛；Windows 上 `agent-grants.json` 的 ACL 失败被吞掉。
3. **自动化状态机在失败路径上语义漂移**：`publish_failed` 重试返回旧状态、`reverted/aborted` 幂等重放被当作成功、启动恢复失败后 host_lock 整体丢失、TTL 清理失败被静默吞掉。
4. **证据链会给出与真实链路相反的结论**：offline 验证对 response 阶段规则、HTTP/2 body rewrite、被回滚的旧证据都没有降级标注。
5. **前端安全/一致性门禁被绕过或未兑现**：连接流程跳过二次确认、预设匹配忽略 grant policy、审批对话框不可关闭、change 快照的 `headerName/value` 未脱敏。

---

## 2. P1：高优先级（建议本轮修复）

### P1-1 `pnpm check:api-contract` 在 master 上必然失败，CI 契约门禁形同虚设

| 项 | 内容 |
|---|---|
| 位置 | `.github/workflows/ci.yml:72-73`、`scripts/check-api-contract.mjs:90-106,177-184`、`docs/API_SPEC.md:2741-2758`、`apps/desktop/src-tauri/src/main.rs:317-321` |
| 复核 | ✓（本地实际运行） |

`docs/API_SPEC.md` 用一个小节 + 无标注 TypeScript 代码块记录 automation 命令：

```ts
list_automation_changes(limit?: number): AutomationChangeView[];
get_automation_change(changeId: string): AutomationChangeView;
rollback_automation_change(input: {...}): AutomationApplyResult;
promote_automation_change(changeId: string): AutomationChangeView;
clear_agent_automation(input: {...}): ClearAgentAutomationResult;
```

而契约脚本只识别 `### \`命令名\`` 标题或反引号包裹的 `name(` 形式，因此把这 5 个已注册命令判为“注册但未文档化”。本地实测：

```
[check-api-contract] FAIL: Commands registered in main.rs but missing from docs/API_SPEC.md:
  - clear_agent_automation
  - get_automation_change
  - list_automation_changes
  - promote_automation_change
  - rollback_automation_change
[exit code: 1]
```

**影响**：任何 push 到 `master` / PR 的 Verify 都会红；而 `scripts/release-checklist.sh` 与 `release.yml` 都不执行该步骤，本地发版检查可以全绿、CI 却红——发布门禁与真实门禁不一致，且该不一致已持续存在。

**修复建议**：给 5 个命令补 `### \`name\`` 标准小节（含参数、返回值、错误码），或扩展脚本接受该 TS 代码块；同时把 `pnpm check:api-contract` 加进 `release-checklist.sh` 与 `docs/RELEASE_GUIDE.md`。补一条测试：新增 command 未在 API_SPEC 出现时脚本必须失败。

---

### P1-2 授权额度与审批选项由 sidecar 自报，桌面端未按能力收敛：高风险动作可获批 15 分钟 / 50 次

| 项 | 内容 |
|---|---|
| 位置 | `apps/desktop/src-tauri/src/agent_grants.rs:428-450`（`validate_request`）、`:245-257`（`approve`）、`apps/desktop/src-tauri/src/agent_control.rs:649-662`（`preflight_request`） |
| 复核 | ✓ |

`validate_request` 的唯一高风险约束是客户端自报的 `non_idempotent`：

```rust
if request.non_idempotent
    && request.approval_options.iter().any(|option| *option != Once)
{
    return Err("Non-idempotent actions can only be approved once");
}
```

桌面端从不检查“当前 `capability` 是否允许 15 分钟 / 50 次”，也不检查 `non_idempotent` 是否属实。`approve` 也只校验 `grant.approval_options.contains(&input.option)`，而 `approval_options` 完全来自请求。于是同用户进程只要读到 `agent-control.json` 的 token（`0600`，同用户可读），就可以：

- 对 `deleteSessions`、非幂等的 `replaySession`、`controlSystemProxy`、`manageUserAutomation` 等能力，传 `nonIdempotent=false`、`approvalOptions=["once","fifteenMinutes"]`；
- 审批卡会展示“允许 15 分钟”按钮（`AgentGrantApprovalHost.tsx:131` 直接读 `approvalOptions`），用户批准后同一动作指纹可在 15 分钟内执行最多 50 次。

**影响**：直接违背 ADR-011 §3「非幂等动作与高风险能力只提供 once」与 §7「桌面端在 IPC 边界重新校验」；审批卡对 `deleteSessions` 显示 15 分钟选项本身就会误导用户。利用前提是该能力已被用户设为「请求时询问」，且动作指纹绑定具体参数，因此爆炸半径是“同一动作重复执行”，而非任意 50 个不同目标；但一次批准覆盖 50 次高风险副作用仍不符合 ADR 承诺。ADR-011 §5 承认同用户信任边界较高，但明确要求桌面端双重校验，当前校验只覆盖“指纹是否匹配”。

**修复建议**：桌面端维护 `capability -> allowed approval options` 白名单（高风险只 `once`），`request()` 直接拒绝越界选项，`approve()` 再裁剪一次；`non_idempotent` 仅作辅助信号，不作为唯一判据。补两组用例：高风险能力传 15 分钟必须失败；伪造 `nonIdempotent=false` 不能获得多额度。

---

### P1-3 Windows Map Local：请求路径首段为盘符时 `PathBuf::push` 替换映射目录，可读取目录外文件；preview 会把内容回传

| 项 | 内容 |
|---|---|
| 位置 | `crates/proxy-core/src/rules/map.rs:96-108`（`sanitize_request_path`）、`:194-215`（拼接与读取）；放大器 `crates/proxy-core/src/rules/preview.rs:155-174` |
| 复核 | ✓（路径语义由子代理用本机 rustc 1.96 验证；跨盘解析基址待确认） |

`sanitize_request_path` 只丢弃空段、`.`、`..`，不拒绝含冒号的段：

```rust
for segment in path.trim_start_matches('/').split('/') {
    if segment.is_empty() || segment == "." || segment == ".." { continue; }
    relative.push(segment);   // "C:" 会进入 PathBuf
}
```

在 Windows 上 `PathBuf::push("C:")` 得到一个带 `Prefix::Disk` 的相对路径，而 `PathBuf::push` 对“有前缀”的路径会**整体替换**当前值。于是 `target_canon`（映射目录）被丢弃，后续 `resolved_path.push("Windows")` 得到 `C:Windows\...`，再经 `fs::canonicalize` / `is_file` / `fs::read` 读出映射目录之外的文件。新增的 offline preview 会把这份字节以 base64 回传给调用方（`preview.rs:155-174`），使“本地代理越权读文件”进一步变成“Agent 可直接取回文件内容”。

**触发**：Windows + 目录型 Map Local 规则 + 请求路径首段形如 `C:`（如 `GET /C:Windows/win.ini`）。上一轮报告已把它列为 P3（“PathBuf::push 的前缀替换语义可让 Map Local 逃出映射目录”），本轮未修，且 preview 放大了影响。

**修复建议**：`sanitize_request_path` 拒绝含 `:` 的段，或对 `Path::components()` 出现非 `Normal` 组件即拒绝；拼接后 `canonicalize` 并校验 `canonical.starts_with(target_canon)`。补 Windows 单测：`/C:...`、`/..%5C`、盘符与 UNC 前缀。

---

## 3. P2：真实缺陷（特定条件触发）

| # | 位置 | 问题 | 后果 | 复核 |
|---|---|---|---|---|
| P2-1 | `crates/proxy-core/src/rules/preview.rs:137-153` + `automation.rs:2630-2665` | 无 `baselineSessionId` 时不执行 response 阶段规则 | 含 `stage:"response"` 的 change 做 offline 验证恒为 `not_matched`，Agent 误判规则未生效并回滚/重复注入 | ✓ |
| P2-2 | `crates/proxy-core/src/http_proxy.rs:1081-1087`、`:506-510` | 断点 Drop 先按真实上游响应写会话再返回 204/断连；请求阶段 Drop 完全不写会话 | Inspector/MCP 显示 200+完整响应，客户端实际收到 204；请求断点命中不可见（上轮 P2-3 未修） | 子代理 |
| P2-3 | `crates/proxy-core/src/rules/rewrite.rs:200-246` | Body Fields 走 `serde_json` 解析 + 重序列化 | 数字字面量、转义、空白被规范化，签名接口必失败；preview 也把规范化结果当真实结果（上轮 P2-8 未修） | 子代理 |
| P2-4 | `crates/mcp-server/src/tools/compare.rs:436`、`:553`、`:217` | `redactedText` 模式下仍返回原始 body 的 SHA-256 | 给 Agent 一个针对脱敏 body 的确认预言机；`meta.redacted=true` 与原始摘要自相矛盾（上轮 P2-14 未修） | ✓ |
| P2-5 | `crates/mcp-server/src/redaction.rs:437-471` | 文本回退的 quoted-key 规则未做 JSON 字符串反转义 | 非标准 JSON（尾逗号/注释/NDJSON）中 `{"pass\u0077ord":"x"}` 的密钥明文返回，仍标 `redacted=true` | ✓（机制） |
| P2-6 | `crates/mcp-server/src/control_client.rs:224-239,510-525,566-571` | 把“未运行 / descriptor 损坏 / 版本不匹配”统一压成“not running / 需升级” | 桌面崩溃后 120s 内心跳仍新鲜时不会自动拉起，提示升级；损坏的 descriptor 无法自愈 | ✓（部分） |
| P2-7 | `automation.rs:1470-1474,1593-1597,1731-1752,1860-1871` | workspace 计划按全局 id 查找目标，不校验目标 `workspace_id` | 可用 ws1 的计划把 ws2 规则搬入 ws1 或删除，scope hash 看不到跨域变化 | ✓ |
| P2-8 | `automation.rs:1728-1794` | persistent 删除路径缺少 `ensure_persistent_update_allowed` | 可删除仍归属 ephemeral change 的资源，导致该 change TTL 回滚必然 `ROLLBACK_CONFLICT`、元数据/资产永久残留 | ✓ |
| P2-9 | `crates/agent-control/src/lib.rs:112-126`、`agent_control.rs:698-756`、`automation.rs:1498-1507` | `manageUserAutomation` 不在 apply/rollback 的 `required_permissions` 中 | 该能力设为“请求时询问”时永远不弹审批，涉及用户资源的自动化写入只能永久开静态权限 | ✓ |
| P2-10 | `automation.rs:1186-1195`、`:3473-3488` | TTL 清理用 `.is_ok()` 丢弃回滚错误，无日志无计数 | 过期 ephemeral 资源清理失败后每 15s 重试、永远失败，用户与日志都看不到 | ✓ |
| P2-11 | `automation.rs:992-1026` + `main.rs:348-355` | 恢复任一 change 冲突即整体返回 Err，启动不发布运行时；`init_from_db` 用 `set_rules` 装载时 host_lock 恒为 None | 所有 Agent 自动化规则失去精确 host 锁，只剩 URL pattern；RECOVERY_CONFLICT 无 UI 入口 | ✓ |
| P2-12 | `automation.rs:1291-1318` | `publish_failed` 重试成功后仍用旧 `existing` 行构造返回值 | 返回 `ok=true` + `status:"publish_failed"` + `runtimeGeneration:0`，Agent 误判仍需恢复 | ✓ |
| P2-13 | `automation.rs:1286-1289` | 幂等重放在 `reverted` / `aborted` 状态仍返回 Ok + `idempotent:true` | 规则已不存在，Agent 以为 apply 成功；ADR-010 要求只有 active 才算成功 | ✓ |
| P2-14 | `automation.rs:4395-4415` + `bootstrap/converters.rs:88-121` | legacy rewrite（`payload` 为单个 action 对象）回滚时 `rewrite_row` 把 payload 写成 `"null"` | 用户原始 legacy 规则被破坏，重读后 actions=None、payload=null，规则解析失败 | ✓（机制） |
| P2-15 | `automation.rs:490-504,519-533` | `lifecycle=ephemeral` 的过滤只作用于“有 agent 元数据”的资源 | 无元数据的用户规则/持久规则会以 `lifecycle="persistent"` 出现在 ephemeral 列表，Agent 误当临时实验资源 | ✓ |
| P2-16 | `crates/mcp-server/src/control_client.rs:363-382,316-333` | proxy 模式的 `VerifyAutomationChange` 未标非幂等，`ManageProxiedVerification` 又允许重复 | 一次批准可 15 分钟内发起最多 50 次真实出站验证（每批最多 20 请求）；与 `server.rs:1335` 的 `idempotent_hint=false` 相反 | ✓ |
| P2-17 | `apps/desktop/src-tauri/src/agent_grants.rs:561-605,607-638` | Windows 先按继承 ACL 创建再 `icacls`，失败只 warn | 授权文件（actionSummary/scope/reason）对同机其他用户可读；与 descriptor 的“ACL 失败即失败”策略不一致 | ✓ |
| P2-18 | `AgentAccessSection.tsx:510-573`（`connectMutation`） | 连接流程直接写盘，不调用 `requiresAccessChangeConfirmation` | 「完全控制」或草稿中的 `deleteSessions` 等高风险权限可在一次 Connect 中静默生效，跳过二次确认 | ✓ |
| P2-19 | `agent-access.helpers.ts:99-104` + `AgentAccessSection.tsx:294,935` | `presetForPermissions` 只比较 permissions，不比较 `grantRequestPolicy` | 全新默认配置（readOnly + 多个 ask）被标成“只读分析”，打开 Connect 会把所有 ask 静默写成 deny | ✓ |
| P2-20 | `AgentGrantApprovalHost.tsx:134-148,215-245` | 全局审批 Dialog 未传 `onClose`，没有“稍后处理” | pending 期间整个应用被模态阻塞，无法 Escape/遮罩关闭；审批失败时只能等轮询刷新 | ✓ |
| P2-21 | `AgentGrantList.tsx:25-27`、`AgentAccessSection.tsx:727-729` | 授权列表只渲染 pending/approved/executing | `unknown`（可能已产生副作用）、`denied`、`expired` 永不可见，帮助文档承诺失效 | ✓ |
| P2-22 | `automation-changes.helpers.ts:6-26` | 快照脱敏只按键名匹配，`{headerName:"Authorization", value:"Bearer ..."}` 两端都不匹配 | change 详情以明文渲染 Authorization/Cookie 等凭据，违反 UI_GUIDELINES 二次脱敏要求 | ✓ |
| P2-23 | `MapRulesPanel.tsx:776-786`、`RewriteRulesPanel.tsx:1216-1227` + `commands/rules.rs:829-831,932-938` | 前端仍对 Agent 规则提供 Remove，后端新守卫一律 `RULE_READ_ONLY` | 删除必然失败；`forget_deleted_rule` 成为死代码，与 UI_GUIDELINES:757 冲突 | ✓ |
| P2-24 | `AutomationChangesPanel.tsx:526-560,712-726` | 回滚/提升/清理失败时 ConfirmDialog 不关闭也不显示 `errorMessage` | 错误被遮罩挡住，用户只看到对话框重新可点，容易重复提交 | ✓ |
| P2-25 | `use-automation-changes.ts:31-46` + `use-automation-events.ts:39-67` | 两个查询 `staleTime: Infinity`，事件监听失败只写 dev 日志，无回放 | 事件丢失或监听失败后自动化列表永久陈旧，只能重启窗口 | ✓ |
| P2-26 | `apps/desktop/src/pages/settings/settings-page.test.tsx:451` | 5s 默认超时在高并发全量下稳定超时（单跑 2.7s 通过，全量两次均失败） | `pnpm test` 在 HEAD 上 1 failed / 916；CI 使用同一 `vitest run --pool=threads` 配置，有同类超时风险 | ✓ |
| P2-27 | `crates/mcp-server/src/control_client.rs:914`（`write_enabled_access_config`） | helper 只在 `#[cfg(unix)]` 测试中使用，Windows 编译为 dead code | Windows 上 `cargo clippy --workspace --all-targets -- -D warnings` 直接失败；CI（Ubuntu）不受影响，但与项目“三平台”要求冲突 | ✓ |
| P2-28 | `docs/API_SPEC.md:2745-2758,2531-2537` vs `commands/automation.rs:80-95`、`agent_grants.rs:667-680` | 文档命令形状与实现不一致：`clear_agent_automation` 文档为 `input` 对象、实现为扁平参数；`deny/revoke_agent_access_grant` 文档为扁平、实现为 `{input}` | 按文档调用会得到 Tauri `invalid args`；契约脚本只校验命令名，永不报警 | ✓ |
| P2-29 | `.github/workflows/release.yml:203-235`、`ci.yml` | 五处版本一致性只有本地脚本校验，CI 与 release workflow 都不检查 tag 与 `tauri.conf.json`/`Cargo.toml` | tag 与代码版本不一致时可发布成功，`latest.json` 版本与产物版本错配，自动更新循环（上轮 P2-40 未修） | ✓ |
| P2-30 | `README.md:31`、`README.zh-CN.md:31` | 仍写“8 读取 + 2 诊断 + 9 写控制”，实际 33 个工具（含 8 个自动化工具）；中文仍用“权限模板”旧术语 | 用户与协作者对 Agent 能力的认知与实现/帮助文档冲突 | 子代理 |
| P2-31 | `automation.rs:1198-1255,3305-3404` | verify 全程不持 `automation_mutation_lock`，落库时读“当前” generation | proxy/external 验证与 rollback/clear 交错时，已回滚的 change 仍会写入 passed 证据并绑定新 generation | 子代理 |

> 说明：P2-2/P2-3/P2-4/P2-29 是上一轮报告已记录、但在 HEAD 仍未修复的条目；其余为本轮新功能引入或新发现。

### 3.1 重点条目展开

#### P2-1 offline 验证对 response 阶段规则给出相反的“未命中”结论

`preview.rs` 只有在存在 `local_response` 或 `baseline_response` 时才执行 response 阶段 rewrite：

```rust
let mut response = match local_response {
    Some(response) => Some(response),
    None => input.baseline_response.map(response_from_input).transpose()?,
};
if let Some(response) = response.as_mut() { /* apply response rewrite */ }
```

而 `baselineSessionId` 是可选参数（`automation.rs:2631-2643`）。当变更集包含 `stage:"response"` 的规则、调用方没有传 baseline 时，response 规则根本不会执行，`rewrite_traces` 为空，`classify_match_status` 返回 `not_matched` 并追加“No target rule matched the supplied request.”。真实链路里这条规则是生效的，Agent 却会据此回滚或重复注入。修复：目标含 response 规则且无 baseline 时返回 `insufficient_evidence`（或专用状态），并在 limitations/tool 描述里声明需要 baseline。

#### P2-7 / P2-8 自动化 plan 的 scope 与生命周期约束不完整

`prepare_automation_plan` 用全局 manager 查找目标：

```rust
let existing = self.read_rewrite_manager().list_rules()
    .into_iter().find(|rule| rule.id == id);
```

不比较 `existing.workspace_id` 与 `plan.workspace_id`。更新时 `build_rewrite_rule` 无条件写入 plan 的 workspace，删除时直接按 id 删。于是 ws1 的计划可以静默把 ws2 的规则搬入 ws1 或删除；`scope_hash` 只统计同 workspace 规则（`:1860-1871`），跨域变化完全不在冲突检测内。

同一条链路上，persistent 的 update 分支有 `ensure_persistent_update_allowed` 拦截“更新仍归属 ephemeral change 的资源”，delete 分支没有。删除后该 ephemeral change 的 item 期望 `version_after` 存在，TTL 回滚必然 `ROLLBACK_CONFLICT`，元数据/资产残留，清理失败又被 P2-10 静默吞掉。

#### P2-9 `manageUserAutomation` 的“请求时询问”永远不可达

`ControlOperation::required_permissions()` 对 `ApplyAutomationPlan` / `RollbackAutomationChange` / `ClearAgentAutomation` 只返回 `ManageAutomation`。`ensure_approved_grants` 的 `missing` 只来自这个列表，`AuthorizedGrants.capabilities` 也只填 missing 对应能力；因此即使用户批准了 `ManageUserAutomation` 的限时授权，`automation_permissions()` 里的 `manage_user_automation` 仍为 false，域层返回 `CONTROL_PERMISSION_DENIED`，而 sidecar 也不会主动申请该能力。ADR-011 §2 的“多缺失能力分别授权”在自动化写路径上完全失效。

#### P2-12 / P2-13 失败与回滚后的幂等语义

- `publish_failed` 重试：`apply_automation_plan_locked` 加载 `existing` 后重新发布并更新 DB 为 `active`，但返回时仍用未刷新的 `existing`，于是 `status` 仍是 `publish_failed`、`runtime_generation` 仍是 0。
- 回滚后重放：`reverted`/`aborted` 与 `active` 一起进入 `apply_result_from_change`，返回 `ok=true, idempotent=true`，但资源已不存在。ADR-010 决策 3 明确“只有 change set 进入 active 才返回 apply 成功”。

#### P2-14 legacy rewrite 回滚损坏原规则

`rewrite_row_to_rule` 对 legacy 行保留 `payload` 对象、`actions=None`；`rewrite_row` 却只序列化 `rule.actions`：

```rust
payload: serde_json::to_string(&rule.actions).unwrap_or_else(|_| "[]".to_string()),
```

legacy 规则被更新后再回滚时，`before_json` 里的 payload 对象被写成字符串 `"null"`，重读后 `actions=None` 且 `payload=null`，proxy-core 的 `rewrite_actions()` 退化为 `(rewrite_type, null)`，用户原规则被破坏。

#### P2-18 / P2-19 前端两条高风险写入路径

- Connect：`connectMutation` 依据 `accessForConnectPreset` 直接 `updateAgentAccessSettings`，没有任何 `requiresAccessChangeConfirmation` 分支；当用户选“完全控制”或草稿里已有未保存的高风险权限时，一次 Connect 就会把它们落盘，跳过保存路径必经的二次确认。
- 预设匹配：`presetForPermissions` 只比较 permissions，不比较 grantRequestPolicy。默认配置（readOnly 权限 + replay/automation 的 ask 策略）因此显示为“只读分析”；打开 Connect 时默认选中该预设，`grantRequestPoliciesEqual` 不等，于是把全部 ask 静默写成 deny——用户没有做任何修改，配置却被收回。

---

## 4. P3：低危 / 健壮性 / 可排障性

### 4.1 代理核心与规则

- `preview.rs:128-133,146-152`：预览恒按 `is_http2=false` 评估，HTTP/2 body rewrite 在运行时实际会 skip；离线证据与真实行为相反，且输入没有 protocol 字段可校正。
- `preview.rs:177-180` + `automation.rs:2625-2629`：limitations 只声明“不证明运行时/网络/渲染”，没有声明 script/throttle/breakpoint/DNS 未参与，Agent 会把“预览没改”当成“脚本没生效”。
- `preview.rs:184-187` + `automation.rs:4883-4885`：baseline 是连接层失败会话（`status_code=0`）时 `StatusCode::from_u16(0)` 失败，整批 offline 校验命令级失败，文案指向“status 非法”。
- `http_proxy.rs:973-979` vs `:1023-1031`：response rewrite 用请求开始快照，response script/throttle 仍读实时 manager；长请求跨规则发布时同一请求内规则视图不一致。
- `rules/managers.rs:213-240` + `automation.rs:4571-4584,679-748`：Agent persistent 规则被 promote 为用户规则后不重发布内存规则，旧 `host_lock` 保留；用户改 host 后规则静默不匹配，直到重启/下一次 publish。
- `commands/rules.rs:13-63,292-316,502-527`：规则列表每次拉最多 10 000 条 metadata，并为每条各查 change+experiment（N+1），全程持 DB 互斥锁；规则页可能卡顿并与抓包抢锁。
- `map.rs:96-108`：除 P1-3 的盘符场景外，`..` 段只做丢弃而非拒绝；若未来允许编码后的分隔符，仍可能构成穿越，建议统一拒绝非 `Normal` 组件。

### 4.2 自动化 / 授权 / 数据库

- `automation.rs:1198-1255`：verify 不持锁（P2-31 的根因），失败/回滚后仍可能写证据。
- `automation.rs:2701,2707`：offline 验证的 `evidence` 用 `filter(|_| false)` 收集，恒为空；`evidenceSessionIds` 与 DB 列永远为空，与 API_SPEC 不符（死代码）。
- `agent_control.rs:505-510,534-539`：`RequestAgentGrant` / `ConsumeAgentGrant` 在缺少 `agentInstanceId` 时回落常量 `"unknown"`，不同 sidecar 进程共用身份与去重键；控制动作路径却拒绝缺失 id，行为不一致。
- `agent_control.rs:333-350` + `agent_grants.rs:403-419`：`finish` 作用于请求携带的全部 grant id，可能把未参与本次预占、正被另一请求使用的 grant 改成 approved/expired。
- `automation.rs:1341-1345,1957-1995,2500`：`stage_assets` 中途失败不清理已写目录；未被引用的资产、promote 后的资产永不回收；资产默认权限写入（可能是敏感 mock 数据）。
- `automation.rs:1435-1436,2053-2088`：prepare 不校验 workspace 存在；persistent 计划到 commit 才撞 FK（返回 `INTERNAL_ERROR`），ephemeral 不写规则表则留下悬空 workspace_id 的元数据与运行时规则。
- `automation.rs:419-427,541-558`：列表 cursor 实际是内存合并排序列表的数字 offset，资源增删时分页会跳过/重复；API_SPEC 称“不透明 cursor”。
- `automation.rs:3593-3614`：代理验证限流按“每分钟 10 请求”直接拒绝 `count > 10`，而单批允许 20 个请求，20 个的批次永远失败；校验/证书失败也提前占用配额。
- `automation.rs:4024-4098`：`approvedPath` 与 `managedAssetRef` 同时存在时静默取 asset；路径遍历/不可读返回 `INVALID_ARGUMENT`，而 API_SPEC 约定 `PATH_NOT_APPROVED`。
- `crates/db/src/schema.rs:371-442` + `db/automation.rs`：`automation_change_items(resource_kind,resource_id)`、`automation_resources(change_id)`、`automation_change_sets(created_at)` 均无索引；change 历史无保留策略，UI 打开/清理会随历史增长退化。
- `automation.rs:6460` 行的单文件实现（生产代码约 5 000 行）承载校验、DB 编排、运行时发布、验证、rollback、测试；建议按 `prepare/commit/publish/verify/recover` 拆模块（ENGINEERING_GUIDELINES §6.2）。

### 4.3 MCP

- `audit.rs:95-111`：8 个自动化工具不在 `is_agent_control_tool` 名单，桌面端已写权威审计行，sidecar 又写一条；审计日志重复、`agentControl` 标记错误。
- `tools/sessions.rs:598-602`：`get_session(redactionMode=raw)` 直接静态拒绝，不走 `ensure_capability(ReadRawBodies)`；UI 的“请求时询问”在 get_session / export_curl 上不可达。
- `tools/automation.rs:134-145`：先 `call_control` 执行写动作，后构建 `Redactor`；自定义正则非法时动作已生效却返回失败，Agent 可能重试非幂等动作。
- `tools/automation.rs:145`：`meta.redacted` 表示“本次是否命中脱敏规则”，而其他工具表示“是否启用脱敏管线”；同一字段语义相反。
- `tools/sessions.rs:149-152,420-421` + `db/session_search.rs:287-305`：`startedAfter/startedBefore` 未解析/规范化，直接做字符串比较；带时区偏移或毫秒边界会静默漏会话，“inclusive”不成立。
- `control_client.rs:528-557`：取得 grant 后桌面重启，重试仍复用旧 grant id；桌面启动会清空授权，重试必然 `APPROVAL_INVALID`，错误信息没有说明原因。
- `text_search.rs:45-50,73,159-181`：16 MiB 上限只比较入参探测值；流式 JSON 分支 `open()` 没有硬读数上限，探测后被替换/增长的文件可绕过预算（仅在 15s 超时兜底）。
- `body.rs:1574-1584,292,321-333`：`textQuery` 为空白/空串被归一化为 None，既不报错也不搜索，返回整页脱敏 body（256 KiB）。
- `tests/tools.rs`：缺 compare 的“脱敏不得带原始摘要”、自动化审计去重、textQuery >16 MiB、raw+textQuery 授权、descriptor 损坏/半写等断言。

### 4.4 前端

- `AgentGrantList` 已隐藏 unknown/denied（P2-21）；`AgentAccessSection.tsx:443-462,732-738,1019`：收回控制与在飞 save 互斥不足，迟到的保存响应会把刚收回的权限写回；未保存草稿会被收回操作直接覆盖。
- `AgentAccessSection.tsx:320-331,1375-1580,982-993`：save/connect 在飞期间权限下拉与启用开关未禁用，成功回填会静默丢弃这段时间的编辑。
- `AgentClientRow.tsx:79`：`id={itemId}` 缺少 `settings-item-` 前缀，搜索“Cursor”深链定位不到元素；`SettingsPage.tsx:107-114` 的 1.8s 清空可能早于 Agent 数据加载完成。
- `services/commands/agent-access.ts:49-64`：非 Tauri fallback 的默认策略漏了 `readSessions: deny`，与 `grant-policy.ts` 和后端不一致；能力摘要只按 policy 判断，会出现“摘要说可请求、下拉显示禁止”。
- `AgentAccessSection.tsx:2644-2662`、`AgentGrantList.tsx:82-92`：origin 输入框无 label/aria-label；每条撤销按钮文本相同，读屏无法区分。
- `AutomationChangesPanel.tsx:239-260,444-462`：验证记录不比对 `runtimeGeneration`，回滚后旧证据仍按当前结论展示；update 只渲染 `after`，看不到 before、dependencies、`rollbackScopeHash`、`activatedAt`。
- `AutomationChangesPanel.tsx:501` + `use-automation-changes.ts:39-46`：固定 20 条、无加载更多；`useAutomationChange` 无调用方，`AUTOMATION_CHANGE_QUERY_KEY` 的失效是空操作。
- `RulesSharedUi.tsx:806-813`、`AutomationChangesPanel.tsx:681,182,255,438`：`experimentStatus`、`gen`、`PASS/FAIL`、`evidenceLevel`、`resourceKind` 直接展示英文枚举，未走 i18n。
- `apps/desktop/src/features/automation/`：729 行面板与三个 mutation 无测试；`use-automation-events.test.tsx` 只断言 12 次 invalidate，不覆盖监听失败/清理。
- `packages/shared-types` 的 `format:check` 脚本在 Windows 下因单引号被当作模式字符而失败（`prettier` 报 `No files matching 'src/**/*.ts'`），CI 在 Linux 不受影响。

---

## 5. 已核查、确认无问题的部分

为避免后续重复排查，以下区域经主审或子代理逐行核对，未发现新缺陷：

- **上轮 P2 修复复核**：上轮 P2-1（非 UTF-8 body 回退 base64）、P2-2（客户端请求体超时）、P2-6（header 探测总 deadline）、P2-7（chunk-size 行 8 KiB 上限）均已在 HEAD 真正修复，并有回归用例；新增的 `capture_rule_snapshot` 是纯 Arc 拷贝，未插入 await，未绕过超时矩阵。
- **授权预占**：`authorize` → `mark_executing`（锁内扣额度并置 executing）→ dispatch；once 并发第二次因 remaining=0 失败；撤销/过期不会被迟到的成功结果复活；等待写锁期间会重跑 preflight。
- **grant 文件**：Unix `0600`、临时文件 + rename、启动清空、200 条上限淘汰、拒绝冷却、跨进程实例绑定逻辑正确（Windows ACL 失败路径见 P2-17）。
- **MCP 只读保证**：`SQLITE_OPEN_READ_ONLY` + `query_only`，无用户 SQL 拼接，ATTACH/多语句不可达；body reader 拒绝绝对路径、`..`、反斜杠、符号链接与 reparse point。
- **text_search 正则安全**：查询经 `regex::escape` 字面量化、256 字符上限、20 命中上限、有界 retention、切片前 char-boundary 校验；未发现 ReDoS 或越界。
- **控制协议**：token 比较、协议版本、审计可写性、动作指纹重算、请求策略在 preflight 与消费前各校验一次。
- **文档/配置一致性（除 P2-28/P2-30）**：五处版本均 `0.4.2`；`v0.4.2.md` 中英齐全；user-guides 16 个 slug 中英 1:1；118 个注册命令与 118 个前端 invoke 一致；14 个 emit 事件与 14 个 listen 一一对应；CSP/devCsp 均已配置，capabilities 覆盖 main 窗口使用的窗口 API。
- **前端高风险保存确认**（saveDraft 路径）：字段级 diff 与 `requiresAccessChangeConfirmation` 口径一致；readSessions 的 ask 在后端归一化为 deny，下拉只渲染两态。
- **会话域“复制 Host URL”**：`list_sessions` 为升序，取最后一条匹配即最新；只取 origin，无编码问题。

---

## 6. 建议修复顺序

| 批次 | 内容 | 理由 |
|---|---|---|
| 第 1 批 | P1-1、P1-2、P1-3 | 门禁必红 + 两个安全边界；改动局部且可测 |
| 第 2 批 | P2-7、P2-8、P2-9、P2-12、P2-13、P2-14 | 自动化状态机与 scope/生命周期一致性；Agent 闭环会据此做错误决策 |
| 第 3 批 | P2-1、P2-2、P2-3、P2-4、P2-5 | 证据/会话与真实链路不一致，以及脱敏可信度 |
| 第 4 批 | P2-18、P2-19、P2-20、P2-21、P2-22、P2-23 | 前端安全门禁、凭据展示与不可关闭的审批框 |
| 第 5 批 | P2-26、P2-27、P2-28、P2-29、P2-30 | 三平台门禁与文档契约；可与发布流程一起收尾 |
| 后续 | 其余 P2/P3 | 建议把“系统代理跨平台一致性”“MCP 脱敏规则集”“自动化证据口径”各合并成一次专项 |

---

## 7. 门禁结果与审查局限

### 7.1 本次门禁（Windows 本机，HEAD 48d9b67）

| 检查 | 结果 |
|---|---|
| `pnpm typecheck`（root） | ✅ 通过（desktop + shared-types + ui-tokens） |
| `pnpm lint`（root） | ✅ 通过（0 error；dependency-cruiser 50 warning） |
| `prettier --check`（desktop） | ✅ 通过 |
| `prettier --check`（shared-types） | ❌ Windows 下脚本单引号被当作模式字符（P3） |
| `cargo fmt --check --all` | ✅ 通过 |
| `cargo clippy --workspace --all-targets` | ✅ 0 error（1 条 dead_code warning） |
| `cargo clippy ... -- -D warnings` | ❌ Windows 下 dead_code 变 error（P2-27） |
| `cargo test --workspace` | ✅ 通过（首次失败是本地 sidecar 二进制陈旧，重建后 214 个 desktop 用例 + 其余 crate 全通过；非代码缺陷） |
| `pnpm --filter @aiproxy/shared-types test` | ✅ 2 文件 / 75 用例 |
| `pnpm --filter @aiproxy/desktop test` | ❌ 1 failed / 916（`settings-page.test.tsx:451` 5s 超时；单跑 2.7s 通过，全量两次均失败） |
| `pnpm check:api-contract` | ❌ 5 个 automation 命令未按契约形式文档化（P1-1） |
| 五处版本一致性 | ✅ 均 `0.4.2` |
| `cargo audit` / `pnpm audit` | ⏸ 未运行（本机无网络/审计数据库） |

### 7.2 局限

- 7 个只读子代理覆盖了 proxy-core、desktop Rust automation/grants、DB/agent-control、MCP、前端 automation、前端 agent-access、文档/CI；主审回读了全部 P1 与大部分 P2。标注 `子代理` 的条目（如 P2-2/P2-3/P2-29/P2-30 与部分 P3）未逐行复核，按低一档置信度对待。
- 未覆盖：`crates/tls-manager` 与 `sys-util` 本轮无改动，按上轮结论；`commands/*` 的其余命令、`apps/desktop/src` 的纯展示组件、`scripts/*.sh` 的平台分支仍以抽读为主；未在 macOS/Linux 实机运行，Windows 专属路径（Map Local 盘符、agent-grants ACL、clippy dead_code）均标注了平台前提。
- Linux 系统代理、macOS 证书、真实系统代理切换等需要实机验证的路径，本报告只做了代码核对。
- 所有 P1/P2 均给出“文件:行号 + 触发条件 + 期望行为”，可直接转为 issue 与回归用例。

---

## 8. 修复进度（2026-11-06）

按 §6 的批次顺序修复并逐批推送 `origin/master`；每批提交前运行相关测试与 clippy，批次边界见提交记录。

| 批次 | 条目 | 状态 | 提交 | 验证 |
|---|---|---|---|---|
| 第 1 批 | P1-1、P1-2、P1-3 | ✅ | `153de22`、`a8c93ed`、`b7af898` | 契约检查通过；agent-control 11、map 3、agent_grants 8；`clippy -D warnings` 通过 |
| 第 2 批 | P2-7、P2-8、P2-9、P2-12、P2-13、P2-14 | ✅ | `54d66b8` | automation 27 用例；全仓 cargo test 通过 |
| 第 3 批 | P2-1、P2-2、P2-3、P2-4、P2-5 | ✅ | `b6ecd52`、本提交 | automation 27、mcp redaction 14、compare 集成、body-field 字节保持用例 |
| 第 4 批 | P2-18、P2-19、P2-20、P2-21、P2-22、P2-23 | ✅ | `8b589ce` | settings 32、agent-access 22、automation helpers 4 |
| 第 5 批 | P2-26、P2-27、P2-28、P2-29、P2-30 | ✅ | `447b106` | 全量前端 119 文件 / 923 用例；全仓 `clippy -D warnings`；版本脚本正反对照 |
| 第 6 批 | P2-10、P2-11、P2-15、P2-16、P2-24、P2-25、P2-31 | ✅ | `c08d68c` | automation 28；mcp control_client 7；全量 cargo/frontend 测试 |
| 第 7 批 | P2-6、P2-17 | ✅ | `5dadbd6` | 全仓 clippy/test；Windows icacls 实际执行 |
| 第 8 批 | P3：自动化审计去重、offline 证据、空白 `textQuery`、代理验证限流、Map 互斥/错误码 | ✅ | 本提交 | mcp audit/body 用例；automation 28；全仓 clippy/test |

**说明**：

- P2-19 最终采用“重连时保留已有 ask 策略”的实现，而不是让预设匹配包含 policy；这样默认预设标签与帮助文档保持一致，同时消除 Connect 静默把 ask 改成 deny 的问题。
- 当前门禁：`pnpm typecheck`、`pnpm lint`、`pnpm check:api-contract`、`cargo fmt --check`、`cargo clippy --workspace --all-targets -- -D warnings`、`cargo test --workspace`、桌面端全量 119 文件 / 923 用例、`node scripts/check-release-version.mjs` 均通过。
- P2-3 现已改为按原始字节定点替换被修改字段的值；只有路径不存在、remove 操作或 span 冲突时才回退到整份 JSON 重序列化。
- 仍未处理：§4 的其余 P3（本轮已修掉审计去重、offline 证据、空白 `textQuery`、代理验证限流、Map 字段互斥/错误码 5 项；建议其余按“系统代理跨平台一致性”“MCP 脱敏规则集”“自动化证据口径”拆专项）。
- `cargo audit` / `pnpm audit` 需在有审计数据库的网络环境补跑。

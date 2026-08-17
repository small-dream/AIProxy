# AIProxy UI/UX 产品评审报告

- 日期：2026-08-16
- 评审视角：产品与真实用户（开发者日常使用高频路径）
- 评审方式：产品文档（PRD / UI_GUIDELINES / PAGE_BLUEPRINTS / ROADMAP / ARCHITECTURE）+ 前端源码全量走查（`apps/desktop/src`）+ 关键后端链路抽查（`crates`、`apps/desktop/src-tauri`）+ 界面截图
- 路径约定：前端代码均相对 `apps/desktop/src/`；Rust 代码相对仓库根（`crates/…`、`apps/desktop/src-tauri/…`）
- **状态（2026-08-17 更新）**：P0-1 / P0-2 / P0-3 已在 `b8df3b53` 修复并验证；§3.3 / §3.4 / §3.5、以及 §五 全部（5.1–5.8）已于 2026-08-17 修复（见各节标注）。下文已修条目的描述保留评审时快照，仅作背景。其余 P1 / P2 为**待执行 backlog**，与 Roadmap M4–M6 部分重合，执行时以后续排期为准。

---

## 一、总体判断

基础素质高于预期：检查器（JSON 树 / 媒体预览 / WebSocket 注入重放）、端口冲突恢复流程、系统代理三层崩溃恢复、性能工程（虚拟滚动 + 100ms 批量入库 + 10k 会话压测）都达到或超过对标产品水准。

但产品正处在 **“功能已齐、体验断裂”** 的阶段：

1. **可达性水位低**——大量能力写好了却不可达（死代码、死菜单项、断链入口）；
2. **日用效率水位低**——高频路径的信息密度、键盘操作远低于 Charles/Proxyman；
3. **防护水位低**——危险操作几乎没有确认与撤销；
4. 新用户第一次打开应用会遇到一个“全网 HTTPS 报错”的隐形炸弹。

一句话结论：**能力水位已接近甚至部分超过对标产品，但可达性、日用效率和安全防护拖了后腿。先修复断链与防护，再补视图形态，产品成熟度会有质变。**

---

## 二、P0：高危问题（建议立即处理）

### P0-1 首启自动接管系统代理 + SSL 解密默认开，信任证书之前“全网挂掉” ✅ 已修复（`b8df3b53`，2026-08-16）

- 证据：`components/layout/hooks/use-proxy-lifecycle.ts:98-135` 启动时无条件 `startProxy + enableSystemProxy`；`apps/desktop/src-tauri/src/workspace.rs:43` 工作区默认 `ssl_enabled: true`。
- 后果：新用户还没走到向导第 3 步（信任证书），全系统 HTTPS 流量就已被一个未受信任的 CA 接管——浏览器对所有网站报证书错误，且 UI 不解释原因。向导 routing 步（`features/setup-wizard/SetupWizardSteps.tsx:333-367`）声称“开启系统代理”是用户要做的事，实际上早就自动开了。
- 建议：首启顺序改为「证书信任完成 → 才提示开启系统代理」；至少在向导完成前不要自动 `enableSystemProxy`；或接管时弹一次性提示“完成证书信任前浏览器可能报证书错误”。

### P0-2 危险操作零确认、零撤销 ✅ 已修复（`b8df3b53`，2026-08-16）

- 删除 Collection **整棵子树（含所有请求）**：hover 即现删除按钮，一次误点直接消失。`features/collections/use-collection-tree.ts:334-341`、`features/collections/components/CollectionTreeNodeView.tsx:254-265`。
- 全部规则面板删除规则直接 mutate（五处）：`features/rules/components/MapRulesPanel.tsx:132-152`、`RewriteRulesPanel.tsx:422-440`、`DnsMappingsPanel.tsx:83-101`、`ScriptRulesPanel.tsx:206-226`、`features/throttling/use-throttle-editor.ts:375-383`。
- 菜单 Clear All Sessions 无确认无 toast：`components/layout/hooks/use-menu-actions.ts:129-131`。
- 对照：`docs/UI_GUIDELINES.md` §11.4 明确要求“危险操作 → Dialog Confirm”，且删除环境变量组已有现成确认对话框（`features/environments/components/EnvironmentManagerDialog.tsx:434-456`）——模式存在，只是没铺开。
- 建议：统一一个 `ConfirmDialog` 组件铺到所有删除/清空入口；Collection 删除最好带 undo（Snackbar + undo）。

### P0-3 “忽略 host”是功能死胡同 ✅ 已修复（`b8df3b53`，2026-08-16）

- 证据：被忽略的 host 直接从数据里滤掉（`features/sessions/use-session-filters.ts:73-78`），而“停止忽略”入口只在该 host 的右键菜单（`features/sessions/components/DomainContextMenu.tsx:104-132`）——host 已不可见，永远右键不到。
- 后果：用户忽略一个 host 后，没有任何地方查看/清空忽略列表。focused hosts 同样无集中管理入口（但因其可见，可逐个取消）。
- 建议：会话列表顶部加一行可关闭的 filter chips（focus / ignore / throttled 各一枚，点 × 移除），与 UI 规范“Focus/Ignore 是临时视图状态”的定位一致。

---

## 三、P1：核心工作台（Sessions）效率差距

用户每天用几百次的页面，差距集中在四点 + 右键菜单缺口。

### 3.1 信息密度：树叶子行只有文件名 + query

- `features/sessions/components/SessionExplorerPane.tsx:667-692` 叶子行只有路径文件名 + query 后缀，**没有状态码、耗时、大小、时间列**。
- 关键信息只在 hover tooltip（`SessionExplorerPane.tsx:743-761`），且 tooltip 也不含耗时/大小/时间戳。找“刚才那条 500”或“哪条请求 3 秒”必须逐条点开检查器。
- host 行的 `totalCount` 字段存在（`features/sessions/session-explorer.helpers.ts:49`）但从未上屏（`SessionExplorerPane.tsx:367-470`）。Charles/Proxyman 的 host 节点都有计数徽标。
- **全应用没有任何时间列**：时间戳只出现在 Overview 的 Timing 区（`SessionInspectorOverview.tsx:505-508`）。
- 状态码用图标+颜色表达（`session-explorer.helpers.ts:175-239`），数字不上屏，与规范“状态颜色不能作为唯一信息表达方式”（§14）有张力。
- 建议：叶子行右侧加 状态码/耗时/大小 三列等宽数字 + host 行计数徽标。**这是全应用性价比最高的改进**，改动集中在 `SessionExplorerPane.tsx`。

### 3.2 缺少时间序扁平列表视图

- 现在只有 host→路径树（Structure 视图），没有 Charles Sequence / Proxyman List 的按时间平铺列表。PRD §9.2 已承认“预留切换扩展位”。
- 抓包的第一心智是“按时间流看发生了什么”。建议树/列表双视图切换，列表支持列排序与多选。

### 3.3 键盘操作几乎为零 ✅ 已修复（2026-08-17）

- 全 sessions feature 没有任何 `ArrowUp/ArrowDown` 处理——没有方向键切会话、没有 Tab 切请求/响应、没有标签快捷键。
- 无多选：选中态是单个 `selectedSessionId`（`features/sessions/use-session-selection.ts:37-45`、`session-container.store.ts:129`），因此无法批量导出/删除/保存响应。
- 现有键盘行为仅三个：页面级 Cmd/Ctrl+F 唤起检查器搜索（`pages/sessions/index.tsx:291-300`）、SearchBar 内 Enter/Esc（`SearchBar.tsx:190-203`）。
- 建议：至少补 方向键导航 + Cmd/Ctrl 多选 + 批量操作；tooltips 加快捷键后缀。

> **修复（2026-08-17）**：列表容器支持 `↑/↓` 逐条导航、`Home/End` 跳首尾、`Esc` 取消多选；`⌘/Ctrl+点击` 切换多选、`Shift+点击` 范围选择（按树可见顺序，`collectVisibleSessionIds` 为键盘导航与范围选择共用顺序源）；多选后顶部批量条支持 导出 HAR / 保存响应（按实际写入数计数）/ 删除（带确认）/ 清除；叶子 tooltip 追加快捷键提示。**未含**：Tab 切请求/响应面板及其余快捷键（仍为待办）。

### 3.4 全字段搜索写好了但不可达（死代码） ✅ 已修复（2026-08-17）

- `features/sessions/session-explorer.helpers.ts:379-399` 的 `matchesKeyword` 覆盖 host/path/url/method/statusCode/mimeType/httpVersion/协议，经 `useSessionFilters.searchValue` 传入（`use-session-filters.ts:94`）——但 `searchValue` 全库无 setter（仅初始化为 `""`，`session-containers.helpers.ts:311,376`）。
- 现在的 Filter 输入框只做 host 子串匹配（`session-explorer.helpers.ts:115-128`），不支持正则、不支持方法/状态码/content-type 维度。
- 建议：接上现有输入框即可激活全字段搜索，成本极低；再补方法/状态码过滤 chips（DevTools 风格）。

> **修复（2026-08-17）**：搜索输入框经防抖直接写入容器 `searchValue`，`matchesKeyword` 全字段匹配真正生效（输入 `404` / `json` / `GET` 即可按状态码 / MIME / 方法过滤）；原 host 子串过滤链路（`filterSessionsByHostKeyword`）已整体移除，避免与全字段命中做 AND 遮蔽。（曾随本条实现 DevTools 风格方法 / 状态码过滤 chips，经实际使用评估为冗余——与全字段搜索维度重叠——已于同日移除。）**未含**：正则搜索。

### 3.5 右键菜单缺口（对标产品第一梯队功能） ✅ 已修复（2026-08-17）

- **“对此 host 启用/停用 SSL 解密”**：SSL 只有 workspace 级全局 `sslEnabled` 布尔（`features/workspace-manager/use-workspaces.ts:25,52`），无法选择性解密。选择性解密既是隐私合规也是规避证书固定失败的手段。
- **“Map Local 该请求”**：能力在 Rules 页存在，但从流量没有直达入口（`SessionContextMenu.tsx` 全文无 map 项），只能去 Rules 页手填。
- **断点挂起无内联标记**：会话页只有一行跳转 `/rules` 的链接（`pages/sessions/index.tsx:395-401`），列表上没有“此请求正被断点挂起”的标记。

> **修复（2026-08-17）**：右键新增「对此 host 停用/启用 SSL 解密」——写入 `Workspace.sslBlindHosts`（DB `ssl_blind_hosts` 列），代理对列表内 host 的 CONNECT 直接盲通（`is_ssl_blind_tunnel`，复用 `host_in_allowlist` 比较），代理运行中修改后自动重启生效；右键新增「Map Local…」直达 Rules 页 Mapping tab 并以 `mapLocalSeed` 预填 host/path；被断点挂起的会话行内联 `PauseCircle` 标记 + tooltip“被断点挂起”。

---

## 四、P1：规则 / 工具页系统性问题

### 4.1 三种开关行为（最大的不一致）

- 断点规则：行内 Switch 立即生效（`features/rules/components/BreakpointRulesPanel.tsx:58-60,226-230`）。
- Rewrite/Map/DNS/Script：开关只是 draft 一部分（`MapRulesPanel.tsx:263-267`），要“选中→拨开关→保存”三步；列表条目上的 OFF chip 纯展示不可点（`RulesSharedUi.tsx:315-322`）。
- Throttle：开关在编辑器里同样要保存（`features/throttling/components/RuleEditor.tsx:171-187`）。
- 建议：列表条目上直接放可点的启用开关（即时生效）——“临时关一条规则”是真实高频需求。

### 4.2 保存失败静默

- 只有 Script 面板显示 `saveMutation.error`（`ScriptRulesPanel.tsx:409-413`）；Map/Rewrite/DNS 面板保存失败时**没有任何错误提示**，按钮 loading 结束即静默失败。
- 建议：照抄 Script 的 saveError 展示即可。

### 4.3 断点 5 分钟超时是黑箱

- 后端硬超时 5 分钟（`crates/proxy-core/src/lib.rs:56`），超时后**原样静默放行**（`crates/proxy-core/src/breakpoints.rs:673-698,743-759`）；前端无倒计时、无“即将自动放行”提示、超时后无通知、超时值不可配。
- 后果：用户编辑到第 6 分钟才发现请求早被放行，编辑白做。
- 断点命中通知也只有侧滑面板 + ActivityBar 角标 + 状态栏计数（`components/layout/AppShell.tsx:212-227`），用户在别的窗口工作时无系统通知/声音——请求一直挂着。
- 建议：面板显示剩余时间 + 最后 30s 变色 + 超时事件 toast；加可选系统级通知（Tauri notification）。
- 另：断点不能编辑请求 URL/path（只能改 query），Charles 可以。

### 4.4 编辑体验割裂

- 断点面板的 body 编辑器有 JSON 高亮/搜索/全屏/Format（`BreakpointInterceptPanel.tsx:824-933`），而 Script 规则编辑器是裸 `multiline TextField`（`ScriptRulesPanel.tsx:530-542`），且没有 Rewrite 那样的规则测试器（`RewriteRuleTester`，`RewriteRulesPanel.tsx:912-1000`）——脚本写错只能等真实流量触发。
- 建议：抽公共 `CodeEditor` 组件复用；给 Script 补“用最近会话试跑”入口。

### 4.5 无脏检查

- 全仓库无 `beforeunload`/`useBlocker`/dirty 标记。规则 draft 改一半，切 tab、选另一条规则、离开页面都静默丢弃。
- 代码里专门防“refetch 覆盖编辑”（M22 `lastSyncedRuleIdRef`，`MapRulesPanel.tsx:44-101`），却不防“用户自己切走丢编辑”——投入错位。Collections 编辑器同样（`collection-editor.store.ts` 无 dirty 跟踪）。

### 4.6 Compose 与 Collections 是两套并行编辑器

- Compose 页发送**不应用环境变量**（`pages/compose/index.tsx:168-177` 直接发 url），变量替换只在 Collections 页有环境选择器（`CollectionTreePane.tsx:214-243`）。
- Compose 页**没有“保存到 Collection”按钮**——唯一入口是回会话列表右键 Save to Collection。
- multipart **只支持纯文本字段**不能附文件（`compose-editor.store.ts:25-42`）；cURL **只能导出不能导入**（`features/compose/curl-export.ts`，全库无 parseCurl）。
- 建议：收敛为一条链路——cURL 导入 + Compose 保存到 Collection + 环境变量选择器。

### 4.7 其它差距

- 单条 Rewrite 规则只能挂一个动作（`RewriteRulesPanel.tsx:675-700` 四选一，切类型即重置 payload）；Charles 可一条规则叠加多动作（加头+删头+改 body）。
- 规则集导入/导出缺失（M6 已规划，建议提前——团队分享规则是刚需）。
- 校验是“提交后集中弹错”无字段级定位（`MapRulesPanel.tsx:118-130,311-321`）。
- priority 用裸数字表达，无“越大越优先”提示、无拖拽排序；`priorityText` onBlur 逻辑在 5 个文件里复制粘贴（重构信号）。
- 无批量操作（多选启用/禁用/删除）。
- matchType 只有 Rewrite/Breakpoint 有四种匹配类型；Map/DNS/Throttle 只有裸 pattern 输入框。
- 断点放行时不校验 JSON 有效性（`handleResolve` 只校验状态码，`BreakpointInterceptPanel.tsx:1244-1260`），坏 JSON 会被直接放行。

---

## 五、P1：证书与新手引导（FTUE）的“最后一公里”

底层做得扎实：系统代理三层崩溃恢复（正常退出恢复 `apps/desktop/src-tauri/src/main.rs:303-359`、停止时恢复 `apps/desktop/src-tauri/src/commands/proxy.rs:408-415`、崩溃快照恢复 `apps/desktop/src-tauri/src/system_proxy_recovery.rs`）、7 类错误映射（`features/certificate-center/error-guidance.ts:51-86`）、ADB/hdc 快捷操作、鸿蒙完整覆盖。问题集中在**内容不可达**：

### 5.1 新手最需要的 MITM 风险说明是死代码 ✅ 已修复（2026-08-17）

- `pages/certificates/CertificateRiskNotes.tsx`（“中间人是设计使然 / 如何撤销 / 证书锁定”三段优秀文案，`i18n/messages/zh-CN.ts:809-821`）只被 `ReferenceTab.tsx` 引用，而 ReferenceTab、PlatformGuideTabs、CertificateRiskNotes、`components/shared/ProxyStatusCard.tsx` **均未挂载到任何路由/页面**（全仓 grep 仅互相引用）。
- 建议：挂回证书页（Reference tab 或风险说明卡）。

> **修复（2026-08-17）**：`CertificateRiskNotes` 挂载到证书页 desktop tab（`PlatformTrustGuide` 之后）；死文件 `ReferenceTab.tsx`、`PlatformGuideTabs.tsx` 删除；死 key `certificatesPage.tabs.reference`、`guideDescription` 清理。`ProxyStatusCard` 属 §六.9（P2）暂保留。

### 5.2 “随时可移除证书”的承诺不成立 ✅ 已修复（2026-08-17）

- 向导 welcome 步声称“随时可在「证书」页移除”（`zh-CN.ts:1571`），但全应用没有移除/撤销信任入口——证书页只有生成/重新生成/安装/刷新（`DesktopCertificateTab.tsx:54-89`）。
- 建议：补移除入口 + 各平台撤销信任指引；短期至少改文案。

> **修复（2026-08-17）**：完整实现——新增 Tauri command `remove_certificate_trust`（撤销系统信任[逐 store 报告，提权失败给手动命令] → 删除根 CA 文件 → 工作区持久化 `ssl_enabled=false` → 交还系统代理 → 运行中代理以 HTTP-only 重启），Rust 侧新增 `tls-manager::trust::remove_cert_trust_on_platform`、`CertStorage::remove_root_cert`、`db::set_workspace_ssl_enabled`；前端证书页「移除证书」按钮 + `ConfirmDialog`（不可逆，无“不再确认”）+ 三态结果 Alert（成功/部分失败+各平台手动命令/失败）；向导 privacyNote 文案同步为真实承诺；契约 `TrustRemovalReport` 等进 `shared-types`；API_SPEC §6.9 已同步。

### 5.3 排障指南断链 ✅ 已修复（2026-08-17）

- `CertificateErrorGuidance` 的“打开排障指南”链接需要调用方传 `guideUrl`（`CertificateErrorGuidance.tsx:15,62-66`），唯一调用方 `SetupWizard.tsx:335` 没传——文档锚点（`#port-in-use` 等）与 `user-guides/zh-CN/certificate-setup.md` 里的真实锚点都写好了，一行参数的事。

> **修复（2026-08-17）**：prop 改为 `onOpenGuide` 回调（HashRouter 内 `Link href` 会甩到系统浏览器）；向导按错误类导航 `/docs?doc=certificate-setup&anchor=<锚点>`；DocsPage 支持 `?anchor=` 深链滚动（渲染后重试数帧 `getElementById().scrollIntoView()`，有 anchor 时跳过滚动复位，`?doc=` 规范化时保留 anchor）。

### 5.4 多网卡/VPN 用户拿到错误 IP ✅ 已修复（2026-08-17）

- 只取 `localIps[0]` 无切换（`MobileSetupTab.tsx:94`），QR 码与代理地址一起错。建议 IP 下拉可选。
- 相关小 bug：`pages/certificates/index.tsx:196` 端口 fallback 硬编码 `8888` 而非 `DEFAULT_PROXY_PORT`。

> **修复（2026-08-17）**：新增纯函数 `resolveSelectedLocalIp`（选中地址失效时回落第一个）+ 测试；`NetworkInfoPanel` 本机 IP 行在多地址时渲染 `Select` 可切换，QR/代理地址/ADB 面板全部跟随所选 IP；端口 fallback 改用 `DEFAULT_PROXY_PORT`。

### 5.5 移动端无验证闭环 ✅ 已修复（2026-08-17）

- 桌面向导有 verifyTraffic（`SetupWizard.tsx:85`），手机装完证书后没有“确认手机流量已进来”的检测——手机抓包恰恰是最容易卡住的场景。

> **修复（2026-08-17）**：新增 `MobileTrafficCheckCard`（移动端 tab 右列）：点「开始检测」记录会话数基线，借既有 session 事件实时推送检测新会话，成功显示新增条数，120s 无流量给出 triage 清单（同网段/地址正确/证书已信任/防火墙）+ 重试；状态机为纯函数 `computeMobileVerifyState` + 测试。

### 5.6 SetupChecklistCard 的“打开设置向导”会清掉手动代理确认 ✅ 已修复（2026-08-17）

- 卡片仅在 `!captureReady` 时渲染（`components/shared/SetupChecklistCard.tsx:53-55`），已就绪用户根本看不到这张卡，不受影响。
- 真实陷阱在按钮行为：`SetupChecklistCard.tsx:164-166` 调 `resetSetupWizardState`，该 action 除重置向导 completed/dismissed 外，还会清掉 `manualProxyAcknowledgedFor`（`app/store/app-preferences.store.ts:89-93`）。手动代理用户在 captureReady 为 false 的窗口（如端口变更导致 ack 绑定失效、自动启动进行中）点这个按钮，manual ack 被清、向导状态被重置——向导立即弹出，此前“我在用手动代理”的确认丢失。
- 建议：`resetSetupWizardState` 不应触碰 `manualProxyAcknowledgedFor`；或存在 manual ack 时给出二次确认。

> **修复（2026-08-17）**：`resetSetupWizardState` 只重置 `setupWizardCompleted`/`setupWizardDismissedAt`，不再触碰 `manualProxyAcknowledgedFor`（附意图注释）。

### 5.7 Linux 双坑 ✅ 已修复（2026-08-17）

- 安装指引只给 Debian/Ubuntu 命令，Fedora/RHEL 变体只在离线指南里（信任检测倒是对的，`crates/tls-manager/src/trust.rs:188-197`）。
- 非 GNOME/KDE 启用系统代理失败被归类为 `unknown`（`error-guidance.ts:70-76`），只显示“重试”——应引导改点“我将手动配置代理”；UI 也没有任何地方预告这个 Linux 限制。

> **修复（2026-08-17）**：`platformSteps.linux`（zh/en）与 Rust `open_certificate_install_guide` 的 Linux 步骤均补 Fedora/RHEL 目录与 `update-ca-trust`；`error-guidance` 新增 `desktopEnvUnsupported` 错误类（匹配后端固定文案，`canRetry=false`，指引改点「我将手动配置代理」）；向导 routing 步在 Linux 且未就绪时显示 info Alert 预告限制；user-guides 两语言新增 `#linux-desktop-unsupported` 锚点小节。

### 5.8 系统代理恢复失败警告位置过深 ✅ 已修复（2026-08-17）

- 恢复失败（用户系统代理仍指向死端口、全网断网）的警告只显示在设置页（`pages/settings/index.tsx:369-375`）。建议上状态栏或全局 Snackbar。

> **修复（2026-08-17）**：状态栏新增 warning 色 StatusItem（Warning 图标 + 短标签，tooltip 显示具体原因，点击跳设置页），warning 存在时全局可见；设置页详情警告保留；`StatusItem` 增加可选 `iconColor`。

---

## 六、P2：全局壳层细节

> **修复（2026-08-17）**：Windows/Linux 顶部菜单接入 i18n、快捷键标注与禁用态；Find / Refresh / Keyboard Shortcuts 不再派发无人监听事件；补齐页面切换快捷键与设置文档快捷键锚点；Docs 进入侧栏导航；全局 Snackbar 改为右下角 severity toast，错误提供查看日志出口；代理状态增加轮询；zoom 持久化；ErrorBoundary 文案 i18n；断点侧滑面板宽度改为响应式；Edit 菜单移除 `document.execCommand` 依赖；ADB 多设备时跳转到已有设备选择 UI。`hdc` label 已在当前代码中存在。状态栏吞吐/连接数仍需后端暴露运行时计数后再接入。

| # | 问题 | 证据 |
|---|---|---|
| 1 | Windows 菜单全部硬编码英文（无 i18n、无快捷键标注、无禁用态），与 macOS 双语原生菜单不对齐 | `components/layout/app-shell-windows-menu.definitions.ts`；对照 `apps/desktop/src-tauri/src/menu.rs:196-485` |
| 2 | 三个死菜单项：Find / Refresh / Keyboard Shortcuts dispatch 的事件全库无监听者，点击无反应 | `components/layout/hooks/use-menu-actions.ts:134,137,211-213` |
| 3 | 快捷键帮助实际不存在（无命令面板、无快捷键文档页）；Windows/Linux 无页面切换快捷键 | 全库 grep；macOS 有 Cmd+1~6（`apps/desktop/src-tauri/src/menu.rs:205-346`） |
| 4 | Toast 显示在屏幕正中央、无 severity、无 action 按钮（错误没有“查看日志/重试”出口）；全应用三套 toast 并存 | `AppShell.tsx:274-292`；`pages/insights/index.tsx:872-877`；`pages/settings/index.tsx:475-488` |
| 5 | Docs 页无侧栏入口且无高亮项（唯一入口 Help 菜单），用户会迷路 | `features/navigation/navigation-items.tsx:21-76` 不含 `/docs` |
| 6 | 状态栏无流量速率/连接数（抓包工具的能力空缺）；代理状态无轮询，后端崩溃后可能一直显示 Recording | `components/layout/AppShellStatusBar.tsx:203-263`；`use-proxy-status.ts:22-27` 无 refetchInterval |
| 7 | ErrorBoundary 文案英文硬编码、未接结构化日志 | `components/shared/ErrorBoundary.tsx:29-32,42-74` |
| 8 | 字号双机制并存（MUI fontSize vs style.zoom），zoom 不持久化（重启即失） | `pages/settings/index.tsx:907-921`；`use-zoom-control.ts:8` |
| 9 | 死代码：`navigationExpanded`（导航不可折叠）、多工作区 hooks 无 UI、`ProxyStatusCard` | `app/store/app-shell.store.ts:6-7`；`workspace-manager/use-workspaces.ts:21-42` |
| 10 | ADB 永远选第一台设备，无多设备选择 UI | `use-adb-actions.ts:42-43` |
| 11 | Breakpoint 侧滑面板 `minWidth: 640px` + `calc(100% - 420px)`，窗口宽 < ~1060px 横向溢出 | `AppShell.tsx:212-227` |
| 12 | Edit 菜单用已废弃的 `document.execCommand` | `use-menu-actions.ts:243` |
| 13 | 诊断卡 `hdc` 检查项无 label 映射，界面裸显示 "hdc" | `DesktopCertificateTab.tsx:217-222` vs `apps/desktop/src-tauri/src/commands/certificates.rs:359` |

---

## 七、文档侧问题（影响协作效率）

1. **导航清单三处三个版本**：PRD §8.1（11 项）、UI_GUIDELINES §8.3（11 项、另一套）、ARCHITECTURE §11.1（实际 9 页）互不一致；UI Guidelines 自身“8~10 个以内”与 11 项建议矛盾。
2. **Script Rules 无页面级规范**：Rules 页实际含 Script tab，但 UI_GUIDELINES/PAGE_BLUEPRINTS 的 Rules tab 清单均未包含。
3. **PRD 落后于实现**：Collections 在 §5.2 仅有一条带实现注记的条目（无页面级需求展开，也未进入 §8.1 一级导航），HTTP/2 只在 §12 以风险条款出现（“应分阶段推进”）；Protobuf、gRPC、Scenario Replay 则完全缺席；§13 的 Phase 1/2/3 与 Roadmap M1–M6 是两套版本规划。
4. 文档编号冲突：UI Guidelines 仍是 Draft v1.0，且存在两个 §9.4（Rules Page / Throttling Page）；PAGE_BLUEPRINTS 存在两个 §11（“页面与模块映射”/“实现建议”）。需统一清理。
5. Roadmap M1–M3 均标注“2026-05-25 完成”（roadmap 生成次日）——状态标记可信度存疑，评审以仓库实现为准。
6. **文档明示的能力空缺（有据可查）**：HTTP/3/QUIC（Roadmap 明确“不做”，`NEXT_6_MONTH_ROADMAP.md:251,290`）；证书锁定场景为客户端策略限制、无绕过方案（PRD §12:413）；扁平列表视图为预留扩展位（PRD §9.2:261）。
7. **评审对标差距（文档未提及，属本评审观点而非文档承诺）**：上游代理/代理链、SOCKS 代理、反向代理模式、Block/Allow List、SSL 解密按 host 白名单（✅ 2026-08-17 已实现为 `Workspace.sslBlindHosts` 盲解列表，见 §3.5，API_SPEC 已同步）、Repeat Advanced——这些能力文档既未规划也未排除，建议在 PRD/Roadmap 中明确“做或不做”。（注：API_SPEC 的 `tlsVerifyHosts` 白名单属于上游 TLS 校验维度，不是解密白名单。）

---

## 八、值得保持的亮点

- **检查器**：JSON 树（列宽拖拽/虚拟滚动/搜索命中居中，`SessionInspectorJsonTree.tsx`）、媒体预览、WebSocket 消息**注入与编辑重放**（`SessionInspectorMessagesPane.tsx:225-261`，超出对标预期）、按需延迟加载 body、截断/超限提示完备。
- **Repeat 体验优于 Charles**：右键直发 + pending 占位行 + 成功后自动选中（`use-session-context-actions.ts:250-325`）。
- **限速页超过 Charles**：per-host 规则 + 15 分钟定时（到点只关自己开的档，`use-throttle-editor.ts:241-260`）+ 实时命中统计。
- **端口冲突恢复**是全应用错误处理范本：杀进程（显示进程名+PID、二次确认、SIGKILL 竞态退避）/换端口双路径（`use-proxy-lifecycle.ts:229-309`、`AppShellDialogs.tsx:92-175`）。
- **系统代理三层崩溃恢复**（正常退出/停止时/崩溃快照）。
- **Insights 下钻链路完整**：host 行 → Sessions 过滤展开；排行行 → 选中会话并逐级展开；双数据路径（前端实时 + 后端持久化）排序对齐。
- 会话右键一键生成 Rewrite/Throttle 规则（带 seed）；host 分组新流量闪烁提示（2.6s 渐隐）。
- 性能工程：@tanstack/react-virtual 虚拟滚动、100ms 事件批量入库、150ms 搜索防抖、`useDeferredValue` 高亮、10k 会话建树 <100ms 压测。
- 双层 ErrorBoundary（根 + 路由页），单页崩溃不白屏整个应用。

---

## 九、建议执行顺序

| 优先级 | 内容 | 理由 |
|---|---|---|
| **P0** | ~~首启代理/SSL 接管顺序（P0-1）；删除/清空统一确认 + Collection 删除 undo（P0-2）；忽略 host 管理 chips（P0-3）~~（✅ 2026-08-16 已全部完成，`b8df3b53`） | 直接造成新用户流失和数据丢失 |
| **P1-效率** | 会话行加 状态/耗时/大小/时间 列 + host 计数（待办）；~~方向键 + 多选；接通全字段搜索 `searchValue`~~（✅ 2026-08-17 完成，见 §3.3 / §3.4） | 日用频次最高，改动集中收益大 |
| **P1-防呆** | 规则开关行内即时生效；Map/Rewrite/DNS 保存失败提示；编辑器脏检查；断点超时倒计时与通知 | 低成本、高确定性修复 |
| **P1-内容** | ~~挂回 MITM 风险说明死代码；证书移除入口；排障指南 guideUrl 断链；移动端 IP 选择；移动端验证闭环~~（✅ 2026-08-17 完成，连同 5.6–5.8 一并修复，见 §五 各节标注） | 写好的内容接上即可 |
| **P2** | 扁平列表视图（Sequence/List）；~~SSL 按 host 白名单~~（✅ 2026-08-17 完成，见 §3.5）；cURL 导入；Compose↔Collection 收敛（环境变量/保存/附件）；Windows 菜单 i18n；toast 体系统一；状态栏吞吐 | 结构性改进，排进 roadmap（部分与 M4–M6 重合，建议调整优先级） |
| **文档** | 同步 PRD/UI_GUIDELINES/PAGE_BLUEPRINTS 的导航与 Rules tab 清单；补 Script Rules 页面规范 | 消除“三处三个版本”的协作噪音 |

---

## 附：本次评审覆盖的文件范围

- 产品文档：`docs/PRD.md`、`UI_GUIDELINES.md`、`PAGE_BLUEPRINTS.md`、`NEXT_6_MONTH_ROADMAP.md`、`ARCHITECTURE.md`、`SYSTEM_PROXY.md`
- 前端：`apps/desktop/src` 下 pages / features / components / services / app 全目录（约 200 个源文件）
- 后端抽查：`crates/proxy-core`（断点/服务端点）、`crates/tls-manager`（信任检测）、`crates/db`（throttle seed）、`apps/desktop/src-tauri`（菜单/工作区/系统代理恢复/证书诊断）

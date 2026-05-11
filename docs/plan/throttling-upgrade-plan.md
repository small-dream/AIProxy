# Throttling 功能升级计划

## 背景

AIProxy 当前的 Throttling 已经有首版能力：用户可以在 Throttling 页面选择预设或创建自定义 Profile，并全局启用延迟、上下行带宽和丢包模拟。代理运行时会按当前 Workspace 的 active profile 对请求和响应链路施加影响。

从产品定位看，这里的 Throttling 更接近 Charles / Proxyman 的「弱网模拟」，不是 API 网关里的 QPS / Quota / 429 限流。因此好用标准应围绕这些用户目标设计：

- 快速模拟真实网络环境，例如 4G、Slow 3G、弱 Wi-Fi、高延迟、易丢包。
- 能明确知道当前是否生效、对哪些请求生效、每条请求受到了什么影响。
- 能按域名、路径、方法、应用场景精细启用，而不是只能全局开关。
- 能用真实抓包结果验证配置是否符合预期。
- 能安全地开关、保存、恢复和分享配置，不误伤正常调试流量。

## 当前能力盘点

### P0/P1 已落地更新

当前代码已完成本计划中的 P0/P1 主体能力：

- **Session 级 Throttling Trace**：Session Automation tab 可展示 request / response 阶段的 profile、rule、delay、transfer delay、body bytes、dropped outcome 与 message。
- **运行状态栏**：Throttling 页面顶部展示 active profile、命中数、丢包数、累计延迟，并提供临时启用和一键关闭。
- **临时启用**：支持 15 分钟临时启用，倒计时到期后自动关闭。
- **Throttling Rule Scope**：支持按 URL / host pattern、method、stage、priority 创建定向规则；规则命中优先于全局 Profile。
- **从 Session 创建规则**：Session 右键可创建 Throttling Rule，并自动带入 host / path / method / url。
- **Sessions 过滤**：Sessions 页可切换只查看已产生 Throttling Trace 的请求。
- **持久化**：新增 `throttle_rules` 与 `throttle_runs`，用于保存定向规则与 Session 级执行记录。

仍未完全落地的 P0/P1 细节：

- 首次开启全局 Throttling 的确认提示尚未实现。
- 主导航区域展示 active profile 尚未实现，目前状态集中在 Throttling 页面顶部。
- Profile 列表中的最近命中次数与“从 Profile 查看最近 Sessions”尚未实现。
- 当前 Sessions 过滤为 `Throttled`，尚未拆成 `Dropped by throttling` 独立过滤。

### 已具备

- **全局 Profile 管理**：支持预设、自定义、保存、启用、关闭。
- **核心参数**：支持 `latencyMs`、`uploadKbps`、`downloadKbps`、`packetLossRatio`。
- **作用范围**：支持全局 Profile，也支持定向 Throttling Rule。
- **持久化**：`throttle_profiles`、`throttle_rules`、`throttle_runs` SQLite 表保存 Profile、Rule 与执行记录。
- **运行时生效**：代理核心会在请求阶段模拟上传延迟和丢包，在响应阶段模拟下载延迟；规则命中优先于全局 Profile。
- **可解释性**：Session Automation tab 展示 Throttling Trace。
- **基础校验**：前端限制名称、带宽、延迟、丢包范围，避免明显无效配置。
- **本地 fallback**：非 Tauri 或命令失败场景下有 localStorage fallback，方便 Web 端开发调试。

### 明显短板

- **启用体验仍可加强**：全局开关仍需首次确认提示，避免误伤所有请求。
- **模拟不够真实**：带宽模拟是按完整 body 计算后整体 sleep，不能表现分块传输、流式响应、WebSocket 长连接、jitter、离线、DNS 慢解析等真实网络现象。
- **缺少场景化预设**：目前只有少量移动网络/弱 Wi-Fi 预设，未覆盖离线、超时、抖动、上传慢、下载慢、高丢包、地区网络等常见测试场景。
- **配置不可复用协作**：缺少导入导出、复制 Profile、团队共享、备注/标签、排序、搜索。
- **验证工具仍缺失**：用户不能在保存前用一个 URL 或历史 Session 预测该 profile 会产生什么效果。
- **命中管理仍可加强**：Profile 级命中统计、Dropped 独立过滤、最近受影响 Sessions 入口还未完善。
- **命名可能误导**：英文 Throttling 与中文「弱网」不完全一致，用户可能期待 QPS 限流、429、Retry-After、并发控制等能力。

## 差距评估

以「用户敢开、知道效果、能精细控制、能排查」为好用标准，P0/P1 落地后当前完成度约为 **70%**。

| 能力维度 | 目标体验 | 当前状态 | 完成度 |
| --- | --- | --- | --- |
| 快速启用 | 选择预设后一键生效，能随时关闭 | 已有全局开关和预设 | 70% |
| 参数配置 | 延迟、带宽、丢包可调，输入清晰 | 已有基础参数和校验 | 65% |
| 作用范围 | 支持全局、域名、路径、方法、单次会话 | 已支持全局 + URL/Host/Method/Stage Rule | 75% |
| 可解释性 | 每条 Session 显示命中 profile 和影响明细 | 已接入 Session Automation Trace | 80% |
| 运行状态 | 实时统计命中、丢包、额外耗时 | 页面顶部已展示运行统计 | 70% |
| 真实模拟 | 支持 jitter、超时、离线、流式、WebSocket | 仅 body 级整体延迟和请求丢包 | 25% |
| 安全开关 | 临时启用、倒计时关闭、作用范围提醒 | 已支持临时启用和关闭，缺首次确认 | 65% |
| 协作复用 | 复制、导入导出、标签、团队共享 | 基本缺失 | 15% |
| 验证调试 | 保存前测试，保存后可追踪 | 保存后可追踪，保存前测试缺失 | 50% |
| 文档与命名 | 清楚说明是弱网模拟还是 API 限流 | 已在 API / PRD / UI / 计划文档中明确边界 | 80% |

## 产品原则

1. **先让用户信任它确实生效**：Session 级可解释性优先于新增复杂参数。
2. **先避免误伤流量**：作用范围、临时启用和醒目状态优先于高级模拟。
3. **场景优先于字段**：用户选择「Slow 3G」「High latency」「Offline for 10s」，而不是先理解每个底层参数。
4. **与抓包工作流闭环**：从 Session 发现问题、创建弱网规则、复现、查看影响记录。
5. **明确边界**：短期将 Throttling 定位为弱网模拟；QPS / Quota / 429 API 限流作为独立能力评估，不混进当前首版。

## 分阶段实施计划

## P0：信任与安全

目标：让用户清楚知道 Throttling 是否打开、影响了谁、对每条请求做了什么。

### 1. Session 级 Throttling Trace

优先级：P0

状态：已落地

功能范围：

- [x] 在每条 Session detail 中记录 Throttling 执行结果。
- [x] 展示命中的 profile 名称、ID、作用阶段：request / response。
- [x] 展示 request latency、upload delay、response download delay、packet loss decision。
- [x] 如果请求被丢包，Session 中标记为 `throttled / dropped`，并显示原因。
- [x] 在 Automation / Rules 相关区域与 Rewrite / Script traces 放在一起。

验收标准：

- 用户打开任意 Session，可以判断该请求是否被 Throttling 影响。
- 被影响的 Session 可以看到额外增加的耗时。
- 被丢弃的请求有清晰原因和命中的 Profile。

### 2. 顶部全局状态增强

优先级：P0

状态：部分落地

功能范围：

- [x] 在 Throttling 页面显示当前 active profile。
- [ ] 在主导航区域显示当前 active profile。
- [x] 展示作用范围：当前为 global profile + targeted rules。
- [x] 显示命中请求数、丢包数、累计额外延迟。
- [x] 提供一键关闭。

验收标准：

- 用户不进入编辑区也能看到 Throttling 是否正在影响代理流量。
- 用户可以在 1 次点击内关闭 Throttling。
- 开启状态在页面切换后仍然清晰可见。

### 3. 启用安全确认与临时启用

优先级：P0

状态：部分落地

功能范围：

- [ ] 首次开启全局 Throttling 时提示「会影响当前 Workspace 的所有代理请求」。
- [x] 支持启用时长：15 分钟。
- [x] 到期后自动关闭。
- [x] 页面顶部展示剩余时间。

验收标准：

- 用户不会在不知情情况下长时间影响所有请求。
- 临时启用到期后自动恢复正常网络。

## P1：精细作用范围

目标：把 Throttling 从全局工具升级成可控规则，避免误伤其他调试流量。

### 4. Throttling Rule Scope

优先级：P1

状态：已落地

功能范围：

- [x] Rule 增加匹配条件：URL pattern / host pattern、HTTP method、request / response stage、enabled、priority。
- [x] 支持「全局 Profile」和「规则 Profile」两种模式。
- [x] 多条规则命中时按 priority 选择，短期只允许一个最终 profile 生效，避免叠加语义复杂。

验收标准：

- 用户可以只对某个域名或接口开启弱网。
- 未命中的请求不受影响。
- 多条规则冲突时 UI 能解释最终生效的是哪条。

### 5. 从 Session 创建 Throttling 规则

优先级：P1

状态：已落地

功能范围：

- [x] Session 右键增加「Create Throttling Rule」。
- [x] 自动带入 host、path、method、url。
- [x] 可选择当前 active profile 或其他 profile。
- [x] 创建后跳转到 Throttling 页面编辑态。

验收标准：

- 用户能从一条真实请求在 3 步内创建仅影响该接口的弱网规则。
- 创建后的规则默认可测试、可保存、可立即启用。

### 6. Throttling 命中统计与过滤

优先级：P1

状态：部分落地

功能范围：

- [x] Sessions 列表支持按 `Throttled` 过滤。
- [ ] Sessions 列表支持按 `Dropped by throttling` 过滤。
- [ ] Profile 列表显示最近命中次数。
- [ ] 支持从 Profile 查看最近被影响的 Sessions。

验收标准：

- 用户可以快速找到所有受 Throttling 影响的请求。
- 用户可以判断某个 Profile 是否真的在被使用。

## P2：真实网络场景

目标：从「简单延迟」升级为「覆盖常见弱网测试场景」。

### 7. 新增网络场景参数

优先级：P2

功能范围：

- Jitter：延迟随机抖动范围。
- Timeout：按概率或按匹配条件触发超时。
- Offline：在指定时间窗口内断网。
- Connect delay：模拟连接建立慢。
- DNS delay：与 DNS Mapping 能力联动模拟解析慢。
- Response stall：响应开始后停顿。

验收标准：

- 用户可以模拟高延迟但不丢包、高抖动、短暂断网、接口超时等常见场景。
- 每个新增行为都能在 Session Trace 中解释。

### 8. 分块/流式带宽模拟

优先级：P2

功能范围：

- 对大响应按 chunk 写回并在 chunk 间 sleep。
- 支持流式响应逐段限速。
- 明确 WebSocket 首版策略：连接握手可受 HTTP profile 影响，消息级限速作为后续专项。

验收标准：

- 下载大文件或流式响应时，用户能观察到渐进式传输，而不是等待后一次性返回。
- 现有普通响应行为不回退。

### 9. 场景化预设升级

优先级：P2

预设范围：

- Fast 4G
- Slow 3G
- High Latency
- Upload Slow
- Download Slow
- Flaky Wi-Fi
- 5% Packet Loss
- Short Offline
- API Timeout

验收标准：

- 用户不懂网络参数也能选择合适测试场景。
- 每个预设有明确说明、参数摘要和适用场景。

## P3：复用、协作与高级能力

目标：让团队长期维护和共享弱网测试配置。

### 10. Profile 管理增强

优先级：P3

功能范围：

- 复制 Profile。
- 删除自定义 Profile。
- 搜索、排序、标签。
- 备注在列表中可见。
- 预设不可直接改写，但可「另存为自定义」。

验收标准：

- 用户能维护超过 20 个 Profile 仍然不混乱。
- 用户不会误改系统预设。

### 11. 导入导出

优先级：P3

功能范围：

- 导出单个 Profile / 全部 Profiles 为 JSON。
- 从 JSON 导入，冲突时支持重命名或覆盖。
- 导出内容包含版本号，方便未来 schema migration。

验收标准：

- 团队成员可以共享同一套弱网配置。
- 旧版本配置导入失败时有可读错误。

### 12. 测试器与校准工具

优先级：P3

功能范围：

- 输入 URL、method、body size、response size，预估额外耗时。
- 可选择历史 Session 作为样本。
- 显示预计是否命中、命中哪条规则、延迟/丢包概率。
- 提供本地 echo endpoint 或 sample request 进行真实验证。

验收标准：

- 用户保存前能确认规则会不会命中。
- 用户能理解为什么一次请求没有受到影响。

## 数据与技术建议

### 数据模型

P0/P1 已采用拆分模型：

- `throttle_profiles`：保存可复用弱网参数。
- `throttle_rules`：保存匹配条件、priority、enabled、profile_id。
- `throttle_runs`：保存 Session 级执行摘要。

当前每个 request / response 阶段各写入一条 `throttle_runs`，因此暂未单独创建 `throttle_run_entries`。

### 命令接口

建议新增或演进：

- `list_throttle_profiles`
- `save_throttle_profile`
- `list_throttle_rules`
- `save_throttle_rule`
- `delete_throttle_rule`
- `set_active_throttle_profile`
- `get_throttle_runtime_stats`
- `list_throttle_session_trace`
- `list_throttled_session_ids`

### 前端页面

建议将 Throttling 页面拆成三个区域：

- **Status Bar**：当前启用状态、作用范围、命中统计、临时启用倒计时、一键关闭。
- **Profiles**：预设、自定义、复制、导入导出。
- **Rules / Scope**：匹配条件、优先级、命中预览、最近 Sessions。

## 非目标

短期不把以下能力混入当前 Throttling 升级：

- API QPS 限流、并发限制、Quota、Retry-After、429 响应。
- 用户账号级或 API Key 级配额。
- 成本预算控制。

这些更像「API Rate Limit / Quota」能力，可以独立成后续产品模块。如果未来要做，应避免与弱网模拟共用同一个配置模型和页面文案。

## 里程碑

### Milestone 1：可解释、可安全关闭

状态：已基本落地，首次启用确认与主导航状态待补

范围：

- Session 级 Throttling Trace。
- 顶部状态增强。
- 临时启用和自动关闭。

成功标准：

- 用户能回答「这条请求有没有被弱网影响，影响了多少」。
- 用户能放心开启，因为知道影响范围并能自动恢复。

### Milestone 2：按接口精细启用

状态：已基本落地，Profile 命中统计与 Dropped 独立过滤待补

范围：

- Throttling Rule Scope。
- 从 Session 创建 Throttling 规则。
- Throttled Sessions 过滤。

成功标准：

- 用户可以只对目标接口开启弱网。
- 用户可以从真实抓包流量快速创建规则。

### Milestone 3：真实场景覆盖

范围：

- Jitter、Timeout、Offline、Connect delay、Response stall。
- 分块/流式带宽模拟。
- 场景化预设升级。

成功标准：

- 用户能覆盖移动端、弱 Wi-Fi、接口超时、大响应下载、短暂断网等主流测试场景。

### Milestone 4：团队复用

范围：

- Profile 管理增强。
- 导入导出。
- 测试器与校准工具。

成功标准：

- 团队能共享和维护标准弱网测试配置。
- 新成员能直接使用现成场景完成回归测试。

## 建议优先落地顺序

1. Session 级 Throttling Trace。
2. 顶部状态增强和一键关闭。
3. 临时启用与自动关闭。
4. URL / Host / Method 作用范围。
5. 从 Session 创建 Throttling 规则。
6. Sessions 过滤与 Profile 命中统计。
7. Jitter / Timeout / Offline 场景。
8. 分块/流式带宽模拟。
9. Profile 复制、删除、导入导出。
10. 测试器与校准工具。

## 一句话结论

当前 Throttling 已经具备「能模拟一点弱网」的基础，但离「好用」还有明显距离。最先补的不是更多参数，而是 **可解释性、作用范围和安全开关**：让用户知道它正在影响什么、影响了多少，并且可以只影响自己想测试的那部分流量。

# AIProxy 下个阶段半年 Roadmap

生成日期：2026-05-24  
执行周期：2026-06-01 至 2026-11-30  
文档定位：未来半年产品与研发执行事实源，负责阶段取舍、优先级、里程碑和验收口径。

> 状态标注说明（2026-08-18）：M1–M3 原标注的完成日期 2026-05-25 早于执行周期起点（2026-06-01），不可采信；且仓库 git 历史已于 2026-08-14 重建，精确完成日期不可考。里程碑完成状态自即日起以仓库实现核验为准，不再标注具体完成日期。

## 1. 结论先行

未来半年，AIProxy 的核心目标不是继续堆更多零散功能，而是从“P0 功能闭环”升级为“可长期日常使用的现代协议调试工作台”。

产品主线采用三条并行但有先后依赖的路线：

1. **可靠性与性能产品化**：高流量、大 body、长连接、跨平台代理/证书/发布链路必须稳定。
2. **现代协议能力**：HTTP/2、Protobuf、gRPC-Web / gRPC 是下一阶段竞争门槛，不是锦上添花。
3. **可复用调试工作流**：统计洞察、Waterfall、Collection 增强、Scenario Replay、分享导出，把一次性抓包变成可沉淀、可复现、可协作的资产。

半年结束时的目标版本定义为：

- AIProxy 可以作为开发者日常 HTTP/HTTPS/WebSocket 调试主工具。
- 对 HTTP/2 与 Protobuf/gRPC-Web 有可用级支持，Native gRPC 至少完成 unary / 基础 streaming 的技术预览。
- 高流量场景下 Sessions 工作台、WebSocket 面板、导出与大 body 捕获不再成为主要阻塞。
- Collection、Replay、规则/弱网/快照导入导出形成文件级协作闭环。
- macOS / Windows / Linux 具备可重复发布、升级、冒烟验证和用户指南。

## 2. 当前产品现状

### 2.1 已经具备的基础盘

根据当前仓库实现与文档，AIProxy 已经完成了一个很完整的 P0 调试闭环：

- Tauri 2 + React 19 + Rust + SQLite 的跨平台桌面架构。
- HTTP / HTTPS / WebSocket 抓包、MITM 解密、系统代理接管、手机端抓包辅助。
- Sessions、Compose、Collections、Rules、Throttling、Certificates、Settings、Compare 等核心页面。
- Rewrite / Map Local / Map Remote / DNS Mapping / Script Rules / Breakpoints / Throttling 的规则体系。
- WebSocket 消息查看、搜索与活跃连接注入。
- Session 持久化、HAR 导入、HAR / cURL / Snapshot 导出。
- API Collections、环境变量、变量替换、批量执行、从 Session 保存请求。
- 请求 / 响应 Diff 与 OpenAI-compatible AI 总结。
- 中文 / 英文国际化、浅色 / 暗色 / 跟随系统主题。
- 协议模型结构化字段已经落地：`scheme`、`httpVersion`、`transportProtocol`、`applicationProtocol`。

### 2.2 未来半年必须补齐的缺口

当前最大缺口集中在五个方向：

- **协议深度**：真实捕获链路仍以 HTTP/1.1 为主，HTTP/2、gRPC、Protobuf 还没有形成可用闭环。
- **性能与大流量稳定性**：高频 session-upsert、大量 DOM、WebSocket 消息堆积、大 body 缓冲、SQLite 同步写入、导出 N+1 都会影响“长期打开使用”的信心。
- **性能分析体验**：Timing 字段已有模型，但 DNS / TCP / TLS / TTFB / download 的真实采样和 Waterfall 尚未完成；统计分析面板缺失。
- **工作流沉淀**：Collections 首版可用，但 Postman 兼容、断言、执行报告、Scenario Replay、规则包分享仍缺。
- **发布与上手**：功能已经丰富，但跨平台发布、升级、冒烟、证书/移动端引导、故障诊断还需要产品化打磨。

## 3. 外部基准与机会

官方资料显示，主流竞品已经把“现代协议 + 可复现工作流”作为基础能力或高级能力：

- Charles 官方强调 HTTPS/SSL 代理、带宽限制、结构化请求/响应查看与系统代理配置能力。参考：[Charles Features](https://www.charlesproxy.com/overview/features/)、[Charles Proxying](https://www.charlesproxy.com/documentation/proxying/)。
- mitmproxy 官方支持 HTTP/1、HTTP/2、WebSocket，并提供 client/server replay、Map Local、Map Remote、Modify Headers/Body 与 streaming。参考：[mitmproxy Introduction](https://docs.mitmproxy.org/stable/)、[mitmproxy Protocols](https://docs.mitmproxy.org/stable/concepts/protocols/)、[mitmproxy Features](https://docs.mitmproxy.org/stable/overview/features/)。
- Fiddler Everywhere 官方支持 HTTP/1.x、HTTP/2、WebSocket、SSE、Socket.IO、gRPC，并提供 inspectors、Compare、Snapshots、Repro Playback。参考：[Fiddler Introduction](https://www.telerik.com/fiddler/fiddler-everywhere/documentation)、[Capturing Modes](https://docs.telerik.com/fiddler-everywhere/capture-traffic/capturing-modes)、[Inspector Insights](https://www.telerik.com/fiddler/fiddler-everywhere/documentation/inspect-traffic/inspector-insights)、[Repro Playback](https://docs.telerik.com/fiddler-everywhere/modify-and-filter-traffic/repro-playback)。
- Proxyman 官方突出 WebSocket 查看、Protobuf 解码、Map/Breakpoint/Scripting/Diff 等高级调试工具。参考：[Proxyman Overview](https://docs.proxyman.com/)、[WebSocket](https://docs.proxyman.com/advanced-features/websocket)、[Protobuf](https://docs.proxyman.com/advanced-features/protobuf)。

机会判断：

- AIProxy 已经把 Charles/Proxyman/Fiddler 的常用 P0 能力补得比较完整，下一阶段不应在低价值 UI 细节上消耗主战力。
- Fiddler 和 mitmproxy 在 HTTP/2/gRPC/replay 上已经形成用户预期，AIProxy 必须补齐，否则很难成为现代后端、移动端、平台团队的默认工具。
- Proxyman 在 Protobuf / WebSocket 体验上有强信号，AIProxy 可以用“跨平台 + Rust 核心 + 本地优先 + 轻量 API 工作流”形成差异化。

## 4. 半年产品北极星

### 4.1 北极星目标

让开发者在一次真实问题排查中，可以只打开 AIProxy，完成：

1. 连接代理并解密 HTTPS / WebSocket / HTTP/2 流量。
2. 快速定位慢请求、错误请求、协议异常或 body 差异。
3. 将问题请求保存为 Collection 或 Replay 场景。
4. 用规则、断点、弱网、Mock 或脚本复现问题。
5. 导出脱敏快照、规则包或执行报告给团队成员。

### 4.2 关键结果

半年内以这些结果衡量路线图是否成功：

| 维度 | 2026-11-30 目标 |
|---|---|
| 上手闭环 | 新用户在 5 分钟内完成一次 HTTPS 抓包；移动端证书/代理配置有明确诊断反馈 |
| 性能 | 10,000 条 session 可筛选、滚动、查看详情；1,000 条 WebSocket 消息滚动不卡顿；大 body 不导致 OOM |
| 协议 | HTTP/2 会话可捕获、展示、过滤、导出；Protobuf body 可通过 descriptor 解码；gRPC-Web 可检查 message |
| 分析 | Sessions 支持 Waterfall；Insights 面板提供 host/path/status/latency/size 聚合与慢请求排行 |
| 复现 | 可从选中 sessions 生成 Scenario Replay，支持环境变量、顺序执行、状态码/JSON path/耗时断言 |
| 协作 | Collection、环境、规则、弱网 profile、session snapshot 可导入导出，默认提供脱敏选项 |
| 发布 | 三端安装包、自动更新、发布 checklist、冒烟脚本和用户指南保持同步 |

## 5. 产品原则

1. **先稳定，再扩展**：会破坏抓包稳定性、性能或数据安全的能力，不进入主线版本。
2. **先本地文件协作，再云协作**：半年内不做账号体系和云同步，先把导入导出、脱敏、报告做好。
3. **先协议底座，再高级 gRPC**：HTTP/2 模型、ALPN、trailers、pseudo headers、stream 关系先打牢。
4. **先可解释，再智能化**：AI 总结保留，但不作为排查链路的唯一入口；可视化、diff、trace、日志必须自洽。
5. **先真实工作流，再营销页面**：每个版本都要围绕抓包、定位、复现、沉淀推进，不做和调试闭环无关的展示型功能。

## 6. 月度 Roadmap

### M1：2026-06，可靠性与性能产品化

**状态：✅ 已完成**（经仓库实现核验）

实现摘要：

- Session 事件双重订阅合并为单一批量缓冲（100ms）
- SessionExplorer 和 WS Messages 迁移至 @tanstack/react-virtual
- 搜索/过滤输入统一防抖（150ms）
- 导出批量加载统一（BATCH_SIZE=10）
- Body 截断 UI 提示（i18n）
- Rust 日志迁移至 tracing（缓冲异步写入）
- TLS 证书缓存 LRU 淘汰（512 上限）
- Session 持久化批量化（50 条/事务）
- build_session_detail body 解压去重
- 压测 fixture（10k sessions, 1k WS messages, 50MB body）
- 发布检查脚本 release-checklist.sh

主题：让现有 P0 功能从”能用”变成”敢长期打开用”。

核心交付：

- Sessions 高流量渲染优化：
  - session-upsert 事件批量化。
  - Session Explorer 虚拟滚动。
  - WebSocket Messages 虚拟滚动。
  - 搜索/过滤输入防抖。
  - 事件监听器清理与内存泄漏修复。
- 大 body 与导出稳定性：
  - 响应体捕获上限、截断标识和 UI 提示统一。
  - 导出大量 session 的 N+1 修复或并发限制。
  - Session detail 懒加载路径压测。
- Rust 热路径第一批优化：
  - `build_session_detail` 去重。
  - `send_direct_request` 复用 HTTP client。
  - 日志写入缓冲或异步化。
  - TLS 证书缓存复核。
- 质量基线：
  - 建立 10k sessions / 1k WebSocket messages / 50MB body 的本地压测 fixture。
  - 发布前固定执行 `pnpm -r typecheck`、`pnpm -r test`、`pnpm -r lint`、`cargo test`。

验收标准：

- 10,000 条 session 下，列表筛选和选择详情不出现明显卡顿。
- 1,000 条 WebSocket message 下，滚动和搜索可用。
- 50MB 响应不会导致代理或 UI 崩溃，详情页明确显示截断/延迟加载状态。
- 导出 500 条 session 时 UI 不冻结。

不做：

- 不在 6 月启动 HTTP/2 大规模改造。
- 不新增云端能力。
- 不做独立 Mock Server。

### M2：2026-07，Timing / Waterfall / Insights

**状态：✅ 已完成**（经仓库实现核验）

实现摘要：

- 代理核心改用 hyper 重写 forward_request，实现全链路 timing 真实采样
- Timing-aware HTTP connector，捕获 DNS、TCP connect、TLS handshake、request send、TTFB、response read、total
- timing_source 字段区分真实抓包 / HAR 导入 / Compose 来源
- Session Inspector Waterfall 阶段耗时条，异常/缺失 timing 有明确状态提示
- Insights 面板首版：按 host、path、status、method 聚合，P50/P95/P99、错误率、流量体积、慢请求排行
- Insights 支持按当前 Sessions 筛选条件统计
- Insights 导出统计摘要为 Markdown / JSON
- Insights 页面路由、导航与 TopBarActionButton 集成
- 修复 timing、断点、session 过滤相关 bug

主题：从”看见请求”升级为”看懂性能和异常”。

核心交付：

- Timing 真实采样：
  - DNS、TCP connect、TLS handshake、request send、waiting / TTFB、response read、total。
  - 对导入 HAR、Compose、真实抓包分别标记 timing 来源和可信度。
- Session Inspector Waterfall：
  - 单个请求的阶段耗时条。
  - 异常/缺失 timing 有明确状态，不误导用户。
  - HTTP/2 先预留 stream / connection 展示位。
- Insights 面板首版：
  - 按 host、path、status、method、mime 聚合。
  - P50 / P95 / P99、错误率、流量体积、慢请求排行。
  - 支持按当前 Sessions 筛选条件统计。
- 轻量报告：
  - 导出当前统计摘要为 Markdown / JSON。
  - 慢请求可跳回 Sessions。

验收标准：

- 用户能在 30 秒内回答”哪个 host 最慢、哪个接口错误最多、最大的响应是什么”。
- Waterfall 能解释单个请求主要耗时来自连接、TLS、等待还是下载。
- Insights 对 10k sessions 的聚合计算在可接受时间内完成，不阻塞主工作台。

不做：

- 不做完整 APM。
- 不做后台长期监控或云端指标看板。

### M3：2026-08，HTTP/2 可用级捕获

**状态：✅ 已完成**（经仓库实现核验）

实现摘要：

- 启用 hyper http2 feature + h2 crate，服务端/客户端双向 ALPN 配置
- 新建 `http_proxy.rs`（`HttpProxyService`）统一 hyper Service 处理器；`ConnectionMode` enum（PlainHttp / MitmHttps） + `ConnectionContext` 区分纯 HTTP 和 MITM；ALPN 结果决定 h1/h2 分支
- 重构 `handle_connect_mitm()` + `handle_connection()` 从 httparse 手动解析改为 hyper server connection
- 新建 upstream_pool.rs 上游 h2 连接池（按 host:port 复用 h2 连接）
- 数据模型新增 trailers、h2StreamId、isPseudo 字段，DB schema 同步更新
- 规则引擎：header 级规则在 h2 session 上正常工作，body rewrite 跳过并生成 trace
- 设置页新增 HTTP/2 开关（中英文 i18n），ALPN 根据配置动态选择
- Session Inspector 伪头斜体 + "pseudo" 标签，Trailers 标签页
- HAR 导入修复：读取 httpVersion 而非硬编码 "1.1"
- 搜索范围扩展：支持按协议字段过滤
- 诊断日志：ALPN 协商结果记录
- 后续协议栈收敛项：明文 HTTP 代理路径仍保留手写 `httparse` 请求解析与 body 读取；chunked body 已先就地修复。长期应评估将明文 HTTP 请求解析和 body 读取收敛到 hyper request/body 模型，与 HTTPS MITM 的 hyper Service 路径共享更多请求构建、超时、大小限制和 raw message 生成逻辑。

主题：补齐现代 Web / 移动端 / 微服务调试的协议门槛。

核心交付：

- HTTP/2 技术路径确认：
  - 明确 Rust HTTP/2 栈、ALPN、TLS MITM、上游连接复用与降级策略。
  - 明确 HTTP/2 与现有规则链路的兼容边界。
- HTTPS HTTP/2 捕获 MVP：
  - 支持 TLS ALPN `h2`。
  - 将 HTTP/2 stream 映射为 Session。
  - 展示 HTTP/2 pseudo headers、普通 headers、status、body、trailers。
  - Session 列表和 Inspector 显示 `HTTP/2`。
- 兼容能力：
  - 过滤、搜索、详情、导出 Snapshot / HAR 对 HTTP/2 session 可用。
  - Rewrite / Map / Throttling / Breakpoint 至少给出“支持/降级/不支持”的明确 trace。
  - WebSocket 和 HTTP/1.1 回归不受影响。
- 诊断能力：
  - HTTP/2 negotiation 失败时给出日志和 UI 提示。
  - 可开关 HTTP/2 支持，便于用户回退到 HTTP/1.1 排障。

验收标准：

- Chrome / curl / 常见移动端 SDK 的 HTTPS HTTP/2 请求可被捕获并显示为独立 sessions。
- HTTP/2 pseudo headers 和 trailers 不丢失。
- HAR 导出中的 HTTP version 正确。
- HTTP/2 关闭开关可让用户回退，且不会影响 HTTP/1.1 抓包。

不做：

- 不做 HTTP/3 / QUIC 捕获。
- 不承诺所有规则动作在 HTTP/2 下完全等价。
- 不做完整 gRPC message inspector，留到 M4。

### M4：2026-09，Protobuf / gRPC-Web / Native gRPC 技术预览

主题：进入后端、平台、移动端团队的高价值调试场景。

核心交付：

- Protobuf Schema 管理：
  - 导入 descriptor set。
  - 管理 message type。
  - 支持按 content-type 或用户手动选择 message type。
- Protobuf Body Inspector：
  - 对 `application/x-protobuf`、`application/protobuf`、`application/grpc-web+proto` 等 body 提供 Raw / Hex / Decoded 视图。
  - 支持 single message 与 length-delimited message。
  - 解码失败给出可读错误，不吞掉原始数据。
- gRPC-Web 检查：
  - 展示 request / response message、trailers、grpc-status、grpc-message。
  - 支持 unary 与 server streaming 的基础 timeline。
- Native gRPC over HTTP/2 技术预览：
  - 在 HTTP/2 基础上识别 `application/grpc`。
  - 支持 unary message 的基础拆帧与展示。
  - streaming 先展示 message timeline，不承诺改写/重放。
- Protobuf 与 WebSocket 结合：
  - 对 WebSocket binary message 提供“尝试用 descriptor 解码”的入口。

验收标准：

- 用户导入 descriptor 后，可以解码典型 Protobuf HTTP body。
- gRPC-Web unary 请求能显示 method、metadata、message、trailers 和 status。
- Native gRPC unary 在技术预览开关下可检查 message。
- 解码失败、descriptor 缺失、message type 不匹配都有清晰解释。

不做：

- 不支持从 `.proto` 源码自动编译全链路，首版优先 descriptor set。
- 不做 gRPC 复杂断言、Mock、Replay 的字段级能力。
- 不做 HTTP/3 gRPC。

### M5：2026-10，Collection 增强与 Scenario Replay

主题：把抓到的问题变成可重复验证的资产。

核心交付：

- Collection 互操作：
  - Collection / Environment 导入导出。
  - Postman Collection v2.1 导入首版。
  - 基础 Postman 导出或 AIProxy 自有 JSON 导出稳定版。
- Collection 执行增强：
  - 批量执行结果页。
  - 状态码、响应时间、Header、JSON path body 断言。
  - 执行报告导出。
- Scenario Replay 首版：
  - 从选中 sessions 生成 replay scenario。
  - 支持顺序回放、环境变量、请求间延迟。
  - 支持断言和失败定位。
  - 支持从 scenario 跳回原始 sessions。
- 从真实流量生成规则：
  - 从 session 或一组 sessions 生成 Mock / Rewrite / Map Local 草稿。
  - 生成前展示将写入的规则内容，默认不直接启用。

验收标准：

- 用户能从一次登录/下单/查询链路生成 Scenario Replay，并在测试环境重复执行。
- Collection 批量执行能给出 pass/fail、耗时和失败原因。
- Postman 常见 GET/POST/headers/body/environment 导入可用。
- 规则草稿生成不会误启用高风险 Mock。

不做：

- 不做完整 Postman Runner 兼容。
- 不做云端团队工作区。
- 不做复杂脚本依赖管理。

### M6：2026-11，协作打包与 Beta 发布

主题：把半年能力收束成可发布、可传播、可团队试用的版本。

> 注记（2026-08）：规则包导入导出已提前落地（M6 前移），支持
> rewrite / map / dns / script / breakpoint / throttle 规则 + throttle profiles
> 的单文件 JSON 导入导出；导入为追加合并（全新 uuid、默认禁用），**不含**
> 脱敏与"替换全部"模式，这两项仍留在 M6 正式交付。

核心交付：

- 文件级协作闭环：
  - 规则包导入导出。
  - Throttling profile 导入导出。
  - Collection / Environment / Scenario bundle 导入导出。
  - Session snapshot 脱敏导出与注释。
- 安全与隐私：
  - 导出前统一脱敏预览。
  - 默认遮蔽 Authorization、Cookie、Set-Cookie、token、password、secret、apiKey、PII-like 字段。
  - AI payload、导出、日志均不包含明文 API key。
- 发布产品化：
  - macOS / Windows / Linux 安装包发布流程固化。
  - 自动更新链路可用。
  - 三端冒烟 checklist 与失败回滚说明。
  - 首次启动引导：HTTPS 证书、系统代理、手机抓包、常见故障诊断。
- 文档与开发入口：
  - 用户指南同步覆盖 HTTP/2、Protobuf/gRPC-Web、Replay、导入导出、Insights。
  - 开发任务入口按本 roadmap 更新 issue / checklist。

验收标准：

- 三端至少各完成一次从安装到 HTTPS 抓包再到导出快照的冒烟。
- 一位新用户可以仅依靠应用内引导和文档完成基础抓包。
- 团队成员可以通过文件导入复用规则、弱网、collection 和 replay 场景。
- Beta 版本 release notes 明确列出已知限制。

不做：

- 不做账号体系、云同步、团队权限。
- 不做插件市场。
- 不做安全扫描套件。

## 7. 优先级分层

### P0：半年内必须完成

- Sessions / WebSocket / 大 body / 导出性能稳定性。
- Timing 真实采样与 Waterfall。
- Insights 首版。
- HTTP/2 捕获、展示、导出基础闭环。
- Protobuf descriptor 管理与 body 解码。
- gRPC-Web 基础检查。
- Collection 导入导出、Postman 导入首版。
- Scenario Replay 首版。
- 文件级协作导入导出与脱敏。
- 三端 Beta 发布链路。

### P1：尽量完成

- Native gRPC unary 技术预览。
- Native gRPC streaming message timeline。
- 从 session 批量生成 Mock / Rewrite / Map 草稿。
- 执行报告 Markdown / JSON 双格式。
- HTTP/2 规则链路更完整兼容。
- Protobuf WebSocket message 解码。
- 轻量诊断中心：代理、证书、系统代理、端口、网络接口、日志入口统一展示。

### P2：明确延后

- HTTP/3 / QUIC 捕获。
- 云端团队协作、账号、权限。
- 插件系统与插件市场。
- 独立 Mock Server。
- 深度安全审计模式。
- TypeScript 脚本多文件工程、npm 依赖管理。
- 完整 Postman Runner 兼容。
- gRPC 字段级 Mock / Rewrite / Replay。
- 反向代理（入站服务端 / Listen）模式。
- Block / Allow List 域名级黑白名单（Focus / Ignore 视图状态与 SSL 逐域名策略部分覆盖该需求）。
- Repeat Advanced 高级重放（并发 N 次 / 编辑后批量重发）；编排类回放由 M5 Scenario Replay 承接，不单独实现。

## 8. 研发执行建议

### 8.1 版本节奏

| 时间 | 版本建议 | 核心含义 |
|---|---|---|
| 2026-06-30 | `0.2.0` | 性能与可靠性基线 |
| 2026-07-31 | `0.3.0` | Timing / Waterfall / Insights |
| 2026-08-31 | `0.4.0-alpha` | HTTP/2 alpha |
| 2026-09-30 | `0.4.0-beta` | Protobuf / gRPC-Web beta |
| 2026-10-31 | `0.5.0-alpha` | Collection / Scenario Replay |
| 2026-11-30 | `0.5.0-beta` | 文件协作与三端 Beta 发布 |

### 8.2 每个功能的固定交付模板

后续开发任务默认包含：

- PRD / API / Architecture / UI / Page Blueprint 是否需要同步更新。
- 共享类型更新与 parser / type guard。
- Rust 单测、前端 helper 单测、关键页面 UI 测试。
- 至少一个 fixture 或手动验证脚本。
- 用户指南或 release note 更新。
- 已知限制与回滚开关。

### 8.3 质量门槛

每个里程碑发布前必须通过：

- `pnpm -r typecheck`
- `pnpm -r test`
- `pnpm -r lint`
- `cargo test`
- macOS / Windows / Linux 至少基础冒烟：
  - 启动应用。
  - 生成/检测证书。
  - 启动 HTTPS 代理。
  - 开启系统代理。
  - 捕获 HTTPS 请求。
  - 查看详情。
  - 导出 snapshot 或 HAR。

## 9. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| HTTP/2 改造复杂度高 | 拖慢 M3/M4 | M3 先做捕获/展示/导出，规则全兼容后置；提供 HTTP/2 开关与回退 |
| 大 body / streaming 与规则改写冲突 | 影响代理正确性 | 明确 streaming 模式下 body 改写不可用或降级，并在 trace 中解释 |
| Protobuf 解码体验依赖 descriptor | 用户上手成本高 | 提供 descriptor 导入指引、content-type 推断、解码失败诊断 |
| gRPC streaming 范围膨胀 | 研发失控 | 半年只承诺 gRPC-Web 可用和 Native gRPC 技术预览 |
| 性能优化不可见 | 用户感知弱 | 用 10k sessions、1k WS messages、50MB body 的验收数据写入 release notes |
| 三端平台差异 | 发布阻塞 | 每月保留发布冒烟时间，不把平台验证推迟到 11 月 |
| AI 能力引发隐私顾虑 | 影响信任 | AI 默认手动触发、默认脱敏、payload 预览，本地 API key 不回传前端 |

## 10. 取舍规则

如果半年内出现延期，按以下顺序裁剪：

1. 先裁剪视觉增强，不裁剪抓包正确性和稳定性。
2. 先裁剪 Native gRPC streaming，不裁剪 HTTP/2 基础捕获。
3. 先裁剪完整 Postman 导出，不裁剪 AIProxy 自有格式导入导出。
4. 先裁剪复杂断言，不裁剪状态码/JSON path/耗时断言。
5. 先裁剪 AI 增强，不裁剪 Waterfall、Diff、Trace、日志等可解释能力。
6. 不为赶功能牺牲三端发布、证书恢复、系统代理恢复和数据脱敏。

## 11. 半年后判断标准

到 2026-11-30，如果满足以下条件，可以进入下一阶段“商业化 / 团队协作 / 插件化”规划：

- 核心用户可以把 AIProxy 作为日常默认代理调试工具，而不是只作为演示项目。
- HTTP/2、Protobuf、gRPC-Web 能覆盖真实项目中的基础排查。
- Replay、Collection、规则包、snapshot 的导入导出能支撑团队文件级协作。
- 三端安装、升级、证书引导和故障诊断足够稳定。
- 性能压测结果可公开写入 release notes。

若未满足，则下一阶段继续优先补可靠性、协议和发布质量，不进入云协作或插件市场。

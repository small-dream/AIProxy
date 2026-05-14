# AIProxy 功能路线图

基于当前已实现功能、竞品分析（Charles / Fiddler / Proxyman / mitmproxy）和目标用户群体（前端、后端、QA、移动端、安全工程师），整理的高价值功能建议。

> 生成日期：2026-04-19

---

## Tier 1：基础必备（不做到会明显掉用户）

### 1. ~~数据持久化（SQLite）~~ ✅ 已完成

- **现状**：已完整实现。`crates/db/` 包含 8 张表，采用双写模式（内存 Mutex + SQLite），启动时从数据库恢复所有数据，重启不丢失。Body 大文件通过 `BodyStore` 写入磁盘。Session 上限 15,000 条，超限同步清理。

### 2. ~~WebSocket 深度查看与重放~~ ✅ 已完成

- **现状**：已完整实现。代理层自动捕获所有 WebSocket 帧（文本/二进制/控制帧），前端 Messages 面板支持方向/类型过滤、全文搜索、帧级别详情查看（Text/JSON/Hex）。活跃连接支持消息注入（重放），可通过 Compose 面板编写新消息或 Replay 按钮编辑并重发已有消息。连接状态实时显示（活跃/已关闭）。

### 3. ~~DNS 映射 / Host Override~~ ✅ 已完成

- **现状**：已完整实现。`crates/db/` 包含 `dns_mappings` 表，`crates/proxy-core` 在连接层拦截 DNS 解析并应用映射规则，前端 `DnsMappingsPanel` 支持增删改查和批量导入。支持多环境联调和灰度验证场景。

---

## Tier 2：差异化竞争力（竞品做得不够好或没做的）

### 4. 流量统计分析面板

- **内容**：按域名、API 路径、状态码、响应时间、流量体积做聚合分析，包含：
  - 响应时间分布（P50 / P95 / P99）
  - 错误率趋势图
  - 流量体积 Top N 域名
  - 慢请求排行
- **竞品对标**：Charles 统计功能简陋，仅基础计数和简单图表。
- **价值**：对后端性能分析和平台工程师有独特吸引力，是产品差异化的亮点。
- **受益用户**：后端工程师、平台工程师。
- **预估工作量**：中。

### 5. 请求 / 响应 Diff 对比

- **内容**：选择两个 session 逐字段对比——Headers diff、Body JSON diff，高亮差异行。
- **相关进展**：已落地 Compare 独立页面与 Sessions 右键入口，支持任意两个 session 的 summary / query / headers / request body / response body / timing 对比；Body diff 已支持 lazy 展开、截断可见提示、body size guard 和 binary / non-text 明确状态。
- **竞品对标**：Fiddler 有基础的请求对比，Charles 不支持。Proxyman 无此功能。
- **价值**：排查「同样接口为何返回不同」是日常最高频的调试场景之一，目前只能肉眼比对或外部工具。
- **受益用户**：全部。
- **预估工作量**：小。

### 6. Waterfall / Timing 瀑布图

- **内容**：类似 Chrome DevTools Network 的瀑布图视图，展示各阶段耗时：
  - DNS Lookup
  - TCP Connect
  - TLS Handshake
  - TTFB（Time to First Byte）
  - Content Download
- **竞品对标**：Charles 有基础 Timing 面板但没有瀑布图。Chrome DevTools 体验最好但不支持代理级抓包。
- **价值**：前后端性能分析、瓶颈定位的核心可视化手段。
- **受益用户**：前端工程师、后端工程师。
- **预估工作量**：中。

### 7. 流量录制与回放（Scenario Replay）

- **内容**：
  - 录制一组请求序列并保存为场景
  - 一键回放 + 断言校验（状态码、Body 字段值、响应时间阈值）
  - 场景管理（分组、编辑、导入导出）
- **竞品对标**：mitmproxy 有脚本化回放能力，但 GUI 工具普遍缺失此功能。
- **价值**：QA 回归测试、后端接口兼容性验证的利器。
- **受益用户**：QA 工程师、后端工程师。
- **预估工作量**：大。

---

## Tier 3：扩展用户场景（打开新用户群）

### 8. ~~API Collection（类 Postman 轻量版）~~ ✅ 已完成首版

- **现状**：已完成首版。Collections 页面支持文件夹树、请求项编辑、拖拽排序、环境变量 / 全局变量、`{{key}}` 替换、批量执行，以及从 Sessions 右键保存请求到集合。
- **后续增量方向**：
  - Collection 导入 / 导出
  - Postman 格式兼容
  - 批量执行结果断言与报告
- **竞品对标**：Postman 的核心功能，但无代理抓包能力。Charles 有 Compose 但无 Collection 管理。
- **价值**：将「调试工具」延伸为「轻量 API 测试工具」，消除用户同时开 Charles + Postman 的痛点。
- **受益用户**：前端工程师、后端工程师。
- **预估工作量**：大。

### 9. 智能规则推荐

- **内容**：分析抓包流量，自动推荐 Rewrite / Map Local 规则：
  - 检测重复或冗余的缓存头 → 推荐创建 Rewrite 规则
  - 检测相同路径的重复响应 → 推荐创建 Map Local 规则
  - 检测慢接口 → 推荐创建 Throttling 规则模拟
- **竞品对标**：无竞品有此功能。
- **价值**：降低规则配置门槛，让 QA 和初级开发者更容易上手。
- **受益用户**：QA 工程师、初级开发者。
- **预估工作量**：大。
- **相关进展**：Sessions 右键已支持基于当前请求创建 Rewrite 草稿，后续可在此基础上扩展 Header / Query / Body 字段级推荐。

### 10. 自动 Mock / Mock Server

- **内容**：
  - 基于已抓取的真实响应，一键生成 Mock 规则
  - 启动本地 Mock Server，独立于代理运行
  - 支持 JSON 模板变量（随机 ID、时间戳等）
- **竞品对标**：Charles 有 Map Local 但不是独立 Mock Server。mockoon 等 Mock 工具与代理脱节。
- **价值**：前端开发者在后端接口未就绪时直接使用，消除联调阻塞。
- **受益用户**：前端工程师。
- **预估工作量**：大。

### 11. 协作与分享

- **内容**：
  - 规则包导出 / 导入（JSON 文件，团队成员共享配置）
  - Session 快照分享（生成脱敏后的 HAR，可附注解）
  - 团队规则库（远程同步，长期演进）
- **竞品对标**：Charles 无团队协作。Proxyman 有有限的规则导出。
- **价值**：团队内推广使用、减少重复配置、建立团队调试知识库。
- **受益用户**：团队用户、技术负责人。
- **预估工作量**：中～大。

---

## Tier 4：技术前瞻（长期壁垒）

### 12. 协议栈现代化（HTTP/2 优先）

- **现状**：核心捕获、转发、展示链路仍以 HTTP/1.1 文本模型为主，协议字段更多表示 `http` / `https` scheme，而不是完整的 HTTP version / transport / application protocol。
- **趋势**：现代 App、移动端 SDK、云服务和微服务网关普遍启用 HTTP/2；如果长期停留在 HTTP/1.1，会导致抓不到、展示不完整、性能分析失真，也会阻塞后续 gRPC 能力。
- **建议拆分**：
  - **P0：协议模型重构**：在 Session 模型中区分 `scheme`、`httpVersion`、`transportProtocol`、`applicationProtocol`，为 HTTP/2 stream、trailers、pseudo headers、gRPC message 留出结构化字段。
  - **P1：HTTP/2 基础捕获与展示**：支持 TLS ALPN `h2`，捕获 HTTP/2 请求 / 响应并展示为普通会话，至少覆盖 headers、body、status、timing、trailers。
  - **P2：HTTP/2 规则与重放兼容**：让 Rewrite、Map、Throttle、Script、Compose、Export 能在 HTTP/2 会话上保持可用，必要时用内部统一模型屏蔽 HTTP/1.1 与 HTTP/2 差异。
  - **P3：HTTP/3 / QUIC 研究项**：HTTP/3 涉及 UDP / QUIC / QPACK / 0-RTT / 连接迁移，技术路线与 HTTP/2 不同，先做识别、提示和降级策略，不阻塞 HTTP/2 落地。
- **竞品对标**：Charles / Fiddler 对 HTTP/2 有基础支持，但深度调试体验有限；如果 AIProxy 能把 HTTP/2 会话、规则、timing 和 gRPC 展示打通，会形成更强竞争力。
- **价值**：补齐现代协议基础盘，为移动端、微服务、云原生后端和 gRPC 场景建立长期壁垒。
- **受益用户**：移动端工程师、后端工程师、平台工程师、QA。
- **预估工作量**：HTTP/2 中～大；HTTP/3 极大，应单独立项。

### 13. TypeScript 脚本化规则引擎

- **现状**：`v1` 已落地。支持 HTTP/HTTPS 请求与响应阶段脚本、动态响应、日志与数据提取、会话级 trace 持久化。
- **内容**：允许用户用 JS/TS 编写自定义请求处理逻辑：
  - 修改请求 / 响应
  - 条件过滤
  - 动态生成响应
  - 数据提取与日志
- **当前边界**：
  - 单文件脚本
  - 严格沙箱
  - 不覆盖 WebSocket 消息脚本化
  - 不支持 npm 依赖与多文件工程
- **竞品对标**：mitmproxy 支持 Python 脚本，但 JS/TS 更主流。Fiddler 有 FiddlerScript 但体验差。
- **价值**：高级用户和自动化场景的核心需求，打开无限可能。
- **受益用户**：高级用户、自动化工程师。
- **后续增量方向**：多文件项目、外部依赖、WebSocket 脚本化、更多宿主 API。

### 14. gRPC / Protocol Buffers 分阶段支持

- **现状**：尚未支持 Protobuf 解码、gRPC message 展示、`.proto` 导入或 gRPC-Web。
- **建议拆分**：
  - **P0：Protobuf Body 解码**：对 `application/x-protobuf`、`application/protobuf` 等二进制 body 提供 Hex / Raw / Decoded 视图；支持用户导入 `.proto` 或 descriptor set 后按类型解码。
  - **P1：gRPC-Web 支持**：优先覆盖 Web 前端和网关常见场景，可在 HTTP/1.1 或 HTTP/2 基础上展示 unary / streaming message。
  - **P2：Native gRPC over HTTP/2**：在 HTTP/2 基础能力稳定后，按 gRPC message frame 展示请求 / 响应流，支持 headers、trailers、status、metadata、streaming timeline。
  - **P3：规则与测试增强**：支持按 Protobuf 字段搜索、过滤、断言、Diff、Mock 和 Replay，形成区别于传统代理工具的高级能力。
- **竞品对标**：Charles 和 Fiddler 的 gRPC 支持都较弱，mitmproxy 更偏脚本化；GUI 中如果能把 Protobuf message 结构化展示和调试规则结合起来，会有明显差异化。
- **价值**：微服务架构中 gRPC 广泛使用，是面向后端 / 平台团队的杀手级功能；且可以从 Protobuf / gRPC-Web 开始较早释放价值，不必等待完整 HTTP/3。
- **受益用户**：后端工程师、平台工程师、移动端工程师。
- **预估工作量**：大；建议与 HTTP/2 基础能力解耦分批交付。

### 15. 安全审计模式

- **内容**：自动扫描流量中的安全风险：
  - 敏感信息泄露检测（Token 暴露在 URL / Header 中、PII 明文传输）
  - 不安全 Header 检查（缺少 CSP、HSTS、X-Content-Type-Options）
  - 证书问题告警（过期、弱签名算法）
  - 混合内容检测（HTTPS 页面加载 HTTP 资源）
- **竞品对标**：无主流代理工具内置此能力。
- **价值**：对安全工程师和企业合规场景有独特吸引力，B 端场景差异化。
- **受益用户**：安全工程师、企业合规团队。
- **预估工作量**：大。

---

## 建议实施优先级

| 阶段 | 功能 | 工作量 | 核心受益用户 |
|---|---|---|---|
| **立即** | ~~SQLite 持久化~~ ✅ | 中 | 全部 |
| **立即** | ~~DNS 映射~~ ✅ | 小 | 后端 / QA |
| **立即** | ~~WebSocket 深度支持~~ ✅ | 中 | 前端 / 移动端 |
| **短期** | 请求 Diff 对比 | 小 | 全部 |
| **短期** | 协议模型重构（scheme / HTTP version / transport / application protocol） | 中 | 移动端 / 后端 / 平台 |
| **中期** | 流量统计面板 | 中 | 后端 / 平台 |
| **中期** | Waterfall 瀑布图 | 中 | 前端 / 后端 |
| **中期** | HTTP/2 基础捕获与展示 | 中～大 | 移动端 / 后端 / 平台 |
| **中期** | Protobuf Body 解码 / gRPC-Web | 中～大 | 后端 / 平台 / 移动端 |
| **中期** | 流量录制回放 | 大 | QA |
| **长期** | API Collection 增量（导入导出 / Postman 兼容 / 断言报告） | 大 | 前端 / 后端 |
| **长期** | 脚本化规则引擎 | 大 | 高级用户 |
| **长期** | Native gRPC over HTTP/2 | 大 | 后端 / 平台 |
| **远期** | 安全审计模式 | 大 | 安全 / 企业 |
| **远期** | 自动 Mock Server | 大 | 前端 |
| **远期** | 智能规则推荐 | 大 | QA / 初级开发者 |
| **远期** | 协作与分享 | 大 | 团队 |
| **远期** | HTTP/3 / QUIC 研究与降级策略 | 极大 | 移动端 / 平台 |

---

## 核心策略建议

**持久化、WebSocket 和 DNS 映射等基础短板已补齐，下一步建议采用“双线推进”：一条线继续做流量统计面板、Waterfall 和 Diff 对比，快速增强日常调试体验；另一条线启动协议栈现代化，先重构内部协议模型，再落 HTTP/2 基础捕获，并以 Protobuf / gRPC-Web 先释放微服务调试价值。HTTP/3 / QUIC 单独作为远期研究项，不应阻塞 HTTP/2 和 gRPC 能力建设。**

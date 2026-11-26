# AIProxy 下个阶段半年 Roadmap

更新日期：2026-11-26
执行周期：2026-12-01 至 2027-05-31
文档定位：未来半年产品与研发执行事实源，负责阶段取舍、优先级、里程碑和验收口径。

## 1. 结论先行

上一周期（2026-06-01 至 2026-11-30）的计划主线是“协议深度 + 可复现工作流”，但 8 月中旬起实际主线转向了**AI Agent 集成**（MCP sidecar、受控自动化），并已形成产品差异化。本周期不推翻这一转向：Agent 自动化仍是当前最活跃、最具差异化的方向；同时把被顺延的“现代协议”与“可复现工作流”缺口重新排期，避免它们无限期漂移。

三条主线并行：

1. **Agent 自动化扩展**：按已定序（Map Remote → DNS → Throttle → Script）逐步放开写能力，每项独立权限、验证与回滚。
2. **现代协议**：Protobuf descriptor 解码与 gRPC-Web 检查仍是与 Charles/mitmproxy/Fiddler 竞争的门槛项，连续两个半年未启动，本周期必须交付技术预览到可用级。
3. **可复现工作流**：Collections 导入导出、Postman 导入、Scenario Replay、Snapshot 脱敏导出——把一次性抓包变成可沉淀资产。
4. **维护节奏固化**：周期性全仓 review → 修复版本的模式已被证明有效（六轮审查驱动了 v0.4.5–v0.4.7），保持；RustSec 滚动补丁、三端冒烟与开源化收尾并入常态。

## 2. 上周期复盘（2026-06 至 2026-11）

### 2.1 按计划完成（2026-06 至 08）

- M1 可靠性与性能产品化：事件批量化、虚拟滚动、tracing 日志、TLS 证书缓存 LRU、持久化批量化、压测 fixture。✅
- M2 Timing / Waterfall / Insights 首版。✅
- M3 HTTP/2 可用级捕获（hyper 重写、ALPN、连接池、trailers/pseudo headers）。✅
- M3.5 协议正确性与发布稳定性收口。✅

### 2.2 计划外主线（2026-08 末至 11，实际发生）

原 M4（Protobuf/gRPC）、M5（Replay/Postman）、M6（协作 Beta）未启动，主线转向 Agent 集成，并沿四级台阶演进：

- **只读**：MCP + Agent Skill 只读 MVP（stdio sidecar、默认脱敏、审计、Codex / Claude Code / Cursor 分发）。
- **受控**：Agent Access 权限（v0.2.x）——`get_app_status`、抓包启停、系统代理、证书、Session 清理，默认关闭、按项授权。
- **自动化**：Rewrite + Map Local 创建 / 离线验证 / 受控代理验证 / 断言 / 回滚（v0.3.x），三级证据与 Rules → Agent 实验页。
- **权限 UX 产品化 + 质量收口**（v0.4.x）——预设下拉、批量授权、限时授权（ADR-011），以及三轮全仓 review 驱动的修复版本（v0.4.5→v0.4.7）。

版本节奏现实：`0.1.x` 维护线跑到 v0.1.51，`0.2.x`/`0.3.x`/`0.4.x` 均为主题版本。旧版规则“不提前使用 0.4.x”已被现实取代，新版本规则见 §7。

### 2.3 遗留缺口（本周期要还的债）

经代码核验（2026-11-26），以下原 P0 项仍未实现：

| 能力 | 现状 |
|---|---|
| Protobuf descriptor 管理与 body 解码 | 未实现 |
| gRPC-Web / Native gRPC 检查 | 未实现（仅协议标签识别） |
| Collections / Environments 导入导出、Postman v2.1 导入 | 未实现 |
| Scenario Replay | 未实现 |
| Session Snapshot 脱敏导出 | helper 已存在，未接入导出 UI |
| cURL 批量导出、Insights Markdown/JSON 导出 | helper 已存在，未接入 UI |
| 自动化资源扩展 | 写能力仅 Rewrite + Map Local；Map Remote / DNS / Throttle / Script / Breakpoint 写入返回 `FEATURE_NOT_AVAILABLE`，既定扩展序为 Map Remote → DNS → Throttle → Script（Breakpoint 为破坏性语义，单独评估） |

## 3. 北极星与关键结果

让开发者（以及其 AI Agent）在一次真实问题排查中，可以只打开 AIProxy，完成：

1. 连接代理并解密 HTTPS / WebSocket / HTTP/2 流量。
2. 快速定位慢请求、错误请求、协议异常或 body 差异。
3. 让 Agent 在授权范围内自动化修改规则、验证并回滚，全程有证据。
4. 将问题请求保存为 Collection 或 Replay 场景，用规则复现。
5. 导出脱敏快照、规则包或执行报告给团队成员。

| 维度 | 2027-05-31 目标 |
|---|---|
| Agent 自动化 | Rewrite / Map Local / Map Remote / DNS / Throttle / Script 六类资源具备受控写入、验证与回滚；权限默认关闭、逐项授权不变 |
| 协议 | Protobuf body 完成 descriptor 解码可用级；gRPC-Web unary 基础检查可用；Native gRPC unary 保持实验性 |
| 复现 | Scenario Replay 首版（顺序回放、环境变量、基础断言）；Collections / Postman 导入导出可用 |
| 协作 | Snapshot 脱敏导出接入导出 UI；执行报告可导出 |
| 质量 | 周期性全仓 review 保持（目标 ≥2 轮）；三端冒烟每版本至少一轮；RustSec 滚动补丁 48 小时内响应 |
| 发布 | 三端安装、自动更新、发布验证流程固化（RELEASE_GUIDE 已沉淀版本号同步 / audit 闸门 / 重打 tag 流程） |

## 4. 月度 Roadmap

### M1：2026-12，自动化资源第二批

主题：把自动化从 Rewrite + Map Local 扩到 **Map Remote + DNS**，每类独立权限、离线/代理验证、资源级回滚，沿用三级证据。

核心交付：

- Map Remote 写入（含 Redirect 必须留在精确匹配 host 的约束与跨 host 拒绝语义）。
- DNS Mapping 写入。
- 每类的权限项、审计、失败原因与回滚。
- 开源化收尾：隐私截图重拍、README 双语核对。

不做：Script / Throttle 写入（按序在 M2）；Breakpoint 写入（破坏性语义单独评估）。

### M2：2027-01，自动化资源第三批 + 质量轮

主题：完成计划扩展序（**Throttle + Script**），并跑一次全仓 review。

核心交付：

- Throttle Profile / 规则写入。
- Script 规则写入（脚本安全边界与执行超时沿用现有 rule-engine 约束）。
- `replay_session` 证据语义改进：明确“直连上游、绕过全部规则”的边界，评估受控规则内回放。
- 全仓 review 第 7 轮 + 修复版本（v0.4.5 模式）。

### M3：2027-02，Protobuf 技术预览

主题：补上连续两个半年未启动的协议门槛第一半。

核心交付：

- Descriptor set 导入与 message type 管理。
- `application/x-protobuf`、`application/protobuf`、`application/grpc-web+proto` 的 Raw / Hex / Decoded 视图；解码失败保留原始数据。
- WebSocket binary message 的“尝试解码”入口。
- 验收：用户导入 descriptor 后可解码典型 Protobuf HTTP body。

不做：`.proto` 源码编译全链路（首版优先 descriptor set）；gRPC 字段级改写。

### M4：2027-03，gRPC-Web 可用级

核心交付：

- gRPC-Web unary：request / response message、trailers、grpc-status / grpc-message 展示。
- Native gRPC（HTTP/2 + `application/grpc`）unary 拆帧技术预览，实验性开关。
- 验收：gRPC-Web unary 请求能显示 method、metadata、message、trailers 与 status；解码失败、descriptor 缺失均有清晰解释。

### M5：2027-04，可复现工作流

核心交付：

- Collections / Environments 导入导出；Postman Collection v2.1 导入首版。
- Scenario Replay 首版：从选中 sessions 生成场景、顺序回放、环境变量、状态码 / JSON path / 耗时断言。
- 执行报告导出。
- 从 session 生成 Mock / Rewrite / Map 草稿（生成前预览、默认不启用）。

### M6：2027-05，协作打包与收束

核心交付：

- Session Snapshot 脱敏导出接入导出 UI；cURL 批量导出、Insights Markdown / JSON 导出接入。
- 导出前统一脱敏预览（Authorization、Cookie、token、password、secret、apiKey 等）。
- 全仓 review 第 8 轮 + 三端完整冒烟（安装 → 证书 → HTTPS 抓包 → 系统代理恢复 → 导出）。
- 半年复盘：对照 §3 关键结果，决定下一周期是否进入“商业化 / 团队协作 / 插件化”。

## 5. 优先级分层

### P0（必须完成）

- 自动化资源扩展：Map Remote、DNS、Throttle、Script（各带独立权限与回滚）。
- Protobuf descriptor 管理与 body 解码。
- gRPC-Web 基础检查。
- Collections / Environments 导入导出、Postman v2.1 导入。
- Scenario Replay 首版。
- Snapshot 脱敏导出接入 UI。
- 每月维护版本与周期性全仓 review。

### P1（尽量完成）

- Native gRPC unary 技术预览。
- `replay_session` 规则内回放评估。
- 执行报告 Markdown / JSON 双格式。
- 从 session 批量生成规则草稿。
- Protobuf WebSocket 解码。
- 轻量诊断中心。

### P2（明确延后）

- HTTP/3 / QUIC。
- 云端团队协作、账号、权限。
- 插件系统与插件市场。
- gRPC 字段级 Mock / Rewrite / Replay。
- 反向代理（入站服务端 / Listen）模式。
- Breakpoint 写入自动化（破坏性语义单独评估后再排）。
- TypeScript 脚本多文件工程、npm 依赖管理。

## 6. 研发执行

### 6.1 固定交付模板

- PRD / API_SPEC / ARCHITECTURE / PAGE_BLUEPRINTS / 用户指南是否需要同步更新。
- 共享类型与 parser / type guard；`check:api-contract` 必须通过。
- Rust 单测、前端 helper 单测、关键页面 UI 测试；`cargo fmt --check` 与 `format:check` 必须通过。
- 至少一个 fixture 或手动验证脚本；用户指南或 release note 更新。

### 6.2 质量门槛

- 发布前：`pnpm -r typecheck`、`pnpm -r test`、`pnpm -r lint`、`cargo test`、`cargo fmt --check --all`。
- 新增依赖触发 RustSec advisory 时：`cargo update -p <crate> --precise <patched>` 补丁优先，48 小时内响应。
- 版本号同步与发布验证流程以 `docs/RELEASE_GUIDE.md` 为准（版本号取自远程最新 tag + 1）。

### 6.3 版本节奏

- 主题能力用 minor 版本（如 0.5.x 自动化扩展、0.6.x 协议、0.7.x 工作流），协议正确性与修复用 patch 版本。
- 发布节奏维持高频维护版本 + 主题版本；每个版本必须有双语摘要（`docs/releases/v<版本>.md`）与已验证的发布流程。
- 具体版本号不提前硬编码，以实际发版为准。

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 自动化资源扩展引入危险写能力 | 用户数据被误改 | 每类资源独立权限默认关闭；沿用三级证据与回滚；Breakpoint 写入暂不开放 |
| Protobuf 体验依赖 descriptor | 用户上手成本高 | descriptor 导入指引、content-type 推断、解码失败诊断 |
| Agent 主线继续挤占协议/工作流 | 竞品差距持续 | 本 roadmap 明确 M3–M5 为协议与工作流保留月份，不因 Agent 需求顺延超过一个月 |
| 维护版本被新功能挤压 | 已实现能力不可信 | 每月保留 patch 窗口；全仓 review 每半年至少 2 轮 |
| 大 body / streaming 与规则改写冲突 | 代理正确性 | streaming 模式下 body 改写降级并在 trace 中解释 |
| 三端平台差异 | 发布阻塞 | 每版本至少基础冒烟；发布经验已沉淀进 RELEASE_GUIDE |
| 开源与隐私 | 信任与合规 | 截图隐私重拍收尾；导出默认脱敏 |

## 8. 取舍规则

如果本周期出现延期，按以下顺序裁剪：

1. 先裁剪视觉增强，不裁剪抓包正确性和稳定性。
2. 先裁剪 Native gRPC（保 Protobuf / gRPC-Web）。
3. 先裁剪 Script 自动化（保 Map Remote / DNS / Throttle）。
4. 先裁剪完整 Postman 导出，不裁剪 AIProxy 自有格式导入导出。
5. 先裁剪复杂断言，不裁剪状态码 / JSON path / 耗时断言。
6. 不为赶功能牺牲三端发布、证书恢复、系统代理恢复和数据脱敏。

## 9. 半年后判断标准

到 2027-05-31，如果满足以下条件，可以进入下一阶段“商业化 / 团队协作 / 插件化”规划：

- Agent 自动化覆盖六类资源且证据链完整，用户敢把真实问题交给 Agent 处理。
- Protobuf / gRPC-Web 能覆盖真实项目中的基础排查。
- Replay、Collection、规则包、Snapshot 的导入导出能支撑团队文件级协作。
- 三端安装、升级、证书引导和故障诊断足够稳定，周期性 review 保持无新增高危。
- 性能与验收数据可公开写入 release notes。

若未满足，下一阶段继续优先补可靠性、协议和发布质量，不进入云协作或插件市场。

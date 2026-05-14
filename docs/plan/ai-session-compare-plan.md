# AI Session Compare：请求 / 响应 Diff + AI 总结方案

## Summary

- 新增独立一级页面 `Compare`，用于选择两个 Session，展示请求 / 响应差异，并手动触发 AI 总结。
- 首版模型能力采用 **OpenAI-compatible Chat Completions**：内置 OpenAI-compatible 配置方式，支持 `baseUrl`、`model`、`apiKey`、温度、超时。
- API Key 存入本地 SQLite；后端命令不向前端回传明文，只返回是否已配置和掩码。
- AI 调用由 Rust / Tauri 后端执行，前端只提交默认脱敏后的结构化 diff payload，避免 renderer 暴露密钥和 CORS 问题。
- AI 总结默认手动触发，语言跟随应用语言。

## Key Changes

### Compare 页面与入口

- 在导航新增 `Compare`，路由为 `/compare`。
- Sessions 右键新增两类入口：`Set as Compare Base`、`Compare with...`；跳转到 `/compare?left=<id>&right=<id>`。
- Compare 页支持直接从当前 Session 列表中选择 Left / Right，两侧选择器按 host、method、path、status、startedAt 展示。
- 页面布局：顶部 session 选择与 AI 操作栏；中间为 Diff 工作台；右侧或下方为 AI Summary 面板，桌面宽屏用右侧面板，窄屏改为下方区域。

### Diff 行为

- 前端新增纯函数 diff engine，复用现有 `ensureSessionDetailContent` 拉取两边完整请求 / 响应 body 文本。
- 对比范围固定为：summary、URL / method / status / duration / size、query params、request headers、request body、response headers、response body、timing。
- Headers / query 按 key 大小写不敏感匹配，展示 added / removed / changed / unchanged count。
- Body 优先 JSON diff：两边都能解析 JSON 时按 path 对比；否则做文本行级 diff；二进制或缺失内容展示不可比较原因。
- 大 body 默认只参与本地 diff 的截断预览，AI payload 只发送结构化摘要和有限上下文，避免把超大响应直接发给模型。

### AI 架构

- 新增 `ai_settings` SQLite 表，保存 provider config：provider type 固定为 `openai-compatible`、base URL、model、API key、temperature、timeout、updatedAt。
- 新增 Tauri 命令：
  - `get_ai_settings`：返回配置状态、base URL、model、参数和 masked key。
  - `save_ai_settings`：保存 / 更新配置；空 key 表示保留旧 key，显式 clear 才删除。
  - `test_ai_connection`：用当前配置发一个轻量请求验证可用性。
  - `summarize_session_diff`：接收已脱敏 diff payload，调用 OpenAI-compatible `/v1/chat/completions`。
- 后端新增独立 `commands/ai.rs`，桌面 crate 增加 `reqwest` 依赖；AI 请求不经过本地代理抓包运行时，避免自我抓包循环。
- AI prompt 固定输出结构：`核心结论`、`关键差异`、`可能原因`、`建议验证步骤`、`风险 / 注意事项`。
- 默认脱敏规则：Authorization、Cookie、Set-Cookie、token、access_token、refresh_token、apiKey、password、secret、session、jwt 等字段值替换为 `[REDACTED]`。
- Compare 页提供“发送前预览”与“包含脱敏后的 Body 摘要”开关，不提供默认完整原文发送。

### Settings UI

- Settings 新增 `AI Model` section，字段包括 Provider、Base URL、Model、API Key、Temperature、Timeout。
- API Key 输入支持 `Save`、`Clear Key`、`Test Connection`；保存后只显示 masked 状态。
- Compare 页若未配置 AI，AI Summary 面板显示 `Configure AI Model` 按钮跳转 Settings。
- 所有新增文案进入 `en.ts` 和 `zh-CN.ts`。

## Public Interfaces / Types

- 在 `packages/shared-types` 新增 `ai.ts` 并导出：
  - `AiProviderType = "openai-compatible"`
  - `AiSettingsPublic`
  - `SaveAiSettingsInput`
  - `TestAiConnectionResult`
  - `SessionDiffPayload`
  - `SessionDiffSummaryRequest`
  - `SessionDiffSummaryResult`
- 前端新增命令客户端 `services/commands/ai.ts`。
- 前端新增功能目录 `features/session-compare/`，包含 diff helpers、redaction helpers、AI summary hook、Compare 工作台组件。

## Test Plan

### Unit tests

- JSON body diff：added / removed / changed / unchanged path。
- Text body diff：新增行、删除行、修改行。
- Header / query diff：大小写不敏感匹配，同名多值稳定展示。
- Redaction：Authorization、Cookie、token-like JSON fields、query secret fields 都被掩码。
- AI settings parser：masked key、不返回明文 key、clear key 行为。

### UI tests

- Sessions 右键能设置 compare base 并跳转 Compare。
- Compare 页选择两个 sessions 后展示 summary / header / body diff。
- 未配置 AI 时展示配置入口；配置后点击 `Generate Summary` 显示 loading、结果、错误态。
- 应用语言为中文时 AI request language 为中文；英文同理。

### Backend tests

- `save_ai_settings` / `get_ai_settings` 持久化正确。
- `test_ai_connection` 对 provider 错误、401、超时返回结构化错误。
- `summarize_session_diff` 不记录 API key，不把明文 key 返回前端。
- Rust `cargo check`，前端 `typecheck`、`lint`、相关 vitest。

## Assumptions

- 首版只支持 OpenAI-compatible Chat Completions，不做 Anthropic / Gemini 原生协议。
- API Key 存本地 SQLite，属于本机信任模型；前端永不读取明文。
- AI 总结必须由用户手动点击生成，不自动发送抓包数据。
- 发给 AI 的 payload 默认脱敏，输出语言跟随当前应用语言。
- AI 总结结果首版只保存在当前页面状态，不写入数据库；刷新或切换对比后重新生成。
- 需要同步更新 `docs/PRD.md`、`docs/API_SPEC.md`、`docs/ARCHITECTURE.md`、`docs/PAGE_BLUEPRINTS.md` 和 `docs/UI_GUIDELINES.md`。

# ADR-006：本地 MCP Agent Access 采用 stdio 只读 Sidecar

- 状态：`Accepted`
- 日期：`2026-10-17`
- 关联文档：`docs/MCP_AGENT_SKILL_PLAN.md`、`docs/MCP_AGENT_SKILL_ARCHITECTURE.md`、`docs/API_SPEC.md`

## 背景

开发者已习惯让 Codex、Claude Code、Cursor 等 Agent 读取代码、执行命令并解释错误。抓包数据是定位网络问题的关键运行时上下文，但当前交付方式仍是导出 HAR、复制 cURL 或粘贴 Body，既不可追溯，也容易泄露敏感信息。

## 决策

1. 使用独立 Rust 可执行文件 `aiproxy-mcp`，通过 stdio JSON-RPC 接入 MCP 客户端。
2. MVP 只读，不提供任意 SQL、任意文件读取、规则写入、系统代理修改或 Snapshot 导出。
3. 数据库使用 `SQLITE_OPEN_READ_ONLY` + `PRAGMA query_only=ON` 打开，不创建数据库、不执行 migration。
4. Agent 权限来自 `<data-dir>/agent-access.json`，不能通过工具参数提升；Body 默认脱敏，`raw`/`base64` 需要独立的 `readRawBodies` 权限。
5. 审计日志只记录调用元数据，不记录 Header/Body/WebSocket 内容。
6. Skill 与 MCP 同版本分发；Codex、Claude Code、Cursor 安装到各自用户级 skills 目录。
7. 客户端配置默认由应用一键安全合并：Codex 写入 `$CODEX_HOME/config.toml`，Cursor 写入 `~/.cursor/mcp.json`，Claude Code 需用户选择项目根目录后写入 `.mcp.json`。写入前备份原文件，解析失败或结构冲突时拒绝覆盖；复制片段保留为兜底。

## 理由

- stdio 由客户端管理进程生命周期，不暴露本地端口，攻击面小于 localhost HTTP。
- 只读 MVP 先建立用户信任，再评估写入与实时流。
- 统一的脱敏层、受限 Body 范围读取和审计日志，能降低抓包内容被回显或二次泄露的风险。
- 复用 `aiproxy_db` 查询与 Insights 聚合，避免 MCP 与 UI 口径漂移。

## 后果

- Sidecar 需要随桌面端在 macOS / Windows / Linux 三端一起构建、签名和打包。
- Codex、Claude、Cursor 的工具发现与 Skill 加载行为由客户端决定；AIProxy 只负责生成正确配置和文件。
- 应用内不能伪造代理实时运行状态；stdio 模式的 `runtimeStatus` 固定为 `unknown`。
- 后续若增加写工具或实时流，必须新增 ADR，并单独评审权限、审计和回滚策略。

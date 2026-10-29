# ADR-007：Agent 控制通过受权限约束的本地 IPC 执行

- 状态：`Accepted`
- 日期：`2026-10-26`
- 关联文档：`docs/PRD.md`、`docs/ARCHITECTURE.md`、`docs/API_SPEC.md`、`docs/DECISIONS/ADR-006-local-mcp-agent-access.md`

## 背景

ADR-006 的 stdio sidecar 解决了 Agent 读取抓包的问题，但首次安装、SSL 配置、证书信任、抓包启停、系统代理和 Session 清理仍需用户在桌面 UI 中手工完成。把这些能力暴露给 Agent 时，不能让 sidecar 直接写数据库、操作代理运行时或再实现一套业务逻辑，否则会绕过桌面端的锁、事件、持久化与恢复流程。

同时，控制能力必须默认关闭。用户一旦按能力组授予权限，应用内不再弹出二次确认；高风险操作的安全护栏由 Agent Skill、当前对话中的明确用户请求和审计记录共同承担。

## 备选方案

1. **sidecar 直接访问 SQLite、代理端口和系统接口**：实现分散，容易复制业务逻辑并绕过 `AppState` 锁与事件；否决。
2. **开放 localhost HTTP 控制端口**：跨平台简单，但增加网络攻击面、端口冲突和鉴权风险；否决。
3. **本地 IPC 调用桌面端内部实现**：复用现有命令、锁、事件和持久化口径，只增加一层受控协议；采纳。

## 决策

1. 新增共享 crate `aiproxy-agent-control`，定义控制协议 v1、请求/响应信封、操作 DTO、错误码和控制描述文件格式。
2. 桌面端在数据目录启动仅当前用户可访问的本地控制服务：Unix 使用 `<data-dir>/agent-control.sock`（`0600`），Windows 使用当前用户 ACL 的 Named Pipe；不开放 TCP 端口。
3. `<data-dir>/agent-control.json` 保存端点、随机 token、PID、应用版本和启动时间；Unix 文件为 `0600`，Windows 限制为当前用户；应用退出时删除描述文件与 Unix socket。
4. sidecar 每次控制调用都执行：Agent Access 启用检查、权限分组检查、token 校验、参数校验和审计预检。桌面端再次执行同样的启用、权限、token、参数与审计检查，避免直接连接 IPC 绕过 sidecar；请求会携带真实 MCP 客户端名称与版本，供桌面端写审计。
5. 写操作使用 60 秒超时并串行执行；系统代理与 Session 生命周期继续使用桌面端现有锁。超时不会被自动重试，避免证书轮换、删除等非幂等操作重复执行。
6. 控制权限分为 `controlCapture`、`controlSystemProxy`、`manageCertificates`、`deleteSessions`，默认全部关闭。`stop_capture` 即使没有系统代理权限，也允许恢复 AIProxy 接管前的系统代理，作为停止抓包的安全收尾。
7. 安全收尾中的部分失败必须是结构化结果，而不是只写日志：系统代理未能恢复时 `stop_capture` 返回 `systemProxyRestoreFailed` 与 warning；撤销证书后 SSL 配置持久化失败时返回 `workspacePersistWarning`，避免 Agent 误报完整成功。
8. 只读 `get_app_status` 不自动启动应用。写工具在应用未运行时通过 `--agent-launched` 拉起并聚焦 AIProxy；启动来源为 `agent` 时前端跳过自动启抓，避免旧配置先启动再重启。
9. 审计日志在执行前确认可写；失败返回 `AUDIT_UNAVAILABLE` 且不执行。控制动作由桌面端作为权威审计写入点，在动作结束后记录工具、动作摘要、真实客户端身份、耗时和错误码，不记录凭据或 Body；即使同用户进程直接连接 IPC、绕过 sidecar，也会留下动作记录。sidecar 只记录只读工具和未进入桌面控制通道的本地失败，避免重复记账。
10. Agent 不能读取或修改自己的 Agent Access 权限、MCP 客户端配置和 Skill；这些仍只能在桌面 UI 操作，避免自我提权。
11. 控制协议 v1 新增 additive 操作 `readDiagnosticLogs`，由 `diagnose_ai_proxy_issue` 调用。它只读取白名单应用日志与元数据审计，不新增权限，也不开放任意路径；该操作的独立安全决策见 ADR-008。

## 工具范围

- 读取：`list_workspaces`、`search_sessions`、`get_session`、`get_session_body`、`get_session_fields`、`get_websocket_messages`、`get_insights`、`compare_sessions`。
- 只读诊断：`get_app_status` 与 `diagnose_ai_proxy_issue`。后者通过 `readDiagnosticLogs` 获取受限日志摘要，不要求控制权限。
- 控制：`configure_workspace`、`start_capture`、`stop_capture`、`set_system_proxy`、`generate_certificate`、`open_certificate_installer`、`remove_certificate_trust`、`clear_sessions`、`delete_sessions`（共 9 个写工具）。
- 本版不开放规则写入、上游代理配置、移动设备 ADB/HDC、导入导出、AI 模型设置或应用更新控制。

## 后果

- 控制能力要求桌面端和 sidecar 一起升级；旧 sidecar 与新版应用、旧版应用与新版 sidecar 仍保持只读工具兼容，控制不可用时返回明确的升级提示。
- `agent-access.json` 的内存契约升级为 v3，但持久化保持 v2 兼容信封；控制权限作为 additive 字段写入，旧只读 sidecar 可继续读取并忽略未知字段，新版读取时归一化为 v3 且不会隐式授予控制权限。
- 首次证书信任、系统管理员密码、钥匙串或安装确认仍由操作系统要求用户完成；`open_certificate_installer` 会返回成功结果并带 `userActionRequired=true`，Agent 等待用户完成后再做下一轮状态检查。
- 自动拉起的 AIProxy 始终显示并聚焦主窗口，不做无界面运行。
- Windows Named Pipe ACL、macOS/Linux socket 权限、系统代理与证书安装入口仍需在三个原生平台分别验证。

## 回滚

若控制通道出现阻塞性问题，可只关闭四个控制权限并停止启动控制服务，保留只读 MCP 工具；无需数据库迁移，也不改变已有 Session 数据格式。

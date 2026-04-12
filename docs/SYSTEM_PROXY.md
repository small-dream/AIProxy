# Pharles System Proxy Design

## 1. 文档信息

- 产品代号：`Pharles`
- 文档类型：系统代理设计说明
- 当前阶段：`Phase 1 / P0-1.5`
- 文档状态：`Draft v1.0`
- 关联文档：
  - `docs/ARCHITECTURE.md`
  - `docs/API_SPEC.md`

## 2. 目标

让用户在桌面客户端中一键接管本机系统代理，而不是手动去浏览器或操作系统设置页配置 `127.0.0.1:port`。

## 3. 当前实现状态

### Windows

- 已实现真实系统代理开关
- 已实现原始系统代理快照保存与恢复
- 已在停止代理时自动尝试恢复系统代理
- 已通过 Tauri Command 接入桌面客户端

### macOS

- 已预留平台模块与接口
- 尚未实现真实系统代理切换
- 计划后续接入系统网络服务配置能力

## 4. 架构位置

系统代理能力位于：

- `apps/desktop/src-tauri/src/system_proxy/mod.rs`
- `apps/desktop/src-tauri/src/system_proxy/windows.rs`
- `apps/desktop/src-tauri/src/system_proxy/macos.rs`

职责分层：

- `commands/mod.rs`：对前端暴露 Tauri Commands
- `bootstrap/mod.rs`：保存系统代理状态与恢复快照
- `system_proxy/*`：封装平台实现细节

## 5. 命令接口

### `enable_system_proxy`

用途：

- 将当前系统代理切换到 Pharles 当前运行端口

输入：

```ts
type EnableSystemProxyInput = Record<string, never>;
```

输出：

```ts
type EnableSystemProxyOutput = ProxyStatus;
```

约束：

- 必须在本地代理已经启动时调用
- 若首次接管系统代理，需先保存原始系统代理快照

### `disable_system_proxy`

用途：

- 恢复 Pharles 接管前的系统代理配置

输入：

```ts
type DisableSystemProxyInput = Record<string, never>;
```

输出：

```ts
type DisableSystemProxyOutput = ProxyStatus;
```

## 6. Windows 实现说明

Windows 当前实现基于：

- 注册表路径：`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
- WinINet 刷新：`InternetSetOptionW`

接管流程：

1. 读取并保存当前 `ProxyEnable`、`ProxyServer`、`ProxyOverride`、`AutoConfigURL`、`AutoDetect`
2. 写入 Pharles 代理地址，例如 `127.0.0.1:8888`
3. 设置 `ProxyEnable=1`
4. 设置 `ProxyOverride=<local>`
5. 临时关闭 `AutoConfigURL` 与 `AutoDetect`
6. 通知 WinINet 刷新系统代理

恢复流程：

1. 读取 Pharles 运行时保存的快照
2. 逐项恢复原系统代理配置
3. 通知 WinINet 刷新系统代理

## 7. macOS 预留接口

`apps/desktop/src-tauri/src/system_proxy/macos.rs` 当前已预留以下接口：

- `capture_system_proxy_snapshot()`
- `apply_system_proxy_settings()`
- `restore_system_proxy()`

后续实现建议：

- 优先封装“当前活动网络服务”的查询能力
- 支持 HTTP Proxy 与 HTTPS Proxy 的独立开关
- 支持恢复用户原始代理配置
- 需要在文档中明确多网卡和多网络服务的行为策略

## 8. 已知限制

- 当前只实现 Windows 真正的系统代理切换
- 仅适配 HTTP 代理闭环，HTTPS 解密尚未接入
- 若应用异常崩溃，系统代理恢复仍需补充更强的兜底策略

## 9. 开发期排障日志

开发阶段排查系统代理切换失败或“已接管但未见请求”时，优先查看：

- `logs/dev/pharles-desktop-dev.log`
- 若仓库日志目录未生成，则查看：`%TEMP%\\pharles-dev\\logs\\dev\\pharles-desktop-dev.log`

重点事件：

- `desktop.commands event=start_proxy_requested`
- `desktop.commands event=start_proxy_succeeded`
- `desktop.commands event=enable_system_proxy_succeeded`
- `desktop.system_proxy.windows event=snapshot_captured`
- `desktop.system_proxy.windows event=proxy_settings_applied`
- `proxy-core event=listener_started`
- `proxy-core event=connect_received`
- `proxy-core event=connect_mitm_started`
- `proxy-core event=tls_handshake_succeeded`
- `proxy-core event=upstream_request_started`
- `proxy-core event=upstream_request_succeeded`
- `proxy-core event=https_request_forwarded`

说明：

- `logs/dev/pharles-desktop-dev.log` 会在每次桌面端启动时自动清空，只保留当前运行日志
- 若证书已信任，主界面会以 HTTPS 解密模式启动代理

若点击 `Enable System Proxy` 后仍无请求，按以下顺序判断：

1. 若没有 `listener_started`，说明代理未真正绑定监听端口
2. 若有 `listener_started` 但没有 `proxy_settings_applied`，说明系统代理接管失败
3. 若访问 `https://` 站点但没有 `connect_received`，说明流量尚未进入代理
4. 若有 `connect_received` 但出现 `connect_tunneling_without_mitm`，说明当前不是 HTTPS 解密模式启动
5. 若有 `connect_mitm_started` 但没有 `tls_handshake_succeeded`，优先查看 `tls_handshake_failed`
6. 若 TLS 成功但没有 `upstream_request_started`，优先排查解密后的请求解析
7. 若出现 `upstream_request_send_failed` 或 `https_upstream_request_failed`，说明请求已进入代理但访问目标站失败

## 10. 下一步建议

1. 在应用退出事件中强制恢复系统代理
2. 增加“恢复系统代理失败”的用户提示和手动恢复说明
3. 实现 macOS 系统代理切换
4. 在 HTTPS 阶段联动系统代理与证书状态检查

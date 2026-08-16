# AIProxy System Proxy Design

## 1. 文档信息

- 产品代号：`AIProxy`
- 文档类型：系统代理设计说明
- 当前阶段：`P0 系统代理闭环 / 实现同步`
- 文档状态：`Living Spec v1.1`
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

- 已实现真实系统代理开关
- 已实现原始系统代理快照保存与恢复
- 通过 `/usr/sbin/networksetup` 遍历所有网络服务进行代理配置
- 应用失败时自动回滚到快照

### Linux

- 已实现 GNOME 和 KDE 双桌面环境支持
- 自动检测 `XDG_CURRENT_DESKTOP` / `DESKTOP_SESSION` 环境变量判断桌面环境
- GNOME：通过 `gsettings` 操作 `org.gnome.system.proxy` schema
- KDE Plasma：通过 `kwriteconfig6` / `kreadconfig6` 操作 `kioslaverc`
- 已实现原始系统代理快照保存与恢复
- 非 GNOME/KDE 桌面环境返回不支持的错误提示

## 4. 架构位置

系统代理能力位于：

- `apps/desktop/src-tauri/src/system_proxy/mod.rs`
- `apps/desktop/src-tauri/src/system_proxy/windows.rs`
- `apps/desktop/src-tauri/src/system_proxy/macos.rs`
- `apps/desktop/src-tauri/src/system_proxy/linux.rs`

职责分层：

- `commands/mod.rs`：对前端暴露 Tauri Commands
- `bootstrap/mod.rs`：保存系统代理状态与恢复快照
- `system_proxy/*`：封装平台实现细节

## 5. 命令接口

### `enable_system_proxy`

用途：

- 将当前系统代理切换到 AIProxy 当前运行端口

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
- 启用时将 workspace 的 `system_proxy_enabled` 持久化为 `true`（`disable_system_proxy` 对应写 `false`）

### 前端启动恢复语义

应用启动的 auto-start 只拉起代理监听，**不自动接管系统代理**：仅当 workspace 持久化字段 `systemProxyEnabled === true`（用户此前显式开启过）时才恢复接管（见 `use-proxy-lifecycle.ts`）。全新工作区默认 `false`——新用户在信任根证书之前系统流量不被劫持，由首启向导在证书信任完成后引导开启。`enable/disable_system_proxy` 改写该字段后，前端会失效 `workspaces` 查询缓存，保证下次启动读到最新值。

### `disable_system_proxy`

用途：

- 恢复 AIProxy 接管前的系统代理配置

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
2. 写入 AIProxy 代理地址，例如 `127.0.0.1:8888`
3. 设置 `ProxyEnable=1`
4. 设置 `ProxyOverride=<local>`
5. 临时关闭 `AutoConfigURL` 与 `AutoDetect`
6. 通知 WinINet 刷新系统代理

恢复流程：

1. 读取 AIProxy 运行时保存的快照
2. 逐项恢复原系统代理配置
3. 通知 WinINet 刷新系统代理

## 7. macOS 实现说明

`apps/desktop/src-tauri/src/system_proxy/macos.rs` 通过 `/usr/sbin/networksetup` 实现：

接管流程：

1. 列出所有活动网络服务
2. 保存每个服务的 HTTP Proxy / HTTPS Proxy / Auto Proxy / Bypass Domains 快照
3. 设置 Web Proxy 和 Secure Web Proxy 到 AIProxy 代理地址
4. 关闭 Auto Proxy Discovery 和 Auto Proxy URL
5. 设置 bypass domains 为 `localhost, 127.0.0.1, ::1`

恢复流程：

1. 逐服务恢复原始代理配置
2. 恢复 Auto Proxy / Bypass Domains

## 8. Linux 实现说明

`apps/desktop/src-tauri/src/system_proxy/linux.rs` 支持 GNOME 和 KDE 两种桌面环境。

桌面环境检测：

- 读取 `XDG_CURRENT_DESKTOP` 和 `DESKTOP_SESSION` 环境变量
- 包含 `gnome`/`ubuntu`/`pop`/`unity` → 使用 gsettings
- 包含 `kde`/`plasma` → 使用 kwriteconfig6
- 其他桌面环境返回不支持的错误

### GNOME (gsettings)

接管流程：

1. 通过 `gsettings get` 保存 `org.gnome.system.proxy` 的 mode、http/https host/port、ignore-hosts
2. 设置 http/https host 和 port 到 AIProxy 代理地址
3. 设置 ignore-hosts 为 `['localhost', '127.0.0.1', '::1']`
4. 设置 mode 为 `'manual'`

恢复流程：

1. 从快照恢复所有 gsettings 键值

### KDE Plasma (kwriteconfig6)

接管流程：

1. 通过 `kreadconfig6` 保存 `kioslaverc` 中 Proxy Settings 组的 ProxyType、httpProxy、httpsProxy、NoProxyFor
2. 设置 ProxyType=1 (手动代理)
3. 设置 httpProxy 和 httpsProxy 到 AIProxy 代理地址
4. 设置 NoProxyFor

恢复流程：

1. 从快照恢复所有 kioslaverc 键值（含 httpProxy、httpsProxy、NoProxyFor、ProxyType），确保接管期间被改写的 httpsProxy 也被还原

> 注：`httpsProxy` 在接管时会被改写为代理地址，必须在快照捕获与恢复中成对处理，否则用户关闭系统代理后 httpsProxy 会残留为 AIProxy 地址。

### GNOME 取值归一化

`gsettings_get_optional` 在读取 `org.gnome.system.proxy` 的键值时，会将空串、`''`、`'none'` 三种值统一视为「未设置」（返回 `None`），避免把 GNOME 表达「无代理」的 `'none'` 误当成有效 host 捕获进快照。

## 9. 已知限制

- Linux 仅支持 GNOME 和 KDE 桌面环境，其他桌面环境（如 Sway、i3、XFCE）暂不支持
- Linux 系统代理不会设置环境变量 `http_proxy`/`https_proxy`，仅影响桌面应用
- HTTPS 解密链路已接入；系统代理只负责将 HTTP/HTTPS 流量导入 AIProxy，是否解密取决于代理启动模式、根证书生成状态与系统/设备信任状态
- 若应用异常崩溃，系统代理恢复仍需补充更强的兜底策略

## 10. 开发期排障日志

开发阶段排查系统代理切换失败或“已接管但未见请求”时，优先查看：

- `logs/dev/aiproxy-desktop-dev.log`
- 若仓库日志目录未生成，则查看：`%TEMP%\\aiproxy-dev\\logs\\dev\\aiproxy-desktop-dev.log`

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

- `logs/dev/aiproxy-desktop-dev.log` 会在每次桌面端启动时自动清空，只保留当前运行日志
- 若证书已信任，主界面会以 HTTPS 解密模式启动代理

若点击 `Enable System Proxy` 后仍无请求，按以下顺序判断：

1. 若没有 `listener_started`，说明代理未真正绑定监听端口
2. 若有 `listener_started` 但没有 `proxy_settings_applied`，说明系统代理接管失败
3. 若访问 `https://` 站点但没有 `connect_received`，说明流量尚未进入代理
4. 若有 `connect_received` 但出现 `connect_tunneling_without_mitm`，说明当前不是 HTTPS 解密模式启动
5. 若有 `connect_mitm_started` 但没有 `tls_handshake_succeeded`，优先查看 `tls_handshake_failed`
6. 若 TLS 成功但没有 `upstream_request_started`，优先排查解密后的请求解析
7. 若出现 `upstream_request_send_failed` 或 `https_upstream_request_failed`，说明请求已进入代理但访问目标站失败

## 11. 下一步建议

1. 在应用退出事件中强制恢复系统代理
2. 增加”恢复系统代理失败”的用户提示和手动恢复说明
3. 持续加强 HTTPS 解密失败诊断与证书状态联动
4. 考虑支持 Linux 环境变量 `http_proxy`/`https_proxy` 设置

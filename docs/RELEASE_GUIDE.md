# 打包与发布指南

本文档聚焦“正式交付”阶段，覆盖：

- 发版前准备
- 各平台打包
- 各平台签名 / 公证建议
- 各平台发布建议

当前仓库的桌面包由 Tauri 生成，核心配置位于 `apps/desktop/src-tauri/tauri.conf.json`。

## 1. 发布前统一检查

每次正式发布前，建议至少完成以下动作：

1. 更新版本号
2. 执行 lint / test / typecheck / Rust tests
3. 确认 GitHub Actions CI 已通过
4. 在目标平台本机或 Release workflow 中完成一次 `bundle`
5. 手工安装产物验证
6. 验证自动更新与系统代理恢复
7. 再上传到下载站点或 Release 页面

### 版本号需要同步的位置

- `package.json`
- `Cargo.toml`
- `apps/desktop/src-tauri/tauri.conf.json`

### Build Number 与唯一标识

- 桌面端 build script 会在编译时执行 `git rev-list --count HEAD`，并写入 `AIPROXY_BUILD_NUMBER`。
- CI 如需固定构建号，可显式设置环境变量 `AIPROXY_BUILD_NUMBER`；该值必须是纯数字。
- 软件唯一标识使用 `version+buildNumber` 格式，例如 `0.1.0+153`。
- 原生 `About AIProxy` 菜单显示 `0.1.0 (Build 153)`；Settings > About 同时显示 Version、Build Number 和 Version Identifier。
- 每次正式发布前，应确认工作区处于目标 commit，并在构建日志或应用 About 中核对 Build Number。

### 发布前质量命令

```bash
pnpm lint
pnpm test
pnpm typecheck
cargo test --workspace
```

如果只想先验证桌面端，也可以执行：

```bash
pnpm --filter @aiproxy/desktop lint
pnpm --filter @aiproxy/desktop test
pnpm --filter @aiproxy/desktop typecheck
```

## 2. 当前仓库的打包行为

当前 `tauri.conf.json` 已开启 bundle，`targets` 为 `all`。updater artifacts（`.sig` 签名、macOS `.app.tar.gz`）默认关闭（`bundle.createUpdaterArtifacts: false`），由 Release workflow 在配置了签名私钥时通过 `AIPROXY_UPDATER_ARTIFACTS` 自动开启。

含义：

- 在 macOS 主机打包时，会生成 macOS 相关 bundle
- 在 Windows 主机打包时，会生成 Windows 相关 bundle
- 在 Linux 主机打包时，会生成 Linux 相关 bundle

注意：

- 当前仓库脚本不支持跨平台打包
- 必须在对应原生宿主机上执行发布构建
- updater artifacts 需要配置 `TAURI_SIGNING_PRIVATE_KEY`；未配置时 Release 仅产出普通安装包（无 `.sig` / `latest.json`，自动更新不可用，发布流程不受阻塞）
- 配置私钥后，Release workflow 自动设置 `AIPROXY_UPDATER_ARTIFACTS=true`，构建产出 updater artifacts 并生成 `latest.json`，无需再改代码
- updater endpoint 固定为 `https://github.com/small-dream/AIProxy/releases/latest/download/latest.json`

统一打包命令：

macOS：

```bash
pnpm desktop:bundle:macos
```

Windows：

```powershell
pnpm desktop:bundle:windows
```

Linux：

```bash
pnpm desktop:bundle:linux
```

## 3. macOS 打包与发布

### 打包产物

常见产物目录：

- `target/release/bundle/macos/AIProxy.app`
- `target/release/bundle/dmg/AIProxy_<version>_<arch>.dmg`

### 发布前建议

- 使用 Apple Developer 证书对 `.app` 与 `.dmg` 进行签名
- 走 Apple notarization 公证
- 公证通过后再对外分发

### 为什么建议签名与公证

如果不做签名 / 公证，用户从浏览器下载后会被 Gatekeeper 拦截：

- 未签名 app 经浏览器下载后会被打上 `com.apple.quarantine` 隔离标记
- 在新版 macOS 上，提示通常是 **“已损坏，无法打开，应移至废纸篓”**（而不是较温和的“无法验证开发者”）
- **“右键 → 打开”对新版 macOS 上的“已损坏”提示无效**，用户必须手动清除隔离属性才能运行：

  ```bash
  xattr -cr /Applications/AIProxy.app
  ```

- 安装摩擦较大，普通用户难以自行解决

### 推荐发布渠道

- GitHub Releases
- 自建官网下载页
- 企业内部分发平台

### App Store 说明

如果未来要上 Mac App Store，通常需要额外处理：

- entitlements
- 沙箱能力
- 签名与提交流程

这部分不是当前仓库默认配置的一部分，建议单独开一条交付线。

Tauri 官方参考：

- https://v2.tauri.app/distribute/
- https://v2.tauri.app/distribute/sign/macos/

## 4. Windows 打包与发布

### 打包产物

常见产物目录：

- `target/release/bundle/msi/`
- `target/release/bundle/nsis/`

最终常见产物：

- `.msi`
- `.exe`

### 发布前建议

- 使用代码签名证书对安装包签名
- 在干净 Windows 机器上做一次安装验证
- 验证 WebView2 运行时是否已满足目标用户环境

### 为什么建议签名

如果不签名，常见问题是：

- SmartScreen 告警更明显
- 企业环境落地阻力较大
- 安装包信任链较弱

### 推荐发布渠道

- GitHub Releases
- 官网下载页
- 企业软件分发平台
- Microsoft Store（如果未来需要单独适配）

Tauri 官方参考：

- https://v2.tauri.app/distribute/
- https://v2.tauri.app/distribute/sign/windows/

## 5. Linux 打包与发布

### 打包产物

常见产物目录：

- `target/release/bundle/appimage/`
- `target/release/bundle/deb/`
- `target/release/bundle/rpm/`

最终常见产物：

- `.AppImage`
- `.deb`
- `.rpm`

### 发布前建议

- 尽量在你要支持的较低版本 Linux 发行版上构建
- 分别验证 Debian/Ubuntu、Fedora/RHEL、Arch 系兼容性
- 如果要做仓库级分发，再补 GPG 签名与仓库元数据

### 推荐发布渠道

- GitHub Releases
- 官网下载页
- `.deb` APT 仓库
- `.rpm` YUM/DNF 仓库
- AppImage 直接下载

### Linux 特别说明

Linux 桌面依赖、GLIBC 版本、WebKitGTK 版本差异都可能影响可运行性，所以 Linux 发版最适合：

- 明确支持的发行版范围
- 明确最低版本
- 每个目标发行版各做一次安装验证

Tauri 官方参考：

- https://v2.tauri.app/distribute/

## 6. 建议的手工发布流程

### macOS

1. 更新版本号
2. 运行 `pnpm lint && pnpm test && pnpm typecheck`
3. 运行 `pnpm desktop:bundle:macos`
4. 安装并验证 `.app` / `.dmg`
5. 完成签名与公证
6. 上传到 GitHub Releases 或官网

### Windows

1. 更新版本号
2. 运行 `pnpm lint && pnpm test && pnpm typecheck`
3. 运行 `pnpm desktop:bundle:windows`
4. 安装并验证 `.msi` / `.exe`
5. 完成代码签名
6. 上传到 GitHub Releases 或官网

### Linux

1. 更新版本号
2. 运行 `pnpm lint && pnpm test && pnpm typecheck`
3. 运行 `pnpm desktop:bundle:linux`
4. 验证 `.AppImage` / `.deb` / `.rpm`
5. 按分发渠道补签名或仓库元数据
6. 上传到 GitHub Releases、官网或软件仓库

## 7. GitHub Release 建议结构

建议每个版本创建一个 Release，例如：

- `v0.1.0`
- `v0.1.0-test`（预发布验证）

建议上传：

- macOS：`.dmg`
- Windows：`.msi`，如有需要再附 `.exe`
- Linux：`.AppImage`、`.deb`、`.rpm`
- updater artifacts：macOS `.app.tar.gz`、Windows `.msi.sig` / `.exe.sig`、Linux `.AppImage.sig`
- `latest.json`

建议在 Release Notes 中写清楚：

- 版本号
- 更新内容
- 支持的平台与架构
- 安装方式
- 已知限制
- 签名状态：`signed/notarized` 或 `unsigned`
- 未签名产物的用户安装提示（如 macOS 需执行 `xattr -cr /Applications/AIProxy.app` 清除隔离属性）

## 8. GitHub Actions 自动发布

仓库已提供：

- `.github/workflows/ci.yml`：PR 与 `master` push 的质量门禁
- `.github/workflows/release.yml`：`v*` tag 与手动触发的三端打包发布

Release workflow 的默认发布仓库为：

- `small-dream/AIProxy`

updater artifacts 为**条件性开启**：`release.yml` 检测到 `TAURI_SIGNING_PRIVATE_KEY` 已配置时，自动设置 `AIPROXY_UPDATER_ARTIFACTS=true`，`scripts/desktop.mjs` 据此在 `tauri build` 时注入 `--config {"bundle":{"createUpdaterArtifacts":true}}`；未配置时照常发布普通安装包，不会阻塞发版。

正式发布前必须配置：

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

注意：`tauri.conf.json` 中的 updater `pubkey`（当前为正式公钥，key id `F5F73F956781BB2C`）必须与正式发布使用的私钥匹配。私钥由发布负责人通过 `cargo tauri signer generate` 生成并妥善保管（建议存入密码管理器），仅将私钥与密码写入 GitHub Secrets，不要提交到仓库。

平台签名 / 公证 Secrets 可按阶段补齐：

- macOS：`APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`、`APPLE_API_ISSUER`、`APPLE_API_KEY_ID`、`APPLE_API_KEY`
- Windows：`WINDOWS_CERTIFICATE`、`WINDOWS_CERTIFICATE_PASSWORD`

如果未配置平台签名证书，Release workflow 仍允许产出未签名安装包，但 Release Notes 必须明确标记 `unsigned`。

## 9. 自动更新验证

每次发布前至少验证：

1. 安装旧版本
2. 发布更高版本到 GitHub Releases
3. 打开 `Settings -> Software Updates`
4. 点击 `Check for Updates`
5. 确认能检测到新版本
6. 点击 `Install & Restart`
7. 确认应用重启后版本已更新

若 `latest.json` 缺失、签名错误或 updater artifact 不完整，应用应显示失败状态，不应破坏当前安装。

## 10. 系统代理恢复验证

每次正式发布前至少验证：

1. 启动代理并启用系统代理
2. 正常关闭系统代理，确认系统代理恢复且 pending snapshot 被清理
3. 启用系统代理后模拟应用异常退出
4. 重新启动 AIProxy，确认启动时自动恢复系统代理
5. 若恢复失败，确认 `Settings` 中出现恢复警告，并且下次启动仍会重试

## 11. 回滚流程

如果发布后发现阻断问题：

1. 在 GitHub Releases 中将问题版本标记为 pre-release 或撤下下载说明
2. 将 `latest.json` 回滚到上一稳定版本
3. 发布修复版本，例如 `v0.1.1`
4. 在 Release Notes 中说明受影响版本、回滚建议和系统代理手动恢复方式

## 12. 当前仓库的已知发布边界

- 当前仓库已经具备本地运行、调试编译、正式 bundle 的能力
- 当前仓库已提供 CI/CD 自动发布工作流
- updater 签名密钥必须由发布负责人生成并注入 GitHub Secrets
- macOS notarization 与 Windows code signing 仍依赖外部开发者账号和证书

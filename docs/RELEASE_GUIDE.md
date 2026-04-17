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
2. 执行 lint / test / typecheck
3. 在目标平台本机完成一次 `bundle`
4. 手工安装产物验证
5. 再上传到下载站点或 Release 页面

### 版本号需要同步的位置

- `package.json`
- `Cargo.toml`
- `apps/desktop/src-tauri/tauri.conf.json`

### 发布前质量命令

```bash
pnpm lint
pnpm test
pnpm typecheck
```

如果只想先验证桌面端，也可以执行：

```bash
pnpm --filter @aiproxy/desktop lint
pnpm --filter @aiproxy/desktop test
pnpm --filter @aiproxy/desktop typecheck
```

## 2. 当前仓库的打包行为

当前 `tauri.conf.json` 已开启 bundle，且 `targets` 为 `all`。

含义：

- 在 macOS 主机打包时，会生成 macOS 相关 bundle
- 在 Windows 主机打包时，会生成 Windows 相关 bundle
- 在 Linux 主机打包时，会生成 Linux 相关 bundle

注意：

- 当前仓库脚本不支持跨平台打包
- 必须在对应原生宿主机上执行发布构建

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

如果不做签名 / 公证，用户下载后通常会遇到：

- Gatekeeper 拦截
- “无法验证开发者” 提示
- 安装摩擦较大

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

建议上传：

- macOS：`.dmg`
- Windows：`.msi`，如有需要再附 `.exe`
- Linux：`.AppImage`、`.deb`、`.rpm`

建议在 Release Notes 中写清楚：

- 版本号
- 更新内容
- 支持的平台与架构
- 安装方式
- 已知限制

## 8. 当前仓库的已知发布边界

- 当前仓库已经具备本地运行、调试编译、正式 bundle 的能力
- 当前仓库尚未内置 CI/CD 自动发布工作流
- 当前仓库也没有现成的签名 / 公证密钥管理方案

如果后续要做自动化发布，推荐下一步新增：

- GitHub Actions 打包工作流
- 各平台证书与密钥的 Secrets 管理
- 自动创建 GitHub Release
- 自动上传安装产物

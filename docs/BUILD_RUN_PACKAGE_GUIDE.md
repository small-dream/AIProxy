# 编译、运行、打包指南

本文档面向当前仓库的桌面端交付链路，覆盖：

- 环境准备
- 依赖与系统库安装
- 编译 / 运行 / 打包命令
- 各平台一键脚本入口

当前仓库主产物是 Tauri 桌面应用，不是 `npm publish` 类型的 JS 包。桌面端入口位于 `apps/desktop`，Tauri 工程位于 `apps/desktop/src-tauri`。

## 1. 适用范围

- macOS：生成 `.app` 与 `.dmg`
- Windows：生成 `.exe` / `.msi` 等 Windows 安装产物
- Linux：生成 `.AppImage` / `.deb` / `.rpm` 等 Linux 安装产物

说明：

- 运行、编译、打包都必须在对应原生平台上执行
- 当前仓库脚本显式禁止跨平台打包
- `build` 产出的是调试二进制，`bundle` 产出的是正式安装包
- 桌面端编译时会根据当前 Git commit 数生成 Build Number；应用内唯一版本标识格式为 `version+buildNumber`

## 2. 项目所需基础工具

所有平台都需要：

- Node.js
- `pnpm`（通过 `corepack` 启用）
- Rust stable toolchain
- `cargo-tauri`
- 平台自己的桌面运行时依赖

当前仓库已经验证可工作的组合：

- `Node.js 25.2.1`
- `pnpm 10.0.0`
- `cargo 1.94.1`
- `tauri-cli 2.10.1`

推荐：

- 优先使用 Node.js LTS
- Rust 使用 stable
- `cargo-tauri` 安装命令使用官方 v2 方式：

```bash
cargo install tauri-cli --version "^2.0.0" --locked
```

Tauri 官方参考：

- https://v2.tauri.app/start/prerequisites/
- https://v2.tauri.app/reference/cli/

## 3. 各平台所需配置与系统库

### macOS

必需项：

- Xcode Command Line Tools
- Homebrew
- Node.js
- Rustup / Cargo
- `cargo-tauri`

常用安装命令：

```bash
xcode-select --install
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node
corepack enable
corepack prepare pnpm@10.0.0 --activate
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install tauri-cli --version "^2.0.0" --locked
```

### Windows

必需项：

- Microsoft Edge WebView2 Runtime
- Microsoft Visual Studio 2022 Build Tools
- C++ Desktop / MSVC 工具链
- Node.js
- Rustup / Cargo
- `cargo-tauri`

建议使用：

- `winget` 安装系统依赖
- `stable-x86_64-pc-windows-msvc` Rust toolchain

### Linux

必需项：

- GTK / WebKitGTK
- OpenSSL 开发库
- AppIndicator 库
- `librsvg`
- `libxdo`
- `patchelf`
- Node.js
- Rustup / Cargo
- `cargo-tauri`

当前脚本已内置以下 Linux 发行版支持：

- Debian / Ubuntu
- Fedora / RHEL 系
- Arch / Manjaro 系

Tauri 官方前置依赖可能随发行版版本略有差异，请优先以官方页面为准：

- https://v2.tauri.app/start/prerequisites/

## 4. 一键脚本

### 环境安装 / 初始化脚本

- macOS：`scripts/setup/setup-macos.sh`
- Windows：`scripts/setup/setup-windows.ps1`
- Linux：`scripts/setup/setup-linux.sh`

作用：

- 安装平台系统依赖
- 安装 Node.js / pnpm / Rust / `cargo-tauri`
- 执行 `pnpm install`

执行方式：

macOS：

```bash
bash scripts/setup/setup-macos.sh
```

Windows：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup\setup-windows.ps1
```

Linux：

```bash
bash scripts/setup/setup-linux.sh
```

### 运行脚本

- macOS：`scripts/dev/run-macos.sh`
- Windows：`scripts/dev/run-windows.ps1`
- Linux：`scripts/dev/run-linux.sh`

### 编译脚本

- macOS：`scripts/build/build-macos.sh`
- Windows：`scripts/build/build-windows.ps1`
- Linux：`scripts/build/build-linux.sh`

### 打包脚本

- macOS：`scripts/release/bundle-macos.sh`
- Windows：`scripts/release/bundle-windows.ps1`
- Linux：`scripts/release/bundle-linux.sh`

## 5. 安装仓库依赖

初始化完成后，在仓库根目录执行：

```bash
pnpm install
```

如果使用一键初始化脚本，这一步已经自动执行。

## 6. 编译、运行、打包命令

### 运行桌面应用

macOS：

```bash
pnpm desktop:run:macos
```

Windows：

```powershell
pnpm desktop:run:windows
```

Linux：

```bash
pnpm desktop:run:linux
```

说明：

- 会先构建前端产物
- 再执行 Rust/Tauri 本地运行链路

### 编译调试二进制

macOS：

```bash
pnpm desktop:build:macos
```

Windows：

```powershell
pnpm desktop:build:windows
```

Linux：

```bash
pnpm desktop:build:linux
```

说明：

- 当前脚本执行的是 `cargo build`
- 默认生成调试版二进制，方便本地验证

### 打包正式安装产物

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

说明：

- 当前脚本执行的是前端构建 + `cargo tauri build`
- 会生成 release 级别安装产物

## 7. 产物目录

### 前端产物

- `apps/desktop/dist`

### 调试二进制

- macOS / Linux：`target/debug/AIProxy`
- Windows：`target/debug/AIProxy.exe`

### 正式安装产物

- `target/release/bundle/`

常见目录：

- macOS：`target/release/bundle/macos/`、`target/release/bundle/dmg/`
- Windows：`target/release/bundle/msi/`、`target/release/bundle/nsis/`
- Linux：`target/release/bundle/appimage/`、`target/release/bundle/deb/`、`target/release/bundle/rpm/`

当前仓库已验证 macOS 打包成功，示例产物：

- `target/release/bundle/macos/AIProxy.app`
- `target/release/bundle/dmg/AIProxy_0.1.0_aarch64.dmg`

## 8. 常见问题

### 1. 为什么不能在 macOS 上直接打 Windows 包

因为当前 `scripts/desktop.mjs` 显式校验了主机平台，要求：

- macOS 在 macOS 主机打
- Windows 在 Windows 主机打
- Linux 在 Linux 主机打

这是当前仓库的既定约束，也是 Tauri 桌面打包的常见实践。

### 2. `cargo tauri` 找不到

执行：

```bash
cargo install tauri-cli --version "^2.0.0" --locked
```

然后验证：

```bash
cargo tauri -V
```

### 3. macOS 打 `.dmg` 失败

优先检查：

- 是否在原生 macOS 主机执行
- `xcode-select -p` 是否正常
- 是否是受限沙箱 / CI 环境导致 `hdiutil` 无法创建镜像

### 4. Linux 缺少 GTK / WebKitGTK

优先重新执行：

```bash
bash scripts/setup/setup-linux.sh
```

再根据当前发行版补齐缺失系统库。

# macOS 原生菜单本地化设计（rust-i18n 方案）

- 日期：2026-06-14
- 状态：待评审（v2：已吸收 spec review 反馈，收紧错误语义 / system 冷启动 / 命令归属 / 可测性）
- 关联代码：`apps/desktop/src-tauri/src/menu.rs`、`apps/desktop/src/i18n/`、`apps/desktop/src/app/providers/AppProviders.tsx`
- 关联文档：`docs/API_SPEC.md`、`docs/UI_GUIDELINES.md`、`docs/PAGE_BLUEPRINTS.md`、`docs/ARCHITECTURE.md`

## 1. 背景

当前应用菜单完全由 Rust 构建（`menu.rs`），且**仅在 macOS 上构建**（非 macOS 平台 `build_menu` 为 no-op）。约 40 条自定义菜单标签均为硬编码英文（如 `"Import HAR..."`、`"Preferences..."`），不随界面语言切换。

i18n 能力目前只在前端：`apps/desktop/src/i18n/messages/{en,zh-CN}.ts` + `useI18n()` / `t()`。语言偏好 `LanguagePreference`（`"en" | "system" | "zh-CN"`）存在前端 `useAppPreferencesStore`（localStorage），**Rust 侧无任何语言状态**。`PredefinedMenuItem`（undo/redo/cut/copy/paste/select all/minimize/maximize/fullscreen/close/hide/hide_others/show_all/services/quit/about）传 `None` 文本，已由 macOS 系统本地化，不在本方案范围。

## 2. 目标与非目标

### 目标
- 自定义菜单标签随界面语言（en / zh-CN）切换。
- 语言切换后菜单**运行时实时重建**，无需重启。
- 启动即按当前应显示语言构建菜单（**含 `system` 偏好**：Rust 启动期解析系统语言），消除首屏英文闪现。
- 字符串与代码分离，遵循业界 i18n 惯例；为 Rust 侧后续本地化（原生对话框/通知/错误文案）奠定基础。

### 非目标
- 不改动 `PredefinedMenuItem`（已由系统本地化）。
- 不新增 Windows / Linux 原生菜单（当前 `build_menu` 在这些平台为 no-op；本方案仅保证命令前向兼容）。
- 不追求 TS 与 Rust 跨语言共享翻译目录（业界无此标准，[`tauri-plugin-i18n`](https://crates.io/crates/tauri-plugin-i18n) 也前后端各自一套；本方案接受跨边界重复）。
- 不改动前端 `en.ts` / `zh-CN.ts` webview 目录（菜单串属原生界面，独立维护）。
- **接受极小差异**：前端 webview 用 `navigator` 解析 `system`，Rust 菜单用 `sys-locale` 解析；二者规则一致（zh*→zh-CN，否则 en），仅在浏览器语言与 OS 语言不一致的极端情况短暂分歧，并在下一次 `set_menu_locale` 自愈。

## 3. 方案选择与依据

**采用方案：Rust 侧引入 `rust-i18n`（v4）+ YAML locale 文件 + 运行时重建命令。**

调研结论（2026-06）：

1. Tauri 2 官方无"菜单自动本地化"机制，原生菜单 i18n 是公认痛点（[Discussion #4985](https://github.com/orgs/tauri-apps/discussions/4985)）。
2. 事实标准做法 = Rust i18n 库 + locale 文件 + 语言切换时重建并 `set_menu`（[Discussion #7735](https://github.com/orgs/tauri-apps/discussions/7735)、[Window Menu 文档](https://v2.tauri.app/learn/window-menu/)）。Tauri 无对已有菜单项的 `updateText()`，重建整张菜单是共识模式。
3. Rust i18n 生态尚无成熟标准（[Are We Web Yet: i18n](https://www.arewewebyet.org/topics/i18n/)）。按规模：`rust-i18n`（YAML、`t!()` 宏、轻量，[`tauri-plugin-i18n`](https://crates.io/crates/tauri-plugin-i18n) 的后端）适合中小项目；Mozilla `fluent`（`.ftl`、复数/性别）偏重，本场景 ~40 条无复数文案属过度设计。
4. "代码与翻译分离"是最普遍的 i18n 铁律；纯手写 Rust 嵌入式字符串表（早期方案 A）偏离该惯例。故采用 A+。

`rust-i18n` 关键特性（已核对官方 README）：
- 依赖 `rust-i18n = "4"`（最新 4.1.0；v4 对 `i18n!` / `t!` / `set_locale` / 显式 `locale=` 形式无 breaking change，已核对 main 分支 README）；`i18n!("locales", fallback = "en")` 在 crate 根**编译期**嵌入翻译，运行时无文件 IO。
- `_version: 1` 支持**一文件一语言**（`locales/en.yml`、`locales/zh-CN.yml`），与本仓库前端 `en.ts`/`zh-CN.ts` 模式一致。
- key 支持点号（如 `menu.goto.sessions`）；`t!("menu.file")` 全局宏按当前 locale 取值。
- `rust_i18n::set_locale("zh-CN")` 运行时切换全局 locale，`t!` 立即生效——驱动菜单重建。
- 支持 fallback 链与 territory 回退（`zh-CN` → `zh`）。

## 4. 架构概览

```
┌─ Frontend (React/TS) ──────────────────────┐   ┌─ Rust (Tauri core) ──────────────────────────┐
│  useAppPreferencesStore                    │   │  rust-i18n (编译期嵌入 src-tauri/locales/*.yml)│
│   .languagePreference (en/system/zh-CN)    │   │                                               │
│        │ resolve(navigator) → locale       │   │  sys-locale (启动期解析 system 偏好)           │
│        ▼                                   │   │        │                                      │
│  AppProviders effect [pref, locale]        │   │        ▼ resolve_menu_locale(pref, sys)       │
│   setMenuLocale(preference) ───────────────┼──►│  commands::set_menu_locale (薄封装, 不可失败)  │
│                                            │   │     └─► menu::apply_locale                    │
│                                            │   │           ├─ persist preference (warn on fail)│
│                                            │   │           ├─ set_locale + build_menu (warn)   │
│                                            │   │                                               │
│  启动: menu::load_menu_locale() → preference│   │  boot: load pref → resolve(system) → build    │
└────────────────────────────────────────────┘   └───────────────────────────────────────────────┘
```

四块改动：① Rust 接入 `rust-i18n` + `sys-locale` + locale 文件；② `build_menu` 接收 resolved locale、`menu.rs` 暴露域函数 `apply_locale`；③ `commands/menu.rs` 薄封装命令 + 持久化（含路径可注入 helper）；④ 前端 effect 下发 preference。

## 5. 详细设计

### 5.1 Rust：接入 rust-i18n 与 sys-locale

- `apps/desktop/src-tauri/Cargo.toml` 增加：
  - `rust-i18n = "4"`（菜单 i18n；最新 4.1.0）
  - `sys-locale = "0.3"`（启动期在 Rust 侧跨平台解析 `system` 偏好的系统语言；最新 0.3.2，注意是 0.x crate）
- 在 crate 根（`apps/desktop/src-tauri/src/main.rs`）增加：
  ```rust
  #[macro_use]
  extern crate rust_i18n;

  // Load compiled-in translations from src-tauri/locales, English fallback.
  rust_i18n::i18n!("locales", fallback = "en");
  ```
- `menu.rs` 内 `use rust_i18n::t;`，用 `t!("menu.<key>")` 取标签。

> `i18n!` 的 `locales` 路径相对于 crate 根（`src-tauri/`），故文件落在 `apps/desktop/src-tauri/locales/`。

### 5.2 Locale 文件与 key 清单

新建 `apps/desktop/src-tauri/locales/en.yml`、`apps/desktop/src-tauri/locales/zh-CN.yml`（`_version: 1`）。命名空间统一 `menu.*`。

**一致性约束**：导航项 / 主题项 / 配置指南 / 断点规则 等术语**必须对齐**前端 `zh-CN.ts` 现有译法（已核对）：
- 导航：`sessions=会话`、`compose=构造请求`、`rules=规则`、`throttling=弱网`、`certificates=证书`、`settings=设置`
- 主题：`themeOptionDark=暗黑`、`themeOptionLight=浅色`、`themeOptionSystem=跟随系统`
- 其他：`setupGuide=配置指南`、`breakpointRulesTitle=断点规则`

完整 key 清单（en / zh-CN）：

| key | en | zh-CN | 来源/对齐 |
|---|---|---|---|
| `menu.submenu.file` | File | 文件 |  |
| `menu.submenu.edit` | Edit | 编辑 |  |
| `menu.submenu.view` | View | 视图 |  |
| `menu.submenu.proxy` | Proxy | 代理 |  |
| `menu.submenu.tools` | Tools | 工具 |  |
| `menu.submenu.window` | Window | 窗口 |  |
| `menu.submenu.help` | Help | 帮助 |  |
| `menu.submenu.app` | AIProxy | AIProxy | 品牌，不变 |
| `menu.submenu.android_quick_actions` | Android Quick Actions | Android 快捷操作 |  |
| `menu.import_har` | Import HAR... | 导入 HAR... |  |
| `menu.export_har` | Export as HAR... | 导出为 HAR... |  |
| `menu.clear_all_sessions` | Clear All Sessions | 清除所有会话 |  |
| `menu.close_window` | Close Window | 关闭窗口 |  |
| `menu.find` | Find... | 查找... |  |
| `menu.refresh` | Refresh | 刷新 |  |
| `menu.goto.sessions` | Sessions | 会话 | 对齐前端 |
| `menu.goto.compose` | Compose | 构造请求 | 对齐前端 |
| `menu.goto.rules` | Rules | 规则 | 对齐前端 |
| `menu.goto.throttling` | Throttling | 弱网 | 对齐前端 |
| `menu.goto.certificates` | Certificates | 证书 | 对齐前端 |
| `menu.goto.settings` | Settings | 设置 | 对齐前端 |
| `menu.zoom.in` | Zoom In | 放大 |  |
| `menu.zoom.out` | Zoom Out | 缩小 |  |
| `menu.zoom.reset` | Reset Zoom | 重置缩放 |  |
| `menu.theme.dark` | Dark Theme | 暗黑 | 对齐前端 |
| `menu.theme.light` | Light Theme | 浅色 | 对齐前端 |
| `menu.theme.system` | Follow System Theme | 跟随系统 | 对齐前端 |
| `menu.start_proxy` | Start Proxy | 启动代理 |  |
| `menu.stop_proxy` | Stop Proxy | 停止代理 |  |
| `menu.toggle_system_proxy` | Toggle System Proxy | 切换系统代理 |  |
| `menu.clear_sessions` | Clear Sessions | 清除会话 |  |
| `menu.breakpoint_rules` | Breakpoint Rules... | 断点规则... | 对齐前端 |
| `menu.throttling` | Throttling... | 弱网... | 对齐前端 |
| `menu.install_cert` | Install Root Certificate | 安装根证书 |  |
| `menu.cert_status` | Certificate Status | 证书状态 |  |
| `menu.ios_quick_actions` | iOS Quick Actions | iOS 快捷操作 |  |
| `menu.adb_set_proxy` | Set Proxy via ADB | 通过 ADB 设置代理 |  |
| `menu.adb_clear_proxy` | Clear Proxy via ADB | 通过 ADB 清除代理 |  |
| `menu.setup_wizard` | Setup Guide... | 配置指南... | 对齐前端 |
| `menu.check_for_updates` | Check for Updates... | 检查更新... |  |
| `menu.documentation` | AIProxy Documentation | AIProxy 文档 |  |
| `menu.show_logs` | Show Logs | 显示日志 |  |
| `menu.shortcuts` | Keyboard Shortcuts | 键盘快捷键 |  |
| `menu.about` | About AIProxy | 关于 AIProxy |  |
| `menu.preferences` | Preferences... | 偏好设置... |  |

> `menu.about` 用于 `PredefinedMenuItem::about(handle, Some(t!("menu.about")), ...)` 的标题（替换当前硬编码 `"About AIProxy"`）。其余 `PredefinedMenuItem` 仍传 `None`，保持系统本地化。`AboutMetadata` 的 `comments`（`Build {} · {}`）是构建信息，不本地化。

### 5.3 `build_menu` 改造

- 签名：`pub fn build_menu<R: Runtime>(app: &AppHandle<R>, locale: &str) -> Result<(), tauri::Error>`（macOS 实现；非 macOS 实现同样接 `locale` 参数并忽略，保持签名一致）。
- 实现内防御性归一化：`locale` 非 `"zh-CN"` 即按 `"en"` 处理（`build_menu` 内 clamp，不依赖调用方）。
- 每个 `MenuItemBuilder::new(t!("menu.<key>"))` 与 `SubmenuBuilder::new(handle, t!("menu.submenu.<x>"))` 用 `t!` 取标签；`t!` 读取由调用方先行 `set_locale` 设定的全局 locale。其余（id、accelerator）不变。
- **不直接读 locale 全局状态做控制流**——`build_menu` 总是构建完整菜单，仅标签随 locale 变。

### 5.4 命令归属与 `menu::apply_locale` 域函数

**域逻辑收在 `menu.rs`**，命令层只做薄封装：

`menu.rs` 新增：
```rust
/// Resolve a LanguagePreference to a concrete menu locale.
/// `system_locale` 由调用方注入（生产用 sys-locale，测试用固定值），保证纯函数可测。
pub fn resolve_menu_locale(preference: &str, system_locale: Option<&str>) -> &'static str {
    match preference {
        "zh-CN" => "zh-CN",
        "en" => "en",
        _ => resolve_system_locale(system_locale), // "system" / 未知
    }
}

fn resolve_system_locale(system_locale: Option<&str>) -> &'static str {
    match system_locale {
        Some(s) if s.to_lowercase().starts_with("zh") => "zh-CN",
        _ => "en",
    }
}

/// Apply a language preference: persist + set global locale + rebuild (best-effort, infallible).
/// 任何子步骤失败仅 `tracing::warn!`，绝不向上抛错 —— 见 §6 错误语义。
pub fn apply_locale<R: Runtime>(app: &AppHandle<R>, preference: &str) {
    let locale = resolve_menu_locale(preference, sys_locale::get_locale().as_deref());
    if let Err(error) = save_menu_locale(preference) {
        tracing::warn!(
            component = "desktop.menu", event = "menu_locale_persist_failed",
            error = %error, "menu_locale_persist_failed"
        );
    }
    rust_i18n::set_locale(locale);
    #[cfg(target_os = "macos")]
    if let Err(error) = build_menu(app, locale) {
        tracing::warn!(
            component = "desktop.menu", event = "menu_rebuild_failed",
            locale = locale, error = %error, "menu_rebuild_failed"
        );
    }
    // 非 macOS：仅持久化 + set_locale，不重建（无原生菜单）。
}
```

`commands/menu.rs`（新增薄封装）：
```rust
use tauri::{AppHandle, Runtime};

/// Infallible by design: failures are logged best-effort in `menu::apply_locale` (§6).
/// Returning unit (not Result) means the frontend `invoke` never rejects.
#[tauri::command]
pub fn set_menu_locale<R: Runtime>(app: AppHandle<R>, preference: String) {
    crate::menu::apply_locale(&app, &preference);
}
```

`commands/mod.rs` 增加（沿用既有 `mod + pub use` 约定）：
```rust
mod menu;
pub use menu::*;
```

`main.rs` 的 `generate_handler!` 增加 `commands::set_menu_locale`（命令在**所有平台**注册）。

> 设计要点：命令返回 `()` 而非 `Result`，**故意**让前端 `invoke` 永不 reject——菜单重建/持久化失败属可降级（菜单停留在旧语言、下次自愈），不应变成 unhandled promise rejection（见 §6）。

### 5.5 持久化（消除首屏闪现，含 system 冷启动）

**持久化 `LanguagePreference`（三态）而非 resolved locale**，启动期 Rust 自行解析 `system`——这保证"退出期间改了系统语言"后下次冷启动菜单仍正确。

- 文件：`<resolve_db_dir()>/menu-locale.json`，内容 `{ "preference": "en" | "system" | "zh-CN" }`。
- 路径解析**复用** `aiproxy_db::connection::resolve_db_dir()`，fallback `dirs::data_dir()` → `dirs::data_local_dir()` → temp dir（与 `resolve_window_state_path` 完全一致）。
- **可注入路径的纯函数**（测试用 temp dir，不污染真实目录）：
  ```rust
  fn save_menu_locale_to(path: &Path, preference: &str) -> Result<(), String>; // serde_json 序列化 + fs::write，含 create_dir_all
  fn load_menu_locale_from(path: &Path) -> Option<String>;                       // fs::read_to_string + serde 反序列化，失败返回 None
  ```
- **生产 wrapper**（解析真实路径并委托）：
  ```rust
  pub(crate) fn save_menu_locale(preference: &str) -> Result<(), String> {
      save_menu_locale_to(&resolve_menu_locale_path(), preference)
  }
  pub(crate) fn load_menu_locale() -> Option<String> {
      load_menu_locale_from(&resolve_menu_locale_path())
  }
  fn resolve_menu_locale_path() -> PathBuf { /* resolve_db_dir fallback chain */ .join("menu-locale.json") }
  ```
- **启动流程**（`main.rs setup()`，替换当前 `build_menu(app.handle())`）：
  ```rust
  let preference = menu::load_menu_locale().unwrap_or_else(|| "system".to_string()); // 首启默认 system
  menu::apply_locale(app.handle(), &preference); // resolve(system via sys-locale) + set_locale + build
  ```
  首次启动无文件 → 默认 `"system"` → Rust 经 `sys-locale` 解析为当前系统语言。

### 5.6 前端：service + effect（下发 preference）

- 新增 `apps/desktop/src/services/menu/set-menu-locale.ts`（当前 `services/` 下无专门 menu 目录，确认新建；`services/events/index.ts` 仅有 `onMenuEvent`，不并入）：
  ```ts
  export type MenuLanguagePreference = "en" | "system" | "zh-CN";

  export async function setMenuLocale(preference: MenuLanguagePreference): Promise<void> {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
    // Command is infallible (returns unit); no .catch needed — see §6.
    await invoke("set_menu_locale", { preference });
  }
  ```
  防御与现有 `services/events/index.ts` 一致。
- 在 `AppProviders.tsx`（已计算 `languagePreference` 与 `locale`）加 effect，**依赖两者**：
  ```ts
  useEffect(() => {
    void setMenuLocale(languagePreference);
  }, [languagePreference, locale]);
  ```
  - 依赖 `languagePreference`：偏好变更（en↔system↔zh-CN）触发。
  - 依赖 `locale`：`system` 偏好下系统语言变化（`navigator` `languagechange` 事件）触发，重新下发 `system` → Rust 经 `sys-locale` 重新解析并重建。
  - **去重策略**：不做前端 ref 去重。重复调用 Rust 侧幂等处理，保持实现简单。
- 下发的是 **`preference`（三态）**，不是 resolved locale：Rust 持久化它用于冷启动，并自行解析 `system`。前端 `locale` 仅作 effect 依赖触发，不作为参数。

### 5.7 数据流

- **切换偏好**：Settings 改 `languagePreference` → zustand → effect 触发 → `setMenuLocale(preference)` → Rust `apply_locale`：persist preference + `set_locale`(resolve) + macOS 重建 → 菜单栏实时更新。
- **system 偏好 + 系统语言变化（应用开启）**：`navigator` `languagechange` → 前端 `locale` 变 → effect 触发 → 重发 `system` → Rust 经 `sys-locale` 重新解析 → 重建。
- **冷启动**：Rust 读 `menu-locale.json` 的 preference（首启默认 `system`）→ `apply_locale`：`resolve_menu_locale(pref, sys-locale)` + `set_locale` + `build_menu` → 启动即正确语言，**即使退出期间改过系统语言**。

## 6. 错误语义与边界（统一）

- **命令不可失败**：`set_menu_locale` 返回 `()`；`apply_locale` 内 persist 失败、`build_menu` 失败均仅 `tracing::warn!`，**不向上抛、不向 JS reject**。理由：菜单重建/持久化失败属可降级——菜单停留在旧语言、下次切换或重启自愈，绝不应变成 unhandled promise rejection 影响语言切换主流程。（修正 v1 中"命令返回 Err"与"仅 warn 不崩溃"的矛盾。）
- **平台**：macOS 实际重建；Windows/Linux `apply_locale` 仅 set_locale + persist，不重建。命令注册全平台。
- **locale 归一化**：`resolve_menu_locale` 对未知 preference 走 `system` 分支（→ sys-locale → en fallback）；`build_menu` 内再 clamp 非 `"zh-CN"` → `"en"`，双重防御。
- **PredefinedMenuItem**：保持 `None` 文本，由 macOS 本地化；仅 `about` 标题用 `t!("menu.about")`。
- **key 缺失**：rust-i18n fallback = `en`；缺失显示原始 key 串（可选启用 `log-miss-tr` 特性便于发现遗漏）。
- **invoke 时序**：effect 在 React 首次渲染后触发；命令在 `setup()` 已注册，时序安全。
- **接受极小差异**：前端用 `navigator`、Rust 用 `sys-locale` 解析 `system`；规则一致，仅浏览器语言≠OS 语言的极端情形短暂分歧，下次 `set_menu_locale` 自愈（已列入非目标）。
- **全局 locale 临界区（低优先，可选）**：`rust_i18n::set_locale` 是全局状态；快速连续切换理论上可交错，但因每次 `apply_locale` 用同一 preference 自洽且重建幂等，最终状态由最后一次调用决定，可接受。若需严格原子，可用 `Mutex` 包 `apply_locale` 的 set_locale+build 段——实现期酌情。

## 7. 测试策略

**Rust 单测（全部避免触碰全局 locale / 真实用户目录）**
- `resolve_menu_locale(pref, system_locale)`：纯函数，注入 `system_locale`。断言：`("zh-CN", _)→"zh-CN"`；`("en", _)→"en"`；`("system", Some("zh-CN"))→"zh-CN"`；`("system", Some("en-US"))→"en"`；`("system", None)→"en"`；`("garbage", Some("zh-TW"))→"zh-CN"`。
- **locale 文件完整性**：遍历 §5.2 全部 key，用 **`t!("menu.<key>", locale = "en")` 与 `locale = "zh-CN"` 显式形式**（不调用 `set_locale`、不改动全局）读取，断言返回非空且非原始 key 串。显式 locale 形式使测试**并行安全**，无需 `serial_test`。
- **持久化 round-trip**：用 `save_menu_locale_to(temp_dir_path, pref)` + `load_menu_locale_from(same_path)`，断言取回一致；用 `tempfile::tempdir()` 隔离，**不触碰** `resolve_db_dir()` 真实路径。

**前端测试**
- `setMenuLocale` effect：mock `invoke`，断言 `languagePreference` 或 `locale` 变化时以新 preference 调用一次；非 Tauri 环境 no-op。

**手动验收（macOS）**
- 切换 Settings 显示语言为中文 → 菜单栏立即变中文（含 File/Edit/.../子菜单标题）；切回英文即时恢复。
- 偏好设为"跟随系统"，系统语言切到中文 → 菜单随之变中文（应用开启状态）。
- 偏好设为"跟随系统" + 系统中文 → 退出应用 → 系统切英文 → 重启 → 菜单首屏即英文，无中文闪现（验证 system 冷启动）。
- 重启应用 → 菜单按上次 preference 显示。
- 验证术语与前端侧边栏/设置一致（Compose=构造请求、Throttling=弱网 等）。

## 8. 文档同步（CLAUDE.md §9）

- `docs/API_SPEC.md`：新增 `set_menu_locale(preference)` 命令（入参三态 preference、不可失败语义、平台差异、`menu-locale.json` 持久化）。
- `docs/UI_GUIDELINES.md` + `docs/PAGE_BLUEPRINTS.md`：原生菜单已本地化；preference 流转（前端 → `setMenuLocale` → Rust apply_locale）；术语对齐约束。
- `docs/ARCHITECTURE.md`：Rust 侧 i18n 归属一行说明（`rust-i18n` + `sys-locale`，`src-tauri/locales/`，菜单为目前唯一消费方）。

## 9. 验收标准

1. macOS 上切换显示语言，自定义菜单标签实时切换 en/zh-CN，无需重启。
2. `system` 偏好下系统语言变化（应用开启）菜单随之更新。
3. 冷启动（含退出期间改过系统语言）菜单首屏即正确语言，无闪现。
4. 菜单导航项/主题项译法与前端侧边栏/设置完全一致。
5. `PredefinedMenuItem` 仍由系统本地化（中文系统下 macOS 自动给中文）。
6. 语言切换期间菜单 API 异常**不产生** unhandled promise rejection（命令不可失败）。
7. Rust 单测覆盖 `resolve_menu_locale`、locale 文件完整性（显式 locale 形式）、持久化 round-trip（temp dir 隔离）；全部并行安全、不污染用户目录。
8. 非 macOS 平台命令注册且不报错（不重建）。
9. API_SPEC / UI_GUIDELINES / PAGE_BLUEPRINTS / ARCHITECTURE 同步更新。

## 10. 实现影响面（文件清单）

新增：
- `apps/desktop/src-tauri/locales/en.yml`
- `apps/desktop/src-tauri/locales/zh-CN.yml`
- `apps/desktop/src-tauri/src/commands/menu.rs`（薄封装命令）
- `apps/desktop/src/services/menu/set-menu-locale.ts`

修改：
- `apps/desktop/src-tauri/Cargo.toml`（`rust-i18n = "4"`、`sys-locale = "0.3"`、`tempfile = "3"` dev-dep）
- `apps/desktop/src-tauri/src/main.rs`（`i18n!` 初始化、setup 改用 `apply_locale(load_menu_locale())`、`generate_handler!` 注册 `commands::set_menu_locale`）
- `apps/desktop/src-tauri/src/menu.rs`（`build_menu` 加 locale 参数 + `t!` 标签；新增 `resolve_menu_locale` / `resolve_system_locale` / `apply_locale` / 持久化 `_to`/`_from` + 生产 wrapper + 路径解析）
- `apps/desktop/src-tauri/src/commands/mod.rs`（`mod menu; pub use menu::*;`）
- `apps/desktop/src/app/providers/AppProviders.tsx`（effect 调 `setMenuLocale(languagePreference)`，依赖 `[languagePreference, locale]`）
- 文档 4 处（§8）

## 11. spec review 反馈处置记录（v2）

| 反馈 | 级别 | 处置 |
|---|---|---|
| `set_menu_locale` 失败语义矛盾 → unhandled rejection | 中 | 命令改返回 `()`，`apply_locale` 内部 warn 不抛错（§5.4/§6） |
| 持久化 resolved locale 无法满足 system 冷启动 | 中 | 改持久化 `LanguagePreference` + `sys-locale` 启动期解析（§5.5/§5.7） |
| 命令归属不清 | 中 | 新增 `commands/menu.rs` 薄封装，域逻辑在 `menu.rs`，`commands/mod.rs` 按约定挂载（§5.4/§10） |
| 持久化测试缺路径注入 → 污染用户目录 | 中 | `save/load_menu_locale_to|from(path)` 纯函数 + 生产 wrapper（§5.5/§7） |
| `set_locale` 全局状态 → 测试并发踩踏 | 低 | 完整性测试用 `t!(locale=…)` 显式形式；`resolve_menu_locale` 注入 system locale 纯函数化（§5.4/§7） |

# macOS 原生菜单本地化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 macOS 原生菜单的自定义标签随界面语言（en / zh-CN）实时切换，冷启动即正确，不出现英文闪现。

**Architecture:** Rust 侧引入 `rust-i18n`（编译期嵌入 YAML 翻译）+ `sys-locale`（启动期解析 `system` 偏好）。新增 `set_menu_locale(preference)` 不可失败命令：持久化 preference → `set_locale` → 重建菜单。前端 `AppProviders` 在 preference/locale 变化时下发 preference。

**Tech Stack:** Rust（Tauri 2、rust-i18n 4、sys-locale 0.3、serde_json）、React/TS（invoke 封装、vitest）。

**Spec:** [docs/superpowers/specs/2026-06-14-menu-localization-design.md](../specs/2026-06-14-menu-localization-design.md)

**与 spec 的有意偏差（实现期澄清，已记录）：**
1. **前端服务路径**：spec 写 `services/menu/set-menu-locale.ts`，但仓库约定所有 `invoke` 封装在 `services/commands/<domain>.ts` + barrel `index.ts`。改为 `services/commands/menu.ts`（遵循既有结构）。
2. **`build_menu` 签名**：spec §5.3 说加 `locale` 参数；实际 `t!` 读全局 locale（由 `apply_locale` 先 `set_locale`），locale 参数是冗余的第二真相。保持 `build_menu(app)` 不变签名，由 `apply_locale` 负责先 `set_locale` 后 `build_menu`。
3. **前端运行时检测**：spec 用内联 `__TAURI_INTERNALS__` 检查；改为复用 `services/commands/runtime.ts` 的 `isTauriRuntime()`（与同层其他命令一致）。

---

## File Structure

**新增：**
- `apps/desktop/src-tauri/locales/en.yml` — 英文菜单串（44 key）
- `apps/desktop/src-tauri/locales/zh-CN.yml` — 中文菜单串（44 key）
- `apps/desktop/src-tauri/src/commands/menu.rs` — `set_menu_locale` 命令薄封装
- `apps/desktop/src/services/commands/menu.ts` — 前端 `setMenuLocale` 封装

**修改：**
- `apps/desktop/src-tauri/Cargo.toml` — 依赖
- `apps/desktop/src-tauri/src/main.rs` — `i18n!` 初始化、setup 启动流程、命令注册
- `apps/desktop/src-tauri/src/menu.rs` — `build_menu` 用 `t!`、`resolve_menu_locale`、持久化、`apply_locale`、测试
- `apps/desktop/src-tauri/src/commands/mod.rs` — 挂载 `menu` 模块
- `apps/desktop/src/services/commands/index.ts` — barrel 导出
- `apps/desktop/src/app/providers/AppProviders.tsx` — locale 同步 effect
- `docs/API_SPEC.md` / `docs/UI_GUIDELINES.md` / `docs/PAGE_BLUEPRINTS.md` / `docs/ARCHITECTURE.md` — 文档同步

---

## Task 1: rust-i18n 基础 + locale YAML + 完整性测试（TDD）

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/src/main.rs`（crate 根顶部）
- Create: `apps/desktop/src-tauri/locales/en.yml`
- Create: `apps/desktop/src-tauri/locales/zh-CN.yml`
- Modify: `apps/desktop/src-tauri/src/menu.rs`（追加测试模块）

- [ ] **Step 1: 在 `menu.rs` 末尾追加失败测试**

在 `apps/desktop/src-tauri/src/menu.rs` 文件**末尾**追加：

```rust
#[cfg(test)]
mod tests {
    use rust_i18n::t;

    // Every menu key must resolve to a real translation (not the raw key) in both
    // supported locales. Uses the explicit `locale =` form so we never touch the
    // global locale — safe under parallel test execution.
    const MENU_KEYS: &[&str] = &[
        "menu.submenu.file",
        "menu.submenu.edit",
        "menu.submenu.view",
        "menu.submenu.proxy",
        "menu.submenu.tools",
        "menu.submenu.window",
        "menu.submenu.help",
        "menu.submenu.app",
        "menu.submenu.android_quick_actions",
        "menu.import_har",
        "menu.export_har",
        "menu.clear_all_sessions",
        "menu.close_window",
        "menu.find",
        "menu.refresh",
        "menu.goto.sessions",
        "menu.goto.compose",
        "menu.goto.rules",
        "menu.goto.throttling",
        "menu.goto.certificates",
        "menu.goto.settings",
        "menu.zoom.in",
        "menu.zoom.out",
        "menu.zoom.reset",
        "menu.theme.dark",
        "menu.theme.light",
        "menu.theme.system",
        "menu.start_proxy",
        "menu.stop_proxy",
        "menu.toggle_system_proxy",
        "menu.clear_sessions",
        "menu.breakpoint_rules",
        "menu.throttling",
        "menu.install_cert",
        "menu.cert_status",
        "menu.ios_quick_actions",
        "menu.adb_set_proxy",
        "menu.adb_clear_proxy",
        "menu.setup_wizard",
        "menu.check_for_updates",
        "menu.documentation",
        "menu.show_logs",
        "menu.shortcuts",
        "menu.about",
        "menu.preferences",
    ];

    #[test]
    fn menu_keys_resolve_in_all_locales() {
        for &key in MENU_KEYS {
            for locale in ["en", "zh-CN"] {
                let value = t!(key, locale = locale).to_string();
                assert_ne!(
                    &value, key,
                    "missing translation for key `{key}` in locale `{locale}`"
                );
                assert!(
                    !value.is_empty(),
                    "empty translation for key `{key}` in `{locale}`"
                );
            }
        }
    }
}
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml menu::tests`
Expected: 编译失败（`rust_i18n` 未引入 / `i18n!` 未初始化）。若因缺少 `use rust_i18n::t;` 报错也属预期。

- [ ] **Step 3: 在 `Cargo.toml` 加依赖**

编辑 `apps/desktop/src-tauri/Cargo.toml`，在 `[dependencies]` 段（`tracing-appender = "0.2"` 之后）追加两行：

```toml
rust-i18n = "4"
sys-locale = "0.3"
```

并在 `[dependencies]` 段结束、`[target.'cfg(windows)'.dependencies]` 之前，新增 dev-dependencies 段（仓库当前无此段）：

```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 4: 创建 `apps/desktop/src-tauri/locales/en.yml`**

```yaml
_version: 1
menu.submenu.file: File
menu.submenu.edit: Edit
menu.submenu.view: View
menu.submenu.proxy: Proxy
menu.submenu.tools: Tools
menu.submenu.window: Window
menu.submenu.help: Help
menu.submenu.app: AIProxy
menu.submenu.android_quick_actions: Android Quick Actions
menu.import_har: Import HAR...
menu.export_har: Export as HAR...
menu.clear_all_sessions: Clear All Sessions
menu.close_window: Close Window
menu.find: Find...
menu.refresh: Refresh
menu.goto.sessions: Sessions
menu.goto.compose: Compose
menu.goto.rules: Rules
menu.goto.throttling: Throttling
menu.goto.certificates: Certificates
menu.goto.settings: Settings
menu.zoom.in: Zoom In
menu.zoom.out: Zoom Out
menu.zoom.reset: Reset Zoom
menu.theme.dark: Dark Theme
menu.theme.light: Light Theme
menu.theme.system: Follow System Theme
menu.start_proxy: Start Proxy
menu.stop_proxy: Stop Proxy
menu.toggle_system_proxy: Toggle System Proxy
menu.clear_sessions: Clear Sessions
menu.breakpoint_rules: Breakpoint Rules...
menu.throttling: Throttling...
menu.install_cert: Install Root Certificate
menu.cert_status: Certificate Status
menu.ios_quick_actions: iOS Quick Actions
menu.adb_set_proxy: Set Proxy via ADB
menu.adb_clear_proxy: Clear Proxy via ADB
menu.setup_wizard: Setup Guide...
menu.check_for_updates: Check for Updates...
menu.documentation: AIProxy Documentation
menu.show_logs: Show Logs
menu.shortcuts: Keyboard Shortcuts
menu.about: About AIProxy
menu.preferences: Preferences...
```

- [ ] **Step 5: 创建 `apps/desktop/src-tauri/locales/zh-CN.yml`**

```yaml
_version: 1
menu.submenu.file: 文件
menu.submenu.edit: 编辑
menu.submenu.view: 视图
menu.submenu.proxy: 代理
menu.submenu.tools: 工具
menu.submenu.window: 窗口
menu.submenu.help: 帮助
menu.submenu.app: AIProxy
menu.submenu.android_quick_actions: Android 快捷操作
menu.import_har: 导入 HAR...
menu.export_har: 导出为 HAR...
menu.clear_all_sessions: 清除所有会话
menu.close_window: 关闭窗口
menu.find: 查找...
menu.refresh: 刷新
menu.goto.sessions: 会话
menu.goto.compose: 构造请求
menu.goto.rules: 规则
menu.goto.throttling: 弱网
menu.goto.certificates: 证书
menu.goto.settings: 设置
menu.zoom.in: 放大
menu.zoom.out: 缩小
menu.zoom.reset: 重置缩放
menu.theme.dark: 暗黑
menu.theme.light: 浅色
menu.theme.system: 跟随系统
menu.start_proxy: 启动代理
menu.stop_proxy: 停止代理
menu.toggle_system_proxy: 切换系统代理
menu.clear_sessions: 清除会话
menu.breakpoint_rules: 断点规则...
menu.throttling: 弱网...
menu.install_cert: 安装根证书
menu.cert_status: 证书状态
menu.ios_quick_actions: iOS 快捷操作
menu.adb_set_proxy: 通过 ADB 设置代理
menu.adb_clear_proxy: 通过 ADB 清除代理
menu.setup_wizard: 配置指南...
menu.check_for_updates: 检查更新...
menu.documentation: AIProxy 文档
menu.show_logs: 显示日志
menu.shortcuts: 键盘快捷键
menu.about: 关于 AIProxy
menu.preferences: 偏好设置...
```

- [ ] **Step 6: 在 `main.rs` crate 根顶部初始化 `i18n!`**

编辑 `apps/desktop/src-tauri/src/main.rs`，在**文件最顶部**（`mod bootstrap;` 之前）插入：

```rust
#[macro_use]
extern crate rust_i18n;

// Load compiled-in menu translations from src-tauri/locales/*.yml; English fallback.
rust_i18n::i18n!("locales", fallback = "en");

```

> `i18n!` 路径相对于 crate 根（`src-tauri/`），编译期嵌入，运行时无文件 IO。`#[macro_use]` 使 `t!` 在整个 crate（含 `menu.rs` 的 `mod tests`）可用。

- [ ] **Step 7: 运行测试，确认通过**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml menu::tests`
Expected: PASS（`menu_keys_resolve_in_all_locales` 通过）。

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock \
        apps/desktop/src-tauri/src/main.rs apps/desktop/src-tauri/src/menu.rs \
        apps/desktop/src-tauri/locales/en.yml apps/desktop/src-tauri/locales/zh-CN.yml
git commit -m "feat(menu): wire rust-i18n + locale YAML for menu labels

Add rust-i18n (compile-time embedded) and sys-locale deps, init i18n! at crate
root, and add en/zh-CN menu locale files. Add an integrity test asserting every
menu key resolves in both locales.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: `resolve_menu_locale` 纯函数（TDD）

**Files:**
- Modify: `apps/desktop/src-tauri/src/menu.rs`（实现 + 测试）

- [ ] **Step 1: 在 `menu.rs` 的 `mod tests` 内追加测试**

在 Task 1 新增的 `mod tests` 中追加：

```rust
    #[test]
    fn resolve_menu_locale_handles_known_preferences() {
        assert_eq!(super::resolve_menu_locale("zh-CN", None), "zh-CN");
        assert_eq!(super::resolve_menu_locale("en", None), "en");
    }

    #[test]
    fn resolve_menu_locale_system_follows_injected_system_locale() {
        // system preference resolves via the injected system locale
        assert_eq!(super::resolve_menu_locale("system", Some("zh-CN")), "zh-CN");
        assert_eq!(super::resolve_menu_locale("system", Some("zh-TW")), "zh-CN");
        assert_eq!(super::resolve_menu_locale("system", Some("en-US")), "en");
        assert_eq!(super::resolve_menu_locale("system", None), "en");
    }

    #[test]
    fn resolve_menu_locale_unknown_preference_falls_back_to_system() {
        assert_eq!(super::resolve_menu_locale("garbage", Some("zh-CN")), "zh-CN");
        assert_eq!(super::resolve_menu_locale("", Some("en-US")), "en");
    }
```

- [ ] **Step 2: 运行，确认失败**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml menu::tests::resolve`
Expected: FAIL（`resolve_menu_locale` 未定义）。

- [ ] **Step 3: 实现 `resolve_menu_locale` + `resolve_system_locale`**

在 `menu.rs` 的 `ids` 模块之后、`build_menu` 之前插入：

```rust
/// Resolve a LanguagePreference to a concrete menu locale ("en" | "zh-CN").
///
/// `system_locale` is injected by the caller (production: `sys_locale::get_locale`;
/// tests: a fixed value) so this stays a pure, parallel-safe function and never
/// reads global state.
pub fn resolve_menu_locale(preference: &str, system_locale: Option<&str>) -> &'static str {
    match preference {
        "zh-CN" => "zh-CN",
        "en" => "en",
        _ => resolve_system_locale(system_locale),
    }
}

fn resolve_system_locale(system_locale: Option<&str>) -> &'static str {
    match system_locale {
        Some(value) if value.to_lowercase().starts_with("zh") => "zh-CN",
        _ => "en",
    }
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml menu::tests`
Expected: PASS（全部 menu 测试）。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/menu.rs
git commit -m "feat(menu): add resolve_menu_locale preference resolver

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 持久化 helper（TDD，路径可注入）

**Files:**
- Modify: `apps/desktop/src-tauri/src/menu.rs`

- [ ] **Step 1: 在 `mod tests` 追加 round-trip 测试**

```rust
    #[test]
    fn persisted_menu_locale_round_trips() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("menu-locale.json");

        super::save_menu_locale_to(&path, "system").expect("save");

        let loaded = super::load_menu_locale_from(&path);
        assert_eq!(loaded.as_deref(), Some("system"));

        // overwrite works
        super::save_menu_locale_to(&path, "zh-CN").expect("save overwrite");
        assert_eq!(super::load_menu_locale_from(&path).as_deref(), Some("zh-CN"));
    }

    #[test]
    fn load_menu_locale_missing_file_returns_none() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("does-not-exist.json");
        assert_eq!(super::load_menu_locale_from(&path), None);
    }

    #[test]
    fn load_menu_locale_corrupt_file_returns_none() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("menu-locale.json");
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(super::load_menu_locale_from(&path), None);
    }
```

- [ ] **Step 2: 运行，确认失败**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml menu::tests::persisted`
Expected: FAIL（`save_menu_locale_to` / `load_menu_locale_from` 未定义）。

- [ ] **Step 3: 实现持久化 helper（含生产 wrapper + 路径解析）**

在 `menu.rs` 顶部 `use` 区追加（若 `Path`/`PathBuf` 未引入）：

```rust
use std::path::{Path, PathBuf};
```

在 `resolve_system_locale` 之后插入：

```rust
const MENU_LOCALE_FILE_NAME: &str = "menu-locale.json";

#[derive(serde::Serialize, serde::Deserialize)]
struct PersistedMenuLocale {
    preference: String,
}

/// Pure, path-injected writer — testable with a temp dir, never touches the real
/// user data directory.
pub(crate) fn save_menu_locale_to(path: &Path, preference: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create menu locale directory {}: {error}",
                parent.display()
            )
        })?;
    }

    let payload = PersistedMenuLocale {
        preference: preference.to_string(),
    };
    let json = serde_json::to_string_pretty(&payload)
        .map_err(|error| format!("failed to serialize menu locale: {error}"))?;

    std::fs::write(path, json)
        .map_err(|error| format!("failed to write menu locale file {}: {error}", path.display()))
}

/// Pure, path-injected reader. Returns `None` for missing file or parse failure
/// (parse failures are logged at warn level).
pub(crate) fn load_menu_locale_from(path: &Path) -> Option<String> {
    let contents = std::fs::read_to_string(path).ok()?;

    match serde_json::from_str::<PersistedMenuLocale>(&contents) {
        Ok(state) => Some(state.preference),
        Err(error) => {
            tracing::warn!(
                component = "desktop.menu",
                event = "menu_locale_parse_failed",
                path = %path.display(),
                error = %error,
                "menu_locale_parse_failed"
            );
            None
        }
    }
}

/// Production writer — resolves the real app data dir, then delegates.
pub(crate) fn save_menu_locale(preference: &str) -> Result<(), String> {
    save_menu_locale_to(&resolve_menu_locale_path(), preference)
}

/// Production reader — resolves the real app data dir, then delegates.
pub(crate) fn load_menu_locale() -> Option<String> {
    load_menu_locale_from(&resolve_menu_locale_path())
}

/// Same resolution + fallback chain as `window_state::resolve_window_state_path`:
/// prefer the shared DB dir, then OS data dirs, then temp.
fn resolve_menu_locale_path() -> PathBuf {
    aiproxy_db::connection::resolve_db_dir()
        .unwrap_or_else(|_| {
            dirs::data_dir()
                .or_else(dirs::data_local_dir)
                .unwrap_or_else(std::env::temp_dir)
        })
        .join(MENU_LOCALE_FILE_NAME)
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml menu::tests`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/menu.rs
git commit -m "feat(menu): add preference persistence with injectable path

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: `build_menu` 用 `t!` + `apply_locale` 域函数

**Files:**
- Modify: `apps/desktop/src-tauri/src/menu.rs`

> 无单元测试（依赖 Tauri 运行时）；以 `cargo check` 为编译门。`build_menu` 签名**不变**（仍 `(app)`），`t!` 读由 `apply_locale` 先设定的全局 locale。

- [ ] **Step 1: 把 `build_menu`（macOS 实现）内所有硬编码串替换为 `t!`**

逐项替换（保持 id、accelerator、结构不变，只换显示文本）：

| 原 | 替换为 |
|---|---|
| `SubmenuBuilder::new(handle, "File")` | `SubmenuBuilder::new(handle, t!("menu.submenu.file"))` |
| `SubmenuBuilder::new(handle, "Edit")` | `... t!("menu.submenu.edit")` |
| `SubmenuBuilder::new(handle, "View")` | `... t!("menu.submenu.view")` |
| `SubmenuBuilder::new(handle, "Proxy")` | `... t!("menu.submenu.proxy")` |
| `SubmenuBuilder::new(handle, "Tools")` | `... t!("menu.submenu.tools")` |
| `SubmenuBuilder::new(handle, "Window")` | `... t!("menu.submenu.window")` |
| `SubmenuBuilder::new(handle, "Help")` | `... t!("menu.submenu.help")` |
| `SubmenuBuilder::new(handle, "AIProxy")` | `... t!("menu.submenu.app")` |
| `SubmenuBuilder::new(handle, "Android Quick Actions")` | `... t!("menu.submenu.android_quick_actions")` |
| `MenuItemBuilder::new("Import HAR...")` | `MenuItemBuilder::new(t!("menu.import_har"))` |
| `MenuItemBuilder::new("Export as HAR...")` | `... t!("menu.export_har")` |
| `MenuItemBuilder::new("Clear All Sessions")` | `... t!("menu.clear_all_sessions")` |
| `PredefinedMenuItem::close_window(handle, Some("Close Window"))` | `... Some(t!("menu.close_window"))` |
| `MenuItemBuilder::new("Find...")` | `... t!("menu.find")` |
| `MenuItemBuilder::new("Refresh")` | `... t!("menu.refresh")` |
| `MenuItemBuilder::new("Sessions")` | `... t!("menu.goto.sessions")` |
| `MenuItemBuilder::new("Compose")` | `... t!("menu.goto.compose")` |
| `MenuItemBuilder::new("Rules")` | `... t!("menu.goto.rules")` |
| `MenuItemBuilder::new("Throttling")`（View 菜单） | `... t!("menu.goto.throttling")` |
| `MenuItemBuilder::new("Certificates")` | `... t!("menu.goto.certificates")` |
| `MenuItemBuilder::new("Settings")` | `... t!("menu.goto.settings")` |
| `MenuItemBuilder::new("Zoom In")` | `... t!("menu.zoom.in")` |
| `MenuItemBuilder::new("Zoom Out")` | `... t!("menu.zoom.out")` |
| `MenuItemBuilder::new("Reset Zoom")` | `... t!("menu.zoom.reset")` |
| `MenuItemBuilder::new("Dark Theme")` | `... t!("menu.theme.dark")` |
| `MenuItemBuilder::new("Light Theme")` | `... t!("menu.theme.light")` |
| `MenuItemBuilder::new("Follow System Theme")` | `... t!("menu.theme.system")` |
| `MenuItemBuilder::new("Start Proxy")` | `... t!("menu.start_proxy")` |
| `MenuItemBuilder::new("Stop Proxy")` | `... t!("menu.stop_proxy")` |
| `MenuItemBuilder::new("Toggle System Proxy")` | `... t!("menu.toggle_system_proxy")` |
| `MenuItemBuilder::new("Clear Sessions")` | `... t!("menu.clear_sessions")` |
| `MenuItemBuilder::new("Breakpoint Rules...")` | `... t!("menu.breakpoint_rules")` |
| `MenuItemBuilder::new("Throttling...")`（Tools 菜单） | `... t!("menu.throttling")` |
| `MenuItemBuilder::new("Install Root Certificate")` | `... t!("menu.install_cert")` |
| `MenuItemBuilder::new("Certificate Status")` | `... t!("menu.cert_status")` |
| `MenuItemBuilder::new("iOS Quick Actions")` | `... t!("menu.ios_quick_actions")` |
| `MenuItemBuilder::new("Set Proxy via ADB")` | `... t!("menu.adb_set_proxy")` |
| `MenuItemBuilder::new("Clear Proxy via ADB")` | `... t!("menu.adb_clear_proxy")` |
| `MenuItemBuilder::new("Setup Guide...")` | `... t!("menu.setup_wizard")` |
| `MenuItemBuilder::new("Check for Updates...")` | `... t!("menu.check_for_updates")` |
| `MenuItemBuilder::new("AIProxy Documentation")` | `... t!("menu.documentation")` |
| `MenuItemBuilder::new("Show Logs")` | `... t!("menu.show_logs")` |
| `MenuItemBuilder::new("Keyboard Shortcuts")` | `... t!("menu.shortcuts")` |
| `PredefinedMenuItem::about(handle, Some("About AIProxy"), ...)` | `... Some(t!("menu.about")) ...` |
| `MenuItemBuilder::new("Preferences...")` | `... t!("menu.preferences")` |

> 其余 `PredefinedMenuItem`（undo/redo/cut/copy/paste/select all/minimize/maximize/fullscreen/close/hide/hide_others/show_all/services/quit）保持 `None` 文本，由 macOS 系统本地化。
> `t!` 返回 `Cow<str>`；Tauri 2 的 builder 接 `AsRef<str>`，无需转换。若个别签名要 `String`，加 `.to_string()`。

- [ ] **Step 2: 在 `menu.rs` 实现 `apply_locale`**

在 `load_menu_locale` 之后、`build_menu` 之前插入：

```rust
/// Apply a language preference end-to-end: persist it, set the global i18n locale,
/// and rebuild the native menu (macOS only).
///
/// Best-effort and infallible: persistence or rebuild failures are logged at warn
/// level but never propagated — the menu is a non-critical surface and a stale
/// language self-heals on the next switch or restart.
pub fn apply_locale<R: Runtime>(app: &AppHandle<R>, preference: &str) {
    let locale = resolve_menu_locale(preference, sys_locale::get_locale().as_deref());

    if let Err(error) = save_menu_locale(preference) {
        tracing::warn!(
            component = "desktop.menu",
            event = "menu_locale_persist_failed",
            error = %error,
            "menu_locale_persist_failed"
        );
    }

    rust_i18n::set_locale(locale);

    #[cfg(target_os = "macos")]
    if let Err(error) = build_menu(app) {
        tracing::warn!(
            component = "desktop.menu",
            event = "menu_rebuild_failed",
            locale = locale,
            error = %error,
            "menu_rebuild_failed"
        );
    }
    // Non-macOS: only persist + set_locale; no native menu to rebuild.
}
```

- [ ] **Step 3: 编译门**

Run: `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: 编译通过（无错误）。若有未使用 import 警告（如 `Path`/`PathBuf`），保留——`resolve_menu_locale_path` 会用到。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/menu.rs
git commit -m "feat(menu): localize build_menu via t! and add apply_locale

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: `commands/menu.rs` 命令 + 注册 + 启动流程

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/menu.rs`
- Modify: `apps/desktop/src-tauri/src/commands/mod.rs`
- Modify: `apps/desktop/src-tauri/src/main.rs`

- [ ] **Step 1: 创建 `apps/desktop/src-tauri/src/commands/menu.rs`**

```rust
//! `set_menu_locale` command — thin Tauri surface over `crate::menu::apply_locale`.
//!
//! The command is infallible by design: it returns unit, so the frontend `invoke`
//! never rejects. All failures are logged best-effort inside `apply_locale`.

use tauri::{AppHandle, Runtime};

/// Push the current display-language preference to the native (macOS) menu so it
/// rebuilds in the right language. `preference` is the 3-state LanguagePreference
/// (`"en" | "system" | "zh-CN"`); Rust resolves `system` via sys-locale.
#[tauri::command]
pub fn set_menu_locale<R: Runtime>(app: AppHandle<R>, preference: String) {
    crate::menu::apply_locale(&app, &preference);
}
```

- [ ] **Step 2: 在 `commands/mod.rs` 挂载 `menu` 模块**

编辑 `apps/desktop/src-tauri/src/commands/mod.rs`，在 `mod files;` 之后、`mod proxy;` 之前插入：

```rust
mod menu;
```

并在对应 `pub use` 区（`pub use files::*;` 之后、`pub use proxy::*;` 之前）插入：

```rust
pub use menu::*;
```

- [ ] **Step 3: 在 `main.rs` 注册命令**

编辑 `apps/desktop/src-tauri/src/main.rs` 的 `generate_handler!`，在 `commands::show_log_file,` 之后、闭合 `])` 之前插入：

```rust
            commands::set_menu_locale,
```

- [ ] **Step 4: 改 `main.rs` 启动流程用 `apply_locale`**

在 `setup(|app| { ... })` 内，把现有的菜单构建块：

```rust
            if let Err(error) = menu::build_menu(app.handle()) {
                tracing::warn!(
                    component = "desktop.app",
                    event = "menu_build_failed",
                    error = %error,
                    "menu_build_failed"
                );
            }
```

替换为：

```rust
            // Build the initial menu in the persisted (or default "system") language.
            // apply_locale resolves `system` via sys-locale, set_locale, and rebuilds;
            // all failures are logged best-effort inside it.
            let menu_preference = menu::load_menu_locale().unwrap_or_else(|| "system".to_string());
            menu::apply_locale(app.handle(), &menu_preference);
```

（紧随其后的 `menu::register_menu_event_handler(app.handle());` 保留不变。）

- [ ] **Step 5: 编译门**

Run: `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: 编译通过。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/menu.rs \
        apps/desktop/src-tauri/src/commands/mod.rs \
        apps/desktop/src-tauri/src/main.rs
git commit -m "feat(menu): add set_menu_locale command and boot-time apply_locale

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: 前端 `setMenuLocale` 封装（TDD）

**Files:**
- Create: `apps/desktop/src/services/commands/menu.ts`
- Modify: `apps/desktop/src/services/commands/index.ts`
- Test: `apps/desktop/src/services/commands/menu.test.ts`

- [ ] **Step 1: 创建失败测试 `apps/desktop/src/services/commands/menu.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("./runtime", () => ({
  isTauriRuntime: vi.fn(() => true),
  reportCommandFailure: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./runtime";
import { setMenuLocale } from "./menu";

describe("setMenuLocale", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isTauriRuntime).mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("invokes set_menu_locale with the preference", async () => {
    await setMenuLocale("zh-CN");

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("set_menu_locale", { preference: "zh-CN" });
  });

  it("bypasses invoke in non-Tauri runtime", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(false);

    await setMenuLocale("en");

    expect(invoke).not.toHaveBeenCalled();
  });

  it("swallows IPC errors (never rejects) so fire-and-forget callers stay safe", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("ipc down"));

    await expect(setMenuLocale("system")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm --filter @aiproxy/desktop test -- src/services/commands/menu.test.ts`
Expected: FAIL（`./menu` 模块不存在）。

- [ ] **Step 3: 创建 `apps/desktop/src/services/commands/menu.ts`**

```ts
import { invoke } from "@tauri-apps/api/core";

import { logDevDebug, logDevInfo } from "@/services/logger/dev-logger";

import { isTauriRuntime, reportCommandFailure } from "./runtime";

export type MenuLanguagePreference = "en" | "system" | "zh-CN";

/**
 * Push the current display-language preference to the native (macOS) menu so it
 * rebuilds in the right language.
 *
 * The Rust command is infallible (returns unit); we also swallow IPC errors here
 * because callers invoke this fire-and-forget from an effect and must never
 * surface an unhandled promise rejection for a non-critical menu sync.
 */
export async function setMenuLocale(preference: MenuLanguagePreference): Promise<void> {
  if (!isTauriRuntime()) {
    logDevDebug("ui.commands", "set_menu_locale_bypassed_non_tauri_runtime");
    return;
  }

  try {
    logDevInfo("ui.commands", "set_menu_locale_requested", { preference });
    await invoke("set_menu_locale", { preference });
    logDevDebug("ui.commands", "set_menu_locale_succeeded", { preference });
  } catch (error) {
    reportCommandFailure("set_menu_locale", error);
  }
}
```

- [ ] **Step 4: 在 barrel 导出**

编辑 `apps/desktop/src/services/commands/index.ts`，在 `export * from "./files";` 之后、`export * from "./proxy";` 之前插入：

```ts
export * from "./menu";
```

- [ ] **Step 5: 运行，确认通过**

Run: `pnpm --filter @aiproxy/desktop test -- src/services/commands/menu.test.ts`
Expected: PASS（3 个测试）。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/services/commands/menu.ts \
        apps/desktop/src/services/commands/menu.test.ts \
        apps/desktop/src/services/commands/index.ts
git commit -m "feat(menu): add setMenuLocale frontend command wrapper

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: `AppProviders` locale 同步 effect

**Files:**
- Modify: `apps/desktop/src/app/providers/AppProviders.tsx`

> 纯 wiring（3 行 effect + 1 行 import），无单元测试——invoke 契约由 Task 6 覆盖，wiring 由 typecheck + 手动验收。

- [ ] **Step 1: 加 import**

编辑 `apps/desktop/src/app/providers/AppProviders.tsx`，在现有 `@/services/logger/dev-logger` import 之后追加：

```ts
import { setMenuLocale } from "@/services/commands";
```

- [ ] **Step 2: 在 effect 区追加 locale 同步 effect**

在该文件已有 effects 之后（`useEffect(() => { ... font_resolved ... }, [...])` 块之后、`return (` 之前）插入：

```ts
  // Keep the native (macOS) menu in sync with the display language. Depends on both
  // the preference (en/system/zh-CN switches) and the resolved locale (so a system
  // language change while preference is "system" also re-syncs). Fire-and-forget;
  // setMenuLocale never rejects.
  useEffect(() => {
    void setMenuLocale(languagePreference);
  }, [languagePreference, locale]);
```

- [ ] **Step 3: typecheck + lint**

Run: `pnpm --filter @aiproxy/desktop typecheck`
Expected: 通过（无 TS 错误）。

Run: `pnpm --filter @aiproxy/desktop lint -- src/app/providers/AppProviders.tsx src/services/commands/menu.ts`
Expected: 通过。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/app/providers/AppProviders.tsx
git commit -m "feat(menu): sync native menu locale from AppProviders

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: 全量验证 + 文档同步

**Files:**
- Modify: `docs/API_SPEC.md`, `docs/UI_GUIDELINES.md`, `docs/PAGE_BLUEPRINTS.md`, `docs/ARCHITECTURE.md`

- [ ] **Step 1: Rust 全量测试**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: 全部 PASS（含新增 menu 测试，且未破坏既有测试）。

- [ ] **Step 2: 前端全量验证**

Run: `pnpm --filter @aiproxy/desktop typecheck && pnpm --filter @aiproxy/desktop lint && pnpm --filter @aiproxy/desktop test`
Expected: 全部通过。

- [ ] **Step 3: 文档同步 —— `docs/API_SPEC.md`**

在命令清单中新增条目：

```markdown
### set_menu_locale

```ts
invoke("set_menu_locale", { preference: "en" | "system" | "zh-CN" }): Promise<void>
```

设置原生（macOS）菜单的显示语言。`preference` 为三态语言偏好：`en` / `system` / `zh-CN`。Rust 侧由 `menu::apply_locale` 持久化偏好到 `menu-locale.json`、经 `sys-locale` 解析 `system`、`rust_i18n::set_locale` 后重建菜单。

**语义：不可失败。** 命令返回 unit，持久化或重建失败仅 `tracing::warn!`，不向 JS reject。

**平台：** 所有平台注册；macOS 重建菜单，Windows/Linux 仅持久化 + set_locale（无原生菜单）。

**持久化：** `<app_data_dir>/menu-locale.json`，内容 `{ "preference": "en" | "system" | "zh-CN" }`，启动期读取并解析。
```

- [ ] **Step 4: 文档同步 —— `docs/UI_GUIDELINES.md`**

在 i18n / 本地化相关章节追加：

```markdown
## 原生菜单本地化

macOS 原生菜单（File/Edit/View/Proxy/Tools/Window/Help）已本地化，随界面显示语言切换：

- 字符串来源：Rust 侧 `rust-i18n`（`src-tauri/locales/{en,zh-CN}.yml`），独立于前端 webview 目录。
- 切换流程：Settings 改显示语言 → `AppProviders` effect → `setMenuLocale(preference)` → Rust `apply_locale`（持久化 + `set_locale` + 重建）。
- 术语约束：菜单导航/主题项译法必须与前端一致（Compose=构造请求、Throttling=弱网、主题=暗黑/浅色/跟随系统）。
- `PredefinedMenuItem`（剪切/复制/最小化/退出等）由 macOS 系统本地化，不在本项目翻译范围。
- Windows/Linux 暂无原生菜单；命令前向兼容。
```

- [ ] **Step 5: 文档同步 —— `docs/PAGE_BLUEPRINTS.md`**

在状态模型/事件流相关章节追加事件流说明：

```markdown
## 菜单 locale 同步事件流

触发：`useAppPreferencesStore.languagePreference` 变更，或 `system` 偏好下系统语言变化（`navigator.languagechange`）。

```
languagePreference/locale 变化
  → AppProviders useEffect([languagePreference, locale])
  → setMenuLocale(preference)            // 前端 service，fire-and-forget
  → invoke("set_menu_locale", { preference })
  → menu::apply_locale
      ├─ save_menu_locale(preference)     // 持久化 menu-locale.json
      ├─ rust_i18n::set_locale(resolved)  // 解析 system via sys-locale
      └─ build_menu(app)                  // macOS 重建（t! 读全局 locale）
```

冷启动：`main.rs setup()` → `load_menu_locale()` → `apply_locale`（同上，无需前端参与）。
```

- [ ] **Step 6: 文档同步 —— `docs/ARCHITECTURE.md`**

在分层/模块边界章节追加一行说明：

```markdown
### Rust 侧 i18n（菜单）

`src-tauri/locales/{en,zh-CN}.yml` 由 `rust-i18n` 编译期嵌入；目前唯一消费方是原生菜单（`menu.rs`）。`sys-locale` 用于启动期在 Rust 侧解析 `system` 偏好。与前端 TS i18n 目录独立维护（跨语言不共享，业界常态）。
```

- [ ] **Step 7: 手动验收（macOS）**

Run: `pnpm desktop:run`，依次验证：
1. Settings 切换显示语言为中文 → 菜单栏立即变中文（File→文件、子菜单标题、各项）；切回英文即时恢复。
2. 验证术语一致：Compose→构造请求、Throttling→弱网、主题项→暗黑/浅色/跟随系统。
3. 偏好设"跟随系统"，系统语言切到中文（应用开启）→ 菜单随之变中文。
4. 偏好"跟随系统"+系统中文 → 退出应用 → 系统切英文 → 重启 → 菜单首屏即英文，无中文闪现。
5. 重启应用 → 菜单按上次偏好显示。
6. 中文系统下 `PredefinedMenuItem`（剪切/最小化/退出）显示为系统中文。

- [ ] **Step 8: Commit 文档**

```bash
git add docs/API_SPEC.md docs/UI_GUIDELINES.md docs/PAGE_BLUEPRINTS.md docs/ARCHITECTURE.md
git commit -m "docs(menu): sync API/UI/blueprints/architecture for menu localization

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec 覆盖：**
- §5.1 rust-i18n + sys-locale 接入 → Task 1（deps + i18n!）。
- §5.2 locale 文件 + 44 key → Task 1（en/zh-CN.yml）。
- §5.3 build_menu 用 t! → Task 4（签名有意保持不变，已记录偏差）。
- §5.4 命令 + apply_locale 域函数 → Task 4（apply_locale）+ Task 5（命令/注册）。
- §5.5 持久化（preference 三态 + sys-locale 启动解析 + 路径注入）→ Task 2（resolve）+ Task 3（持久化）+ Task 5 Step 4（启动）。
- §5.6 前端 service + effect（依赖 [pref, locale]）→ Task 6（service，路径偏差已记录）+ Task 7（effect）。
- §5.7 数据流 → Task 7 + Task 8 手动验收覆盖。
- §6 错误语义（不可失败）→ Task 5 命令返回 unit；Task 6 service 吞 IPC 错；Task 8 验收 6 不涉及 rejection（隐式：service 不 reject）。
- §7 测试（resolve / 完整性显式 locale / round-trip temp dir）→ Task 1/2/3/6。
- §8 文档 → Task 8 Step 3-6。
- §9 验收 → Task 8 Step 7。

**2. 占位符扫描：** 无 TBD/TODO；每个代码步骤含完整代码；YAML 含全部 44 key。

**3. 类型一致性：** `setMenuLocale(preference: MenuLanguagePreference)`（前端）↔ `set_menu_locale(preference: String)`（Rust，接三态字符串）一致；`apply_locale(app, preference)` ↔ 命令调用一致；`resolve_menu_locale(&str, Option<&str>) -> &'static str` 跨 Task 一致。

**4. 编译顺序：** 每个 Task 结束都处可编译状态。Task 1 建立 `t!`/`i18n!`；Task 2-3 加纯函数；Task 4 用 `t!`（Task 1 已就绪）+ apply_locale（引用 Task 2/3）；Task 5 命令引用 apply_locale（Task 4）；Task 6-7 前端独立。

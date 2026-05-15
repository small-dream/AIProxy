# Platform Title Bar And Menu Notes

AIProxy uses different title/menu strategies by platform.

## macOS

- Uses the native Tauri menu from `apps/desktop/src-tauri/src/menu.rs`.
- Keeps expected macOS menu behavior.
- The React top controls render in the macOS overlay titlebar area.

## Windows / Linux

- Do not install a native Tauri menu.
- Disable system window decorations at runtime in `apps/desktop/src-tauri/src/main.rs`.
- Use the React `AppShellWindowsMenuBar` component for:
  - `File / Edit / View / Proxy / Tools / Window / Help`,
  - centered global proxy/session controls,
  - window minimize / maximize / close buttons,
  - Tauri drag region.

Custom menu definitions live in:

```text
apps/desktop/src/components/layout/app-shell-windows-menu.definitions.ts
```

Menu actions are handled by:

```text
apps/desktop/src/components/layout/AppShell.tsx
```

Window API permissions live in:

```text
apps/desktop/src-tauri/capabilities/default.json
```

## Required Checks

Run these after changing titlebar, menu, or window-control behavior:

```bash
corepack pnpm --dir apps/desktop typecheck
corepack pnpm --dir apps/desktop build
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml
```

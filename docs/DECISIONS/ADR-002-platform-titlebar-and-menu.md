# ADR-002: Platform Title Bar And Menu Strategy

## Status

Accepted

## Context

AIProxy uses Tauri 2 with a React frontend. The desktop shell needs global actions such as start/stop proxy, system proxy toggle, export, and session cleanup to remain visible while the user works in dense inspector views.

The native menu model differs by platform:

- macOS expects an operating-system menu bar and window controls managed by the system.
- Windows users expect a title/menu area inside the app window for modern tools such as VS Code.
- Linux desktop environments vary, so the Windows approach provides the most predictable fallback.

React controls cannot be inserted into the middle of a native Tauri menu bar. Keeping a native Windows menu plus a separate React toolbar created duplicated vertical chrome and poor alignment.

## Decision

- macOS keeps the Tauri native menu defined in `apps/desktop/src-tauri/src/menu.rs`.
- Windows and Linux do not install a native Tauri menu. They use a custom React menu bar implemented by `AppShellWindowsMenuBar`.
- The Windows/Linux menu bar is a compact VS Code-style row:
  - menu items on the left,
  - global proxy/session actions centered,
  - window controls on the right.
- Menu definitions for the custom bar live in `apps/desktop/src/components/layout/app-shell-windows-menu.definitions.ts`.
- Menu item IDs must be handled by `AppShell.handleMenuCommand`, so native macOS menu events and custom Windows/Linux menu clicks share behavior.
- Non-macOS windows disable system decorations at runtime in `apps/desktop/src-tauri/src/main.rs`; the custom menu bar provides the drag region and window controls.
- Window API permissions must be declared in `apps/desktop/src-tauri/capabilities/default.json`.

## Consequences

- Windows/Linux get a cleaner single-row desktop shell without duplicated menu/tool bars.
- macOS keeps expected platform-native menu behavior.
- Adding cross-platform menu actions now requires updating both the React menu definition and, when applicable, the macOS native menu.
- Window-control behavior is now part of frontend shell code on Windows/Linux and must be verified when changing Tauri capabilities.

## Verification

Expected checks after changing this area:

- `corepack pnpm --dir apps/desktop typecheck`
- `corepack pnpm --dir apps/desktop build`
- `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml`

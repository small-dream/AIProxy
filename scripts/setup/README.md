# Setup Scripts

This directory contains one-click environment bootstrap scripts for the desktop app.

- `setup-windows.ps1`
- `setup-macos.sh`
- `setup-linux.sh`

What the scripts do:

- install platform prerequisites for Tauri desktop development
- install Node.js / pnpm / Rust / `cargo-tauri` when missing
- run `pnpm install` for the workspace

Notes:

- `setup-linux.sh` currently targets Debian/Ubuntu, Fedora/RHEL, and Arch-based systems
- package installation may require administrator privileges
- if a platform installer opens a GUI prompt, finish that step and rerun the script once

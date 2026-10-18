<div align="center">

# AIProxy

**A modern, cross-platform proxy debugging tool for developers — now with AI agent access.**

Capture, inspect, and manipulate HTTP / HTTPS / WebSocket traffic with a polished Material Design desktop experience. Connect Codex, Claude Code, or Cursor to investigate real traffic through MCP.

[English](./README.md) | [简体中文](./README.zh-CN.md)

[![CI](https://github.com/small-dream/AIProxy/actions/workflows/ci.yml/badge.svg)](https://github.com/small-dream/AIProxy/actions/workflows/ci.yml)
[![Release](https://github.com/small-dream/AIProxy/actions/workflows/release.yml/badge.svg)](https://github.com/small-dream/AIProxy/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)](#platform-support)
[![MCP](https://img.shields.io/badge/MCP-Agent%20Ready-6f42c1)](#ai-assisted-debugging)
[![AI](https://img.shields.io/badge/AI-Diff%20Summary-ff6f00)](#ai-assisted-debugging)
[![Tauri](https://img.shields.io/badge/Tauri-2-orange)](https://tauri.app)
[![React](https://img.shields.io/badge/React-19-61dafb)](https://react.dev)
[![Rust](https://img.shields.io/badge/Rust-2021-dea584)](https://www.rust-lang.org)

</div>

---

## AI-Assisted Debugging

AIProxy turns captured traffic into an evidence source your coding agent can reason about. Set it up once in **Settings → Agent Access**, then ask Codex, Claude Code, or Cursor to investigate real requests instead of exported snapshots.

| Capability | What you get |
|------------|--------------|
| **Agent Access (MCP)** | One-click MCP setup for Codex, Claude Code, and Cursor. Eight read-only tools cover session search, header and timing inspection, JSON field extraction, WebSocket messages, traffic insights, and structured session comparison. |
| **AI diff summaries** | Generate a Markdown explanation of any Compare result with an OpenAI-compatible model. Preview the payload and redact sensitive fields locally before it is sent to your configured provider. |
| **Private by default** | The MCP server runs as a local stdio sidecar with no open port. AIProxy never uploads captures, but once your agent reads them that content is sent to its model provider. Reads are redacted by default, body access is bounded, and audit logs contain metadata only. Raw-body access requires a separate opt-in. |

> Example: ask your agent to “compare the failed `/api/checkout` requests with the last successful run and cite the session IDs.” Your agent gets the evidence through MCP and explains what changed.

## 📸 Screenshots

### Traffic Inspector
The three-pane session workspace — domain-grouped traffic explorer on the left, request/response inspector with JSON syntax highlighting on the right.

<img src="./docs/screenshots/1.jpg" alt="AIProxy Sessions — Traffic Inspector (Dark)" width="800">

### Traffic Inspector
The same three-pane session workspace in the light theme — request/response inspector with query parameters and JSON syntax highlighting.

<img src="./docs/screenshots/2.jpg" alt="AIProxy Sessions — Traffic Inspector (Light)" width="800">

### Traffic Insights
Aggregate analytics dashboard with overview cards, per-host breakdown table, and status code / method distributions.

<img src="./docs/screenshots/3.jpg" alt="AIProxy Insights — Analytics Dashboard (Light)" width="800">

---

## ✨ Features

### Traffic Capture & Inspection
- 🔍 **Full protocol support** — HTTP, HTTPS (MITM decryption), and WebSocket
- 📱 **Mobile debugging** — capture traffic from iOS, Android, and HarmonyOS devices over Wi-Fi
- 🌐 **System proxy takeover** — automatic system proxy configuration on all platforms
- 📋 **Rich session view** — headers, body, timing, transfer stats, and JSON highlighting

### Rules & Manipulation
- ✏️ **Rewrite Rules** — modify requests and responses on the fly
- 🗺️ **Map Local / Map Remote** — redirect traffic to local files or different servers
- 🌐 **DNS Mapping** — override DNS resolution for testing
- 📜 **Script Rules** — JavaScript-powered request/response interception (QuickJS runtime)
- ⏸️ **Breakpoints** — intercept, inspect, modify, mock, or drop requests at request/response stage

### Developer Tools
- 🐌 **Throttling** — simulate slow networks with configurable profiles and per-rule targeting
- 📬 **Compose & Repeat** — craft and resend requests with full editing
- 📂 **Collections** — save, organize, and batch-execute requests with environments
- 🔀 **Session Compare** — diff two sessions to spot behavioral changes, then generate an AI summary
- 🤖 **Agent Access (MCP)** — let Codex, Claude Code, and Cursor query captured traffic through eight read-only tools
- 🧠 **AI diff summaries** — summarize Compare results with any OpenAI-compatible model
- 📊 **Insights** — aggregate traffic analytics
- 🔐 **Certificate Center** — root CA generation, trust management, and QR-code mobile setup

### Experience
- 🎨 **Material Design** — clean, modern UI with light / dark / system themes
- 🌍 **Bilingual** — English & 简体中文, follows your system language
- ⚡ **Fast & Native** — Rust core with Tauri 2 shell, not another Electron app

## Platform Support

| Platform | Status |
|----------|--------|
| 🪟 Windows | ✅ Supported |
| 🍎 macOS | ✅ Supported |
| 🐧 Linux | ✅ Supported |

## Download

Pre-built binaries are available on the [GitHub Releases](https://github.com/small-dream/AIProxy/releases) page.

> **Note:** Builds are currently unsigned. On macOS, a browser-downloaded app is flagged by Gatekeeper as **"damaged and can't be opened"** — and on recent macOS the usual right-click → Open shortcut does **not** bypass this. After dragging `AIProxy.app` to `/Applications`, clear the quarantine attribute, then open normally:
>
> ```bash
> xattr -cr /Applications/AIProxy.app
> ```
>
> (Adjust the path if the app lives elsewhere, e.g. `~/Downloads/AIProxy.app`.) On Windows, SmartScreen may show a warning — click "More info" → "Run anyway".

## Quick Start (Development)

### Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [pnpm](https://pnpm.io/) 10+
- [Rust](https://www.rust-lang.org/tools/install) (stable)

### Setup

```bash
# Clone the repository
git clone https://github.com/small-dream/AIProxy.git
cd AIProxy

# Install dependencies
pnpm install

# One-time system setup (installs Tauri prerequisites):
#   macOS:  bash scripts/setup/setup-macos.sh
#   Linux:  bash scripts/setup/setup-linux.sh
#   Windows: powershell -ExecutionPolicy Bypass -File .\scripts\setup\setup-windows.ps1
```

### Run

```bash
# Start the desktop app in development mode
pnpm desktop:run           # auto-detects platform
# Or explicitly:
pnpm desktop:run:macos
pnpm desktop:run:windows
pnpm desktop:run:linux
```

### Build & Bundle

```bash
# Build the frontend
pnpm build

# Create a distributable bundle (.dmg / .msi / .AppImage, etc.)
pnpm desktop:bundle:macos
pnpm desktop:bundle:windows
pnpm desktop:bundle:linux
```

## Project Structure

```text
apps/desktop/      Tauri 2 + React 19 desktop application
  src/             Frontend source (pages, features, components, i18n)
  src-tauri/       Rust Tauri shell + proxy integration
crates/            Rust core modules
  proxy-core/      Proxy engine (HTTP/HTTPS/WS capture, MITM)
  rule-engine/     Rewrite / Map / Script rule execution
  tls-manager/     Certificate authority & TLS management
  db/              SQLite persistence layer
  mcp-server/      Local read-only MCP server for AI agents
packages/          Shared TypeScript packages
  shared-types/    Frontend ↔ backend contracts
  ui-tokens/       Design tokens
docs/              Architecture & design documents
scripts/           Setup, build, and release scripts
```

## Quality Checks

```bash
pnpm lint         # ESLint across the workspace
pnpm typecheck    # TypeScript type checking
pnpm test         # Frontend tests (Vitest)
cargo fmt --all   # Format Rust code
cargo clippy --workspace -- -D warnings   # Lint Rust code
cargo test --workspace                     # Rust tests
```

## Documentation

- [Product Requirements (PRD)](./docs/PRD.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [API Specification](./docs/API_SPEC.md)
- [MCP & Agent Access Architecture](./docs/MCP_AGENT_SKILL_ARCHITECTURE.md)
- [ADR-006: Local MCP Agent Access](./docs/DECISIONS/ADR-006-local-mcp-agent-access.md)
- [UI Guidelines](./docs/UI_GUIDELINES.md)
- [Engineering Guidelines](./docs/ENGINEERING_GUIDELINES.md)
- [Build, Run & Package Guide](./docs/BUILD_RUN_PACKAGE_GUIDE.md)
- [Release Guide](./docs/RELEASE_GUIDE.md)
- [Architecture Decision Records (ADRs)](./docs/DECISIONS/)

### In-App User Guides

Bilingual guides are available within the app's Docs page — from certificate setup and capture (sessions, WebSocket inspection) to rules (rewrite, script, breakpoints, map local/remote, DNS mapping, throttling), plus collections & environments, Compose, insights, session compare, and settings.

## Internationalization

AIProxy ships with full bilingual support:

- **English** and **简体中文**
- Automatically follows your system language
- Manually switchable in Settings → Appearance

The frontend uses a custom type-safe i18n system (no external library) with compile-time key validation. The Rust layer uses `rust-i18n` for native menu strings. See [ADR-001](./docs/DECISIONS/ADR-001-frontend-i18n.md) for the design rationale.

## Contributing

Contributions are welcome! 🎉

Please read our [Contributing Guide](./CONTRIBUTING.md) to get started. By participating, you are expected to uphold our [Code of Conduct](./CODE_OF_CONDUCT.md).

### Good First Issues

Check out issues labeled [`good first issue`](https://github.com/small-dream/AIProxy/labels/good%20first%20issue) for beginner-friendly tasks.

## Security

Found a security vulnerability? Please see our [Security Policy](./SECURITY.md) for responsible disclosure instructions. **Do not open a public issue for security vulnerabilities.**

## Roadmap

See the [6-month roadmap](./docs/NEXT_6_MONTH_ROADMAP.md) for planned features and direction.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Shell | Tauri 2 |
| Frontend | React 19, TypeScript, Vite 8 |
| UI | MUI 9 (Material UI), Emotion |
| State | Zustand, TanStack Query |
| Routing | React Router 7 |
| Core | Rust 2021 |
| i18n | Custom type-safe (frontend), rust-i18n (Rust) |

## License

[MIT](./LICENSE) © 2024-2026 small-dream

## Acknowledgments

Built with these outstanding open-source projects: [Tauri](https://tauri.app), [React](https://react.dev), [Rust](https://www.rust-lang.org), [MUI](https://mui.com), and many more.

# Contributing to AIProxy

First off, thank you for considering contributing to AIProxy! 🎉 The community makes open-source projects thrive, and we appreciate every contribution — from bug reports to feature implementations.

This document guides you through the contribution process.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Coding Standards](#coding-standards)
- [Internationalization (i18n)](#internationalization-i18n)
- [Commit Messages](#commit-messages)
- [Pull Requests](#pull-requests)
- [Reporting Bugs](#reporting-bugs)
- [Suggesting Features](#suggesting-features)

## Code of Conduct

Participation in this project is governed by our [Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to the maintainers.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [pnpm](https://pnpm.io/) 10+
- [Rust](https://www.rust-lang.org/tools/install) (stable, edition 2021)
- Platform-specific Tauri dependencies (see the [setup scripts](./scripts/setup/))

### Setup

```bash
# Fork and clone the repository
git clone https://github.com/<your-username>/AIProxy.git
cd AIProxy

# Install dependencies
pnpm install

# Run the platform setup script (installs Tauri prerequisites)
#   macOS:   bash scripts/setup/setup-macos.sh
#   Linux:   bash scripts/setup/setup-linux.sh
#   Windows: powershell -ExecutionPolicy Bypass -File .\scripts\setup\setup-windows.ps1

# Start the app
pnpm desktop:run
```

## Development Workflow

1. **Create a branch** from `master`:
   ```bash
   git checkout -b feat/my-feature
   # or: fix/my-bugfix, docs/my-docs, etc.
   ```

2. **Make your changes.** Follow the [coding standards](#coding-standards) below.

3. **Run quality checks** before committing:
   ```bash
   pnpm lint         # ESLint
   pnpm typecheck    # TypeScript
   pnpm test         # Frontend tests (Vitest)
   cargo fmt --all   # Format Rust
   cargo clippy --workspace -- -D warnings
   cargo test --workspace
   ```

4. **Commit** your changes following our [commit conventions](#commit-messages).

5. **Push** and open a Pull Request against `master`.

## Coding Standards

### General

- Write **convergent changes** — don't spread unrelated modifications across the codebase.
- **Reuse existing modules, types, and helpers** — avoid duplicating logic.
- Keep the boundary between frontend presentation, command/service layer, and Rust domain layer clear.
- Don't build large abstractions "for the future" — solve the problem at hand.
- **Before modifying code, look at neighboring implementations** and follow existing naming, structure, and style.

### Cross-Platform

All code must work across **Windows, macOS, and Linux**. System-interacting features must handle all three platforms explicitly with appropriate fallbacks.

### Rust

- Code comments in **English**.
- Follow `rustfmt` formatting (enforced by `cargo fmt --check`).
- No clippy warnings (`cargo clippy -- -D warnings`).
- Prefer structured logging over silent failures.
- Don't leave empty `catch`/error swallowing — provide context for UI feedback or debugging.

### Frontend (React / TypeScript)

- Source directory: `apps/desktop/src/`
- Follow the existing layering:
  - `pages/*` — route-level pages
  - `features/*` — business domain logic & feature components
  - `components/*` — shared UI / layout components
  - `services/*` — command, event, and logging access layer
  - `i18n/*` — internationalization resources
- Use the `@/` path alias for imports.
- Maintain the existing MUI-first visual style — don't introduce conflicting design languages.
- Code comments in **English**.

### Shared Contracts

- Shared data structures go in `packages/shared-types`.
- Tauri command behavior, parameters, and return values must match `docs/API_SPEC.md`.

## Internationalization (i18n)

**User-visible strings must never be hardcoded in components.** All UI text must be added to both:

- `apps/desktop/src/i18n/messages/en.ts` (English — the source of truth)
- `apps/desktop/src/i18n/messages/zh-CN.ts` (Simplified Chinese)

The `Messages` type is derived from `en.ts`, so the TypeScript compiler and a key-parity test ensure both files stay in sync. Use the `t()` / `tList()` functions from the `useI18n()` hook.

For native menu strings, update both:
- `apps/desktop/src-tauri/locales/en.yml`
- `apps/desktop/src-tauri/locales/zh-CN.yml`

## Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>
```

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`, `build`

**Examples:**
```
feat(proxy-core): add HTTP/2 support for upstream connections
fix(desktop): resolve session list virtualization flicker
docs(readme): update build instructions for Linux
chore(deps): bump React to 19.2.8
```

- Write commit messages (subject and body) in English.
- Keep the subject line under 72 characters.
- Use the imperative mood ("add", not "added" or "adds").
- Reference issues in the body: `Closes #123`, `Refers to #456`.

## Pull Requests

1. **One PR per feature/fix.** Keep PRs focused and reviewable.
2. **Write a clear description** — explain what changed and why.
3. **Link related issues** using `Closes #123` or `Fixes #123`.
4. **Ensure CI passes.** All lint, typecheck, and test checks must be green.
5. **Be responsive** to review feedback.

### PR Checklist

Before submitting:
- [ ] Code follows the [coding standards](#coding-standards)
- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] `pnpm -r format:check` passes
- [ ] `cargo fmt --check --all` passes
- [ ] `cargo clippy --workspace -- -D warnings` passes
- [ ] `cargo test --workspace` passes
- [ ] User-visible strings are added to both `en.ts` and `zh-CN.ts`
- [ ] Relevant documentation is updated (`docs/` or in-app guides)
- [ ] Changes are tested on the relevant platform(s)

## Reporting Bugs

Use the [Bug Report issue template](https://github.com/small-dream/AIProxy/issues/new?template=bug_report.yml). Please include:

- AIProxy version and platform (Windows / macOS / Linux)
- Steps to reproduce
- Expected vs. actual behavior
- Screenshots or logs (`logs/dev/aiproxy-desktop-dev.log`) if applicable

## Suggesting Features

Use the [Feature Request issue template](https://github.com/small-dream/AIProxy/issues/new?template=feature_request.yml). Describe the use case and the value it provides to users.

For general questions and discussions, please use [GitHub Discussions](https://github.com/small-dream/AIProxy/discussions) instead of opening an issue.

---

Thank you for contributing! 💛

# Documentation

This directory contains the design and architecture documentation for AIProxy. These documents serve as the source of truth for the project's structure and decisions.

> **Note:** These documents are primarily written in Chinese (简体中文) as they are internal design references. The [README](../README.md) and [user guides](../apps/desktop/user-guides/) provide bilingual (English / Chinese) documentation for end users and contributors.

## Table of Contents

### Product & Architecture

| Document | Description |
|----------|-------------|
| [PRD.md](./PRD.md) | Product requirements — goals, scope, and feature definitions |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System architecture — layers, module boundaries, responsibilities |
| [API_SPEC.md](./API_SPEC.md) | Tauri commands, events, and data model contracts |
| [NEXT_6_MONTH_ROADMAP.md](./NEXT_6_MONTH_ROADMAP.md) | Planned features and project direction |
| [MCP_AGENT_SKILL_PLAN.md](./MCP_AGENT_SKILL_PLAN.md) | MCP + Agent Skill product plan and implementation status |
| [MCP_AGENT_SKILL_ARCHITECTURE.md](./MCP_AGENT_SKILL_ARCHITECTURE.md) | MCP transport, tools, permissions, and client integration architecture |
| [UI_UX_REVIEW_2026-08-16.md](./UI_UX_REVIEW_2026-08-16.md) | UI/UX review snapshot — P0 fixed, P1/P2 backlog pending |

### UI & Design

| Document | Description |
|----------|-------------|
| [UI_GUIDELINES.md](./UI_GUIDELINES.md) | UI specifications and interaction rules |
| [PAGE_BLUEPRINTS.md](./PAGE_BLUEPRINTS.md) | Page structures, state models, and event flows |

### Engineering

| Document | Description |
|----------|-------------|
| [ENGINEERING_GUIDELINES.md](./ENGINEERING_GUIDELINES.md) | Engineering quality baselines and conventions |
| [SYSTEM_PROXY.md](./SYSTEM_PROXY.md) | System proxy behavior and platform differences |
| [BUILD_RUN_PACKAGE_GUIDE.md](./BUILD_RUN_PACKAGE_GUIDE.md) | How to build, run, and package the app |
| [RELEASE_GUIDE.md](./RELEASE_GUIDE.md) | Release process and publishing guide |
| [DECISIONS/ADR-006-local-mcp-agent-access.md](./DECISIONS/ADR-006-local-mcp-agent-access.md) | Local MCP sidecar and read-only Agent Access decision |
| [releases/](./releases/) | Versioned bilingual release summaries used by GitHub Releases and in-app updates |

### Architecture Decision Records (ADRs)

ADRs capture important architectural decisions and their rationale.

| ADR | Title |
|-----|-------|
| [ADR-001](./DECISIONS/ADR-001-frontend-i18n.md) | Frontend Internationalization Strategy |
| [ADR-002](./DECISIONS/ADR-002-platform-titlebar-and-menu.md) | Platform-specific Titlebar and Menu |
| [ADR-003](./DECISIONS/ADR-003-proxy-http-client-strategy.md) | Proxy HTTP Client Strategy |
| [ADR-004](./DECISIONS/ADR-004-panic-strategy.md) | Panic Strategy (unwinding vs abort) |
| [ADR-005](./DECISIONS/ADR-005-mutex-poison-policy.md) | Mutex Poison Recovery Policy |

### Screenshots

Real UI screenshots are in [screenshots/](./screenshots/).

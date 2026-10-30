# Settings Guide

The Settings page centralizes proxy parameters, upstream proxying, SSL proxy policy, Agent Access, the AI model, appearance and language, notifications and confirmations, and software updates. For certificate install and capture-ready flow, see [Certificate Setup & Capture Troubleshooting](./certificate-setup.md). For Agent permissions and client setup, see [Agent Access](./agent-access.md); this page covers everyday configuration.

## Where to find it

1. Click **Settings** in the left nav

The page is organized into **Proxy Presets**, **Upstream Proxy**, **SSL / TLS**, **Agent Access**, **AI Model**, **Appearance & Language**, **Notifications & Confirmations**, **Updates**, and **About**. Use the section navigator on the left to jump directly. The top **search settings** field supports localized keywords and jumps to — and briefly highlights — the matching section row.

> The system-proxy **on/off** toggle is not on this page — it's in the top control bar. This page only configures the proxy's own parameters.

## Proxy settings

| Option | Description | Default |
|---|---|---|
| Proxy Port | The port the proxy listens on, 1–65535 | `8888` |
| SSL Enabled | Whether to decrypt HTTPS; off means forward-only with no plaintext capture | on |
| HTTP/2 Support | Whether captured connections use HTTP/2; off falls back all to HTTP/1.1 | on |
| Verify Upstream TLS | Verify upstream server certificates against the OS root store on new HTTPS/WSS connections. Off (default), the proxy accepts any upstream certificate — convenient for interception but insecure. A warning hint is shown while it's off | off |
| TLS Verify Hosts | One host per line (shown while Verify Upstream TLS is on). Listed hosts are always verified even when the global switch is off — handy for pinning down specific upstreams without turning verification on everywhere | — |

Click **Save** to apply:

- If the proxy is **running**, saving **restarts the proxy immediately** to apply the new params
- If the proxy is **stopped**, the new params apply on the **next proxy start**

> After changing the port or SSL, confirm the capture chain is still ready (see the `captureReady` conditions in the [Certificate guide](./certificate-setup.md); SSL decryption being on is one of them).

## Agent Access

Let Codex, Claude Code, and Cursor query captured traffic through a local MCP sidecar, and perform permitted setup, certificate, capture, system-proxy, and session-cleanup actions. Control writes call the desktop app through a local IPC channel accessible only to the current user; AIProxy opens no network port and does not upload captures, but content read by an Agent is sent to that client's model provider.

- Turn on **Local Agent Access** and save before a client can call MCP tools.
- Under **Connect an Agent client**, choose Codex, Claude Code, or Cursor, click **Connect**, then select **Metadata only**, **Include response bodies**, **Include raw data (high risk)**, or the **Full control** preset. If a custom permission mix is saved, reconnecting defaults to **Keep current permissions** instead of resetting it.
- Connecting writes user-level MCP configuration and installs the AIProxy Skill. Existing files are backed up first, and the client must be restarted or reloaded afterward.
- **Read permissions** separately control session metadata, bodies, and WebSocket messages. Turning off Body access also turns off unredacted bodies; enable unredacted access only when a task truly requires it.
- **Advanced permissions** include unredacted bodies, format-based sensitive-value detection, stable identifier hashing, custom sensitive field names, the page size, and the Body chunk limit.
- **Control permissions** are off by default and split into capture/workspace control, system-proxy control, root-certificate management, session deletion, request replay, and temporary rules. Enable them individually, or use **Enable full control** to turn on all six. Once enabled, the app does not ask for a second in-app confirmation for an authorized action.
- **Diagnostics → Verify connection** checks the sidecar, database schema, MCP handshake, tool call, client configuration, control channel, and control permissions. Failures show their reason inline.
- **Diagnostics** also points the Agent to `diagnose_ai_proxy_issue`, which uses desktop status, allowlisted redacted logs, and metadata-only audit entries to diagnose an AIProxy failure. The desktop app must be running; logs are bounded summaries, not arbitrary-file access or a complete log export.
- **More actions** covers MCP config only, Skill only, manual configuration, and disconnect. Disconnecting confirms and backs up the original file; the AIProxy-managed Skill is removed while a custom Skill is preserved.
- **Agent Audit Log** shows a call-count summary by default. Expand it to inspect the tool, action summary, client, result, duration, and returned bytes over time; payloads and secrets are not stored.

> A successful connection means the configuration and Skill were written; it does not mean the client completed a handshake. Reload the client as prompted, then run **Verify connection**.

## AI model

Provides the model for the **AI diff summary** in [Session Compare](./session-compare.md). Currently supports **OpenAI-compatible** APIs.

| Field | Description | Default |
|---|---|---|
| Provider | Model provider | OpenAI-compatible |
| Base URL | API base URL | `https://api.openai.com/v1` |
| Model | Model name | `gpt-4.1-mini` |
| API Key | Secret; leave blank to keep the saved key, use "Clear Key" to delete | — |
| Temperature | Sampling temperature | `0.2` |
| Timeout | Request timeout (ms) | `60000` |

Actions:

- **Test Connection**: send a probe with the current config to verify Key / Base URL / model
- **Save**: persist the config, takes effect immediately

> Third-party OpenAI-compatible services (self-hosted gateways, Azure-compatible endpoints) just need the Base URL swapped. Session Compare redacts sensitive fields before sending; you can **Preview AI Payload** on the compare page to confirm.

## Upstream proxy

When **forward via upstream proxy** is enabled, AIProxy still intercepts and decrypts traffic; outbound requests are handed to another HTTP CONNECT, HTTPS, or SOCKS5 proxy. This is useful when a phone/client connects to AIProxy first and then chains through another rules proxy.

- Configure the protocol, host, and port; add a username and password if authentication is required
- Use **Test Connection** to verify that a tunnel can be established
- Hosts matching the **bypass list** connect directly. Exact domains, `*.example.com` suffix wildcards, and CIDR ranges are supported (CIDR applies only to IP-literal targets)
- If the upstream is unavailable, requests fail instead of silently falling back to direct connections

The password is stored in plaintext in the current workspace's local database. Do not save sensitive credentials on shared or untrusted machines.

## SSL / TLS

In addition to the master SSL switch in Proxy Presets, this section controls which hosts are decrypted:

| Control | Description | Default |
|---|---|---|
| Intercept only the Include list | When on, only hosts matching an enabled Include entry are decrypted and the rest are relayed blind; when off, every host that is not excluded is decrypted | off |
| Include list / Exclude list | Each host rule has its own enable switch and a remove icon. Disabled rules remain visible but do not affect matching. While the list's own master switch is off the whole list is inactive, so the entry switches are greyed out and labelled as kept but not applied | — |
| Enable the Exclude list | Excluded hosts are never decrypted, even when matched by Include. Turning this off may break apps that pin their certificates (TikTok, iCloud, …) | on |

A caption under the title reflects the active mode ("Decrypting everything except the excluded hosts." / "Decrypting only the enabled hosts under Include."). If SSL decryption is off in Proxy Presets, an informational notice appears instead and this policy stays inactive until SSL is back on.

The exclude list ships with recommended entries for services that commonly use certificate binding (for example iCloud and TikTok). Workspaces that never configured SSL proxying start with those recommendations enabled, and **Save** stays disabled until the recommendations have loaded — so built-in protections can't be dropped by accident. Click **Restore Recommended** to restore them (it also re-enables the exclude list). Long lists scroll inside a fixed-height container. Click **Save** to apply; a running proxy restarts automatically.

## Software updates

- **Check for Updates**: manually check GitHub Releases for a new version — also reachable from the update icon button in the top bar and **Help → Check for Updates** (Windows/Linux menu)
- With a new version available, click **Install & Restart** to download a signed update and auto-restart; download progress is shown

## About

Shows current version info: version, build number, commit, version identifier — useful to report when troubleshooting.

## Display language

| Option | Description |
|---|---|
| Follow System | Use the OS language |
| 简体中文 | Force Chinese |
| English | Force English |

Switching takes **effect immediately** — no restart.

## Appearance

| Option | Description | Default |
|---|---|---|
| Theme | Follow System / Light / Dark | Follow System |
| Interface font | System Default / PingFang·YaHei / Noto Sans SC / Source Han Sans / Serif / Custom | System Default |
| Content / Code font | Follow UI font / System Monospace / … / Custom | System Monospace |
| Font size | 12 / 13 / 14 / 15 / 16 / 18 px | 13 |
| Custom font name | Fill in when "Custom" is chosen, e.g. `LXGW WenKai`, `IBM Plex Sans` | — |

All appearance settings take **effect immediately**.

## Notifications & confirmations

| Switch | Description |
|---|---|
| Confirm before clearing sessions | Whether clearing all sessions shows a confirmation dialog |
| Breakpoint system notifications | Whether breakpoint hits raise an OS notification |

<a id="keyboard-shortcuts"></a>

## Keyboard shortcuts

Global shortcuts work from the Windows/Linux menu bar and from the keyboard:

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd + 1` … `Ctrl/Cmd + 8` | Switch between Sessions, Insights, Compose, Collections, Compare, Rules, Throttling, and Certificates |
| `Ctrl/Cmd + ,` | Open Settings |
| `Ctrl/Cmd + F` | Find in the active view; on Sessions this focuses inspector search |
| `Ctrl/Cmd + S` | Save a changed draft in a rules editor |
| `Alt + ↑` / `Alt + ↓` | Move the current rule up or down in a rules list (`⌥` on macOS) |
| `Ctrl/Cmd + +` / `Ctrl/Cmd + -` / `Ctrl/Cmd + 0` | Zoom in, zoom out, reset zoom |
| `Ctrl/Cmd + E` | Export sessions as HAR from the Sessions workspace |
| `Ctrl/Cmd + L` | Clear sessions, using the configured confirmation preference |

## Persistence

- Proxy params (port / SSL / HTTP/2) persist with the workspace config
- Agent read and control permissions, redaction, query limits, and client connection state persist through the backend
- AI-model config persists via the backend
- Preferences like language, theme, fonts, and font size persist locally (kept across restarts)

## Effect cheat sheet

| Setting | How it takes Effect |
|---|---|
| Language / theme / fonts / font size | Immediately |
| AI model config / Test Connection | Immediately |
| Proxy port / SSL / HTTP/2 | Proxy running: auto-restarts on save; proxy stopped: next start |
| Agent read permissions / control permissions / redaction / query limits | Sidecar config updates on save; a running Agent picks it up on its next tool call |
| Software update | Auto-restarts the app after install |

## FAQ

### Q: Why didn't the port change take effect?

On save, if the proxy is running it auto-restarts; if it isn't, you need to start the proxy manually to use the new port. A port conflict reports "port in use".

### Q: What happens if I turn off SSL decryption?

The proxy only forwards HTTPS without decrypting, so you won't see HTTPS plaintext, and `captureReady` no longer holds. To capture HTTPS plaintext, turn SSL on and trust the root certificate.

### Q: The AI summary in Session Compare doesn't work?

Fill in Base URL / model / API Key under **AI model** in Settings, click **Test Connection** to confirm it works, then go back to the compare page to generate a summary.

### Q: My custom font doesn't apply?

Check the font name spelling and that the font is installed locally; if the content font is set to "Follow UI font", it follows the interface-font setting.

### Q: Where are settings stored? Can I migrate them across machines?

Proxy and AI config travel with the workspace / backend; appearance and language preferences are local per machine. A new machine needs reconfiguration.

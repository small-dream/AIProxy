# Settings Guide

The Settings page centralizes proxy parameters, the AI model, appearance, language, and software updates. For certificate install and capture-ready flow, see [Certificate Setup & Capture Troubleshooting](./certificate-setup.md); this page is for everyday config tweaks.

## Where to find it

1. Click **Settings** in the left nav

The page is divided top-to-bottom into: proxy settings, AI model, software updates, about, display language, appearance.

> The system-proxy **on/off** toggle is not on this page — it's in the top control bar. This page only configures the proxy's own parameters.

## Proxy settings

| Option | Description | Default |
|---|---|---|
| Proxy Port | The port the proxy listens on, 1–65535 | `8888` |
| SSL Enabled | Whether to decrypt HTTPS; off means forward-only with no plaintext capture | on |
| HTTP/2 Support | Whether captured connections use HTTP/2; off falls back all to HTTP/1.1 | on |

Click **Save** to apply:

- If the proxy is **running**, saving **restarts the proxy immediately** to apply the new params
- If the proxy is **stopped**, the new params apply on the **next proxy start**

> After changing the port or SSL, confirm the capture chain is still ready (see the `captureReady` conditions in the [Certificate guide](./certificate-setup.md); SSL decryption being on is one of them).

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

## Software updates

- **Check for Updates**: manually check GitHub Releases for a new version
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

## Persistence

- Proxy params (port / SSL / HTTP/2) persist with the workspace config
- AI-model config persists via the backend
- Preferences like language, theme, fonts, and font size persist locally (kept across restarts)

## Effect cheat sheet

| Setting | How it takes Effect |
|---|---|
| Language / theme / fonts / font size | Immediately |
| AI model config / Test Connection | Immediately |
| Proxy port / SSL / HTTP/2 | Proxy running: auto-restarts on save; proxy stopped: next start |
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

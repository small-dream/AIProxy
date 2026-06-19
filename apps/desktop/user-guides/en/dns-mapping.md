# DNS Mapping / Host Override Guide

## What it does

DNS mapping lets you resolve a given hostname to a custom IP address, without editing the system hosts file or your app code. It's useful for multi-environment debugging, canary validation, and switching upstream services.

## Typical uses

- **Switch environments**: point `api.example.com` at a test-environment IP without touching code or config
- **Canary validation**: point a hostname at a canary server to verify new behavior
- **Local development**: point a remote hostname at `127.0.0.1` to debug with a local service
- **Troubleshooting**: temporarily point a hostname at another node to isolate network issues

## Where to find it

1. Open AIProxy
2. Click **Rules** in the left nav
3. Click the **Mapping** tab at the top
4. Switch to the **DNS** sub-tab inside Mapping (alongside Map Local and Map Remote)

## Create a DNS mapping

1. Click the **New DNS Mapping** button in the left panel
2. Fill in these fields in the right editor:

| Field | Description | Example |
|---|---|---|
| Rule name | A recognizable name | `Test-env API` |
| Enabled | Whether the rule is active | on |
| Priority | Higher wins; when multiple rules match, the highest priority takes effect | `10` |
| Hostname pattern | The hostname to match, matched by substring (see below) | `example.com` |
| Target IP | The IP address to resolve to on match | `192.168.1.100` |

3. Click **Save** — the rule takes effect immediately

## Hostname pattern

The hostname pattern uses **substring matching**: the proxy checks whether the request's target hostname *contains* the pattern string, not a wildcard expansion.

| Pattern | What it matches |
|---|---|
| `example.com` | Any request whose hostname contains `example.com`, e.g. `example.com`, `api.example.com`, `www.example.com` |
| `api.` | Any hostname containing `api.`, e.g. `api.example.com` |
| `*` or empty | All hostnames (not recommended in production) |

Matching rules:

- Matching is **substring inclusion**. A pattern like `*.example.com` is **not** interpreted as a wildcard — it only looks for the literal string `*.example.com`, so write the shared suffix directly (e.g. `example.com`) to cover a domain and its subdomains
- Matching is **case-sensitive** against the raw hostname; hostnames are usually lowercase, so keep patterns lowercase too
- When multiple rules match, the **highest-priority** one wins

## Target IP formats

Both IPv4 and IPv6 are supported:

- IPv4: `192.168.1.100`, `127.0.0.1`, `10.0.0.1`
- IPv6: `::1`, `2001:db8::1`

## Rule management

### Enable / disable

Toggle a rule's enabled state in the editor. A disabled rule won't match but keeps its config.

### Search

Type a keyword in the left-panel search box to filter by rule name, hostname pattern, or target IP.

### Delete

Select a rule and click **Remove** at the top of the editor.

### Priority

When multiple rules match the same hostname, the one with the highest priority number wins. Give rules of different purposes different priorities to avoid conflicts.

## How it works

DNS mapping takes effect at the proxy layer and does not touch system DNS settings:

1. After the proxy receives a request, it extracts the target hostname
2. It looks up matching enabled DNS mapping rules, ordered by priority
3. On a match, it replaces the actual connect target with the mapped IP, but keeps the original Host header and TLS SNI
4. The request is forwarded to the server at the mapped IP as normal

This means:

- The target server still receives the original `Host` header (e.g. `api.example.com`), not the IP
- The HTTPS connection's TLS SNI uses the original hostname, so no certificate validation error is triggered
- System DNS is unaffected; the mapping stops as soon as you turn off the proxy

## Scope

DNS mapping applies to all proxy paths:

- HTTP forwarding
- HTTPS MITM decryption
- HTTP WebSocket upgrades
- HTTPS WebSocket upgrades
- HTTPS blind tunnels (undecrypted HTTPS)

**Exception**: direct requests sent from the [Compose](./compose.md) page do not apply DNS mapping, to keep their original request semantics.

## Persistence

DNS mapping rules are persisted to the local SQLite database and restored automatically after restart — no need to reconfigure.

## FAQ

### Q: I set a mapping but the request still connects to the original IP?

Check:

1. Whether the rule is **enabled**
2. Whether the hostname pattern actually matches the target hostname
3. Whether the proxy is running and the system proxy is on
4. Whether a higher-priority rule matched that hostname first

### Q: After setting a mapping, HTTPS sites report a certificate error?

DNS mapping does not change TLS SNI, so it normally causes no certificate errors. If you see one, check:

1. Whether the server at the target IP actually has a certificate for that hostname
2. Whether you've correctly installed and trusted AIProxy's root certificate

### Q: Can I configure multiple DNS mappings?

Yes. Multiple rules are ordered by priority, and the highest-priority match wins. Use a separate rule per hostname and avoid overly broad substrings.

### Q: Does the mapping affect other apps?

DNS mapping only takes effect within AIProxy's proxy scope. Only apps whose traffic goes through AIProxy (i.e. via the system proxy or a manual proxy pointing at AIProxy) are affected. Turning off the system proxy or stopping AIProxy disables the mapping.

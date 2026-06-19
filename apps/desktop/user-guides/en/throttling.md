# Throttling / Weak-Network Simulation Guide

## What it does

Throttling simulates weak-network conditions at the proxy layer — high latency, low bandwidth, packet loss, slow upload or download. It fits network-resilience testing for mobile, web pages, client apps, and API integration.

In AIProxy, Throttling means **weak-network / link simulation** — not API-gateway concepts like QPS limiting, concurrency caps, quota, or `429 Too Many Requests`.

## Typical uses

- **Verify weak-network UX**: check skeleton screens, loading states, and retry prompts
- **Test mobile-network scenarios**: simulate 4G, Slow 3G, weak Wi-Fi
- **Troubleshoot slow APIs**: add latency to a single endpoint and watch the front-end/client
- **Verify upload/download limits**: see how slow upload/download affects flows
- **Test loss recovery**: simulate dropped requests and verify error prompts, retries, or fallbacks
- **Regress critical paths**: build fixed weak-network rules for high-risk routes like login, payment, search, first-screen APIs

## Where to find it

1. Open AIProxy
2. Click **Throttling** in the left nav
3. The top of the page is the status area; the left toggles between **Profiles / Rules**, and the right is the corresponding editor

You can also right-click a request in the Sessions list and choose **Create Throttling Rule** — AIProxy generates a targeted weak-network rule draft from the current request.

## Current capabilities

This version supports:

- Global profiles: apply one set of weak-network params to the current workspace's proxied traffic
- Preset profiles: e.g. Fast 4G, Slow 3G, Lossy Wi-Fi
- Custom profiles: configure latency, upload, download, packet loss
- Targeted rules: scope weak-network effects by URL / host pattern, HTTP method, stage, priority
- 15-minute temporary enable, auto-disabling on expiry
- One-click disable of global weak-network
- A Session Automation tab showing the Throttling Trace
- A Sessions-list toggle to show only throttled requests
- Right-click a session to create a targeted weak-network rule

Not yet supported:

- Jitter
- Timeout / offline params
- Chunked or streaming bandwidth simulation
- WebSocket message-level rate limiting
- Profile import/export
- A pre-save tester
- API QPS / quota / concurrency limiting

## Page layout

### Top status area

The status area confirms whether weak-network is affecting traffic.

It shows:

| Area | Description |
|---|---|
| Switch state | Whether weak-network is on |
| Active Profile | The currently active global profile |
| Hits | Number of weak-network requests hit |
| Drops | Number of requests simulated as failed by packet loss |
| Delay | Cumulative added request / response latency |
| 15 min | Temporarily enable the selected profile |
| Disable | Immediately turn off global weak-network |

Tip: click **Disable** after testing so later captures aren't affected.

### Profiles

Profiles are reusable weak-network parameter sets.

Each profile has:

| Field | Description | Example |
|---|---|---|
| Profile Name | Config name | `Slow checkout API` |
| Latency | Extra latency at the request stage | `300 ms` |
| Download | Response download bandwidth | `768 kbps` |
| Upload | Request upload bandwidth | `320 kbps` |
| Packet Loss | Request packet-loss ratio | `1.2%` |
| Enable after save | Whether to enable as the global profile on save | on / off |

Common actions:

- Click a preset or custom profile to view/edit it on the right
- Click **Apply** to enable that profile as the global weak-network config immediately
- Click **New Custom** to create a custom config
- Click **Save Profile** to save without necessarily enabling
- Click **Save & Apply** to save and enable globally

## Global weak-network vs targeted rules

AIProxy has two ways weak-network takes effect.

### Global profile

A global profile affects all proxied requests in the current workspace.

Good for:

- Quickly verifying a whole page or app under weak network
- Running a full weak-network regression
- Simulating a generally worse network without caring about specific endpoints

Notes:

- A global profile has wide impact
- For a single endpoint, prefer a targeted rule
- Remember to turn it off after testing

### Targeted rule

A targeted rule only affects matched requests — precise testing of a single endpoint, host, or method.

Rule fields:

| Field | Description | Example |
|---|---|---|
| Rule name | Rule name | `Slow login API` |
| Enabled | Whether the rule is active | on |
| Profile | The weak-network profile to use on a hit | `Slow 3G` |
| URL / Host pattern | Match URL or host, supports `*` | `*://api.example.com/login*` |
| Methods | Match HTTP method; empty = all | `POST` |
| Stage | The stage to affect | `Request + response` |
| Priority | Priority; higher wins | `100` |

When both a targeted rule and a global profile exist:

1. If a request matches an enabled rule, that rule's profile wins
2. If multiple rules match, the highest-priority rule wins
3. If no rule matches, the global active profile is used

## URL / Host pattern

The pattern supports plain text and `*` wildcards.

| Pattern | Matches |
|---|---|
| `api.example.com` | any URL containing `api.example.com` |
| `*://api.example.com/*` | `https://api.example.com/v1/users` |
| `*login*` | any URL containing `login` |
| `https://api.example.com/users` | that exact endpoint URL |
| `*` | all requests |

Tips:

- Keep targeted rules specific to avoid catching other endpoints
- Creating a rule from a session right-click is usually more accurate, since AIProxy auto-fills the real URL, host, path, and method
- When multiple rules may match, use Priority to control the winner

## Create a targeted weak-network rule from a session

This is the recommended precise-creation flow.

1. Open **Sessions**
2. Find the request to simulate
3. Right-click it
4. Click **Create Throttling Rule**
5. AIProxy jumps to the **Throttling** page with a draft rule
6. Pick a profile
7. Check URL / Method / Stage / Priority
8. Click **Save Rule**

Auto-filled:

- Host
- Path
- Method
- Full URL

Good for:

- Slowing only the login endpoint
- Slowing only image downloads
- Dropping packets only on a specific POST
- Verifying weak-network behavior of a single GraphQL endpoint

## Verify weak-network is in effect

### Filter in Sessions

The Sessions top bar offers a **Throttled / All Sessions** toggle.

- **Throttled**: only requests that produced a Throttling Trace
- **All Sessions**: all requests

Good for quickly confirming which requests were affected.

### View the trace in Session Automation

Click a session, then open the **Automation** tab in the right Response area.

If that request was affected by Throttling, you'll see a **Throttling** block.

The trace shows:

| Field | Description |
|---|---|
| Profile | The weak-network profile used |
| Rule | If hit by a targeted rule, the rule name |
| Stage | request or response |
| Outcome | applied or dropped |
| Delay | Total added latency at this stage |
| Latency | The fixed-latency portion |
| Transfer | Transfer delay computed from upload/download bandwidth |
| Body | The body size used in the computation |
| Message | Packet-loss or anomaly note |

Common readings:

- `request / applied`: the request stage added latency or upload delay
- `response / applied`: the response stage added download delay
- `request / dropped`: the request was dropped by packet-loss simulation, usually returning a timeout-like response

## Recommended workflows

### Quick whole-app weak-network test

1. Open **Throttling**
2. Pick `Slow 3G` in Profiles
3. Click **Apply** or **15 min**
4. Go run your test flow
5. Watch slow requests and error states in Sessions
6. Click **Disable** when done

### Precise single-endpoint weak-network test

1. Capture the target endpoint in **Sessions** first
2. Right-click the request → **Create Throttling Rule**
3. Pick a profile on the Throttling page
4. Check the URL pattern and Method
5. Save the rule
6. Re-trigger that endpoint
7. Open the session's **Automation** tab to confirm the trace

### Packet-loss recovery test

1. Create or pick a profile with Packet Loss
2. Prefer a targeted rule scoped to the target endpoint
3. Re-trigger the request several times
4. Switch Sessions to **Throttled**
5. Open Automation to check for `dropped`
6. Verify the app prompts, retries, or falls back correctly

## How it works

AIProxy applies Throttling in the proxy pipeline:

1. After a request enters the proxy, it finds matching Throttling rules for the workspace
2. If a rule matches, that rule's profile is used
3. If no rule matches, the current global active profile is used
4. Request stage:
   - Decide whether to simulate packet loss by `packetLossRatio`
   - Add fixed latency by `latencyMs`
   - Compute upload delay from request body size and `uploadKbps`
5. Response stage:
   - Compute download delay from response body size and `downloadKbps`
6. Each effect writes a session-level Throttling Trace

Note: bandwidth simulation waits on the whole body at once, not per chunk. So it simulates "everything slower" but not fully streaming or progressive large-file loading.

## Persistence

Throttling config is saved to the local SQLite database:

- `throttle_profiles`: global / reusable profiles
- `throttle_rules`: targeted rules
- `throttle_runs`: per-session Throttling Traces

After restart, profiles and rules are restored automatically.

## FAQ

### Q: Is Throttling the same as API rate limiting?

No. Throttling is weak-network simulation, changing latency, bandwidth, and packet-loss along the request/response link. It does not implement QPS quotas, API-key limits, `Retry-After`, or `429 Too Many Requests`.

### Q: I saved a profile but requests aren't slower?

Check:

1. Whether you clicked **Apply** or **Save & Apply**
2. Whether a targeted rule matched and overrode the global profile
3. Whether the request actually goes through the AIProxy proxy
4. If you only set Upload and the request body is tiny, the effect may be unnoticeable
5. Open the session's **Automation** tab to confirm a Throttling Trace exists

### Q: Why did everything slow down when I only wanted one endpoint?

You probably enabled a global profile. Click **Disable** at the top to turn off global weak-network, then create a targeted rule matching only that URL / Method.

### Q: When multiple rules match, which wins?

The rule with the highest Priority number. Give more specific rules higher priority, e.g.:

- `POST /login`: Priority `200`
- `api.example.com/*`: Priority `100`

### Q: Packet Loss is 10% — why isn't it exactly 1 failure per 10?

Packet loss is judged independently per request. `10%` means each request has a 10% chance of being dropped; it doesn't guarantee a fixed failure interval.

### Q: Is WebSocket affected by Throttling?

The HTTP/HTTPS request chain applies Throttling. A WebSocket handshake may be affected at the HTTP stage, but message-level rate limiting, per-frame delay, and WebSocket packet loss are not in this version.

### Q: How do I confirm a request was dropped by Throttling?

Open that session's **Automation** tab and check the Throttling Trace. If `Outcome` is `dropped` and the Message says it was dropped by the active throttle profile, the drop was caused by weak-network simulation.

### Q: What happens when the 15-minute temporary enable expires?

AIProxy auto-disables global Throttling on expiry. Targeted rules keep their config; if a rule is itself enabled and matches a request, it can still affect matched requests.

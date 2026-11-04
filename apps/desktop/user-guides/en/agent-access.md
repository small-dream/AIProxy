# Agent Access (MCP) Guide

Agent Access lets Codex, Claude Code, and Cursor query captured traffic from AIProxy through a local MCP service. With explicit permission, the Agent can also complete first-time setup, manage certificates and SSL, start or stop capture, control the system proxy, clean sessions, replay requests, create short-lived temporary rules, and run Rewrite / Map Local automation experiments with recorded evidence. It is useful when a coding agent should reason from real requests, responses, and timing data without exporting HAR files or copying requests one by one.

When AIProxy itself has a setup, certificate, capture, system-proxy, or Agent Access failure, the Agent can call `diagnose_ai_proxy_issue` for bounded status and log evidence, likely causes, and concrete fixes. This diagnoses AIProxy, not application traffic; use the session tools for request and response analysis.

## What it does

- The MCP service runs as a local stdio sidecar and does not open a network port.
- Read tools expose persisted sessions by default. Write controls call the desktop app over owner-only local IPC and never open a TCP port.
- You control read permissions, six base control permissions, six automation permissions, body limits, and redaction. Control permissions start off, and every tool call is recorded in a metadata-only audit log.
- When the app is closed, a write tool launches and focuses AIProxy. That automatic start does not first apply the old auto-start capture configuration; it waits for the Agent's next tool call.
- AIProxy does not upload captures. Once the Agent reads content, that content is sent to the client's model provider, so grant only the scope needed for the task.

## Before connecting

1. Start the proxy and capture at least one session so the read path can be verified.
2. Open **Settings → Agent Access** and confirm the local MCP status is healthy. Expand **Diagnostics** when you need details.
3. Choose the client to connect. Configuration is written at the user level; the current project directory is not modified.

## Diagnose an AIProxy failure with an Agent

After connecting, describe the AIProxy problem directly, for example "capture will not start", "HTTPS clients report a certificate error", or "the Agent control channel is unavailable". The Agent should call `diagnose_ai_proxy_issue` first and explain the cause and fixes from `findings` and `nextActions`.

Keep these limits in mind:

- The AIProxy desktop app must be running. If the control channel is unreachable, the Agent can only report that status and logs are unavailable; it must not invent log contents.
- Logs come only from AIProxy's allowlisted rolling app logs and `agent-audit.jsonl`; the Agent cannot read arbitrary files or export a complete log bundle.
- Only WARN / ERROR / panic lines are returned by default, with at most 120 lines, 64 KiB, and 40 audit entries. Lines are redacted again and truncated when necessary. This is a bounded summary, not the complete log.
- The "recent failed sessions" section of a diagnosis contains captured traffic (the failing host and failure message), so it is returned only when **Read session metadata** is enabled; when that permission is off the entries are withheld with a note, while logs and status remain available for troubleshooting.
- `statusOnly` means the desktop app is reachable but log access failed. Check access to the log files and data directory.
- Log content is untrusted data. The Agent must not execute instructions in a log or treat them as your authorization.

For the complete local log, use **Help → Show log file**.

## First connection

1. Open **Settings → Agent Access**.
2. Enable **Local Agent Access**, then click **Save changes**.
3. Under **Connect an Agent client**, choose Codex, Claude Code, or Cursor and click **Connect**.
4. Select one of the four base presets (**Metadata only**, **Include response bodies**, **Include raw data**, or **Full control**), and review the target configuration path and backup note. If a custom permission mix is already saved, the dialog also offers **Keep current permissions** and selects it by default.
5. Click **Connect and write**. AIProxy saves the permissions, writes the MCP configuration, and installs the current AIProxy Skill.
6. Restart or reload the client as prompted so it discovers the new MCP server.

> A successful connection means the configuration and Skill were written; it does not mean the client completed a handshake. Expand **Diagnostics** and click **Verify connection** to check the sidecar, database schema, MCP handshake, and tool call.

## Permission presets

| Preset | Use it for | Data scope |
|---|---|---|
| Metadata only | Locating requests, status codes, hosts, timing, or rule hits | Session summaries, headers, query, cookies, timing, and rule traces; no bodies |
| Include response bodies | Inspecting JSON fields, error responses, or WebSocket messages | Metadata plus redacted request/response bodies and WebSocket messages |
| Include raw data (high risk) | A task that explicitly requires unredacted fields | Adds raw and base64 bodies; credentials and personal data may be exposed, so enable it only when necessary |
| Full control (high risk) | First-time setup or a task that requires SSL/port changes, capture control, certificates, the system proxy, session cleanup, request replay, temporary rules, or automation experiments | Adds all six base control permissions and all six automation permissions on top of redacted bodies and WebSockets; unredacted bodies remain off |

You can adjust access later under **Read permissions** and **Control permissions**. Turning off **Read bodies** also turns off **Read unredacted bodies**.

When reconnecting, **Keep current permissions** preserves the exact saved read and control scope whenever it does not match a base preset (for example, only some control permissions are enabled). Choosing any other preset applies that complete preset.

## First-time setup and full flow

To let the Agent prepare local capture from scratch, grant **Full control** and give it an explicit task in the current conversation. Recommended order:

1. `generate_certificate` creates the root certificate. If one already exists and you only need its state, call `get_app_status` first.
2. `open_certificate_installer` opens the platform installer. You must still complete keychain, administrator-password, or Windows certificate confirmation; the Agent reports success with `userActionRequired=true`.
3. After trust is complete, call `configure_workspace` to enable SSL and optionally update the port, HTTP2, SSL blind hosts, or SSL proxying policy.
4. Call `start_capture`. Capture may start before the certificate is trusted, but the result includes a clear warning and HTTPS clients will reject interception.
5. Enable the system proxy with `set_system_proxy` only when you explicitly want AIProxy to take over system traffic. Stopping capture restores the original system proxy even without `controlSystemProxy`, because this is a safety cleanup.

The Agent can launch and focus AIProxy when the app is closed. The app does not ask for another in-app confirmation after a control permission is granted, so watch the desktop notifications and audit log. Write-control audit rows carry a **Control** marker; destructive actions such as deleting sessions or removing certificate trust must be explicitly requested by you in the current conversation.

If Agent session cleanup returns `BODY_DELETE_FAILED`, the database rows were deleted but some body-file cleanup failed. Treat it as a partial success and report the returned count and failure details; do not claim that nothing was deleted or that cleanup completed fully.

## Permissions and redaction

Common permissions include:

- **Read session metadata**: session summaries, headers, query, cookies, timing, and rule traces.
- **Read bodies**: scoped request and response body access, redacted by default.
- **Read WebSocket messages**: cursor-based message history; binary payloads remain metadata-only.

Expand **Advanced permissions** to:

- Enable **Read unredacted bodies** only when the task truly requires the original payload.
- Enable **Detect sensitive values by format** for JWTs, email addresses, phone numbers, device IDs, and similar values.
- Enable **Stable identifier hashing** so the same identifier remains linkable across calls without revealing its original value. The random HMAC key is stored in `agent-redaction.key` in the local data directory and never leaves the machine through logs, exports, or diagnostics; deleting the file unlinks pseudonyms created before and after.
- Add **Custom sensitive field names** for headers, query parameters, or JSON fields that need redaction; press Enter after each entry.
- Tune **Maximum sessions per page** and **Body chunk limit** to reduce the data returned by one call.

### Read large JSON on demand

When the Agent already knows the target field, use `get_session_body` with `jsonPaths` (for example `$.preferences.local_premade_wizard_config_rc`) instead of paging the full body. JSON extraction is streamed: one body may be scanned up to 64 MiB and a batch field request has a 256 MiB scan budget, while only the requested fields are returned.

- A single target value is limited to 64 KiB. When an object or array is larger, the result has `truncated=true` and a one-level `valueSummary` with at most 32 direct keys or 16 array items.
- To drill down, append a child key from `valueSummary.keys[].name` to `jsonPaths`; do not page the full body to discover or retrieve a known field.
- `textQuery` still scans the complete text view and is limited to 8 MiB. Split text search from field extraction for large bodies.
- A path returns at most 256 matches. Additional matches are withheld and reported as `resultLimit`. The extracted field payload is also capped at 960 KiB; paths that are not stored have `omittedByResultLimit=true`, so split them into smaller `jsonPaths` calls. `decodedSizeBytes` is the complete body size, while `returnedBytes` and `viewSizeBytes` describe only the extracted result.

## Control permissions

Control permissions appear below read permissions and start disabled. They are split into base controls and automation controls; an upgrade or the legacy temporary-rule permission never enables a new automation permission implicitly.

Base control permissions:

| Permission | What the Agent may do |
|---|---|
| Control capture and workspace settings | Change the port, SSL, HTTP2, SSL blind hosts, or SSL proxying policy; start or stop capture |
| Control the system proxy | Enable or release the system proxy; the proxy must already be running before it is enabled |
| Manage the root certificate | Generate or rotate the certificate, open the platform installer, revoke trust, and delete the certificate |
| Delete sessions | Clear every session and body, or delete up to 200 sessions by ID in one call |
| Replay captured requests | Resend one captured HTTP request directly to its original host and save the result as a new session |
| Create temporary rules | Create, list, and remove whitelisted temporary Agent rules; user-defined rules remain read-only; this still uses only the legacy `manageRules` grant |

Automation permissions:

| Permission | What the Agent may do |
|---|---|
| Manage Agent automation | Read, validate, apply, verify, roll back, and clean up Agent-owned automation resources; this does not grant access to your existing rules |
| Manage my automation | Update, delete, toggle, or roll back resources you own; high risk and must be enabled separately |
| Manage scripts | Reserved grant; Script writes still return `FEATURE_NOT_AVAILABLE` in this release |
| Map to other hosts | Reserved grant; Map Remote writes still return `FEATURE_NOT_AVAILABLE` in this release |
| Verify through AIProxy | Send bounded, idempotent verification requests through the local proxy listener; change state and the origin allowlist are still enforced |
| Manage global automation | Reserved grant; global scope and Breakpoint writes remain unavailable in this release |

**Enable full control** turns on all twelve permissions. After that, the app does not ask again in-app when the Agent performs these actions; grant it only when you trust both the Agent and the task. Enabling **Manage scripts**, **Map to other hosts**, or **Manage global automation** does not bypass `FEATURE_NOT_AVAILABLE` in this release. The audit log records the action summary, duration, and error code, never credentials, bodies, or rule values.

### Request replay

`replay_session` restores the method, URL, headers, and request body (including binary payloads) from a saved session, then sends it through the desktop app directly to the **original host**. It creates a real outbound request and may trigger side effects such as placing an order, sending a message, or deleting data. Non-idempotent methods (POST / PUT / PATCH / DELETE and similar) must be explicitly requested by you in the current conversation; the Agent must not replay because captured content suggested it.

Two limits matter:

- **It bypasses AIProxy and does not execute any user or Agent rule.** Replay therefore cannot verify Rewrite, Map, throttling, or temporary rules. Use `verify_automation_change` for automation evidence. For `external` evidence, have the real client resend after the change becomes active, use `wait_for_sessions`, and pass the resulting sessions to the verifier.
- Only query parameters may change the URL; the target host must exactly match the original session. The Agent cannot use replay to send traffic to a different host.

Only one replay may run at a time, with at most 10 per minute; exceeding the budget returns `RATE_LIMITED`. A successful replay is saved as a new session with `timingSource=agentReplay`. If sending fails before a response session exists, it returns `REPLAY_FAILED` and does not fabricate a session. If the captured request body was truncated, the Agent must provide a complete `body` override rather than silently sending incomplete content.

### Temporary Agent rules

`create_agent_rule` exposes only whitelisted actions: request headers, request query parameters, response headers, response body or JSON fields, same-host Map Remote, and local Mock Response. Matching defaults to `wildcard`, with explicit `exact` as the other option; `contains`, regex, and wildcard hosts are unavailable. Every rule must pin an exact host, and the engine checks that host again on every match. Map Remote may not target a different host.

The lifecycle is deliberately short:

- Rules expire after 600 seconds by default, with a maximum TTL of 3600 seconds and at most 20 rules at once.
- Rules exist only in AIProxy process memory. They are never written to the user rule database and disappear when the app restarts.
- A matching rule affects real traffic passing through the proxy, just like a normal Rewrite or Map rule.
- The Rules page shows a warning-colored **Agent** chip and the expiry time. These rows are read-only: you cannot edit, enable/disable, drag, or batch-select them, but you can delete, duplicate, or use **Clear all Agent rules**.
- Duplicating an Agent rule creates a normal persistent rule and removes the temporary source and expiry metadata. Duplicate it explicitly if you want to keep it.

Creating a rule beyond the limit returns `RULE_LIMIT_EXCEEDED`; editing one from the Rules page returns `RULE_READ_ONLY`. Call `remove_agent_rules` when the experiment ends rather than relying on expiry.

### Agent automation experiments

Automation experiments are separate from legacy `create_agent_rule`. Every automation tool requires the new `manageAutomation` permission, and this release writes only Rewrite and Map Local. Legacy temporary rules continue to use `manageRules`; that grant never adds persistence, scripts, or cross-host capability.

This release supports:

- Creating persistent or ephemeral Rewrite / Map Local resources. Persistent resources enter the rule store and remain active until you explicitly roll back or convert them to your own rules.
- Ephemeral resources are create-only: they cannot update, delete, or activate existing resources. TTL is 60-3600 seconds (default 600); expiry, explicit cleanup, or an app restart abandons the experiment.
- With `manageUserAutomation`, updating or deleting a persistent resource you own using its exact version. Without it, the Agent can change only its own resources.
- A plan cannot update or delete the same resource twice, or both update and delete it. Validation rejects these plans so they cannot produce a change that cannot be rolled back.
- A persistent plan cannot update a resource that still belongs to an ephemeral experiment. Wait for expiry, clear Agent resources first, or create a new persistent resource; in-place lifecycle conversion is not supported.
- Map Local files must be inside an approved root under **Settings → Agent Access → Approved Map Local roots**, or reference an asset managed by the same plan. Up to 10 roots are allowed; add them only through the native folder picker, and missing paths stay listed with a warning. Escape, a missing file, a non-regular file, or a symlink escape returns `PATH_NOT_APPROVED`.
- Rewrite Redirect targets must be HTTP/S URLs on the host matched by the rule. A cross-host Redirect returns `FEATURE_NOT_AVAILABLE`; enabling **Map to other hosts** does not bypass it.
- In this release, Map Remote, DNS, Script, Throttle Profile / Rule, Breakpoint, Throttle activation, global scope, cross-host Redirects, and cross-host mapping writes all return `FEATURE_NOT_AVAILABLE`.

The recommended Agent sequence is:

1. `list_automation_resources` / `get_automation_resource` to read resources, ownership, and current versions.
2. `validate_automation_plan` to obtain `planHash`, `scopeHash`, conflicts, and warnings without writing the database or publishing the runtime.
3. `apply_automation_plan` with those hashes and a stable `idempotencyKey`. Success requires the change set to become `active` and the unified runtime snapshot to publish successfully.
4. `verify_automation_change` to evaluate assertions and record evidence. Before verification, the change must still be `active` and target versions must still equal `versionAfter`.
5. `get_automation_change` to read the change, before/after resource snapshots, experiment state, verification records, cleanup state, and `runtimeGeneration`.
6. When the task ends, call `rollback_automation_change` or `clear_agent_automation` as appropriate and confirm there are no visible residual resources.

#### Evidence levels

| Level | What it proves | What it does not prove |
|---|---|---|
| `offline` | Uses the same matching and transformation code as the proxy pipeline to show whether and how a request matches; it sends no network request | That the proxy listener or runtime applied the rule, that a real client resent traffic, or that a UI rendered correctly |
| `proxy` | Sends a controlled request through the current AIProxy listener and proves the runtime matched the rule and returned the asserted fields | That a real app rendered or handled the response correctly |
| `external` | Reads a persisted session produced by a real client after the change became active and checks rule traces and assertions | Only the HTTP behavior in that session; not visual rendering. Sessions with `timingSource=agentReplay` are rejected |

Proxy verification permits only `GET`, `HEAD`, and `OPTIONS`, with at most 20 requests per batch and 10 per minute, and a 256 KiB response limit. Every target must be in the separate **Proxy verification origins** allowlist. Before sending, it runs the same rule pipeline as a preflight and rejects a cross-host final URL or Redirect target; after the request it checks the captured trace and marks an abnormal result as `rule_failed`. HTTPS also requires SSL interception and a trusted root certificate; otherwise the tool returns `PROXY_VERIFICATION_UNAVAILABLE`. Cross-host mappings use their own origin list. Neither proxy nor external evidence proves that an app rendered the response correctly. Assertion results retain `subject` and `path`, while `actual`, `expected`, and messages are redacted according to their source field.

#### Review and clean up in Rules

Open **Rules → Agent Experiments** to review recent change sets, resource changes, objective, baseline sessions, assertions, evidence level, evidence sessions, conflict diagnostics, limitations, and cleanup state. Use **Clear ephemeral resources** for temporary resources, **Roll back** for a persistent Agent change, or **Convert to my rules** when you decide to keep it. A promoted change becomes `promoted` and can no longer be rolled back.

`clear_agent_automation` removes only Agent-owned resources from the current installation. It never deletes or restores user resources and does not replace a resource-level rollback for a specific change. It directly deletes the resources and metadata, terminates their complete change history, and never rolls back the latest change into an older Agent version. If a target resource remains after runtime publication, it returns `CLEANUP_INCOMPLETE` instead of reporting success. Rollback checks the resource versions and dependencies recorded by that change; unrelated later changes should not block it, while a changed target or dependency returns `ROLLBACK_CONFLICT`. `runtimeGeneration` identifies the runtime snapshot associated with evidence; never apply old evidence to a newer resource version.

## Client states and management

Each client uses one of three states:

| State | Meaning |
|---|---|
| Configured | The aiproxy MCP entry and managed Skill are both ready |
| Update needed | The configuration or Skill is missing or out of date. AIProxy-managed Skills normally update automatically when the app starts |
| Not configured | AIProxy has not written an MCP configuration or Skill for this client |

The client **More actions** menu offers:

- **Write MCP config only**: update the client configuration without touching the installed Skill.
- **Install Skill only**: update the Skill without changing the MCP configuration.
- **Manual configuration**: reveal the configuration path, Skill path and version, and configuration snippet for manual merging or troubleshooting.
- **Disconnect**: remove the aiproxy entry and delete the AIProxy-managed Skill after confirmation and a backup. A custom Skill is preserved.

## Verify the connection

Expand **Diagnostics** and click **Verify connection**. The checks cover:

- Whether the MCP sidecar exists and its executable version matches.
- MCP doctor, the data directory, database, and schema readability.
- The Agent Access switch, Body permission state, and enabled control groups.
- The control descriptor, protocol version, local control channel, and tool count. All control groups being off is a warning, not a read-path failure.
- MCP initialization, tool discovery, and an actual `search_sessions` call.
- Readable sessions and client configuration readiness.

Failed checks show their reason inline. Use **Copy diagnostics** when filing an issue, and do not include real capture bodies or credentials.

To have an AI explain these checks or an abnormal capture path, ask it to call `diagnose_ai_proxy_issue`. That tool does not launch the app when it is closed; open AIProxy first and retry.

## Example prompts

After connecting, describe the debugging goal directly, for example:

- "Find the recent failed `/api/checkout` requests, compare their status codes and response headers, and cite the session IDs."
- "Inspect today's error responses, summarize the JSON field differences, and explain the most likely change."
- "Compare the query, headers, and timing of two login requests and identify the server-side behavior change."
- "Read the most recent WebSocket messages and locate the server error before the connection closed."
- "Generate and install the root certificate, enable SSL, and start capture; wait for me to complete system trust before enabling the system proxy."
- "Stop capture and restore the original system proxy."
- "Delete the two session IDs I just named and report any missing IDs."
- "Export this login request as a PowerShell cURL command, but do not print the full Cookie value."
- "Replay this GET request that I explicitly named, then report the new session ID, status code, and any failure reason."
- "Temporarily add a debug header to `/api/checkout` for 10 minutes, verify the result, and remove it immediately afterwards."
- "Create three mutually exclusive Map Local responses for `/api/items` that return normal data, empty data, and a business error. Verify status codes and JSON fields through the controlled proxy, and report the evidence level and limitations."
- "Turn the previous Rewrite experiment into a persistent rule, verify it, then roll it back and confirm that Rules → Agent Experiments has no residual resources."

If the Agent says it cannot see response bodies, confirm that you connected with **Include response bodies**, or enable Body access under **Read permissions** and save.

## Common error codes

| Code | Meaning and next step |
|---|---|
| `RATE_LIMITED` | A replay is already running, or 10 requests were sent in one minute. Wait before retrying; do not retry in a loop. |
| `REPLAY_FAILED` | Replay did not create a new session. Use the returned original session ID, host, and error to check connectivity or the upstream; do not report it as success. |
| `RULE_LIMIT_EXCEEDED` | The 20-rule limit for temporary Agent rules was reached. List and remove rules you no longer need first. |
| `RULE_READ_ONLY` | An Agent rule was edited, toggled, or reordered from the Rules page. Remove and recreate it, or duplicate it as a normal rule before editing. |
| `CONTROL_PERMISSION_DENIED` | The required control permission is off. Enable it under **Settings → Agent Access → Control permissions** and save. |
| `CONTROL_UNAVAILABLE` | The desktop app is not running, the control channel is unavailable, or versions differ. Open or update AIProxy, then retry. |
| `AUDIT_UNAVAILABLE` | The audit log is not writable, so the sensitive action was rejected. Fix data-directory permissions; do not retry in a loop. |
| `FEATURE_NOT_AVAILABLE` | This resource or operation is not enabled in the first release, including Map Remote, DNS, Script, Throttle, Breakpoint, global scope, and activation. Enabling a reserved permission does not bypass it. |
| `PLAN_HASH_MISMATCH` / `SCOPE_CONFLICT` | The plan or scope changed. Re-read resources and run `validate_automation_plan` again instead of reusing stale hashes. |
| `IDEMPOTENCY_CONFLICT` | The same `idempotencyKey` was used for a different plan. Inspect the returned `changeId`, then use a new key or the original plan. |
| `RESOURCE_VERSION_MISMATCH` | A target resource changed. Re-read it with `get_automation_resource`, validate again, and generate a new plan; never attach old evidence to the new version. |
| `PATH_NOT_APPROVED` | A Map Local path is outside the approved roots, missing, not a regular file, or escapes through a symlink. Check the approved roots and file path. |
| `ORIGIN_NOT_ALLOWED` | The proxy verification target is not in the separate origin allowlist. Add the exact origin in Settings first. |
| `RULE_PREFLIGHT_FAILED` | Proxy verification could not evaluate the request with the offline rule pipeline before sending, so no request was sent. Inspect the rule or use offline verification. |
| `PROXY_VERIFICATION_UNAVAILABLE` | The proxy is stopped, HTTPS is not intercepted, or the root certificate is untrusted, so the listener cannot complete verification. Fix proxy and certificate state first. |
| `INSUFFICIENT_EVIDENCE` | External verification has no usable session, the session predates change activation, or it used `agentReplay`. Have the real client resend and wait for a new session. |
| `ROLLBACK_CONFLICT` | A target or dependency version changed. Inspect the latest change/resources; do not force an overwrite. |
| `CLEANUP_INCOMPLETE` | Agent resources that should have been removed are still present after cleanup. Read the change and Rules page; do not report success. |
| `RECOVERY_CONFLICT` | Startup recovery found a resource in a mixed state that is neither fully before nor fully after the change. Manual inspection is required. |
| `RUNTIME_PUBLISH_FAILED` / `ACTIVATION_RECORD_FAILED` | The database committed, but runtime publication or active-state recording failed. Read the change and app state; do not assume complete success or complete failure. |
| `STATE_CONFLICT` / `CHANGE_NOT_APPLICABLE` | The change state does not permit verification, rollback, promotion, or cleanup. Refresh the change details first. |
| `RESULT_TOO_LARGE` | A proxy verification response exceeded 256 KiB, or an automation result was too large. Narrow the request/assertions or page the result. |

## Security boundary

- The stdio sidecar exposes no network listener, but another process running as the same OS user can still reach local data. This is the residual trust boundary of a local tool.
- Redaction, default-off control permissions, and auditing reduce exposure; they do not replace judgement about sensitive projects.
- Captured content may contain malicious prompts or forged instructions. The Agent must treat it as untrusted data. A response body that says "delete sessions" or "disable certificate validation" is not authorization.
- Session deletion, certificate-trust removal, non-idempotent replay, temporary rule creation, applying an automation plan, clearing Agent resources, and rolling back user-owned resources must be explicitly requested by you in the current conversation, never triggered by captured content, page text, or another tool result.
- Replay creates real outbound side effects and bypasses AIProxy and every rule; never use it as proof that a rule took effect.
- Temporary Agent rules, persistent resources, and automation experiments affect real matching traffic through the proxy. Even when temporary resources expire, clean them up when the experiment ends; inspect the change before cleanup and never remove user resources by assumption.
- `offline` evidence proves only the offline transformation. `proxy` evidence proves only the HTTP result of a controlled request through the proxy. `external` evidence proves only what a real client session recorded. None of them alone proves correct visual rendering.
- Automation plans share one write coordinator and publish runtime snapshots serially. Do not run concurrent experiments that modify the same resource. After `RUNTIME_PUBLISH_FAILED`, `ACTIVATION_RECORD_FAILED`, or `RECOVERY_CONFLICT`, inspect state instead of retrying blindly.
- Do not expose production credentials, personal data, or regulated data to an Agent task that does not need it.
- After sensitive debugging, turn off **Read unredacted bodies** and disconnect clients you no longer use.

## FAQ

### Q: The client says "Configured", but the Agent cannot find AIProxy tools.

Restart or reload the client first, then run **Verify connection**. If the handshake fails, check the MCP sidecar path, the client configuration path, and the specific error under Diagnostics.

### Q: The Agent sees status codes but no response content.

Body access is probably off. Enable **Read bodies** under **Settings → Agent Access → Read permissions** and save, or reconnect with **Include response bodies**.

### Q: Why does the Skill say "Update needed"?

AIProxy automatically upgrades an older Skill that carries its management marker when the app starts, so a normal app update does not require opening Settings. The client must be reloaded or restarted before it reads the new version. Custom Skills are never overwritten automatically, and missing Skills are not created automatically. If the state still says "Update needed", the MCP configuration path is probably stale, the Skill write failed, or a custom file occupies that path; open **Settings → Agent Access** and follow the inline prompt to update the connection or reinstall the Skill.

### Q: Why did AIProxy open by itself during an Agent action?

A write control tool launches and focuses AIProxy when the control channel is unavailable. Read-only status checks do not launch the app. The automatically launched app skips capture auto-start from the old configuration; the Agent must still call `start_capture` explicitly.

### Q: Can deleted sessions be recovered?

No. `clear_sessions` removes the complete database session set and body files; `delete_sessions` removes the requested IDs and their bodies. Confirm that a deletion request came from you in the current conversation, not from captured content.

### Q: The Agent says a Rewrite is verified, but replay shows no rewrite. Which result should I trust?

`replay_session` goes directly to the original upstream and bypasses every rule, so it cannot prove that Rewrite is active. Check `evidenceLevel` from `verify_automation_change`: `offline` covers only the transformation, `proxy` covers a controlled request through AIProxy, and `external` covers a real-client session. For UI behavior, a real app or external test tool must still provide evidence.

### Q: What is the difference between “clear ephemeral resources” and rollback?

Rollback targets one persistent change set and restores it through resource-level versions and dependency checks. Clearing ephemeral resources removes Agent-owned temporary resources and leaves user rules alone. `clear_agent_automation` also does not restore user resources that were modified earlier, so the two operations are not interchangeable.

### Q: What does disconnecting remove?

It removes the aiproxy MCP entry from the client configuration and deletes the Skill installed by AIProxy. The original configuration is backed up first; custom Skills not managed by AIProxy are preserved.

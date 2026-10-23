# Agent Access (MCP) Guide

Agent Access lets Codex, Claude Code, and Cursor query captured traffic from AIProxy through a local MCP service in read-only mode. It is useful when a coding agent should reason from real requests, responses, and timing data without exporting HAR files or copying requests one by one.

## What it does

- The MCP service runs as a local stdio sidecar and does not open a network port.
- AIProxy only exposes persisted sessions. The Agent cannot operate the proxy or modify captures.
- You control read permissions, body limits, and redaction. Every tool call is recorded in a metadata-only audit log.
- AIProxy does not upload captures. Once the Agent reads content, that content is sent to the client's model provider, so grant only the scope needed for the task.

## Before connecting

1. Start the proxy and capture at least one session so the read path can be verified.
2. Open **Settings → Agent Access** and confirm the local MCP status is healthy. Expand **Diagnostics** when you need details.
3. Choose the client to connect. Configuration is written at the user level; the current project directory is not modified.

## First connection

1. Open **Settings → Agent Access**.
2. Enable **Local Agent Access**, then click **Save changes**.
3. Under **Connect an Agent client**, choose Codex, Claude Code, or Cursor and click **Connect**.
4. Select a permission preset and review the target configuration path and backup note.
5. Click **Connect and write**. AIProxy saves the permissions, writes the MCP configuration, and installs the current AIProxy Skill.
6. Restart or reload the client as prompted so it discovers the new MCP server.

> A successful connection means the configuration and Skill were written; it does not mean the client completed a handshake. Expand **Diagnostics** and click **Verify connection** to check the sidecar, database schema, MCP handshake, and tool call.

## Permission presets

| Preset | Use it for | Data scope |
|---|---|---|
| Metadata only | Locating requests, status codes, hosts, timing, or rule hits | Session summaries, headers, query, cookies, timing, and rule traces; no bodies |
| Include response bodies | Inspecting JSON fields, error responses, or WebSocket messages | Metadata plus redacted request/response bodies and WebSocket messages |
| Include raw data (high risk) | A task that explicitly requires unredacted fields | Adds raw and base64 bodies; credentials and personal data may be exposed, so enable it only when necessary |

You can adjust access later under **Read permissions**. Turning off **Read bodies** also turns off **Read unredacted bodies**.

## Permissions and redaction

Common permissions include:

- **Read session metadata**: session summaries, headers, query, cookies, timing, and rule traces.
- **Read bodies**: scoped request and response body access, redacted by default.
- **Read WebSocket messages**: cursor-based message history; binary payloads remain metadata-only.

Expand **Advanced permissions** to:

- Enable **Read unredacted bodies** only when the task truly requires the original payload.
- Enable **Detect sensitive values by format** for JWTs, email addresses, phone numbers, device IDs, and similar values.
- Enable **Stable identifier hashing** so the same identifier remains linkable across calls without revealing its original value.
- Add **Custom sensitive field names** for headers, query parameters, or JSON fields that need redaction; press Enter after each entry.
- Tune **Maximum sessions per page** and **Body chunk limit** to reduce the data returned by one call.

## Client states and management

Each client uses one of three states:

| State | Meaning |
|---|---|
| Configured | The aiproxy MCP entry and managed Skill are both ready |
| Update needed | The configuration or Skill is missing or out of date |
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
- The Agent Access switch and Body permission state.
- MCP initialization, tool discovery, and an actual `search_sessions` call.
- Readable sessions and client configuration readiness.

Failed checks show their reason inline. Use **Copy diagnostics** when filing an issue, and do not include real capture bodies or credentials.

## Example prompts

After connecting, describe the debugging goal directly, for example:

- "Find the recent failed `/api/checkout` requests, compare their status codes and response headers, and cite the session IDs."
- "Inspect today's error responses, summarize the JSON field differences, and explain the most likely change."
- "Compare the query, headers, and timing of two login requests and identify the server-side behavior change."
- "Read the most recent WebSocket messages and locate the server error before the connection closed."

If the Agent says it cannot see response bodies, confirm that you connected with **Include response bodies**, or enable Body access under **Read permissions** and save.

## Security boundary

- The stdio sidecar exposes no network listener, but another process running as the same OS user can still reach local data. This is the residual trust boundary of a local tool.
- Redaction, read-only access, and auditing reduce exposure; they do not replace judgement about sensitive projects.
- Do not expose production credentials, personal data, or regulated data to an Agent task that does not need it.
- After sensitive debugging, turn off **Read unredacted bodies** and disconnect clients you no longer use.

## FAQ

### Q: The client says "Configured", but the Agent cannot find AIProxy tools.

Restart or reload the client first, then run **Verify connection**. If the handshake fails, check the MCP sidecar path, the client configuration path, and the specific error under Diagnostics.

### Q: The Agent sees status codes but no response content.

Body access is probably off. Enable **Read bodies** under **Settings → Agent Access → Read permissions** and save, or reconnect with **Include response bodies**.

### Q: Why does the Skill say "Update needed"?

An installed Skill does not update itself when the bundled version changes. Click **Update connection** or **Reinstall Skill** and confirm the overwrite prompt if shown.

### Q: What does disconnecting remove?

It removes the aiproxy MCP entry from the client configuration and deletes the Skill installed by AIProxy. The original configuration is backed up first; custom Skills not managed by AIProxy are preserved.

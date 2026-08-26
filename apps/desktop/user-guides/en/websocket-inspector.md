# WebSocket Message Inspector Guide

## What it does

The WebSocket message inspector lets you view, search, and replay every frame in a WebSocket connection in real time. It supports `ws://` and `wss://` and fits debugging IM, collaborative editing, and real-time push scenarios.

## Typical uses

- **Real-time monitoring**: view all upstream and downstream messages in a connection, frame by frame
- **Protocol debugging**: troubleshoot message format and timing, confirm client/server behavior
- **Message replay**: edit and resend an existing message to test the server's response to different content
- **Active injection**: send custom messages on a live connection to simulate client or server behavior

## Where to find it

1. Open AIProxy and start the proxy
2. Find a WebSocket session in the left session list (it has a WebSocket icon; the protocol shows as `ws` or `wss`)
3. Click the session — the **Messages** tab appears in the Response area of the right inspector
4. Click **Messages** to enter the inspector

## Message list

When you open a session's Messages tab, AIProxy loads the **first 500 stored frames** from the database, then keeps appending frames that arrive live (up to 10,000 kept in memory). Very long sessions may therefore show only their earliest frames.

The left list shows the loaded frames. Each row has:

| Column | Description |
|---|---|
| Time | The frame's capture time |
| Type tag | The frame's opcode (text, binary, close, ping, pong) |
| Content preview | First 60 chars for text frames; size for binary frames |
| Size | Frame payload bytes |
| Truncated chip | Shown when reassembly hit the 20 MiB capture cap (see below) |
| ▶ button | Replay (on active connections, shown on any frame with readable text — text frames and close frames carrying a reason) |

Click any row to see that frame's details on the right.

### Direction filter

Filter by direction using the top tabs:

| Option | Description |
|---|---|
| All | Show all messages |
| Sent (↑) | Only client → server messages |
| Received (↓) | Only server → client messages |

### Type filter

Filter by opcode using the second tab set:

| Option | Description |
|---|---|
| All | All types |
| Text | Text frames (including continuation frames) |
| Binary | Binary frames |
| Control | Control frames (close, ping, pong) |

### Search

Type a keyword in the search box to filter the currently loaded messages in real time. Search matches both message content (`payloadText`) and opcode. Note it only covers the loaded window described above — not the full database history of a long session.

### Oversized messages

A single WebSocket message is reassembled from its frames up to **20 MiB**; larger messages keep only the first 20 MiB. Those rows show a **Truncated** chip in the list, and the detail panel explains that only a prefix of the original payload was captured.

## Message detail

With a message selected, the right detail panel shows:

- **Frame meta card**: direction, opcode, FIN flag, timestamp, payload size
- **Format switch**: three display formats
  - **Text**: raw text
  - **JSON**: auto-detect and pretty-print JSON (only for JSON content)
  - **Hex**: hex dump view
- **Copy button**: copy the current format's content to the clipboard

## Connection status

The top-right of the message panel shows the current connection status:

- 🟢 **Active**: the WebSocket is still running; you can send messages
- ⚪ **Closed**: the connection is closed; Compose and Replay are unavailable

Status updates in real time — no page refresh needed.

## Replay

On an active connection you can replay an existing text message:

1. Find the message to replay in the list
2. Click the **▶** button on its row
3. The bottom compose panel auto-expands, pre-filled with that message's direction and content
4. Edit the content as needed
5. Click **Send**

Replayed messages are injected into the real connection through the proxy; the server treats them like normal messages. Injected messages also appear in the list, tagged `clientToServer` or `serverToClient`.

## Compose a custom message

Besides replaying, you can write a brand-new message and send it on a live connection:

1. Click the **✉** (Compose) button at the top-right of the message panel
2. The bottom compose panel expands
3. Choose the direction:
   - **Send to Server**: simulate a client message to the server
   - **Send to Client**: simulate a server message to the client
4. Choose the opcode: Text (default), Ping, Pong
5. Type the message content in the text box
6. Click **Send**

Notes:

- The Compose button is available only when the connection is "Active"
- Sent messages appear in the list immediately
- A send failure shows an error

## How it works

1. AIProxy intercepts WebSocket upgrades (`Upgrade: websocket`) inside HTTP/HTTPS requests
2. The proxy connects upstream, completes the handshake, and enters a bidirectional frame-relay mode
3. Each frame is parsed to extract direction, opcode, and payload, stored to the database, and pushed to the front end in real time
4. Active connections register into a global `WsConnectionRegistry`; the front end queries the registry for status
5. Replayed/injected messages enter the relay loop through an internal channel and are forwarded to the target direction like normal frames

This means:

- The proxy does not modify WebSocket message content — it only passes through and records
- Binary frames store only their size, not their actual content (to save storage)
- Injected messages are transparent to the server/client and indistinguishable from normal messages
- If no frame arrives for 5 minutes, the proxy closes the connection; a frame that stops mid-delivery must finish within 30 seconds or the connection is closed too. These timeouts keep dead connections from lingering forever.

## Supported protocols

| Protocol | Description |
|---|---|
| `ws://` | Plain WebSocket; intercepted via HTTP upgrade |
| `wss://` | Encrypted WebSocket; intercepted after HTTPS MITM decryption |

Prerequisite: `wss://` requires AIProxy's root CA certificate to be installed and trusted.

## FAQ

### Q: Why do some messages show only a size and no content?

Binary frames (opcode: binary) don't store their actual payload — only the byte count. To inspect binary content, consider converting the binary protocol to text with another tool.

### Q: The Compose button is grayed out?

Compose and Replay are available only while the WebSocket is "Active". If the connection is closed (status indicator is gray), these buttons disable automatically. Refresh the page to re-establish the WebSocket and try again.

### Q: Do replayed messages appear in the list?

Yes. All injected messages appear in the list through the normal capture flow; you can inspect their content and metadata like any other message.

### Q: Can I change a replayed message's direction?

Yes. In the compose panel opened by Replay, you can switch the direction to "Send to Server" or "Send to Client".

### Q: Does the search box only search the currently shown messages?

The search box filters client-side among the loaded window: the first 500 stored frames plus everything that arrived live while the pane is open. It doesn't query the session's full database history beyond that window.

### Q: Why did my long-lived connection get disconnected?

The proxy enforces idle timeouts to keep dead connections from lingering: if no frame arrives for 5 minutes the connection is closed, and a frame that stops mid-delivery must complete within 30 seconds. Keepalives (ping frames) from either side prevent the idle close.

### Q: How do I identify a WebSocket session in the list?

A WebSocket session has a WebSocket icon (droplet shape) in the session tree, the protocol column shows `ws` or `wss`, and the status code is `101` (Switching Protocols). You can also identify it by `responseMimeType: "websocket"`.

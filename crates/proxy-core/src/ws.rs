use crate::ProxyError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::time::timeout;

const MAX_WS_FRAME_SIZE: u64 = 16 * 1024 * 1024;
const WS_MASK_CHUNK_BYTES: usize = 16 * 1024;

/// Timeout for individual read operations during WebSocket frame parsing.
/// Prevents a malicious peer from stalling the relay by sending a header
/// that claims a large payload but never delivers the data.
const WS_FRAME_READ_TIMEOUT_SECS: u64 = 30;

/// Marker prefix used to tag `ProxyError::Other` messages produced by
/// `parse_ws_frame` for genuine RFC 6455 protocol violations (reserved
/// opcode, fragmented/oversized control frame, oversized payload, RSV bit
/// set without a negotiated extension, ...).
///
/// Read timeouts and clean EOF surface through different paths and do NOT
/// carry this marker, so the relay can distinguish them via
/// [`is_ws_protocol_error`].
const WS_PROTOCOL_ERROR_MARKER: &str = "ws protocol error:";

/// Build a tagged WS protocol-error so the relay can answer Close(1002).
fn ws_protocol_error(msg: impl Into<String>) -> ProxyError {
    ProxyError::Other(format!("{WS_PROTOCOL_ERROR_MARKER} {}", msg.into()))
}

/// Returns true when the error represents a clean stream EOF, i.e. the peer
/// closed the connection without framing a protocol violation. The relay
/// treats this as a normal end of the connection (no Close(1002) answer).
///
/// `read_exact` reports EOF as `std::io::ErrorKind::UnexpectedEof`; that error
/// is propagated by `parse_ws_frame` as `ProxyError::IoError`.
pub fn is_clean_eof(err: &ProxyError) -> bool {
    match err {
        ProxyError::IoError(io) => io.kind() == std::io::ErrorKind::UnexpectedEof,
        _ => false,
    }
}

/// Returns true when the error is a genuine RFC 6455 protocol violation
/// produced by `parse_ws_frame` (e.g. reserved opcode, fragmented/oversized
/// control frame, oversized payload, RSV bit set). Per RFC 6455 §7.4.1 the
/// relay must answer such a violation with a Close frame carrying status
/// code 1002 before dropping the connection.
///
/// Read timeouts (which become `ProxyError::Other("...timed out...")`) and
/// clean EOF are NOT protocol errors.
pub fn is_ws_protocol_error(err: &ProxyError) -> bool {
    matches!(err, ProxyError::Other(msg) if msg.starts_with(WS_PROTOCOL_ERROR_MARKER))
}

// ---------------------------------------------------------------------------
// WebSocket frame types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WsOpcode {
    Continuation = 0,
    Text = 1,
    Binary = 2,
    Close = 8,
    Ping = 9,
    Pong = 10,
}

impl WsOpcode {
    pub fn from_u8(v: u8) -> Self {
        match v {
            0 => WsOpcode::Continuation,
            1 => WsOpcode::Text,
            2 => WsOpcode::Binary,
            8 => WsOpcode::Close,
            9 => WsOpcode::Ping,
            10 => WsOpcode::Pong,
            _ => WsOpcode::Binary,
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            WsOpcode::Continuation => "continuation",
            WsOpcode::Text => "text",
            WsOpcode::Binary => "binary",
            WsOpcode::Close => "close",
            WsOpcode::Ping => "ping",
            WsOpcode::Pong => "pong",
        }
    }

    pub fn is_control(&self) -> bool {
        matches!(self, WsOpcode::Close | WsOpcode::Ping | WsOpcode::Pong)
    }
}

#[derive(Debug, Clone)]
pub struct WsFrame {
    pub fin: bool,
    pub opcode: WsOpcode,
    pub mask: bool,
    pub payload: Vec<u8>,
}

// ---------------------------------------------------------------------------
// Message reassembly (M1)
//
// A WebSocket message may be split across multiple frames: one start frame
// (opcode Text/Binary, FIN=0) followed by zero or more Continuation frames
// (opcode Continuation) and a final frame with FIN=1. Decoding each fragment
// independently as UTF-8 fails whenever a multibyte code point straddles a
// fragment boundary, and even on success it surfaces a partial fragment as if
// it were a complete message. `WsMessageAssembler` accumulates fragments per
// direction and emits a single `WsMessageData` for the whole message once the
// FIN frame arrives (control frames are never fragmented and pass through
// one-frame-per-message as before).
// ---------------------------------------------------------------------------

/// Cap on how many bytes a reassembled message may accumulate before we stop
/// buffering. Matches the captured-body ceiling used elsewhere; protects the
/// relay from a peer that fragments forever.
const MAX_REASSEMBLED_MESSAGE_BYTES: usize = 20 * 1024 * 1024;

/// State for reassembling a fragmented WebSocket message on one direction.
/// Control frames (Close/Ping/Pong) are emitted immediately and never touch
/// this state (they are always FIN=1 per RFC 6455 §5.5).
struct WsMessageAssembler {
    /// `Some(opcode)` when a fragmented message is in progress (opcode of the
    /// START frame); `None` when idle.
    start_opcode: Option<WsOpcode>,
    buffer: Vec<u8>,
}

impl WsMessageAssembler {
    const fn new() -> Self {
        Self {
            start_opcode: None,
            buffer: Vec::new(),
        }
    }

    /// Reset to idle (used on protocol violations / mid-message stream end).
    fn reset(&mut self) {
        self.start_opcode = None;
        self.buffer.clear();
    }
}

// ---------------------------------------------------------------------------
// Frame parsing (reading from async stream)
// ---------------------------------------------------------------------------

/// Read one WebSocket frame from an async stream.
/// Returns the parsed frame with unmasked payload.
/// Each read operation is guarded by a timeout to prevent a stalled peer
/// from blocking the relay loop indefinitely.
pub async fn parse_ws_frame<R: AsyncReadExt + Unpin>(
    reader: &mut R,
) -> Result<WsFrame, ProxyError> {
    let read_timeout = Duration::from_secs(WS_FRAME_READ_TIMEOUT_SECS);

    let mut head = [0u8; 2];
    timeout(read_timeout, reader.read_exact(&mut head))
        .await
        .map_err(|_| {
            ProxyError::Other(format!(
                "ws frame header read timed out ({WS_FRAME_READ_TIMEOUT_SECS}s)"
            ))
        })?
        .map_err(ProxyError::IoError)?;

    let fin = (head[0] & 0x80) != 0;
    // RFC 6455 §5.2: RSV1/RSV2/RSV3 MUST be zero unless an extension
    // negotiated during the opening handshake gives meaning. AIProxy does not
    // negotiate WS extensions, so any set RSV bit is a protocol violation
    // (close code 1002).
    let rsv_bits = head[0] & 0x70;
    if rsv_bits != 0 {
        return Err(ws_protocol_error(format!(
            "RSV bit(s) set (0x{rsv_bits:02x}) without negotiated extension"
        )));
    }
    let opcode_raw = head[0] & 0x0F;
    // RFC 6455 §5.2: opcodes 3-7 and 11-15 are reserved and MUST fail the
    // connection (close code 1002). The previous `from_u8` silently mapped
    // them to Binary, letting malformed/reserved frames pass through the relay.
    if (3..=7).contains(&opcode_raw) || (11..=15).contains(&opcode_raw) {
        return Err(ws_protocol_error(format!(
            "frame uses reserved opcode {opcode_raw}"
        )));
    }
    let opcode = WsOpcode::from_u8(opcode_raw);
    let mask = (head[1] & 0x80) != 0;
    let mut payload_len = (head[1] & 0x7F) as u64;

    // RFC 6455 §5.5: control frames (close/ping/pong) MUST have FIN=1 and a
    // payload no longer than 125 bytes. A malicious/buggy peer sending a
    // fragmented or oversized control frame would otherwise corrupt relay state.
    if opcode.is_control() {
        if !fin {
            return Err(ws_protocol_error(
                "control frame must not be fragmented (FIN=1 required)",
            ));
        }
        if payload_len > 125 {
            return Err(ws_protocol_error(format!(
                "control frame payload length {payload_len} exceeds 125-byte limit"
            )));
        }
    }

    if payload_len == 126 {
        let mut ext = [0u8; 2];
        timeout(read_timeout, reader.read_exact(&mut ext))
            .await
            .map_err(|_| {
                ProxyError::Other(format!(
                    "ws extended length read timed out ({WS_FRAME_READ_TIMEOUT_SECS}s)"
                ))
            })?
            .map_err(ProxyError::IoError)?;
        payload_len = u16::from_be_bytes(ext) as u64;
    } else if payload_len == 127 {
        let mut ext = [0u8; 8];
        timeout(read_timeout, reader.read_exact(&mut ext))
            .await
            .map_err(|_| {
                ProxyError::Other(format!(
                    "ws extended length read timed out ({WS_FRAME_READ_TIMEOUT_SECS}s)"
                ))
            })?
            .map_err(ProxyError::IoError)?;
        payload_len = u64::from_be_bytes(ext);
    }

    if payload_len > MAX_WS_FRAME_SIZE {
        return Err(ws_protocol_error(format!(
            "payload length {payload_len} exceeds limit {MAX_WS_FRAME_SIZE}"
        )));
    }

    let mut mask_key = [0u8; 4];
    if mask {
        timeout(read_timeout, reader.read_exact(&mut mask_key))
            .await
            .map_err(|_| {
                ProxyError::Other(format!(
                    "ws mask key read timed out ({WS_FRAME_READ_TIMEOUT_SECS}s)"
                ))
            })?
            .map_err(ProxyError::IoError)?;
    }

    let payload_len = usize::try_from(payload_len)
        .map_err(|_| ws_protocol_error("payload length does not fit in usize"))?;
    let mut payload = vec![0u8; payload_len];
    if payload_len > 0 {
        timeout(read_timeout, reader.read_exact(&mut payload))
            .await
            .map_err(|_| {
                ProxyError::Other(format!(
                    "ws payload read timed out ({WS_FRAME_READ_TIMEOUT_SECS}s)"
                ))
            })?
            .map_err(ProxyError::IoError)?;
    }

    if mask {
        for (i, byte) in payload.iter_mut().enumerate() {
            *byte ^= mask_key[i % 4];
        }
    }

    Ok(WsFrame {
        fin,
        opcode,
        mask: false, // payload is now unmasked
        payload,
    })
}

// ---------------------------------------------------------------------------
// Frame writing (writing to async stream)
// ---------------------------------------------------------------------------

/// Write one WebSocket frame to an async stream.
/// Frames sent to the client are NOT masked (server-to-client).
/// Frames sent to the upstream server ARE masked (client-to-server simulation).
pub async fn write_ws_frame<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    frame: &WsFrame,
    mask_output: bool,
) -> Result<(), ProxyError> {
    let mut head = [0u8; 2];

    if frame.fin {
        head[0] |= 0x80;
    }
    head[0] |= frame.opcode as u8;

    let payload_len = frame.payload.len();
    let mask_bit: u8 = if mask_output { 0x80 } else { 0 };

    if payload_len < 126 {
        head[1] = mask_bit | payload_len as u8;
        writer.write_all(&head).await.map_err(ProxyError::IoError)?;
    } else if payload_len <= 65535 {
        head[1] = mask_bit | 126;
        writer.write_all(&head).await.map_err(ProxyError::IoError)?;
        writer
            .write_all(&(payload_len as u16).to_be_bytes())
            .await
            .map_err(ProxyError::IoError)?;
    } else {
        head[1] = mask_bit | 127;
        writer.write_all(&head).await.map_err(ProxyError::IoError)?;
        writer
            .write_all(&(payload_len as u64).to_be_bytes())
            .await
            .map_err(ProxyError::IoError)?;
    }

    if mask_output {
        let mask_key = rand::random::<[u8; 4]>();
        writer
            .write_all(&mask_key)
            .await
            .map_err(ProxyError::IoError)?;
        let mut offset = 0;
        let mut masked_chunk = vec![0u8; WS_MASK_CHUNK_BYTES.min(frame.payload.len().max(1))];
        while offset < frame.payload.len() {
            let end = (offset + masked_chunk.len()).min(frame.payload.len());
            let chunk = &frame.payload[offset..end];
            for (i, byte) in chunk.iter().enumerate() {
                masked_chunk[i] = *byte ^ mask_key[(offset + i) % 4];
            }
            writer
                .write_all(&masked_chunk[..chunk.len()])
                .await
                .map_err(ProxyError::IoError)?;
            offset = end;
        }
    } else {
        writer
            .write_all(&frame.payload)
            .await
            .map_err(ProxyError::IoError)?;
    }

    writer.flush().await.map_err(ProxyError::IoError)?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Message data (emitted per-frame to the session layer)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsMessageData {
    pub id: String,
    pub session_id: String,
    pub direction: String,
    pub timestamp: String,
    pub opcode: String,
    pub payload_text: Option<String>,
    pub payload_size: usize,
    pub fin: bool,
}

/// Direction of a WebSocket message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WsDirection {
    ClientToServer,
    ServerToClient,
}

impl WsDirection {
    pub fn label(&self) -> &'static str {
        match self {
            WsDirection::ClientToServer => "clientToServer",
            WsDirection::ServerToClient => "serverToClient",
        }
    }
}

/// Build a WsMessageData from a parsed frame.
///
/// NOTE: this decodes the frame as a self-contained message. For a fragmented
/// message (Text/Binary start frame + Continuation frames) the relay uses
/// [`assemble_ws_message`] instead so that the text is decoded from the full
/// reassembled payload, not per-fragment (M1). This direct constructor remains
/// the right choice for control frames and for injected frames (which carry
/// their own start/FIN semantics).
pub fn build_ws_message(
    session_id: &str,
    direction: WsDirection,
    frame: &WsFrame,
) -> WsMessageData {
    build_ws_message_raw(
        session_id,
        direction,
        frame.opcode,
        &frame.payload,
        frame.fin,
    )
}

/// Build a `WsMessageData` from explicit opcode/payload/fin. Shared by the
/// per-frame constructor ([`build_ws_message`]) and the reassembled-message
/// path ([`assemble_ws_message`]).
fn build_ws_message_raw(
    session_id: &str,
    direction: WsDirection,
    opcode: WsOpcode,
    payload: &[u8],
    fin: bool,
) -> WsMessageData {
    let payload_text = if opcode == WsOpcode::Text {
        String::from_utf8(payload.to_vec()).ok()
    } else if opcode == WsOpcode::Close && !payload.is_empty() {
        // Close frame: first 2 bytes are status code, rest is reason
        if payload.len() > 2 {
            String::from_utf8(payload[2..].to_vec()).ok()
        } else {
            None
        }
    } else {
        None
    };

    WsMessageData {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        direction: direction.label().to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        opcode: opcode.label().to_string(),
        payload_text,
        payload_size: payload.len(),
        fin,
    }
}

/// Feed one data frame into the assembler and return the reassembled message to
/// emit, if any.
///
/// - A START frame (Text/Binary) with FIN=1 → emit immediately (single-frame
///   message; the common case).
/// - A START frame with FIN=0 → begin buffering; emit nothing.
/// - A Continuation frame with FIN=0 → append; emit nothing.
/// - A Continuation frame with FIN=1 → append and emit the whole message using
///   the START frame's opcode (so a fragmented Text message decodes as Text).
///
/// Protocol violations (a Continuation with no message in progress, a START
/// frame while a message is in progress, or exceeding the reassembly cap) reset
/// the assembler and emit a best-effort single-frame message for the offending
/// frame so the capture is not silently dropped.
fn assemble_ws_message(
    session_id: &str,
    direction: WsDirection,
    frame: &WsFrame,
    assembler: &mut WsMessageAssembler,
) -> WsMessageData {
    // Control frames are never fragmented: emit one-frame-per-message and do
    // not touch the in-progress reassembly (RFC 6455 §5.4 allows control frames
    // to be interleaved between data fragments).
    if frame.opcode.is_control() {
        return build_ws_message(session_id, direction, frame);
    }

    match frame.opcode {
        WsOpcode::Text | WsOpcode::Binary => {
            if assembler.start_opcode.is_some() {
                // A new START frame arrived mid-message: protocol violation.
                // Reset and emit this frame standalone.
                tracing::warn!(
                    event = "ws_fragment_unexpected_start",
                    session_id = %session_id,
                    "ws_fragment_unexpected_start"
                );
                assembler.reset();
                return build_ws_message(session_id, direction, frame);
            }
            if frame.fin {
                // Unfragmented message: emit directly, no buffering needed.
                return build_ws_message(session_id, direction, frame);
            }
            // Fragmented start: begin buffering.
            assembler.start_opcode = Some(frame.opcode);
            assembler.buffer.clear();
            if frame.payload.len() <= MAX_REASSEMBLED_MESSAGE_BYTES {
                assembler.buffer.extend_from_slice(&frame.payload);
            }
            // Emit an intermediate capture so the UI shows the fragment with
            // FIN=false; the final reassembled message is emitted on FIN.
            build_ws_message(session_id, direction, frame)
        }
        WsOpcode::Continuation => {
            let Some(start_opcode) = assembler.start_opcode else {
                // Continuation without a start frame: protocol violation.
                tracing::warn!(
                    event = "ws_fragment_continuation_without_start",
                    session_id = %session_id,
                    "ws_fragment_continuation_without_start"
                );
                return build_ws_message(session_id, direction, frame);
            };
            if assembler.buffer.len() + frame.payload.len()
                <= MAX_REASSEMBLED_MESSAGE_BYTES
            {
                assembler.buffer.extend_from_slice(&frame.payload);
            }
            if frame.fin {
                // Final fragment: emit the whole reassembled message under the
                // START frame's opcode so multi-byte UTF-8 decodes correctly.
                let message = build_ws_message_raw(
                    session_id,
                    direction,
                    start_opcode,
                    &assembler.buffer,
                    true,
                );
                assembler.reset();
                message
            } else {
                // Intermediate continuation: emit the fragment with FIN=false.
                build_ws_message(session_id, direction, frame)
            }
        }
        // Control frames were handled above; this is unreachable.
        _ => build_ws_message(session_id, direction, frame),
    }
}

/// Reconstruct raw frame bytes from a WsFrame for forwarding.
/// This writes the frame in its original form (unmasked) for relay.
pub async fn forward_raw_frame<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    frame: &WsFrame,
) -> Result<(), ProxyError> {
    // Server-to-client frames are never masked
    write_ws_frame(writer, frame, false).await
}

// ---------------------------------------------------------------------------
// Injection support (replay into active connections)
// ---------------------------------------------------------------------------

/// Request to inject a frame into an active WS connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsInjectRequest {
    pub direction: WsDirection,
    pub opcode: WsOpcode,
    pub payload: String,
    pub fin: bool,
}

/// Connection status for a WS session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WsConnectionStatus {
    Active,
    Closed,
}

struct WsConnectionEntry {
    inject_sender: mpsc::Sender<WsInjectRequest>,
    status: WsConnectionStatus,
}

/// Capacity of the per-session WS inject channel (M5). Bounded so a fast or
/// misbehaving injector cannot drive the relay task's memory without
/// backpressure. 64 frames is ample headroom for interactive replay; an inject
/// that would overflow returns a clear error to the caller instead of queuing
/// indefinitely.
pub(crate) const WS_INJECT_CHANNEL_CAPACITY: usize = 64;

/// Global registry of active WS connections, keyed by session_id.
pub struct WsConnectionRegistry {
    connections: Mutex<HashMap<String, WsConnectionEntry>>,
}

impl Default for WsConnectionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl WsConnectionRegistry {
    pub fn new() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
        }
    }

    pub fn register(&self, session_id: String, sender: mpsc::Sender<WsInjectRequest>) {
        let mut map = self.connections.lock().unwrap_or_else(|e| e.into_inner());
        if map.contains_key(&session_id) {
            tracing::warn!(
                event = "ws_registry_duplicate_session",
                session_id = %session_id,
                "ws_registry_duplicate_session"
            );
        }
        map.insert(
            session_id,
            WsConnectionEntry {
                inject_sender: sender,
                status: WsConnectionStatus::Active,
            },
        );
    }

    pub fn mark_closed(&self, session_id: &str) {
        let mut map = self.connections.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get_mut(session_id) {
            entry.status = WsConnectionStatus::Closed;
        }
    }

    pub fn unregister(&self, session_id: &str) {
        let mut map = self.connections.lock().unwrap_or_else(|e| e.into_inner());
        map.remove(session_id);
    }

    pub fn get_status(&self, session_id: &str) -> WsConnectionStatus {
        let map = self.connections.lock().unwrap_or_else(|e| e.into_inner());
        map.get(session_id)
            .map(|e| e.status)
            .unwrap_or(WsConnectionStatus::Closed)
    }

    pub fn inject(&self, session_id: &str, request: WsInjectRequest) -> Result<(), ProxyError> {
        let map = self.connections.lock().unwrap_or_else(|e| e.into_inner());
        let entry = map.get(session_id).ok_or_else(|| {
            ProxyError::Other(format!(
                "WebSocket session {} is not active or does not exist",
                session_id
            ))
        })?;
        if entry.status != WsConnectionStatus::Active {
            return Err(ProxyError::Other(format!(
                "WebSocket session {} is closed",
                session_id
            )));
        }
        // M5: `try_send` is non-blocking and returns a clear error when the
        // bounded inject channel is full, instead of growing it without bound.
        // A full queue means the relay is draining slower than injects arrive;
        // surface that to the caller rather than buffering unbounded memory.
        entry.inject_sender.try_send(request).map_err(|e| {
            ProxyError::Other(format!("Failed to inject frame: {e}"))
        })
    }
}

static WS_REGISTRY: OnceLock<WsConnectionRegistry> = OnceLock::new();

pub fn global_ws_registry() -> &'static WsConnectionRegistry {
    WS_REGISTRY.get_or_init(WsConnectionRegistry::new)
}

// ---------------------------------------------------------------------------
// Frame relay with injection support
// ---------------------------------------------------------------------------

/// Build a Close control frame carrying the given RFC 6455 status code.
/// Used to answer a protocol violation (e.g. code 1002) before dropping a peer.
fn close_frame(code: u16) -> WsFrame {
    WsFrame {
        fin: true,
        opcode: WsOpcode::Close,
        mask: false,
        payload: code.to_be_bytes().to_vec(),
    }
}

/// Relay WebSocket frames between client and upstream until the connection closes.
/// Emits each parsed frame as a WsMessageData via the sender.
/// Accepts an injection receiver for replaying frames into the connection.
///
/// Error handling per RFC 6455:
/// - A clean stream EOF from a peer is a normal close (relay just ends).
/// - A genuine protocol violation (reserved opcode, fragmented/oversized
///   control frame, oversized payload, RSV bit set without an extension) is
///   answered with a Close frame carrying status code 1002 before the relay
///   ends, instead of being silently dropped.
/// - Read timeouts are NOT treated as protocol errors (the peer may simply be
///   slow); the relay just ends.
///
/// Close handling (H9):
/// - When either side sends a Close frame, the relay forwards it, shuts down
///   the peer's writer (so a compliant peer sees the close and echoes one
///   back), and arms a close-grace deadline (`ws_close_grace_timeout()`).
/// - If the peer never echoes a Close (non-compliant server, packet loss,
///   half-closed connection) the grace deadline fires and the relay force-
///   terminates, preventing an unbounded `parse_ws_frame` wait and TCP leak.
/// - The grace deadline is also armed on a stream end (EOF/protocol error/
///   timeout) so a peer that stays silent after one side ends cannot pin the
///   relay either. The normal both-sides-close path still exits immediately
///   when both sides are done.
pub async fn relay_websocket_frames<C, U>(
    client_stream: &mut C,
    upstream_stream: &mut U,
    session_id: &str,
    ws_sender: &mpsc::Sender<WsMessageData>,
    inject_rx: &mut mpsc::Receiver<WsInjectRequest>,
) where
    C: AsyncReadExt + AsyncWriteExt + Unpin,
    U: AsyncReadExt + AsyncWriteExt + Unpin,
{
    let mut client_done = false;
    let mut upstream_done = false;
    // Per-direction message reassembly (M1): accumulate fragmented Text/Binary
    // messages so the final FIN frame decodes the whole payload as one message
    // instead of decoding each Continuation fragment in isolation.
    let mut client_assembler = WsMessageAssembler::new();
    let mut upstream_assembler = WsMessageAssembler::new();
    // Once the injection channel is closed it will keep returning `None`, which
    // would busy-spin the select! loop. Track it so we stop polling it.
    let mut inject_closed = false;
    // H9: once a Close frame has been seen from either side, arm a grace
    // deadline. A compliant peer echoes a Close back and the loop exits via
    // the normal both-done path. A non-compliant / half-closed / packet-losing
    // peer that never closebacks would otherwise leave the relay blocked on
    // `parse_ws_frame` forever (TCP leak). When the grace elapses we force the
    // loop to terminate.
    let close_grace = crate::ws_close_grace_timeout();
    let mut close_grace_deadline: Option<tokio::time::Instant> = None;

    loop {
        if client_done && upstream_done {
            break;
        }

        // Snapshot the grace deadline for this iteration so the select! branch
        // can poll it (or stay pending if no Close has been seen yet).
        let grace_wait = async {
            match close_grace_deadline {
                Some(deadline) => {
                    let now = tokio::time::Instant::now();
                    if now >= deadline {
                        return;
                    }
                    tokio::time::sleep_until(deadline).await;
                }
                None => {
                    // No Close seen yet: never fire.
                    std::future::pending::<()>().await;
                }
            }
        };

        tokio::select! {
            // H9: close-grace expired — force-terminate even if the peer never
            // closebacks. Log at debug (not warn) because this is the expected
            // recovery path for non-compliant peers.
            _ = grace_wait => {
                tracing::debug!(
                    event = "ws_relay_close_grace_expired",
                    session_id = %session_id,
                    grace_ms = close_grace.as_millis() as u64,
                    client_done,
                    upstream_done,
                    "ws_relay_close_grace_expired"
                );
                break;
            }
            client_result = async {
                if client_done {
                    std::future::pending::<Option<Result<WsFrame, ProxyError>>>().await;
                    return None;
                }
                Some(parse_ws_frame(client_stream).await)
            } => {
                match client_result {
                    Some(Ok(frame)) => {
                        let msg = assemble_ws_message(
                            session_id,
                            WsDirection::ClientToServer,
                            &frame,
                            &mut client_assembler,
                        );
                        let _ = ws_sender.send(msg).await;

                        if frame.opcode == WsOpcode::Close {
                            // Legitimate Close from the client: forward as-is.
                            let _ = forward_raw_frame(upstream_stream, &frame).await;
                            client_done = true;
                            // H9: shutdown the upstream write side so a compliant
                            // upstream sees its peer close and echoes a Close
                            // back. Arm the grace deadline to bound the wait for
                            // non-compliant upstreams.
                            let _ = upstream_stream.shutdown().await;
                            if close_grace_deadline.is_none() {
                                close_grace_deadline =
                                    Some(tokio::time::Instant::now() + close_grace);
                            }
                        } else {
                            // Forward to upstream masked per RFC 6455 §5.1 (proxy acts as client to upstream)
                            if let Err(e) = write_ws_frame(upstream_stream, &frame, true).await {
                                tracing::debug!(event = "ws_relay_client_to_upstream_write_failed", error = %e, "ws_relay_client_to_upstream_write_failed");
                                break;
                            }
                        }
                    }
                    Some(Err(e)) => {
                        // H10: distinguish clean EOF from protocol violations.
                        // Clean EOF → normal end. Protocol error → answer Close(1002)
                        // to the violating peer (client). Timeouts/other errors → end.
                        if is_ws_protocol_error(&e) {
                            tracing::debug!(
                                event = "ws_relay_client_protocol_error",
                                session_id = %session_id,
                                error = %e,
                                "answering Close(1002) to client for protocol violation"
                            );
                            let _ = write_ws_frame(client_stream, &close_frame(1002), false).await;
                        }
                        client_done = true;
                        // A stream ending (EOF/protocol error/timeout) is itself a
                        // terminal signal from this side; arm the grace so a peer
                        // that never closes cannot pin the relay.
                        if close_grace_deadline.is_none() {
                            close_grace_deadline =
                                Some(tokio::time::Instant::now() + close_grace);
                        }
                    }
                    None => {}
                }
            }
            upstream_result = async {
                if upstream_done {
                    std::future::pending::<Option<Result<WsFrame, ProxyError>>>().await;
                    return None;
                }
                Some(parse_ws_frame(upstream_stream).await)
            } => {
                match upstream_result {
                    Some(Ok(frame)) => {
                        let msg = assemble_ws_message(
                            session_id,
                            WsDirection::ServerToClient,
                            &frame,
                            &mut upstream_assembler,
                        );
                        let _ = ws_sender.send(msg).await;

                        if frame.opcode == WsOpcode::Close {
                            // Legitimate Close from the upstream: forward as-is.
                            let _ = forward_raw_frame(client_stream, &frame).await;
                            upstream_done = true;
                            // H9: shutdown the client write side so a compliant
                            // client echoes a Close back. Arm the grace deadline
                            // to bound the wait for non-compliant clients.
                            let _ = client_stream.shutdown().await;
                            if close_grace_deadline.is_none() {
                                close_grace_deadline =
                                    Some(tokio::time::Instant::now() + close_grace);
                            }
                        } else {
                            if let Err(e) = forward_raw_frame(client_stream, &frame).await {
                                tracing::debug!(event = "ws_relay_upstream_to_client_write_failed", error = %e, "ws_relay_upstream_to_client_write_failed");
                                break;
                            }
                        }
                    }
                    Some(Err(e)) => {
                        // H10: distinguish clean EOF from protocol violations.
                        // Protocol error from upstream → answer Close(1002) to
                        // upstream (masked, since the proxy acts as its client).
                        // Timeouts/other errors → end.
                        if is_ws_protocol_error(&e) {
                            tracing::debug!(
                                event = "ws_relay_upstream_protocol_error",
                                session_id = %session_id,
                                error = %e,
                                "answering Close(1002) to upstream for protocol violation"
                            );
                            let _ = write_ws_frame(upstream_stream, &close_frame(1002), true).await;
                        }
                        upstream_done = true;
                        if close_grace_deadline.is_none() {
                            close_grace_deadline =
                                Some(tokio::time::Instant::now() + close_grace);
                        }
                    }
                    None => {}
                }
            }
            inject_result = async {
                if inject_closed {
                    std::future::pending::<Option<WsInjectRequest>>().await;
                    return None;
                }
                inject_rx.recv().await
            }, if !inject_closed => {
                match inject_result {
                    Some(req) => {
                        let frame = WsFrame {
                            fin: req.fin,
                            opcode: req.opcode,
                            mask: false,
                            payload: req.payload.into_bytes(),
                        };
                        let write_result = match req.direction {
                            WsDirection::ClientToServer => {
                                write_ws_frame(upstream_stream, &frame, true).await
                            }
                            WsDirection::ServerToClient => {
                                write_ws_frame(client_stream, &frame, false).await
                            }
                        };
                        if let Err(e) = write_result {
                            tracing::debug!(event = "ws_inject_write_failed", error = %e, "ws_inject_write_failed");
                            break;
                        }
                        let msg = build_ws_message(session_id, req.direction, &frame);
                        let _ = ws_sender.send(msg).await;
                    }
                    None => {
                        // Injection channel closed; stop listening for injects
                        // so the closed receiver does not busy-spin the loop.
                        inject_closed = true;
                    }
                }
            }
        }
    }

    tracing::debug!(
        event = "ws_relay_ended",
        session_id = %session_id,
        "ws_relay_ended"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opcode_round_trip() {
        assert_eq!(WsOpcode::from_u8(1), WsOpcode::Text);
        assert_eq!(WsOpcode::from_u8(2), WsOpcode::Binary);
        assert_eq!(WsOpcode::from_u8(8), WsOpcode::Close);
        assert_eq!(WsOpcode::from_u8(9), WsOpcode::Ping);
        assert_eq!(WsOpcode::from_u8(10), WsOpcode::Pong);
    }

    #[test]
    fn build_ws_message_text() {
        let frame = WsFrame {
            fin: true,
            opcode: WsOpcode::Text,
            mask: false,
            payload: b"hello world".to_vec(),
        };
        let msg = build_ws_message("sess-1", WsDirection::ClientToServer, &frame);
        assert_eq!(msg.opcode, "text");
        assert_eq!(msg.payload_text, Some("hello world".to_string()));
        assert_eq!(msg.payload_size, 11);
        assert!(msg.fin);
        assert_eq!(msg.direction, "clientToServer");
    }

    // M1: a fragmented Text message split across a multi-byte UTF-8 boundary
    // must be reassembled and decoded as a single message. Per-fragment decoding
    // would fail (the fragment straddling the code point is invalid UTF-8) and
    // yield payload_text = None.
    #[test]
    fn reassembles_fragmented_text_across_multibyte_boundary() {
        let mut assembler = WsMessageAssembler::new();
        // "héllo" — 'é' is U+00E9, encoded as 0xC3 0xA9 (2 bytes).
        let full = "héllo";
        let bytes = full.as_bytes();
        // Split inside the multi-byte sequence: [h, 0xC3] | [0xA9, l, l, o]
        let frag1 = &bytes[..2]; // "h" + first byte of é — invalid UTF-8 alone
        let frag2 = &bytes[2..]; // second byte of é + "llo" — invalid UTF-8 alone

        let start = WsFrame {
            fin: false,
            opcode: WsOpcode::Text,
            mask: false,
            payload: frag1.to_vec(),
        };
        let intermediate = assemble_ws_message(
            "sess-1",
            WsDirection::ServerToClient,
            &start,
            &mut assembler,
        );
        // Start fragment (FIN=false): emitted standalone; its bytes are not
        // valid UTF-8 so payload_text is None — that's expected for a fragment.
        assert!(!intermediate.fin);
        assert_eq!(intermediate.payload_text, None);

        let cont = WsFrame {
            fin: true,
            opcode: WsOpcode::Continuation,
            mask: false,
            payload: frag2.to_vec(),
        };
        let final_msg =
            assemble_ws_message("sess-1", WsDirection::ServerToClient, &cont, &mut assembler);

        // The FIN frame carries the fully reassembled, correctly-decoded message.
        assert!(final_msg.fin);
        assert_eq!(final_msg.opcode, "text");
        assert_eq!(final_msg.payload_text, Some(full.to_string()));
        assert_eq!(final_msg.payload_size, full.len());
        // Assembler returned to idle.
        assert!(assembler.start_opcode.is_none());
    }

    // M1: a single (unfragmented) Text frame still emits directly with no
    // buffering — the common case must not regress.
    #[test]
    fn unfragmented_text_emits_directly() {
        let mut assembler = WsMessageAssembler::new();
        let frame = WsFrame {
            fin: true,
            opcode: WsOpcode::Text,
            mask: false,
            payload: b"hello".to_vec(),
        };
        let msg = assemble_ws_message("sess-1", WsDirection::ClientToServer, &frame, &mut assembler);
        assert!(msg.fin);
        assert_eq!(msg.payload_text, Some("hello".to_string()));
        assert!(assembler.start_opcode.is_none());
        assert!(assembler.buffer.is_empty());
    }

    // M1: control frames (Close) are never fragmented and pass through
    // unchanged even while a data message is mid-reassembly.
    #[test]
    fn control_frame_passes_through_during_fragmentation() {
        let mut assembler = WsMessageAssembler::new();
        // Start a fragmented Text message.
        let start = WsFrame {
            fin: false,
            opcode: WsOpcode::Text,
            mask: false,
            payload: b"part1".to_vec(),
        };
        let _ = assemble_ws_message("sess-1", WsDirection::ServerToClient, &start, &mut assembler);
        assert!(assembler.start_opcode.is_some());

        // A Close frame arrives interleaved — must emit standalone and NOT reset
        // the in-progress data reassembly.
        let close = WsFrame {
            fin: true,
            opcode: WsOpcode::Close,
            mask: false,
            payload: vec![0x03, 0xE8], // 1000
        };
        let close_msg =
            assemble_ws_message("sess-1", WsDirection::ServerToClient, &close, &mut assembler);
        assert_eq!(close_msg.opcode, "close");
        // Reassembly state is untouched by the control frame.
        assert!(assembler.start_opcode.is_some());
    }

    #[test]
    fn build_ws_message_binary() {
        let frame = WsFrame {
            fin: true,
            opcode: WsOpcode::Binary,
            mask: false,
            payload: vec![0x00, 0x01, 0x02],
        };
        let msg = build_ws_message("sess-1", WsDirection::ServerToClient, &frame);
        assert_eq!(msg.opcode, "binary");
        assert!(msg.payload_text.is_none());
        assert_eq!(msg.payload_size, 3);
    }

    #[tokio::test]
    async fn write_and_parse_frame_small() {
        let frame = WsFrame {
            fin: true,
            opcode: WsOpcode::Text,
            mask: false,
            payload: b"hello".to_vec(),
        };

        let mut buf = Vec::new();
        write_ws_frame(&mut buf, &frame, false).await.unwrap();

        let mut cursor = std::io::Cursor::new(buf);
        let parsed = parse_ws_frame(&mut cursor).await.unwrap();

        assert!(parsed.fin);
        assert_eq!(parsed.opcode, WsOpcode::Text);
        assert_eq!(parsed.payload, b"hello");
    }

    #[tokio::test]
    async fn write_and_parse_frame_medium() {
        let payload = vec![0xABu8; 200];
        let frame = WsFrame {
            fin: true,
            opcode: WsOpcode::Binary,
            mask: false,
            payload,
        };

        let mut buf = Vec::new();
        write_ws_frame(&mut buf, &frame, false).await.unwrap();

        let mut cursor = std::io::Cursor::new(buf);
        let parsed = parse_ws_frame(&mut cursor).await.unwrap();

        assert_eq!(parsed.payload.len(), 200);
        assert!(parsed.payload.iter().all(|&b| b == 0xAB));
    }

    // ----- H10: parse_ws_frame must distinguish clean EOF from protocol errors -----

    #[tokio::test]
    async fn parse_ws_frame_eof_is_clean_close() {
        // Empty stream → EOF, not a protocol violation.
        let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
        let result = parse_ws_frame(&mut cursor).await;
        assert!(
            result.is_err(),
            "EOF must surface as Err so the relay can treat it as a clean close"
        );
        let err = result.unwrap_err();
        assert!(
            is_clean_eof(&err),
            "EOF must be classified as clean EOF, got {:?}",
            err
        );
        assert!(
            !is_ws_protocol_error(&err),
            "EOF must NOT be classified as a WS protocol error"
        );
    }

    #[tokio::test]
    async fn parse_ws_frame_eof_from_partial_header_is_clean_close() {
        // A single byte (incomplete header) also yields UnexpectedEof from
        // read_exact, which is a clean close, not a protocol violation.
        let mut cursor = std::io::Cursor::new(vec![0x81u8]);
        let result = parse_ws_frame(&mut cursor).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            is_clean_eof(&err),
            "partial-header EOF must be classified as clean EOF, got {:?}",
            err
        );
    }

    #[tokio::test]
    async fn parse_ws_frame_reserved_opcode_is_protocol_error() {
        // FIN=1, RSV bits clear, reserved opcode 0x03 → exercises the
        // opcode-3-7 branch in parse_ws_frame (RFC 6455 §5.2). RSV bits MUST be
        // clear here so the RSV-bit check returns first; otherwise this test
        // would exit on the RSV path and never reach the opcode-3-7 branch.
        // Bytes: [0x83, 0x00] (FIN=1, opcode=3 reserved, len=0).
        let bytes = vec![0b1000_0011u8, 0x00];
        let mut cursor = std::io::Cursor::new(bytes);
        let result = parse_ws_frame(&mut cursor).await;
        assert!(result.is_err(), "reserved opcode must error");
        let err = result.unwrap_err();
        assert!(
            is_ws_protocol_error(&err),
            "reserved opcode must be a WS protocol error, got {:?}",
            err
        );
        assert!(
            !is_clean_eof(&err),
            "protocol error must NOT be classified as clean EOF"
        );
    }

    #[tokio::test]
    async fn parse_ws_frame_fragmented_control_is_protocol_error() {
        // FIN=0, opcode=9 (Ping) → fragmented control frame, protocol violation.
        let bytes = vec![0b0000_1001u8, 0x00];
        let mut cursor = std::io::Cursor::new(bytes);
        let result = parse_ws_frame(&mut cursor).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            is_ws_protocol_error(&err),
            "fragmented control frame must be a WS protocol error, got {:?}",
            err
        );
    }

    #[tokio::test]
    async fn parse_ws_frame_oversized_control_is_protocol_error() {
        // FIN=1, opcode=9 (Ping), len=126 (extended, > 125) → oversized control.
        let bytes = vec![0b1000_1001u8, 126, 0x00, 0x80]; // len = 128
        let mut cursor = std::io::Cursor::new(bytes);
        let result = parse_ws_frame(&mut cursor).await;
        // Either errors as protocol error (length check) or as clean EOF
        // (can't read 128 payload bytes). The length check happens before the
        // payload read, so it must be the protocol error.
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            is_ws_protocol_error(&err),
            "oversized control frame must be a WS protocol error, got {:?}",
            err
        );
    }

    #[tokio::test]
    async fn parse_ws_frame_rsv_bit_set_is_protocol_error() {
        // FIN=1, RSV1=1, opcode=0x01 (Text), len=0 → RSV1 set without extension.
        // RFC 6455 §5.2: a reserved bit set without negotiation is a protocol
        // error. This test documents/drives the RSV validation.
        let bytes = vec![0b1100_0001u8, 0x00];
        let mut cursor = std::io::Cursor::new(bytes);
        let result = parse_ws_frame(&mut cursor).await;
        assert!(result.is_err(), "RSV1 set without extension must error");
        let err = result.unwrap_err();
        assert!(
            is_ws_protocol_error(&err),
            "RSV bit set must be a WS protocol error, got {:?}",
            err
        );
    }

    // ----- H10: relay answers Close(1002) on protocol error, not on clean EOF -----

    /// Read exactly the bytes of one small unmasked WS frame and parse it.
    async fn read_one_frame<R: AsyncReadExt + Unpin>(reader: &mut R) -> WsFrame {
        parse_ws_frame(reader).await.expect("expected a frame")
    }

    #[tokio::test]
    async fn relay_answers_close_1002_on_client_protocol_error() {
        // The relay reads `client_inner`; data it reads comes from writes on the
        // paired `client_outer`. Writes by the relay onto `client_inner` are
        // observable by reading `client_outer`.
        let (mut client_outer, mut client_inner) = tokio::io::duplex(64);
        let (mut upstream_outer, mut upstream_inner) = tokio::io::duplex(64);

        // Feed a reserved-opcode frame from the client, then close the client
        // write side so the relay's next read hits clean EOF.
        client_outer.write_all(&[0b1000_0011u8, 0x00]).await.unwrap();
        client_outer.shutdown().await.unwrap();
        // Upstream writes nothing; close its write side so the relay's upstream
        // read hits clean EOF and upstream_done flips.
        upstream_outer.shutdown().await.unwrap();

        let (tx, mut rx) = mpsc::channel::<WsMessageData>(16);
        let mut inject_rx = mpsc::channel::<WsInjectRequest>(WS_INJECT_CHANNEL_CAPACITY).1;

        tokio::time::timeout(
            Duration::from_secs(2),
            relay_websocket_frames(
                &mut client_inner,
                &mut upstream_inner,
                "sess-proto-client",
                &tx,
                &mut inject_rx,
            ),
        )
        .await
        .expect("relay should end, not hang");

        // The relay should have written a Close(1002) back to the client
        // (observable on client_outer).
        let answered = read_one_frame(&mut client_outer).await;
        assert_eq!(answered.opcode, WsOpcode::Close);
        assert!(answered.fin);
        assert_eq!(answered.payload.len(), 2);
        assert_eq!(
            u16::from_be_bytes([answered.payload[0], answered.payload[1]]),
            1002
        );

        let mut emitted = 0;
        while rx.try_recv().is_ok() {
            emitted += 1;
        }
        // A protocol-violating frame is rejected by parse_ws_frame before it is
        // ever parsed into a WsFrame, so no WsMessageData is emitted for it.
        // The protocol error is signalled via the Close(1002) answer instead.
        assert_eq!(
            emitted, 0,
            "a rejected protocol-violating frame must not be emitted as a message"
        );
    }

    #[tokio::test]
    async fn relay_answers_close_1002_on_upstream_protocol_error() {
        // Upstream sends a frame with RSV1 set (no extension) → protocol error.
        // The relay must answer upstream with a Close(1002) before ending.
        let (mut client_outer, mut client_inner) = tokio::io::duplex(64);
        let (mut upstream_outer, mut upstream_inner) = tokio::io::duplex(64);

        upstream_outer.write_all(&[0b1100_0001u8, 0x00]).await.unwrap();
        upstream_outer.shutdown().await.unwrap();
        client_outer.shutdown().await.unwrap();

        let (tx, _rx) = mpsc::channel::<WsMessageData>(16);
        let mut inject_rx = mpsc::channel::<WsInjectRequest>(WS_INJECT_CHANNEL_CAPACITY).1;

        tokio::time::timeout(
            Duration::from_secs(2),
            relay_websocket_frames(
                &mut client_inner,
                &mut upstream_inner,
                "sess-proto-upstream",
                &tx,
                &mut inject_rx,
            ),
        )
        .await
        .expect("relay should end, not hang");

        // The Close(1002) answer to upstream is observable on upstream_outer.
        let answered = read_one_frame(&mut upstream_outer).await;
        assert_eq!(answered.opcode, WsOpcode::Close);
        assert_eq!(
            u16::from_be_bytes([answered.payload[0], answered.payload[1]]),
            1002
        );
    }

    #[tokio::test]
    async fn relay_clean_eof_does_not_answer_close() {
        // Both peers simply close their write sides (clean EOF). The relay must
        // NOT write a Close(1002) answer — it should just end.
        let (mut client_outer, mut client_inner) = tokio::io::duplex(64);
        let (mut upstream_outer, mut upstream_inner) = tokio::io::duplex(64);

        client_outer.shutdown().await.unwrap();
        upstream_outer.shutdown().await.unwrap();

        let (tx, _rx) = mpsc::channel::<WsMessageData>(16);
        let mut inject_rx = mpsc::channel::<WsInjectRequest>(WS_INJECT_CHANNEL_CAPACITY).1;

        tokio::time::timeout(
            Duration::from_secs(2),
            relay_websocket_frames(
                &mut client_inner,
                &mut upstream_inner,
                "sess-clean-eof",
                &tx,
                &mut inject_rx,
            ),
        )
        .await
        .expect("relay should end on clean EOF, not hang");

        // On a clean EOF the relay must NOT write a Close(1002) answer. A
        // Close frame is at least 2 bytes, so any bytes here would be a
        // violation; we assert the read either times out (relay wrote nothing)
        // or yields no data.
        let mut out = [0u8; 8];
        let read_result = tokio::time::timeout(
            Duration::from_millis(150),
            client_outer.read(&mut out),
        )
        .await;
        match read_result {
            Err(_) => { /* timed out: relay wrote nothing — expected */ }
            Ok(Ok(0)) => { /* EOF: relay wrote nothing — expected */ }
            Ok(Ok(n)) => panic!("clean EOF must not produce a Close frame, got {n} bytes: {:?}", &out[..n]),
            Ok(Err(e)) => panic!("unexpected read error: {e}"),
        }
    }

    #[tokio::test]
    async fn relay_forwards_legitimate_close_without_double_answer() {
        // Client sends a legitimate Close frame (code 1000). The relay must
        // forward it to upstream as-is and NOT synthesize a Close(1002).
        let (mut client_outer, mut client_inner) = tokio::io::duplex(64);
        let (mut upstream_outer, mut upstream_inner) = tokio::io::duplex(64);

        let close = WsFrame {
            fin: true,
            opcode: WsOpcode::Close,
            mask: false,
            payload: 1000u16.to_be_bytes().to_vec(),
        };
        let mut buf = Vec::new();
        write_ws_frame(&mut buf, &close, false).await.unwrap();
        client_outer.write_all(&buf).await.unwrap();
        // Close both write sides so the relay's reads hit EOF and it exits.
        client_outer.shutdown().await.unwrap();
        upstream_outer.shutdown().await.unwrap();

        let (tx, _rx) = mpsc::channel::<WsMessageData>(16);
        let mut inject_rx = mpsc::channel::<WsInjectRequest>(WS_INJECT_CHANNEL_CAPACITY).1;

        tokio::time::timeout(
            Duration::from_secs(2),
            relay_websocket_frames(
                &mut client_inner,
                &mut upstream_inner,
                "sess-legit-close",
                &tx,
                &mut inject_rx,
            ),
        )
        .await
        .expect("relay should end after forwarding Close, not hang");

        // The forwarded Close lands on the upstream read side (upstream_outer).
        let forwarded = read_one_frame(&mut upstream_outer).await;
        assert_eq!(forwarded.opcode, WsOpcode::Close);
        assert_eq!(
            u16::from_be_bytes([forwarded.payload[0], forwarded.payload[1]]),
            1000,
            "legitimate Close(1000) must be forwarded unchanged, not replaced with 1002"
        );
    }

    // ----- H9: on Close, relay shuts down the peer writer + honors grace -----

    #[tokio::test]
    async fn relay_terminates_via_close_grace_without_peer_closeback() {
        // Upstream sends a Close and then NEVER closebacks (keeps its read side
        // open, no FIN, no further frames). The client likewise stays open and
        // sends nothing. Without the close-grace timeout the relay would block
        // on the client read forever. The grace deadline must force termination.
        // Use 300ms to match the integration test's override value so the two
        // do not fight over the global override slot when run in parallel.
        let _guard = crate::override_ws_close_grace_timeout_for_test(Duration::from_millis(300));

        let (client_outer, mut client_inner) = tokio::io::duplex(64);
        let (mut upstream_outer, mut upstream_inner) = tokio::io::duplex(64);

        // Upstream sends a Close(1000) then sits silent. Do NOT shutdown
        // upstream_outer — that would produce a clean EOF and the relay would
        // exit regardless of the grace fix.
        let close = WsFrame {
            fin: true,
            opcode: WsOpcode::Close,
            mask: false,
            payload: 1000u16.to_be_bytes().to_vec(),
        };
        let mut buf = Vec::new();
        write_ws_frame(&mut buf, &close, false).await.unwrap();
        upstream_outer.write_all(&buf).await.unwrap();

        let (tx, _rx) = mpsc::channel::<WsMessageData>(16);
        let mut inject_rx = mpsc::channel::<WsInjectRequest>(WS_INJECT_CHANNEL_CAPACITY).1;

        // Outer bound well beyond the 150ms grace, far short of the 30s frame
        // read timeout a hung relay would hit.
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            relay_websocket_frames(
                &mut client_inner,
                &mut upstream_inner,
                "sess-grace",
                &tx,
                &mut inject_rx,
            ),
        )
        .await;

        // The relay MUST terminate (grace fired). Hold the outer handles open
        // for the duration so neither side sees a clean EOF from us.
        let _ = client_outer;
        let _ = upstream_outer;

        assert!(
            result.is_ok(),
            "relay must terminate via close-grace timeout even without peer closeback"
        );
    }

    #[tokio::test]
    async fn relay_shutdowns_peer_writer_on_close() {
        // When the client sends a Close, the relay must shutdown the upstream
        // writer (its write side toward upstream) so a compliant upstream sees
        // its peer close. We observe this on upstream_outer as a clean EOF
        // (read returns 0) AFTER the forwarded Close frame is read.
        // No grace override needed here: we observe the writer shutdown (which
        // happens before any grace elapses) and then abort the relay task, so
        // the default grace value is irrelevant.

        let (mut client_outer, mut client_inner) = tokio::io::duplex(64);
        let (mut upstream_outer, mut upstream_inner) = tokio::io::duplex(64);

        let close = WsFrame {
            fin: true,
            opcode: WsOpcode::Close,
            mask: false,
            payload: 1000u16.to_be_bytes().to_vec(),
        };
        let mut buf = Vec::new();
        write_ws_frame(&mut buf, &close, false).await.unwrap();
        client_outer.write_all(&buf).await.unwrap();
        // Do NOT shutdown client_outer here — we want to confirm the relay's
        // OWN shutdown of the upstream writer is observable.

        let (tx, _rx) = mpsc::channel::<WsMessageData>(16);
        let mut inject_rx = mpsc::channel::<WsInjectRequest>(WS_INJECT_CHANNEL_CAPACITY).1;

        // The relay will: forward Close to upstream, shutdown upstream writer,
        // arm grace. Since neither side ever EOFs naturally (both outer halves
        // stay open), the relay exits via the grace timeout (5s is too long to
        // wait in a unit test, so we bound the whole thing and just observe the
        // forwarded Close + the writer shutdown within a short window).
        let relay_task = tokio::spawn(async move {
            relay_websocket_frames(
                &mut client_inner,
                &mut upstream_inner,
                "sess-peer-shutdown",
                &tx,
                &mut inject_rx,
            )
            .await;
        });

        // Read the forwarded Close frame on the upstream side.
        let forwarded = read_one_frame(&mut upstream_outer).await;
        assert_eq!(forwarded.opcode, WsOpcode::Close);

        // The relay shut down the upstream writer → the next read on
        // upstream_outer must yield clean EOF (0 bytes) promptly.
        let mut probe = [0u8; 4];
        let read_result = tokio::time::timeout(
            Duration::from_millis(500),
            upstream_outer.read(&mut probe),
        )
        .await
        .expect("upstream writer should be shut down promptly");
        match read_result {
            Ok(0) => { /* clean EOF from relay's shutdown — expected */ }
            Ok(n) => panic!(
                "expected clean EOF after relay shut down upstream writer, got {n} bytes: {:?}",
                &probe[..n]
            ),
            Err(e) => panic!("unexpected read error after relay shutdown: {e}"),
        }

        relay_task.abort();
        let _ = client_outer;
    }
}

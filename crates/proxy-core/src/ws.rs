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
// Frame parsing (reading from async stream)
// ---------------------------------------------------------------------------

/// Read one WebSocket frame from an async stream.
/// Returns the parsed frame with unmasked payload.
/// Each read operation is guarded by a timeout to prevent a stalled peer
/// from blocking the relay loop indefinitely.
pub async fn parse_ws_frame<R: AsyncReadExt + Unpin>(reader: &mut R) -> Result<WsFrame, String> {
    let read_timeout = Duration::from_secs(WS_FRAME_READ_TIMEOUT_SECS);

    let mut head = [0u8; 2];
    timeout(read_timeout, reader.read_exact(&mut head))
        .await
        .map_err(|_| format!("ws frame header read timed out ({WS_FRAME_READ_TIMEOUT_SECS}s)"))?
        .map_err(|e| format!("ws frame header read: {e}"))?;

    let fin = (head[0] & 0x80) != 0;
    let opcode = WsOpcode::from_u8(head[0] & 0x0F);
    let mask = (head[1] & 0x80) != 0;
    let mut payload_len = (head[1] & 0x7F) as u64;

    if payload_len == 126 {
        let mut ext = [0u8; 2];
        timeout(read_timeout, reader.read_exact(&mut ext))
            .await
            .map_err(|_| {
                format!("ws extended length read timed out ({WS_FRAME_READ_TIMEOUT_SECS}s)")
            })?
            .map_err(|e| format!("ws extended length read: {e}"))?;
        payload_len = u16::from_be_bytes(ext) as u64;
    } else if payload_len == 127 {
        let mut ext = [0u8; 8];
        timeout(read_timeout, reader.read_exact(&mut ext))
            .await
            .map_err(|_| {
                format!("ws extended length read timed out ({WS_FRAME_READ_TIMEOUT_SECS}s)")
            })?
            .map_err(|e| format!("ws extended length read: {e}"))?;
        payload_len = u64::from_be_bytes(ext);
    }

    if payload_len > MAX_WS_FRAME_SIZE {
        return Err(format!(
            "ws payload length {payload_len} exceeds limit {MAX_WS_FRAME_SIZE}"
        ));
    }

    let mut mask_key = [0u8; 4];
    if mask {
        timeout(read_timeout, reader.read_exact(&mut mask_key))
            .await
            .map_err(|_| {
                format!("ws mask key read timed out ({WS_FRAME_READ_TIMEOUT_SECS}s)")
            })?
            .map_err(|e| format!("ws mask key read: {e}"))?;
    }

    let payload_len = usize::try_from(payload_len)
        .map_err(|_| "ws payload length does not fit in usize".to_string())?;
    let mut payload = vec![0u8; payload_len];
    if payload_len > 0 {
        timeout(read_timeout, reader.read_exact(&mut payload))
            .await
            .map_err(|_| {
                format!("ws payload read timed out ({WS_FRAME_READ_TIMEOUT_SECS}s)")
            })?
            .map_err(|e| format!("ws payload read: {e}"))?;
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
) -> Result<(), String> {
    let mut head = [0u8; 2];

    if frame.fin {
        head[0] |= 0x80;
    }
    head[0] |= frame.opcode as u8;

    let payload_len = frame.payload.len();
    let mask_bit: u8 = if mask_output { 0x80 } else { 0 };

    if payload_len < 126 {
        head[1] = mask_bit | payload_len as u8;
        writer
            .write_all(&head)
            .await
            .map_err(|e| format!("ws frame write head: {e}"))?;
    } else if payload_len <= 65535 {
        head[1] = mask_bit | 126;
        writer
            .write_all(&head)
            .await
            .map_err(|e| format!("ws frame write head: {e}"))?;
        writer
            .write_all(&(payload_len as u16).to_be_bytes())
            .await
            .map_err(|e| format!("ws frame write ext len: {e}"))?;
    } else {
        head[1] = mask_bit | 127;
        writer
            .write_all(&head)
            .await
            .map_err(|e| format!("ws frame write head: {e}"))?;
        writer
            .write_all(&(payload_len as u64).to_be_bytes())
            .await
            .map_err(|e| format!("ws frame write ext len: {e}"))?;
    }

    if mask_output {
        let mask_key = rand::random::<[u8; 4]>();
        writer
            .write_all(&mask_key)
            .await
            .map_err(|e| format!("ws frame write mask: {e}"))?;
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
                .map_err(|e| format!("ws frame write payload: {e}"))?;
            offset = end;
        }
    } else {
        writer
            .write_all(&frame.payload)
            .await
            .map_err(|e| format!("ws frame write payload: {e}"))?;
    }

    writer
        .flush()
        .await
        .map_err(|e| format!("ws frame flush: {e}"))?;

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
pub fn build_ws_message(
    session_id: &str,
    direction: WsDirection,
    frame: &WsFrame,
) -> WsMessageData {
    let payload_text = if frame.opcode == WsOpcode::Text || frame.opcode == WsOpcode::Continuation {
        String::from_utf8(frame.payload.clone()).ok()
    } else if frame.opcode == WsOpcode::Close && !frame.payload.is_empty() {
        // Close frame: first 2 bytes are status code, rest is reason
        if frame.payload.len() > 2 {
            String::from_utf8(frame.payload[2..].to_vec()).ok()
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
        opcode: frame.opcode.label().to_string(),
        payload_text,
        payload_size: frame.payload.len(),
        fin: frame.fin,
    }
}

/// Reconstruct raw frame bytes from a WsFrame for forwarding.
/// This writes the frame in its original form (unmasked) for relay.
pub async fn forward_raw_frame<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    frame: &WsFrame,
) -> Result<(), String> {
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
    inject_sender: mpsc::UnboundedSender<WsInjectRequest>,
    status: WsConnectionStatus,
}

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

    pub fn register(&self, session_id: String, sender: mpsc::UnboundedSender<WsInjectRequest>) {
        let mut map = self.connections.lock().unwrap_or_else(|e| e.into_inner());
        if map.contains_key(&session_id) {
            crate::logging::emit_log(
                "WARN",
                "ws_registry_duplicate_session",
                &[("session_id", session_id.clone())],
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

    pub fn inject(&self, session_id: &str, request: WsInjectRequest) -> Result<(), String> {
        let map = self.connections.lock().unwrap_or_else(|e| e.into_inner());
        let entry = map.get(session_id).ok_or_else(|| {
            format!(
                "WebSocket session {} is not active or does not exist",
                session_id
            )
        })?;
        if entry.status != WsConnectionStatus::Active {
            return Err(format!("WebSocket session {} is closed", session_id));
        }
        entry
            .inject_sender
            .send(request)
            .map_err(|e| format!("Failed to inject frame: {:?}", e))
    }
}

static WS_REGISTRY: OnceLock<WsConnectionRegistry> = OnceLock::new();

pub fn global_ws_registry() -> &'static WsConnectionRegistry {
    WS_REGISTRY.get_or_init(WsConnectionRegistry::new)
}

// ---------------------------------------------------------------------------
// Frame relay with injection support
// ---------------------------------------------------------------------------

/// Relay WebSocket frames between client and upstream until the connection closes.
/// Emits each parsed frame as a WsMessageData via the sender.
/// Accepts an injection receiver for replaying frames into the connection.
pub async fn relay_websocket_frames<C, U>(
    client_stream: &mut C,
    upstream_stream: &mut U,
    session_id: &str,
    ws_sender: &mpsc::Sender<WsMessageData>,
    inject_rx: &mut mpsc::UnboundedReceiver<WsInjectRequest>,
) where
    C: AsyncReadExt + AsyncWriteExt + Unpin,
    U: AsyncReadExt + AsyncWriteExt + Unpin,
{
    use crate::logging::emit_log;

    let mut client_done = false;
    let mut upstream_done = false;

    loop {
        tokio::select! {
            client_result = async {
                if client_done {
                    std::future::pending::<()>().await;
                    return None;
                }
                parse_ws_frame(client_stream).await.ok()
            } => {
                match client_result {
                    Some(frame) => {
                        let msg = build_ws_message(session_id, WsDirection::ClientToServer, &frame);
                        let _ = ws_sender.send(msg).await;

                        if frame.opcode == WsOpcode::Close {
                            let _ = forward_raw_frame(upstream_stream, &frame).await;
                            client_done = true;
                        } else {
                            // Forward to upstream masked per RFC 6455 §5.1 (proxy acts as client to upstream)
                            if let Err(e) = write_ws_frame(upstream_stream, &frame, true).await {
                                emit_log("DEBUG", "ws_relay_client_to_upstream_write_failed", &[("error", e)]);
                                break;
                            }
                        }
                    }
                    None => {
                        client_done = true;
                    }
                }
            }
            upstream_result = async {
                if upstream_done {
                    std::future::pending::<()>().await;
                    return None;
                }
                parse_ws_frame(upstream_stream).await.ok()
            } => {
                match upstream_result {
                    Some(frame) => {
                        let msg = build_ws_message(session_id, WsDirection::ServerToClient, &frame);
                        let _ = ws_sender.send(msg).await;

                        if frame.opcode == WsOpcode::Close {
                            let _ = forward_raw_frame(client_stream, &frame).await;
                            upstream_done = true;
                        } else {
                            if let Err(e) = forward_raw_frame(client_stream, &frame).await {
                                emit_log("DEBUG", "ws_relay_upstream_to_client_write_failed", &[("error", e)]);
                                break;
                            }
                        }
                    }
                    None => {
                        upstream_done = true;
                    }
                }
            }
            inject_result = inject_rx.recv() => {
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
                            emit_log("DEBUG", "ws_inject_write_failed", &[("error", e)]);
                            break;
                        }
                        let msg = build_ws_message(session_id, req.direction, &frame);
                        let _ = ws_sender.send(msg).await;
                    }
                    None => {
                        // Injection channel closed; stop listening for injects.
                    }
                }
            }
        }

        if client_done && upstream_done {
            break;
        }
    }

    emit_log(
        "DEBUG",
        "ws_relay_ended",
        &[("session_id", session_id.to_string())],
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
}

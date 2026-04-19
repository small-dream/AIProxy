use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

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
pub async fn parse_ws_frame<R: AsyncReadExt + Unpin>(
    reader: &mut R,
) -> Result<WsFrame, String> {
    let mut head = [0u8; 2];
    reader
        .read_exact(&mut head)
        .await
        .map_err(|e| format!("ws frame header read: {e}"))?;

    let fin = (head[0] & 0x80) != 0;
    let opcode = WsOpcode::from_u8(head[0] & 0x0F);
    let mask = (head[1] & 0x80) != 0;
    let mut payload_len = (head[1] & 0x7F) as u64;

    if payload_len == 126 {
        let mut ext = [0u8; 2];
        reader
            .read_exact(&mut ext)
            .await
            .map_err(|e| format!("ws extended length read: {e}"))?;
        payload_len = u16::from_be_bytes(ext) as u64;
    } else if payload_len == 127 {
        let mut ext = [0u8; 8];
        reader
            .read_exact(&mut ext)
            .await
            .map_err(|e| format!("ws extended length read: {e}"))?;
        payload_len = u64::from_be_bytes(ext);
    }

    let mut mask_key = [0u8; 4];
    if mask {
        reader
            .read_exact(&mut mask_key)
            .await
            .map_err(|e| format!("ws mask key read: {e}"))?;
    }

    let mut payload = vec![0u8; payload_len as usize];
    if payload_len > 0 {
        reader
            .read_exact(&mut payload)
            .await
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
        let masked: Vec<u8> = frame
            .payload
            .iter()
            .enumerate()
            .map(|(i, byte)| byte ^ mask_key[i % 4])
            .collect();
        writer
            .write_all(&masked)
            .await
            .map_err(|e| format!("ws frame write payload: {e}"))?;
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

/// Relay WebSocket frames between client and upstream until the connection closes.
/// Emits each parsed frame as a WsMessageData via the sender.
pub async fn relay_websocket_frames<C, U>(
    client_stream: &mut C,
    upstream_stream: &mut U,
    session_id: &str,
    ws_sender: &tokio::sync::mpsc::UnboundedSender<WsMessageData>,
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
                        let _ = ws_sender.send(msg);

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
                        let _ = ws_sender.send(msg);

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
        }

        if client_done && upstream_done {
            break;
        }
    }

    emit_log("DEBUG", "ws_relay_ended", &[("session_id", session_id.to_string())]);
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

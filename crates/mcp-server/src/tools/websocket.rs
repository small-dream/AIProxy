use aiproxy_db::sessions::search_ws_messages_page;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::context::AppContext;
use crate::protocol::{ToolError, ToolMeta};
use crate::redaction::Redactor;

use super::sessions::require_session_id;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GetWebSocketMessagesRequest {
    /// Exact session id or a unique prefix of at least 8 characters.
    pub session_id: String,
    /// Direction filter: `clientToServer` or `serverToClient` (case-insensitive).
    /// The aliases `client` and `server` are accepted and normalized.
    pub direction: Option<String>,
    /// Case-insensitive substring matched against text payloads.
    pub keyword: Option<String>,
    /// Page size, 1-100; default 50.
    #[schemars(range(min = 1, max = 100))]
    pub limit: Option<usize>,
    /// Opaque nextCursor returned by a previous WebSocket message call.
    pub cursor: Option<String>,
}

pub async fn get_messages(
    state: &AppContext,
    request: GetWebSocketMessagesRequest,
) -> Result<(Value, ToolMeta), ToolError> {
    let config = state.config()?;
    if !config.permissions.read_web_socket {
        return Err(ToolError::permission_denied(
            "WebSocket reading is disabled. Enable readWebSocket in AIProxy Settings > Agent Access.",
        ));
    }
    if !state
        .capabilities
        .is_some_and(|capabilities| capabilities.websocket_messages)
    {
        return Err(ToolError::new(
            "SCHEMA_INCOMPATIBLE",
            "WebSocket messages are unavailable until AIProxy migrates the database. Open AIProxy once, then retry.",
        ));
    }
    // P3: the JSON schema told the model to pass `client` / `server`, while the
    // implementation only accepted the storage values. Accept both (and any
    // casing) and normalize, so a schema-following call no longer fails.
    if let Some(direction) = &request.direction {
        normalize_direction(direction)?;
    }

    let redactor = Redactor::from_config(&config, &state.paths.data_dir)
        .map_err(|message| ToolError::new("INVALID_REDACTION_CONFIG", message))?;
    let session_id = require_session_id(state, &request.session_id).await?;
    let direction = match request.direction.as_deref() {
        Some(value) => Some(normalize_direction(value)?),
        None => None,
    };
    let keyword = request.keyword;
    let limit = request.limit.unwrap_or(50).clamp(1, 100);
    let cursor = request.cursor;
    let page = state
        .with_db(move |connection| {
            search_ws_messages_page(
                connection,
                &session_id,
                direction.as_deref(),
                keyword.as_deref(),
                limit,
                cursor.as_deref(),
            )
        })
        .await?;

    let items = page
        .items
        .into_iter()
        .map(|message| {
            let is_binary = message.opcode.eq_ignore_ascii_case("binary");
            let (payload_text, redacted_fields) = if is_binary {
                (Value::Null, Vec::new())
            } else {
                match message.payload_text {
                    Some(text) => {
                        let redacted = redactor.redact_text(&text);
                        (Value::String(redacted.value), redacted.fields)
                    }
                    None => (Value::Null, Vec::new()),
                }
            };
            json!({
                "id": message.id,
                "direction": message.direction,
                "timestamp": message.timestamp,
                "opcode": message.opcode,
                "payloadText": payload_text,
                "payloadSize": message.payload_size,
                "fin": message.fin,
                "truncated": message.truncated,
                "binaryPayloadOmitted": is_binary,
                "redactedFields": redacted_fields,
            })
        })
        .collect::<Vec<_>>();

    Ok((
        json!({ "items": items }),
        ToolMeta::new(page.truncated, true, page.next_cursor),
    ))
}

/// Map a caller-supplied direction onto the stored value, accepting the schema's
/// `client` / `server` aliases in any casing.
fn normalize_direction(value: &str) -> Result<String, ToolError> {
    let normalized = value.trim();
    if normalized.eq_ignore_ascii_case("clientToServer")
        || normalized.eq_ignore_ascii_case("client")
        || normalized.eq_ignore_ascii_case("c2s")
    {
        return Ok("clientToServer".to_string());
    }
    if normalized.eq_ignore_ascii_case("serverToClient")
        || normalized.eq_ignore_ascii_case("server")
        || normalized.eq_ignore_ascii_case("s2c")
    {
        return Ok("serverToClient".to_string());
    }

    Err(ToolError::invalid(
        "direction must be clientToServer or serverToClient (client/server are accepted aliases)",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    // P3: the JSON schema advertised `client` / `server`, but the tool only
    // accepted the storage values, so a schema-following call failed.
    #[test]
    fn normalizes_direction_aliases_and_rejects_unknown_values() {
        assert_eq!(normalize_direction("client").unwrap(), "clientToServer");
        assert_eq!(
            normalize_direction("CLIENTTOSERVER").unwrap(),
            "clientToServer"
        );
        assert_eq!(normalize_direction("c2s").unwrap(), "clientToServer");
        assert_eq!(normalize_direction("server").unwrap(), "serverToClient");
        assert_eq!(normalize_direction(" Server ").unwrap(), "serverToClient");
        assert_eq!(normalize_direction("s2c").unwrap(), "serverToClient");

        for invalid in ["", "both", "upstream"] {
            assert!(normalize_direction(invalid).is_err(), "{invalid}");
        }
    }
}

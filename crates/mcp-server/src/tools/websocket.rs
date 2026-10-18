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
    pub session_id: String,
    pub direction: Option<String>,
    pub keyword: Option<String>,
    pub limit: Option<usize>,
    pub cursor: Option<String>,
}

pub async fn get_messages(
    state: &AppContext,
    request: GetWebSocketMessagesRequest,
) -> Result<(Value, ToolMeta), ToolError> {
    let config = state.config()?;
    if !config.permissions.read_web_socket {
        return Err(ToolError::permission_denied(
            "WebSocket reading is disabled in Agent Access.",
        ));
    }
    if let Some(direction) = &request.direction {
        if direction != "clientToServer" && direction != "serverToClient" {
            return Err(ToolError::invalid(
                "direction must be clientToServer or serverToClient",
            ));
        }
    }

    let redactor = Redactor::from_config(&config, &state.paths.data_dir)
        .map_err(|message| ToolError::new("INVALID_REDACTION_CONFIG", message))?;
    let session_id = require_session_id(state, &request.session_id).await?;
    let direction = request.direction;
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

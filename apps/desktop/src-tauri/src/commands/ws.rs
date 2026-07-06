use super::common::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListWsMessagesInput {
    pub session_id: String,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WsMessageOutput {
    pub id: String,
    pub session_id: String,
    pub direction: String,
    pub timestamp: String,
    pub opcode: String,
    pub payload_text: Option<String>,
    pub payload_size: usize,
    pub fin: bool,
}

// M15: async + `run_blocking_command` so the DB read (and any mutex wait on
// the global connection lock) runs on the blocking pool instead of the IPC
// thread. WS message payloads can be large, and `load_ws_messages` may scan a
// big per-session `ws_messages` set.
#[tauri::command]
pub async fn list_ws_messages(
    input: ListWsMessagesInput,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<WsMessageOutput>, String> {
    let limit = input.limit.unwrap_or(500);
    let offset = input.offset.unwrap_or(0);
    let state = Arc::clone(state.inner());
    run_blocking_command("list_ws_messages", move || {
        let conn_guard = state.lock_db_for_ipc()?;
        let rows =
            aiproxy_db::sessions::load_ws_messages(&conn_guard, &input.session_id, limit, offset)
                .map_err(|error| app_error(ERR_INTERNAL, format!("list ws messages: {error}")))?;
        Ok(rows
            .into_iter()
            .map(|r| WsMessageOutput {
                id: r.id,
                session_id: r.session_id,
                direction: r.direction,
                timestamp: r.timestamp,
                opcode: r.opcode,
                payload_text: r.payload_text,
                payload_size: r.payload_size,
                fin: r.fin,
            })
            .collect())
    })
    .await
}

// ---------------------------------------------------------------------------
// WebSocket connection status & injection commands
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetWsConnectionStatusInput {
    pub session_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WsConnectionStatusOutput {
    pub status: String,
}

#[tauri::command]
pub fn get_ws_connection_status(input: GetWsConnectionStatusInput) -> WsConnectionStatusOutput {
    let registry = global_ws_registry();
    let status = registry.get_status(&input.session_id);
    WsConnectionStatusOutput {
        status: match status {
            WsConnectionStatus::Active => "active".to_string(),
            WsConnectionStatus::Closed => "closed".to_string(),
        },
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectWsMessageInput {
    pub session_id: String,
    pub direction: String,
    pub opcode: String,
    pub payload: String,
    pub fin: Option<bool>,
}

#[tauri::command]
pub fn inject_ws_message(input: InjectWsMessageInput) -> Result<(), String> {
    let direction = match input.direction.as_str() {
        "clientToServer" => WsDirection::ClientToServer,
        "serverToClient" => WsDirection::ServerToClient,
        _ => {
            return Err(app_error(
                ERR_INVALID_INPUT,
                format!("Invalid WebSocket direction: {}", input.direction),
            ))
        }
    };
    let opcode = match input.opcode.as_str() {
        "text" => WsOpcode::Text,
        "binary" => WsOpcode::Binary,
        "close" => WsOpcode::Close,
        "ping" => WsOpcode::Ping,
        "pong" => WsOpcode::Pong,
        _ => {
            return Err(app_error(
                ERR_INVALID_INPUT,
                format!("Invalid WebSocket opcode: {}", input.opcode),
            ))
        }
    };
    let registry = global_ws_registry();
    let request = aiproxy_proxy_core::WsInjectRequest {
        direction,
        opcode,
        payload: input.payload,
        fin: input.fin.unwrap_or(true),
    };
    registry
        .inject(&input.session_id, request)
        .map_err(|e| app_error(ERR_INTERNAL, e.to_string()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchWsMessagesInput {
    pub session_id: String,
    pub query: String,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

// M15: async + `run_blocking_command`. `search_ws_messages` runs a leading
// wildcard `LIKE '%...%'` over `payload_text`, which is a full scan of the
// session's WS messages — offload it so the IPC thread stays free.
#[tauri::command]
pub async fn search_ws_messages(
    input: SearchWsMessagesInput,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<WsMessageOutput>, String> {
    let limit = input.limit.unwrap_or(500);
    let offset = input.offset.unwrap_or(0);
    let state = Arc::clone(state.inner());
    run_blocking_command("search_ws_messages", move || {
        let conn_guard = state.lock_db_for_ipc()?;
        let rows = aiproxy_db::sessions::search_ws_messages(
            &conn_guard,
            &input.session_id,
            &input.query,
            limit,
            offset,
        )
        .map_err(|error| app_error(ERR_INTERNAL, format!("search ws messages: {error}")))?;
        Ok(rows
            .into_iter()
            .map(|r| WsMessageOutput {
                id: r.id,
                session_id: r.session_id,
                direction: r.direction,
                timestamp: r.timestamp,
                opcode: r.opcode,
                payload_text: r.payload_text,
                payload_size: r.payload_size,
                fin: r.fin,
            })
            .collect())
    })
    .await
}

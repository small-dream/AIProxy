use aiproxy_proxy_core::ProxySessionSummary;
use tauri::Emitter;

/// Emit a `session-upsert` event to the frontend.
pub(crate) fn emit_session_upsert(handle: &tauri::AppHandle, summary: ProxySessionSummary) {
    let _ = handle.emit("session-upsert", summary);
}

/// Emit a `session-remove` event to the frontend for a single session.
pub(crate) fn emit_session_remove(handle: &tauri::AppHandle, session_id: &str) {
    let _ = handle.emit("session-remove", session_id);
}

/// Emit a `sessions-removed` event to the frontend for multiple sessions.
pub(crate) fn emit_sessions_removed(handle: &tauri::AppHandle, ids: Vec<String>) {
    let _ = handle.emit("sessions-removed", ids);
}

/// Emit a `sessions-cleared` event to the frontend.
pub(crate) fn emit_sessions_cleared(handle: &tauri::AppHandle) {
    let _ = handle.emit("sessions-cleared", ());
}

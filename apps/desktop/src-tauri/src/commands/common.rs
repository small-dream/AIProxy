pub(super) use crate::bootstrap::{
    AppState, BootstrapStatus, CertificateStateSnapshot, RuntimeHandles, SESSION_BATCH_SIZE,
};
pub(super) use crate::session_stats;
pub(super) use crate::system_proxy::{
    apply_system_proxy_settings, apply_system_proxy_settings_with_pre_snapshot,
    capture_system_proxy_snapshot, restore_system_proxy, SystemProxySettings,
};
pub(super) use crate::workspace::WorkspaceData;
pub(super) use aiproxy_proxy_core::{
    compile_script_rule, get_local_ip_addresses, global_ws_registry, send_direct_request,
    start_proxy_server, BreakpointEventEmitter, BreakpointResolution, BreakpointRule,
    BreakpointStage, DnsMappingRule, MapRule, ProxyConfig, ProxyHeaderEntry, ProxyManagers,
    ProxyRuntimeConfig, ProxySessionDetail, ProxySessionSummary, ProxyTimingBreakdown, RewriteRule,
    ScriptRule, ScriptRuleLanguage, ScriptRuleSourceType, ThrottleProfileData, ThrottleRuleData,
    ThrottleRuntimeStats, TlsManager, WsConnectionStatus, WsDirection, WsOpcode,
};
pub(super) use aiproxy_tls_manager::{
    detect_platform, is_cert_trusted_on_platform, remove_cert_trust_on_platform, CertStorage,
    RootCaPair, TrustRemovalReport,
};
pub(super) use serde::{Deserialize, Serialize};
pub(super) use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};
pub(super) use tauri::{Emitter, State};
pub(super) use tauri_plugin_opener::OpenerExt;
pub(super) use url::{form_urlencoded, Url};

pub(super) const DEFAULT_PROXY_PORT: u16 = 8888;
pub(super) const EAGER_SESSION_DETAIL_BODY_LIMIT_BYTES: usize = 64 * 1024;
pub(super) const MAX_IMPORTED_SCRIPT_BYTES: usize = 128 * 1024;

// --- Shared error helpers ---

pub(super) const ERR_PROXY_NOT_RUNNING: &str = "PROXY_NOT_RUNNING";
pub(super) const ERR_INVALID_INPUT: &str = "INVALID_INPUT";
pub(super) const ERR_CERT_NOT_FOUND: &str = "CERT_NOT_FOUND";
pub(super) const ERR_INTERNAL: &str = "INTERNAL_ERROR";
pub(super) const ERR_PROCESS_CHANGED: &str = "PROCESS_CHANGED";
/// The DB connection mutex is poisoned (a prior panic left it locked).
/// A poisoned `rusqlite::Connection` may have torn statement state and must
/// not be reused for user-data writes — IPC handlers return this code so the
/// frontend can prompt a restart. See ADR-005.
pub(crate) const ERR_DB_POISONED: &str = "DB_POISONED";

/// Produces a structured JSON error string with `code` and `message`.
/// Tauri commands return `Result<T, String>`, so the error payload is a
/// JSON-encoded string that the frontend can parse via `coerceAppError`.
pub(crate) fn app_error(code: &str, message: impl AsRef<str>) -> String {
    serde_json::json!({
        "code": code,
        "message": message.as_ref(),
    })
    .to_string()
}

/// Like `app_error`, but includes an arbitrary `details` object.
pub(super) fn app_error_with_details(
    code: &str,
    message: &str,
    details: serde_json::Value,
) -> String {
    serde_json::json!({
        "code": code,
        "message": message,
        "details": details,
    })
    .to_string()
}

pub(super) async fn run_blocking_command<T, F>(
    command_name: &'static str,
    task: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("{command_name} blocking task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_error_produces_valid_json_with_code_and_message() {
        let result = app_error("TEST_CODE", "Something went wrong");
        let parsed: serde_json::Value = serde_json::from_str(&result).expect("valid JSON");

        assert_eq!(parsed["code"], "TEST_CODE");
        assert_eq!(parsed["message"], "Something went wrong");
        assert!(parsed.get("details").is_none(), "no details field expected");
    }

    #[test]
    fn app_error_accepts_string_expression() {
        let result = app_error(ERR_PROXY_NOT_RUNNING, format!("Port {} is in use", 8080));
        let parsed: serde_json::Value = serde_json::from_str(&result).expect("valid JSON");

        assert_eq!(parsed["code"], "PROXY_NOT_RUNNING");
        assert_eq!(parsed["message"], "Port 8080 is in use");
    }

    #[test]
    fn app_error_with_details_includes_details_object() {
        let result = app_error_with_details(
            "NOT_FOUND",
            "Resource missing",
            serde_json::json!({ "resourceId": "abc-123" }),
        );
        let parsed: serde_json::Value = serde_json::from_str(&result).expect("valid JSON");

        assert_eq!(parsed["code"], "NOT_FOUND");
        assert_eq!(parsed["message"], "Resource missing");
        assert_eq!(parsed["details"]["resourceId"], "abc-123");
    }

    #[test]
    fn app_error_format_matches_frontend_coerce_app_error() {
        // The frontend coerceAppError expects JSON strings with code + message.
        // Verify the output is parseable by simulating the frontend logic.
        let error = app_error("INVALID_INPUT", "Bad request");
        let parsed: serde_json::Value = serde_json::from_str(&error).unwrap();

        // Frontend checks: isAppError → has string code + string message
        assert!(parsed.get("code").and_then(|v| v.as_str()).is_some());
        assert!(parsed.get("message").and_then(|v| v.as_str()).is_some());
    }

    /// Regression test: list query commands must propagate DB errors as structured
    /// app_error() with a parseable code and message, not silently return Ok(vec![]).
    /// This ensures the frontend can distinguish "no data" from "query failed".
    #[test]
    fn list_query_db_error_produces_structured_app_error() {
        // Simulate what a list command does when DB fails:
        //   .map_err(|error| app_error(ERR_INTERNAL, format!("list collections: {error}")))
        let db_error_msg = "database is locked";
        let error = app_error(ERR_INTERNAL, format!("list collections: {db_error_msg}"));

        // Frontend should be able to extract code and message
        let parsed: serde_json::Value = serde_json::from_str(&error).unwrap();
        assert_eq!(parsed["code"], "INTERNAL_ERROR");
        assert!(parsed["message"]
            .as_str()
            .unwrap()
            .contains("list collections"));
        assert!(parsed["message"].as_str().unwrap().contains(db_error_msg));
    }

    /// Regression test: app_error_with_details preserves structured context
    /// that the frontend can use for error-specific UI behavior.
    #[test]
    fn list_query_error_with_details_preserves_context() {
        let error = app_error_with_details(
            ERR_INTERNAL,
            "query failed",
            serde_json::json!({ "operation": "list_sessions" }),
        );
        let parsed: serde_json::Value = serde_json::from_str(&error).unwrap();
        assert_eq!(parsed["code"], "INTERNAL_ERROR");
        assert_eq!(parsed["details"]["operation"], "list_sessions");
    }
}

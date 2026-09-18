use super::common::*;
use super::multipart::{build_multipart_body_bytes, MultipartEntry};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendComposedRequestInput {
    #[allow(dead_code)]
    pub workspace_id: String,
    pub method: String,
    pub url: String,
    pub headers: Vec<ProxyHeaderEntry>,
    pub body: Option<String>,
    #[serde(default)]
    pub multipart_entries: Option<Vec<MultipartEntry>>,
}

#[tauri::command]
pub async fn send_composed_request(
    input: SendComposedRequestInput,
    state: State<'_, Arc<AppState>>,
) -> Result<ProxySessionDetail, String> {
    let detail = match input.multipart_entries {
        Some(entries) if !entries.is_empty() => {
            // C3: Rust is the single multipart-encoding authority. The
            // renderer supplies structured parts (text values + file paths);
            // bytes are read and assembled here, and the content-type header
            // is guaranteed to carry the generated boundary.
            let boundary = format!(
                "----AIProxyBoundary{}",
                chrono::Utc::now().timestamp_millis()
            );
            // Attachment problems (expired token, unreadable/oversized file,
            // invalid part Content-Type) are request-input failures, so they
            // surface as INVALID_INPUT rather than a bare string (API_SPEC 4.2).
            let body_bytes = build_multipart_body_bytes(&entries, &boundary)
                .map_err(|error| app_error(ERR_INVALID_INPUT, error))?
                .unwrap_or_default();
            let mut headers = input.headers;
            if !headers
                .iter()
                .any(|header| header.name.eq_ignore_ascii_case("content-type"))
            {
                headers.push(ProxyHeaderEntry {
                    name: "Content-Type".to_string(),
                    value: format!("multipart/form-data; boundary={boundary}"),
                    is_pseudo: None,
                });
            }
            send_direct_request_bytes(input.method, input.url, headers, Some(body_bytes))
                .await
                .map_err(|error| app_error(ERR_INTERNAL, format!("send composed request: {error}")))?
        }
        _ => send_direct_request(input.method, input.url, input.headers, input.body)
            .await
            .map_err(|error| app_error(ERR_INTERNAL, format!("send composed request: {error}")))?,
    };
    let session_id = detail.id.clone();
    state.upsert_session_async(detail.clone()).await;

    tracing::info!(
        component = "desktop.commands",
        event = "send_composed_request_succeeded",
        session_id = %session_id,
        status_code = %detail.summary.status_code,
        "send_composed_request_succeeded"
    );

    Ok(detail)
}


#[cfg(test)]
mod tests {
    use super::*;

    /// Regression test: multipart build failures at the command boundary must
    /// be structured app_error payloads (API_SPEC 4.2), not bare strings.
    #[test]
    fn multipart_build_error_maps_to_invalid_input_app_error() {
        let build_error = "attachment 'a.bin': attachment token expired";
        // Mirrors the map_err closure in send_composed_request.
        let error = app_error(ERR_INVALID_INPUT, build_error);
        let parsed: serde_json::Value = serde_json::from_str(&error).expect("valid JSON");

        assert_eq!(parsed["code"], "INVALID_INPUT");
        assert_eq!(parsed["message"], build_error);
    }

    /// Regression test: send_direct_request(_bytes) failures at the command
    /// boundary surface as INTERNAL_ERROR with the underlying cause preserved.
    #[test]
    fn send_failure_maps_to_internal_app_error() {
        let send_error = "invalid URL 'notaurl': relative URL without a base";
        // Mirrors the map_err closures in send_composed_request.
        let error = app_error(ERR_INTERNAL, format!("send composed request: {send_error}"));
        let parsed: serde_json::Value = serde_json::from_str(&error).expect("valid JSON");

        assert_eq!(parsed["code"], "INTERNAL_ERROR");
        assert!(parsed["message"]
            .as_str()
            .expect("message string")
            .contains(send_error));
    }
}

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
            let body_bytes = build_multipart_body_bytes(&entries, &boundary)?.unwrap_or_default();
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
            send_direct_request_bytes(input.method, input.url, headers, Some(body_bytes)).await?
        }
        _ => send_direct_request(input.method, input.url, input.headers, input.body).await?,
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

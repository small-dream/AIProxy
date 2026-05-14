use super::common::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendComposedRequestInput {
    #[allow(dead_code)]
    pub workspace_id: String,
    pub method: String,
    pub url: String,
    pub headers: Vec<ProxyHeaderEntry>,
    pub body: Option<String>,
}

#[tauri::command]
pub async fn send_composed_request(
    input: SendComposedRequestInput,
    state: State<'_, Arc<AppState>>,
) -> Result<ProxySessionDetail, String> {
    let detail = send_direct_request(input.method, input.url, input.headers, input.body).await?;
    let session_id = detail.id.clone();
    state.upsert_session(detail.clone());

    log_info(
        "desktop.commands",
        "send_composed_request_succeeded",
        &[
            ("session_id", session_id),
            ("status_code", detail.summary.status_code.to_string()),
        ],
    );

    Ok(detail)
}

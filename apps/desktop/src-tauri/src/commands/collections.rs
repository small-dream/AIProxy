use super::common::*;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ApiCollectionOutput {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub description: String,
    pub sort_order: u32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ApiCollectionItemOutput {
    pub id: String,
    pub collection_id: String,
    pub name: String,
    pub description: String,
    pub sort_order: u32,
    pub method: String,
    pub url: String,
    pub headers: Vec<ProxyHeaderEntry>,
    pub body: String,
    pub body_type: String,
    pub raw_language: String,
    pub form_data: Vec<ProxyHeaderEntry>,
    pub url_encoded: Vec<ProxyHeaderEntry>,
    pub created_at: String,
    pub updated_at: String,
}

fn parse_collection_header_entries(value: &str) -> Vec<ProxyHeaderEntry> {
    serde_json::from_str(value).unwrap_or_default()
}

fn parse_urlencoded_entries(value: &str) -> Vec<ProxyHeaderEntry> {
    form_urlencoded::parse(value.as_bytes())
        .map(|(name, value)| ProxyHeaderEntry {
            name: name.into_owned(),
            value: value.into_owned(),
            is_pseudo: None,
        })
        .collect()
}

fn substitute_header_entries(
    entries: Vec<ProxyHeaderEntry>,
    vars: &std::collections::HashMap<String, String>,
) -> Vec<ProxyHeaderEntry> {
    entries
        .into_iter()
        .map(|entry| ProxyHeaderEntry {
            name: substitute_vars(&entry.name, vars),
            value: substitute_vars(&entry.value, vars),
            is_pseudo: entry.is_pseudo,
        })
        .collect()
}

fn ensure_content_type_header(headers: &mut Vec<ProxyHeaderEntry>, content_type: &str) {
    if headers
        .iter()
        .any(|header| header.name.eq_ignore_ascii_case("content-type"))
    {
        return;
    }

    headers.push(ProxyHeaderEntry {
        name: "Content-Type".to_string(),
        value: content_type.to_string(),
        is_pseudo: None,
    });
}

fn build_urlencoded_body(entries: Vec<ProxyHeaderEntry>) -> Option<String> {
    let active_entries: Vec<ProxyHeaderEntry> = entries
        .into_iter()
        .filter(|entry| !entry.name.trim().is_empty())
        .collect();

    if active_entries.is_empty() {
        return None;
    }

    let mut serializer = form_urlencoded::Serializer::new(String::new());
    for entry in active_entries {
        serializer.append_pair(&entry.name, &entry.value);
    }

    Some(serializer.finish())
}

fn build_multipart_body(entries: Vec<ProxyHeaderEntry>, boundary: &str) -> Option<String> {
    let active_entries: Vec<ProxyHeaderEntry> = entries
        .into_iter()
        .filter(|entry| !entry.name.trim().is_empty())
        .collect();

    if active_entries.is_empty() {
        return None;
    }

    let mut body = String::new();
    for entry in active_entries {
        body.push_str("--");
        body.push_str(boundary);
        body.push_str("\r\nContent-Disposition: form-data; name=\"");
        body.push_str(&entry.name);
        body.push_str("\"\r\n\r\n");
        body.push_str(&entry.value);
        body.push_str("\r\n");
    }
    body.push_str("--");
    body.push_str(boundary);
    body.push_str("--");

    Some(body)
}

fn build_collection_item_request(
    item: &aiproxy_db::collections::CollectionItemRow,
    vars: &std::collections::HashMap<String, String>,
) -> Result<(String, Vec<ProxyHeaderEntry>, Option<String>), String> {
    let url = substitute_vars(&item.url, vars);
    let headers_str = substitute_vars(&item.headers, vars);
    let mut headers: Vec<ProxyHeaderEntry> = serde_json::from_str(&headers_str).unwrap_or_default();

    let body = match item.body_type.as_str() {
        "formdata" => {
            let entries =
                substitute_header_entries(parse_collection_header_entries(&item.form_data), vars);
            let boundary = format!("----AIProxyBoundary{}", uuid::Uuid::new_v4().simple());
            let body = build_multipart_body(entries, &boundary);
            if body.is_some() {
                ensure_content_type_header(
                    &mut headers,
                    &format!("multipart/form-data; boundary={boundary}"),
                );
            }
            body
        }
        "urlencoded" => {
            let entries =
                substitute_header_entries(parse_collection_header_entries(&item.url_encoded), vars);
            let body = build_urlencoded_body(entries);
            if body.is_some() {
                ensure_content_type_header(&mut headers, "application/x-www-form-urlencoded");
            }
            body
        }
        "raw" => {
            let body = substitute_vars(&item.body, vars);
            if body.trim().is_empty() {
                None
            } else {
                Some(body)
            }
        }
        _ => None,
    };

    Ok((url, headers, body))
}

fn collection_item_output_from_row(
    row: aiproxy_db::collections::CollectionItemRow,
) -> ApiCollectionItemOutput {
    ApiCollectionItemOutput {
        id: row.id,
        collection_id: row.collection_id,
        name: row.name,
        description: row.description,
        sort_order: row.sort_order,
        method: row.method,
        url: row.url,
        headers: parse_collection_header_entries(&row.headers),
        body: row.body,
        body_type: row.body_type,
        raw_language: row.raw_language,
        form_data: parse_collection_header_entries(&row.form_data),
        url_encoded: parse_collection_header_entries(&row.url_encoded),
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertApiCollectionInput {
    pub id: Option<String>,
    pub parent_id: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub sort_order: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertApiCollectionItemInput {
    pub id: Option<String>,
    pub collection_id: String,
    pub name: String,
    pub description: Option<String>,
    pub sort_order: Option<u32>,
    pub method: String,
    pub url: String,
    pub headers: Vec<ProxyHeaderEntry>,
    pub body: String,
    pub body_type: String,
    pub raw_language: String,
    pub form_data: Vec<ProxyHeaderEntry>,
    pub url_encoded: Vec<ProxyHeaderEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteApiCollectionInput {
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListApiCollectionItemsInput {
    pub collection_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetApiCollectionItemInput {
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteApiCollectionItemInput {
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveApiCollectionItemInput {
    pub id: String,
    pub target_collection_id: String,
    pub sort_order: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveApiCollectionInput {
    pub id: String,
    pub target_parent_id: Option<String>,
    pub sort_order: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSessionToCollectionInput {
    pub session_id: String,
    pub collection_id: String,
    pub name: Option<String>,
}

#[tauri::command]
pub fn list_api_collections(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<ApiCollectionOutput>, String> {
    let conn = state
        .read_db_connection()
        .lock()
        .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
    let rows = aiproxy_db::collections::list_all_collections(&conn)
        .map_err(|error| app_error(ERR_INTERNAL, format!("list collections: {error}")))?;
    Ok(rows
        .into_iter()
        .map(|r| ApiCollectionOutput {
            id: r.id,
            parent_id: r.parent_id,
            name: r.name,
            description: r.description,
            sort_order: r.sort_order,
            created_at: r.created_at,
            updated_at: r.updated_at,
        })
        .collect())
}

#[tauri::command]
pub fn upsert_api_collection(
    input: UpsertApiCollectionInput,
    state: State<'_, Arc<AppState>>,
) -> Result<ApiCollectionOutput, String> {
    let id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = chrono::Utc::now().to_rfc3339();

    let row = aiproxy_db::collections::CollectionRow {
        id: id.clone(),
        parent_id: input.parent_id,
        name: input.name,
        description: input.description.unwrap_or_default(),
        sort_order: input.sort_order.unwrap_or(0),
        created_at: now.clone(),
        updated_at: now,
    };

    {
        let conn = state
            .read_db_connection()
            .lock()
            .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
        aiproxy_db::collections::upsert_collection(&conn, &row)
            .map_err(|e| app_error(ERR_INTERNAL, format!("upsert collection: {e}")))?;
    }

    Ok(ApiCollectionOutput {
        id: row.id,
        parent_id: row.parent_id,
        name: row.name,
        description: row.description,
        sort_order: row.sort_order,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

#[tauri::command]
pub fn delete_api_collection(
    input: DeleteApiCollectionInput,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let conn = state
        .read_db_connection()
        .lock()
        .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
    aiproxy_db::collections::delete_collection(&conn, &input.id)
        .map_err(|e| app_error(ERR_INTERNAL, format!("delete collection: {e}")))?;
    Ok(())
}

// M15: async + `run_blocking_command` so the DB read runs on the blocking
// pool rather than the IPC thread. A collection may hold many items and each
// row carries a JSON request definition; loading them should not stall the UI
// command channel.
#[tauri::command]
pub async fn list_api_collection_items(
    input: ListApiCollectionItemsInput,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<ApiCollectionItemOutput>, String> {
    let state = Arc::clone(state.inner());
    run_blocking_command("list_api_collection_items", move || {
        let conn = state.read_db_connection();
        let conn_guard = conn
            .lock()
            .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
        let rows =
            aiproxy_db::collections::list_collection_items(&conn_guard, &input.collection_id)
                .map_err(|error| {
                    app_error(ERR_INTERNAL, format!("list collection items: {error}"))
                })?;
        Ok(rows
            .into_iter()
            .map(collection_item_output_from_row)
            .collect())
    })
    .await
}

#[tauri::command]
pub fn get_api_collection_item(
    input: GetApiCollectionItemInput,
    state: State<'_, Arc<AppState>>,
) -> Result<ApiCollectionItemOutput, String> {
    let conn = state
        .read_db_connection()
        .lock()
        .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
    let row = aiproxy_db::collections::get_collection_item(&conn, &input.id)
        .map_err(|e| app_error(ERR_INTERNAL, format!("get collection item: {e}")))?
        .ok_or_else(|| {
            app_error(
                ERR_INVALID_INPUT,
                format!("Collection item {} was not found.", input.id),
            )
        })?;

    Ok(collection_item_output_from_row(row))
}

#[tauri::command]
pub fn upsert_api_collection_item(
    input: UpsertApiCollectionItemInput,
    state: State<'_, Arc<AppState>>,
) -> Result<ApiCollectionItemOutput, String> {
    let id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = chrono::Utc::now().to_rfc3339();

    let headers_json = serde_json::to_string(&input.headers).unwrap_or_else(|_| "[]".into());
    let form_data_json = serde_json::to_string(&input.form_data).unwrap_or_else(|_| "[]".into());
    let url_encoded_json =
        serde_json::to_string(&input.url_encoded).unwrap_or_else(|_| "[]".into());

    let row = aiproxy_db::collections::CollectionItemRow {
        id: id.clone(),
        collection_id: input.collection_id,
        name: input.name,
        description: input.description.unwrap_or_default(),
        sort_order: input.sort_order.unwrap_or(0),
        method: input.method,
        url: input.url,
        headers: headers_json,
        body: input.body,
        body_type: input.body_type,
        raw_language: input.raw_language,
        form_data: form_data_json,
        url_encoded: url_encoded_json,
        created_at: now.clone(),
        updated_at: now,
    };

    {
        let conn = state
            .read_db_connection()
            .lock()
            .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
        aiproxy_db::collections::upsert_collection_item(&conn, &row)
            .map_err(|e| app_error(ERR_INTERNAL, format!("upsert collection item: {e}")))?;
    }

    Ok(collection_item_output_from_row(row))
}

#[tauri::command]
pub fn delete_api_collection_item(
    input: DeleteApiCollectionItemInput,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let conn = state
        .read_db_connection()
        .lock()
        .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
    aiproxy_db::collections::delete_collection_item(&conn, &input.id)
        .map_err(|e| app_error(ERR_INTERNAL, format!("delete collection item: {e}")))?;
    Ok(())
}

#[tauri::command]
pub fn move_api_collection_item(
    input: MoveApiCollectionItemInput,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let conn = state
        .read_db_connection()
        .lock()
        .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
    aiproxy_db::collections::move_collection_item(
        &conn,
        &input.id,
        &input.target_collection_id,
        input.sort_order,
        &now,
    )
    .map_err(|e| app_error(ERR_INTERNAL, format!("move collection item: {e}")))?;
    Ok(())
}

#[tauri::command]
pub fn move_api_collection(
    input: MoveApiCollectionInput,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let conn = state
        .read_db_connection()
        .lock()
        .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
    aiproxy_db::collections::move_collection(
        &conn,
        &input.id,
        input.target_parent_id.as_deref(),
        input.sort_order,
        &now,
    )
    .map_err(|e| app_error(ERR_INTERNAL, format!("move collection: {e}")))?;
    Ok(())
}

#[tauri::command]
pub fn save_session_to_collection(
    input: SaveSessionToCollectionInput,
    state: State<'_, Arc<AppState>>,
) -> Result<ApiCollectionItemOutput, String> {
    let detail = state
        .read_session_detail(&input.session_id)
        .ok_or_else(|| {
            app_error(
                ERR_INVALID_INPUT,
                format!("Session {} was not found.", input.session_id),
            )
        })?;
    let method = detail.summary.method.clone();
    let url = detail.summary.url.clone();
    let headers = detail.request_headers.clone();
    let body_text = detail
        .request_body
        .as_ref()
        .and_then(|body| body.inline_text())
        .unwrap_or_default();

    // Determine body type from Content-Type header
    let content_type = headers
        .iter()
        .find(|h| h.name.eq_ignore_ascii_case("content-type"))
        .map(|h| h.value.to_lowercase())
        .unwrap_or_default();

    let url_encoded = if content_type.contains("application/x-www-form-urlencoded") {
        parse_urlencoded_entries(&body_text)
    } else {
        Vec::new()
    };

    let (body_type, raw_language) = if content_type.contains("application/json") {
        ("raw".to_string(), "json".to_string())
    } else if content_type.contains("application/x-www-form-urlencoded") && !url_encoded.is_empty()
    {
        ("urlencoded".to_string(), "json".to_string())
    } else if !body_text.is_empty() {
        // Keep multipart or otherwise unparsed bodies visible/editable instead of
        // switching to a structured editor with empty fields.
        ("raw".to_string(), "text".to_string())
    } else {
        ("none".to_string(), "json".to_string())
    };

    let name = input.name.unwrap_or_else(|| format!("{} {}", method, url));

    let upsert_input = UpsertApiCollectionItemInput {
        id: None,
        collection_id: input.collection_id,
        name,
        description: None,
        sort_order: None,
        method,
        url,
        headers: headers.clone(),
        body: body_text,
        body_type,
        raw_language,
        form_data: vec![],
        url_encoded,
    };

    upsert_api_collection_item(upsert_input, state)
}

// ---------------------------------------------------------------------------
// Batch execute collection items
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchExecuteInput {
    pub item_ids: Vec<String>,
    pub environment_id: Option<String>,
}

#[tauri::command]
pub async fn batch_execute_collection_items(
    input: BatchExecuteInput,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<ProxySessionDetail>, String> {
    // M15: load the referenced items + the active environment's variables in a
    // single `spawn_blocking` so neither holds the global DB mutex on the
    // async task (and the IPC thread it ultimately runs on). The subsequent
    // request-sending + upsert loop stays async.
    let state_for_load = Arc::clone(state.inner());
    let (items, env_vars): (
        Vec<aiproxy_db::collections::CollectionItemRow>,
        std::collections::HashMap<String, String>,
    ) = run_blocking_command("batch_execute_collection_items_load", move || {
        let conn = state_for_load.read_db_connection();
        let conn_guard = conn
            .lock()
            .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;

        let mut found = Vec::new();
        for id in &input.item_ids {
            if let Some(item) = aiproxy_db::collections::get_collection_item(&conn_guard, id)
                .map_err(|e| app_error(ERR_INTERNAL, format!("get collection item: {e}")))?
            {
                found.push(item);
            }
        }

        let vars = match &input.environment_id {
            Some(env_id) => {
                aiproxy_db::environments::list_environment_variables(&conn_guard, env_id)
                    .map_err(|e| {
                        app_error(ERR_INTERNAL, format!("load environment variables: {e}"))
                    })?
                    .into_iter()
                    .filter(|v| v.enabled)
                    .map(|v| (v.key, v.value))
                    .collect()
            }
            None => std::collections::HashMap::new(),
        };

        Ok((found, vars))
    })
    .await?;

    let mut results = Vec::new();
    for item in items {
        let (url, headers, body) = build_collection_item_request(&item, &env_vars)?;

        match send_direct_request(item.method, url, headers, body).await {
            Ok(detail) => {
                let session_id = detail.id.clone();
                state.upsert_session_async(detail.clone()).await;
                tracing::debug!(
                    component = "desktop.commands",
                    event = "batch_execute_item_succeeded",
                    session_id = %session_id,
                    "batch_execute_item_succeeded"
                );
                results.push(detail);
            }
            Err(e) => {
                tracing::error!(
                    component = "desktop.commands",
                    event = "batch_execute_item_failed",
                    item_id = %item.id,
                    error = %e,
                    "batch_execute_item_failed"
                );
                return Err(app_error(
                    ERR_INTERNAL,
                    format!("batch execute failed at item '{}': {}", item.name, e),
                ));
            }
        }
    }

    Ok(results)
}

fn substitute_vars(template: &str, vars: &std::collections::HashMap<String, String>) -> String {
    let mut result = template.to_string();
    for (key, value) in vars {
        let pattern = format!("{{{{{}}}}}", key);
        result = result.replace(&pattern, value);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{
        build_collection_item_request, collection_item_output_from_row,
        parse_collection_header_entries, parse_urlencoded_entries,
    };
    use aiproxy_db::collections::CollectionItemRow;
    use std::collections::HashMap;

    #[test]
    fn collection_item_output_decodes_json_fields() {
        let output = collection_item_output_from_row(CollectionItemRow {
            id: "item-1".into(),
            collection_id: "collection-1".into(),
            name: "Create Order".into(),
            description: String::new(),
            sort_order: 0,
            method: "POST".into(),
            url: "https://api.example.com/orders".into(),
            headers: r#"[{"name":"Content-Type","value":"application/json"}]"#.into(),
            body: "{\"ok\":true}".into(),
            body_type: "raw".into(),
            raw_language: "json".into(),
            form_data: r#"[{"name":"file","value":"demo.txt"}]"#.into(),
            url_encoded: r#"[{"name":"page","value":"1"}]"#.into(),
            created_at: "2026-04-20T00:00:00Z".into(),
            updated_at: "2026-04-20T00:00:00Z".into(),
        });

        assert_eq!(output.headers.len(), 1);
        assert_eq!(output.headers[0].name, "Content-Type");
        assert_eq!(output.form_data[0].name, "file");
        assert_eq!(output.url_encoded[0].value, "1");
    }

    #[test]
    fn invalid_collection_json_falls_back_to_empty_entries() {
        assert!(parse_collection_header_entries("{invalid json]").is_empty());
    }

    #[test]
    fn urlencoded_body_is_decoded_into_entries() {
        let entries = parse_urlencoded_entries("name=alice+smith&city=New%20York");

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "name");
        assert_eq!(entries[0].value, "alice smith");
        assert_eq!(entries[1].name, "city");
        assert_eq!(entries[1].value, "New York");
    }

    #[test]
    fn collection_item_request_encodes_structured_urlencoded_body() {
        let item = CollectionItemRow {
            id: "item-1".into(),
            collection_id: "collection-1".into(),
            name: "Search".into(),
            description: String::new(),
            sort_order: 0,
            method: "POST".into(),
            url: "https://api.example.com/search?q={{query}}".into(),
            headers: "[]".into(),
            body: String::new(),
            body_type: "urlencoded".into(),
            raw_language: "json".into(),
            form_data: "[]".into(),
            url_encoded: r#"[{"name":"query","value":"{{query}}"},{"name":"","value":"ignored"}]"#
                .into(),
            created_at: "2026-04-20T00:00:00Z".into(),
            updated_at: "2026-04-20T00:00:00Z".into(),
        };
        let vars = HashMap::from([("query".to_string(), "alice smith".to_string())]);

        let (url, headers, body) = build_collection_item_request(&item, &vars).unwrap();

        assert_eq!(url, "https://api.example.com/search?q=alice smith");
        assert_eq!(
            headers,
            vec![aiproxy_proxy_core::ProxyHeaderEntry {
                name: "Content-Type".into(),
                value: "application/x-www-form-urlencoded".into(),
                is_pseudo: None,
            }]
        );
        assert_eq!(body.as_deref(), Some("query=alice+smith"));
    }
}

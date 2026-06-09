use super::common::*;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ApiEnvironmentOutput {
    pub id: String,
    pub name: String,
    pub sort_order: u32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ApiEnvironmentVariableOutput {
    pub id: String,
    pub environment_id: String,
    pub key: String,
    pub value: String,
    pub enabled: bool,
    pub sort_order: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertApiEnvironmentInput {
    pub id: Option<String>,
    pub name: String,
    pub sort_order: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteApiEnvironmentInput {
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListApiEnvironmentVariablesInput {
    pub environment_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetApiEnvironmentVariablesInput {
    pub environment_id: String,
    pub variables: Vec<ApiEnvironmentVariableInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiEnvironmentVariableInput {
    pub id: String,
    pub key: String,
    pub value: String,
    pub enabled: bool,
    pub sort_order: Option<u32>,
}

#[tauri::command]
pub fn list_api_environments(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<ApiEnvironmentOutput>, String> {
    let conn = state
        .read_db_connection()
        .lock()
        .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
    let rows = aiproxy_db::environments::list_environments(&conn)
        .map_err(|error| app_error(ERR_INTERNAL, format!("list environments: {error}")))?;
    Ok(rows
        .into_iter()
        .map(|r| ApiEnvironmentOutput {
            id: r.id,
            name: r.name,
            sort_order: r.sort_order,
            created_at: r.created_at,
            updated_at: r.updated_at,
        })
        .collect())
}

#[tauri::command]
pub fn upsert_api_environment(
    input: UpsertApiEnvironmentInput,
    state: State<'_, Arc<AppState>>,
) -> Result<ApiEnvironmentOutput, String> {
    let id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = chrono::Utc::now().to_rfc3339();

    let row = aiproxy_db::environments::EnvironmentRow {
        id: id.clone(),
        name: input.name,
        sort_order: input.sort_order.unwrap_or(0),
        created_at: now.clone(),
        updated_at: now,
    };

    {
        let conn = state
            .read_db_connection()
            .lock()
            .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
        aiproxy_db::environments::upsert_environment(&conn, &row)
            .map_err(|e| app_error(ERR_INTERNAL, format!("upsert environment: {e}")))?;
    }

    Ok(ApiEnvironmentOutput {
        id: row.id,
        name: row.name,
        sort_order: row.sort_order,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

#[tauri::command]
pub fn delete_api_environment(
    input: DeleteApiEnvironmentInput,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let conn = state
        .read_db_connection()
        .lock()
        .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
    aiproxy_db::environments::delete_environment(&conn, &input.id)
        .map_err(|e| app_error(ERR_INTERNAL, format!("delete environment: {e}")))?;
    Ok(())
}

#[tauri::command]
pub fn list_api_environment_variables(
    input: ListApiEnvironmentVariablesInput,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<ApiEnvironmentVariableOutput>, String> {
    let conn = state
        .read_db_connection()
        .lock()
        .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
    let rows = aiproxy_db::environments::list_environment_variables(&conn, &input.environment_id)
        .map_err(|error| {
        app_error(ERR_INTERNAL, format!("list environment variables: {error}"))
    })?;
    Ok(rows
        .into_iter()
        .map(|r| ApiEnvironmentVariableOutput {
            id: r.id,
            environment_id: r.environment_id,
            key: r.key,
            value: r.value,
            enabled: r.enabled,
            sort_order: r.sort_order,
        })
        .collect())
}

#[tauri::command]
pub fn set_api_environment_variables(
    input: SetApiEnvironmentVariablesInput,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let vars: Vec<aiproxy_db::environments::EnvironmentVariableRow> = input
        .variables
        .into_iter()
        .enumerate()
        .map(|(i, v)| aiproxy_db::environments::EnvironmentVariableRow {
            id: v.id,
            environment_id: input.environment_id.clone(),
            key: v.key,
            value: v.value,
            enabled: v.enabled,
            sort_order: v.sort_order.unwrap_or(i as u32),
        })
        .collect();

    let conn = state
        .read_db_connection()
        .lock()
        .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
    aiproxy_db::environments::set_environment_variables(&conn, &input.environment_id, &vars)
        .map_err(|e| app_error(ERR_INTERNAL, format!("set environment variables: {e}")))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// API Global variable commands
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ApiGlobalVariableOutput {
    pub id: String,
    pub key: String,
    pub value: String,
    pub enabled: bool,
    pub sort_order: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetApiGlobalVariablesInput {
    pub variables: Vec<ApiGlobalVariableInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiGlobalVariableInput {
    pub id: String,
    pub key: String,
    pub value: String,
    pub enabled: bool,
    pub sort_order: Option<u32>,
}

#[tauri::command]
pub fn list_api_global_variables(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<ApiGlobalVariableOutput>, String> {
    let conn = state
        .read_db_connection()
        .lock()
        .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
    let rows = aiproxy_db::environments::list_global_variables(&conn)
        .map_err(|error| app_error(ERR_INTERNAL, format!("list global variables: {error}")))?;
    Ok(rows
        .into_iter()
        .map(|r| ApiGlobalVariableOutput {
            id: r.id,
            key: r.key,
            value: r.value,
            enabled: r.enabled,
            sort_order: r.sort_order,
        })
        .collect())
}

#[tauri::command]
pub fn set_api_global_variables(
    input: SetApiGlobalVariablesInput,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let vars: Vec<aiproxy_db::environments::GlobalVariableRow> = input
        .variables
        .into_iter()
        .enumerate()
        .map(|(i, v)| aiproxy_db::environments::GlobalVariableRow {
            id: v.id,
            key: v.key,
            value: v.value,
            enabled: v.enabled,
            sort_order: v.sort_order.unwrap_or(i as u32),
        })
        .collect();

    let conn = state
        .read_db_connection()
        .lock()
        .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
    aiproxy_db::environments::set_global_variables(&conn, &vars)
        .map_err(|e| app_error(ERR_INTERNAL, format!("set global variables: {e}")))?;
    Ok(())
}

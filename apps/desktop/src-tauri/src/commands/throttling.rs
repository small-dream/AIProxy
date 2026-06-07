use super::common::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListThrottleProfilesInput {
    pub workspace_id: String,
}

#[tauri::command]
pub fn list_throttle_profiles(
    input: ListThrottleProfilesInput,
    state: State<'_, Arc<AppState>>,
) -> Vec<ThrottleProfileData> {
    state
        .read_throttle_manager()
        .list_profiles()
        .into_iter()
        .filter(|p| p.workspace_id == input.workspace_id)
        .collect()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListThrottleRulesInput {
    pub workspace_id: String,
}

#[tauri::command]
pub fn list_throttle_rules(
    input: ListThrottleRulesInput,
    state: State<'_, Arc<AppState>>,
) -> Vec<ThrottleRuleData> {
    state
        .read_throttle_manager()
        .list_rules()
        .into_iter()
        .filter(|rule| rule.workspace_id == input.workspace_id)
        .collect()
}

#[tauri::command]
pub fn save_throttle_profile(
    input: ThrottleProfileData,
    state: State<'_, Arc<AppState>>,
) -> Result<ThrottleProfileData, String> {
    // Persist to DB first
    {
        let conn = state
            .read_db_connection()
            .lock()
            .expect("db mutex should not be poisoned");
        let row = aiproxy_db::rules::ThrottleProfileRow {
            id: input.id.clone(),
            workspace_id: input.workspace_id.clone(),
            name: input.name.clone(),
            note: input.note.clone(),
            enabled: input.enabled,
            preset: input.preset,
            latency_ms: input.latency_ms,
            upload_kbps: input.upload_kbps,
            download_kbps: input.download_kbps,
            packet_loss_ratio: input.packet_loss_ratio,
        };
        aiproxy_db::rules::save_throttle_profile(&conn, &row)
            .map_err(|error| app_error(ERR_INTERNAL, format!("save throttle profile: {error}")))?;
    }

    let saved = state.read_throttle_manager().save_profile(input);
    if saved.enabled {
        state
            .read_throttle_manager()
            .set_active_profile(&saved.workspace_id, Some(&saved.id));
    }

    Ok(saved)
}

#[tauri::command]
pub fn save_throttle_rule(
    input: ThrottleRuleData,
    state: State<'_, Arc<AppState>>,
) -> Result<ThrottleRuleData, String> {
    {
        let conn = state
            .read_db_connection()
            .lock()
            .expect("db mutex should not be poisoned");
        let row = aiproxy_db::rules::ThrottleRuleRow {
            id: input.id.clone(),
            workspace_id: input.workspace_id.clone(),
            name: input.name.clone(),
            note: input.note.clone(),
            enabled: input.enabled,
            priority: input.priority,
            profile_id: input.profile_id.clone(),
            url_pattern: input.url_pattern.clone(),
            methods: serde_json::to_string(&input.methods).unwrap_or_else(|_| "[]".to_string()),
            stage: input.stage.clone(),
        };
        aiproxy_db::rules::save_throttle_rule(&conn, &row)
            .map_err(|error| app_error(ERR_INTERNAL, format!("save throttle rule: {error}")))?;
    }

    Ok(state.read_throttle_manager().save_rule(input))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteThrottleRuleInput {
    pub rule_id: String,
}

#[tauri::command]
pub fn delete_throttle_rule(
    input: DeleteThrottleRuleInput,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    {
        let conn = state
            .read_db_connection()
            .lock()
            .expect("db mutex should not be poisoned");
        aiproxy_db::rules::delete_throttle_rule(&conn, &input.rule_id)
            .map_err(|error| app_error(ERR_INTERNAL, format!("delete throttle rule: {error}")))?;
    }
    state.read_throttle_manager().delete_rule(&input.rule_id);
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetActiveThrottleProfileInput {
    pub workspace_id: String,
    pub profile_id: Option<String>,
}

#[tauri::command]
pub fn set_active_throttle_profile(
    input: SetActiveThrottleProfileInput,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    {
        let conn = state
            .read_db_connection()
            .lock()
            .expect("db mutex should not be poisoned");
        aiproxy_db::rules::set_active_throttle_profile(
            &conn,
            &input.workspace_id,
            input.profile_id.as_deref(),
        )
        .map_err(|error| {
            app_error(
                ERR_INTERNAL,
                format!("set active throttle profile: {error}"),
            )
        })?;
    }

    state
        .read_throttle_manager()
        .set_active_profile(&input.workspace_id, input.profile_id.as_deref());

    Ok(())
}

#[tauri::command]
pub fn get_throttle_runtime_stats(state: State<'_, Arc<AppState>>) -> ThrottleRuntimeStats {
    state.read_throttle_manager().runtime_stats()
}

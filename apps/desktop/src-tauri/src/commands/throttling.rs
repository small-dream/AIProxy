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
) -> Result<Vec<ThrottleProfileData>, String> {
    Ok(state
        .read_throttle_manager()
        .list_profiles()
        .into_iter()
        .filter(|p| p.workspace_id == input.workspace_id)
        .collect())
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
) -> Result<Vec<ThrottleRuleData>, String> {
    Ok(state
        .read_throttle_manager()
        .list_rules()
        .into_iter()
        .filter(|rule| rule.workspace_id == input.workspace_id)
        .collect())
}

#[tauri::command]
pub async fn save_throttle_profile(
    input: ThrottleProfileData,
    state: State<'_, Arc<AppState>>,
) -> Result<ThrottleProfileData, String> {
    let state = Arc::clone(state.inner());
    let db_state = Arc::clone(&state);
    let row_input = input.clone();
    run_blocking_command("save_throttle_profile", move || {
        let conn_guard = db_state.lock_db_for_ipc()?;
        let row = aiproxy_db::rules::ThrottleProfileRow {
            id: row_input.id.clone(),
            workspace_id: row_input.workspace_id.clone(),
            name: row_input.name.clone(),
            note: row_input.note.clone(),
            enabled: row_input.enabled,
            preset: row_input.preset,
            latency_ms: row_input.latency_ms,
            upload_kbps: row_input.upload_kbps,
            download_kbps: row_input.download_kbps,
            packet_loss_ratio: row_input.packet_loss_ratio,
        };
        aiproxy_db::rules::save_throttle_profile(&conn_guard, &row)
            .map_err(|error| app_error(ERR_INTERNAL, format!("save throttle profile: {error}")))?;
        Ok(())
    })
    .await?;

    let saved = state.read_throttle_manager().save_profile(input);
    if saved.enabled {
        state
            .read_throttle_manager()
            .set_active_profile(&saved.workspace_id, Some(&saved.id));
    }

    Ok(saved)
}

#[tauri::command]
pub async fn save_throttle_rule(
    input: ThrottleRuleData,
    state: State<'_, Arc<AppState>>,
) -> Result<ThrottleRuleData, String> {
    let state = Arc::clone(state.inner());
    let db_state = Arc::clone(&state);
    let row_input = input.clone();
    run_blocking_command("save_throttle_rule", move || {
        let conn_guard = db_state.lock_db_for_ipc()?;
        let row = aiproxy_db::rules::ThrottleRuleRow {
            id: row_input.id.clone(),
            workspace_id: row_input.workspace_id.clone(),
            name: row_input.name.clone(),
            note: row_input.note.clone(),
            enabled: row_input.enabled,
            priority: row_input.priority,
            profile_id: row_input.profile_id.clone(),
            url_pattern: row_input.url_pattern.clone(),
            methods: serde_json::to_string(&row_input.methods).unwrap_or_else(|_| "[]".to_string()),
            stage: row_input.stage.clone(),
            match_type: row_input
                .match_type
                .clone()
                .unwrap_or_else(|| "contains".to_string()),
        };
        aiproxy_db::rules::save_throttle_rule(&conn_guard, &row)
            .map_err(|error| app_error(ERR_INTERNAL, format!("save throttle rule: {error}")))?;
        Ok(())
    })
    .await?;

    Ok(state.read_throttle_manager().save_rule(input))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteThrottleRuleInput {
    pub rule_id: String,
}

#[tauri::command]
pub async fn delete_throttle_rule(
    input: DeleteThrottleRuleInput,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let state = Arc::clone(state.inner());
    let db_state = Arc::clone(&state);
    let rule_id = input.rule_id.clone();
    run_blocking_command("delete_throttle_rule", move || {
        let conn_guard = db_state.lock_db_for_ipc()?;
        aiproxy_db::rules::delete_throttle_rule(&conn_guard, &input.rule_id)
            .map_err(|error| app_error(ERR_INTERNAL, format!("delete throttle rule: {error}")))?;
        Ok(())
    })
    .await?;

    state.read_throttle_manager().delete_rule(&rule_id);
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetActiveThrottleProfileInput {
    pub workspace_id: String,
    pub profile_id: Option<String>,
}

#[tauri::command]
pub async fn set_active_throttle_profile(
    input: SetActiveThrottleProfileInput,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let state = Arc::clone(state.inner());
    let db_state = Arc::clone(&state);
    let workspace_id = input.workspace_id.clone();
    let profile_id = input.profile_id.clone();
    run_blocking_command("set_active_throttle_profile", move || {
        let conn_guard = db_state.lock_db_for_ipc()?;
        aiproxy_db::rules::set_active_throttle_profile(
            &conn_guard,
            &input.workspace_id,
            input.profile_id.as_deref(),
        )
        .map_err(|error| {
            app_error(
                ERR_INTERNAL,
                format!("set active throttle profile: {error}"),
            )
        })?;
        Ok(())
    })
    .await?;

    state
        .read_throttle_manager()
        .set_active_profile(&workspace_id, profile_id.as_deref());

    Ok(())
}

#[tauri::command]
pub fn get_throttle_runtime_stats(state: State<'_, Arc<AppState>>) -> ThrottleRuntimeStats {
    state.read_throttle_manager().runtime_stats()
}

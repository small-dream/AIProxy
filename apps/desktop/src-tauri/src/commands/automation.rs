use super::common::*;

use crate::automation::{
    AutomationApplyResult, AutomationChangeView, AutomationError, ClearAgentAutomationResult,
};
use aiproxy_agent_control::{
    ClearAgentAutomationParams, GetAutomationChangeParams, RollbackAutomationChangeParams,
};

fn automation_error(error: AutomationError) -> String {
    match error.details {
        Some(details) => app_error_with_details(&error.code, &error.message, details),
        None => app_error(&error.code, &error.message),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RollbackAutomationChangeInput {
    pub change_id: String,
    pub expected_scope_hash: String,
}

#[tauri::command]
pub async fn list_automation_changes(
    state: State<'_, Arc<AppState>>,
    limit: Option<u32>,
) -> Result<Vec<AutomationChangeView>, String> {
    let state = Arc::clone(state.inner());
    run_blocking_command("list_automation_changes", move || {
        state
            .list_automation_changes(limit.unwrap_or(20))
            .map_err(automation_error)
    })
    .await
}

#[tauri::command]
pub async fn get_automation_change(
    state: State<'_, Arc<AppState>>,
    change_id: String,
) -> Result<AutomationChangeView, String> {
    let state = Arc::clone(state.inner());
    run_blocking_command("get_automation_change", move || {
        state
            .get_automation_change(GetAutomationChangeParams { change_id })
            .map_err(automation_error)
    })
    .await
}

#[tauri::command]
pub async fn rollback_automation_change(
    state: State<'_, Arc<AppState>>,
    input: RollbackAutomationChangeInput,
) -> Result<AutomationApplyResult, String> {
    state
        .rollback_automation_change(
            RollbackAutomationChangeParams {
                change_id: input.change_id,
                expected_scope_hash: input.expected_scope_hash,
            },
            None,
        )
        .await
        .map_err(automation_error)
}

#[tauri::command]
pub async fn promote_automation_change(
    state: State<'_, Arc<AppState>>,
    change_id: String,
) -> Result<AutomationChangeView, String> {
    state
        .promote_automation_change(change_id)
        .await
        .map_err(automation_error)
}

#[tauri::command]
pub async fn clear_agent_automation(
    state: State<'_, Arc<AppState>>,
    scope: String,
    workspace_id: Option<String>,
    lifecycle: String,
) -> Result<ClearAgentAutomationResult, String> {
    state
        .clear_agent_automation(ClearAgentAutomationParams {
            scope,
            workspace_id,
            lifecycle,
        })
        .await
        .map_err(automation_error)
}

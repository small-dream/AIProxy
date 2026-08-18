use super::common::*;

#[tauri::command]
pub async fn list_script_session_trace(
    input: ListScriptSessionTraceInput,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<ScriptSessionTraceOutput>, String> {
    let state = Arc::clone(state.inner());
    run_blocking_command("list_script_session_trace", move || {
        let conn_guard = state.lock_db_for_ipc()?;
        let runs = aiproxy_db::rules::load_script_runs_for_session(&conn_guard, &input.session_id)
            .map_err(|error| app_error(ERR_INTERNAL, format!("Load script runs: {error}")))?;
        let run_ids: Vec<String> = runs.iter().map(|run| run.id.clone()).collect();
        let entries =
            aiproxy_db::rules::load_script_run_entries(&conn_guard, &run_ids).map_err(|error| {
                app_error(ERR_INTERNAL, format!("Load script run entries: {error}"))
            })?;

        Ok(runs
            .into_iter()
            .map(|run| ScriptSessionTraceOutput {
                duration_ms: run.duration_ms,
                entries: entries
                    .iter()
                    .filter(|entry| entry.run_id == run.id)
                    .map(|entry| ScriptRunEntryOutput {
                        kind: entry.kind.clone(),
                        level: entry.level.clone(),
                        key: entry.key.clone(),
                        message: entry.message.clone(),
                        payload_json: entry.payload_json.clone(),
                        sequence: entry.seq,
                    })
                    .collect(),
                outcome: run.outcome,
                rule_id: run.rule_id,
                stage: run.stage,
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn list_rewrite_session_trace(
    input: ListRewriteSessionTraceInput,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<RewriteSessionTraceOutput>, String> {
    let state = Arc::clone(state.inner());
    run_blocking_command("list_rewrite_session_trace", move || {
        let conn_guard = state.lock_db_for_ipc()?;
        let runs = aiproxy_db::rules::load_rewrite_runs_for_session(&conn_guard, &input.session_id)
            .map_err(|error| app_error(ERR_INTERNAL, format!("Load rewrite runs: {error}")))?;
        let run_ids: Vec<String> = runs.iter().map(|run| run.id.clone()).collect();
        let entries = aiproxy_db::rules::load_rewrite_run_entries(&conn_guard, &run_ids).map_err(
            |error| app_error(ERR_INTERNAL, format!("Load rewrite run entries: {error}")),
        )?;

        Ok(runs
            .into_iter()
            .map(|run| RewriteSessionTraceOutput {
                duration_ms: run.duration_ms,
                entries: entries
                    .iter()
                    .filter(|entry| entry.run_id == run.id)
                    .map(|entry| RewriteRunEntryOutput {
                        after: entry.after_value.clone(),
                        before: entry.before_value.clone(),
                        kind: entry.kind.clone(),
                        key: entry.key.clone(),
                        message: entry.message.clone(),
                        sequence: entry.seq,
                    })
                    .collect(),
                outcome: run.outcome,
                rule_id: run.rule_id,
                rule_name: run.rule_name,
                rewrite_type: run.rewrite_type,
                stage: run.stage,
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn list_map_session_trace(
    input: ListMapSessionTraceInput,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<MapSessionTraceOutput>, String> {
    let state = Arc::clone(state.inner());
    run_blocking_command("list_map_session_trace", move || {
        let conn_guard = state.lock_db_for_ipc()?;
        let runs = aiproxy_db::rules::load_map_runs_for_session(&conn_guard, &input.session_id)
            .map_err(|error| app_error(ERR_INTERNAL, format!("Load map runs: {error}")))?;

        Ok(runs
            .into_iter()
            .map(|run| MapSessionTraceOutput {
                duration_ms: run.duration_ms,
                local_path: run.local_path,
                mapped_url: run.mapped_url,
                mode: run.mode,
                original_url: run.original_url,
                outcome: run.outcome,
                rule_id: run.rule_id,
                rule_name: run.rule_name,
                source_pattern: run.source_pattern,
                target_value: run.target_value,
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn list_throttle_session_trace(
    input: ListThrottleSessionTraceInput,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<ThrottleSessionTraceOutput>, String> {
    let state = Arc::clone(state.inner());
    run_blocking_command("list_throttle_session_trace", move || {
        let conn_guard = state.lock_db_for_ipc()?;
        let runs =
            aiproxy_db::rules::load_throttle_runs_for_session(&conn_guard, &input.session_id)
                .map_err(|error| app_error(ERR_INTERNAL, format!("Load throttle runs: {error}")))?;

        Ok(runs
            .into_iter()
            .map(|run| ThrottleSessionTraceOutput {
                body_bytes: run.body_bytes,
                delay_ms: run.delay_ms,
                latency_ms: run.latency_ms,
                message: run.message,
                outcome: run.outcome,
                profile_id: run.profile_id,
                profile_name: run.profile_name,
                rule_id: run.rule_id,
                rule_name: run.rule_name,
                sequence: run.sequence,
                stage: run.stage,
                transfer_delay_ms: run.transfer_delay_ms,
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn list_throttled_session_ids(
    input: ListThrottledSessionIdsInput,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<String>, String> {
    let state = Arc::clone(state.inner());
    run_blocking_command("list_throttled_session_ids", move || {
        let conn_guard = state.lock_db_for_ipc()?;
        aiproxy_db::rules::load_throttled_session_ids(&conn_guard, &input.workspace_id).map_err(
            |error| app_error(ERR_INTERNAL, format!("Load throttled session IDs: {error}")),
        )
    })
    .await
}

#[tauri::command]
pub fn list_breakpoint_rules(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<BreakpointRule>, String> {
    Ok(state.read_breakpoint_manager().list_rules())
}

#[tauri::command]
pub async fn set_breakpoint_rules(
    rules: Vec<BreakpointRule>,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    // Pre-compute the DB rows before the closure (manager mutation still needs
    // the original `rules` Vec outside the closure).
    let rows: Vec<aiproxy_db::rules::BreakpointRuleRow> = rules
        .iter()
        .map(|r| aiproxy_db::rules::BreakpointRuleRow {
            id: r.id.clone(),
            enabled: r.enabled,
            url_pattern: r.url_pattern.clone(),
            methods: serde_json::to_string(&r.methods).unwrap_or_default(),
            stage: match r.stage {
                BreakpointStage::Request => "Request".to_string(),
                BreakpointStage::Response => "Response".to_string(),
            },
            match_type: r
                .match_type
                .clone()
                .unwrap_or_else(|| "contains".to_string()),
        })
        .collect();

    let state = Arc::clone(state.inner());
    // Persist to DB on the blocking pool.
    run_blocking_command("set_breakpoint_rules", {
        let state = Arc::clone(&state);
        move || {
            let conn_guard = state.lock_db_for_ipc()?;
            aiproxy_db::rules::replace_breakpoint_rules(&conn_guard, &rows).map_err(|error| {
                app_error(ERR_INTERNAL, format!("Set breakpoint rules: {error}"))
            })?;
            Ok(())
        }
    })
    .await?;

    state.read_breakpoint_manager().set_rules(rules);
    Ok(())
}

#[tauri::command]
pub fn resolve_breakpoint(
    resolution: BreakpointResolution,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let session_id = resolution.session_id.clone();
    state
        .read_breakpoint_manager()
        .resolve(&session_id, resolution)
}

// --- Rewrite commands ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListRewriteRulesInput {
    pub workspace_id: String,
}

#[tauri::command]
pub fn list_rewrite_rules(
    input: ListRewriteRulesInput,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<RewriteRule>, String> {
    Ok(state
        .read_rewrite_manager()
        .list_rules()
        .into_iter()
        .filter(|r| r.workspace_id == input.workspace_id)
        .collect())
}

#[tauri::command]
pub async fn save_rewrite_rule(
    input: RewriteRule,
    state: State<'_, Arc<AppState>>,
) -> Result<RewriteRule, String> {
    // Build the DB row up front so `input` stays available for the manager
    // mutation after the closure runs.
    let row = aiproxy_db::rules::RewriteRuleRow {
        id: input.id.clone(),
        workspace_id: input.workspace_id.clone(),
        name: input.name.clone(),
        note: input.note.clone(),
        enabled: input.enabled,
        priority: input.priority,
        match_methods: serde_json::to_string(&input.r#match.methods).unwrap_or_default(),
        match_stage: input.r#match.stage.clone(),
        match_url_pattern: input.r#match.url_pattern.clone(),
        match_type: input
            .r#match
            .match_type
            .clone()
            .unwrap_or_else(|| "contains".to_string()),
        rewrite_type: input.rewrite_type.clone(),
        // D2: the DB payload column stores the ordered actions array in the
        // new format; legacy rows (a single action object) are normalized when
        // read back by the proxy-core rewrite_actions() expansion.
        payload: serde_json::to_string(&input.actions).unwrap_or_else(|_| "[]".to_string()),
    };

    let state = Arc::clone(state.inner());
    // Persist to DB on the blocking pool.
    run_blocking_command("save_rewrite_rule", {
        let state = Arc::clone(&state);
        move || {
            let conn_guard = state.lock_db_for_ipc()?;
            aiproxy_db::rules::save_rewrite_rule(&conn_guard, &row)
                .map_err(|error| app_error(ERR_INTERNAL, format!("Save rewrite rule: {error}")))?;
            Ok(())
        }
    })
    .await?;

    Ok(state.read_rewrite_manager().save_rule(input))
}

// --- Map commands ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListMapRulesInput {
    pub workspace_id: String,
    pub mode: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListScriptRulesInput {
    pub workspace_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickScriptFileInput {
    /// Localized title for the OS file dialog (supplied by the renderer for
    /// i18n; the renderer never supplies a path — see H10).
    pub title: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptSourceFileOutput {
    pub file_name: String,
    pub language: String,
    pub path: String,
    pub source_code: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListScriptSessionTraceInput {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListRewriteSessionTraceInput {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListMapSessionTraceInput {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListThrottleSessionTraceInput {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListThrottledSessionIdsInput {
    pub workspace_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptRunEntryOutput {
    pub kind: String,
    pub level: Option<String>,
    pub key: Option<String>,
    pub message: Option<String>,
    pub payload_json: Option<String>,
    pub sequence: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptSessionTraceOutput {
    pub duration_ms: u128,
    pub entries: Vec<ScriptRunEntryOutput>,
    pub outcome: String,
    pub rule_id: String,
    pub stage: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RewriteRunEntryOutput {
    pub after: Option<String>,
    pub before: Option<String>,
    pub kind: String,
    pub key: Option<String>,
    pub message: Option<String>,
    pub sequence: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RewriteSessionTraceOutput {
    pub duration_ms: u128,
    pub entries: Vec<RewriteRunEntryOutput>,
    pub outcome: String,
    pub rule_id: String,
    pub rule_name: String,
    pub rewrite_type: String,
    pub stage: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapSessionTraceOutput {
    pub duration_ms: u128,
    pub local_path: Option<String>,
    pub mapped_url: Option<String>,
    pub mode: String,
    pub original_url: String,
    pub outcome: String,
    pub rule_id: String,
    pub rule_name: String,
    pub source_pattern: String,
    pub target_value: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThrottleSessionTraceOutput {
    pub body_bytes: usize,
    pub delay_ms: u64,
    pub latency_ms: u64,
    pub message: Option<String>,
    pub outcome: String,
    pub profile_id: String,
    pub profile_name: String,
    pub rule_id: Option<String>,
    pub rule_name: Option<String>,
    pub sequence: u32,
    pub stage: String,
    pub transfer_delay_ms: u64,
}

#[tauri::command]
pub fn list_map_rules(
    input: ListMapRulesInput,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<MapRule>, String> {
    Ok(state
        .read_map_manager()
        .list_rules()
        .into_iter()
        .filter(|r| r.workspace_id == input.workspace_id)
        .filter(|r| match &input.mode {
            Some(mode) => r.mode == *mode,
            None => true,
        })
        .collect())
}

#[tauri::command]
pub async fn save_map_rule(
    input: MapRule,
    state: State<'_, Arc<AppState>>,
) -> Result<MapRule, String> {
    validate_map_rule(&input)?;

    // Build the DB row up front so `input` stays available for the manager
    // mutation after the closure runs.
    let row = aiproxy_db::rules::MapRuleRow {
        id: input.id.clone(),
        workspace_id: input.workspace_id.clone(),
        mode: input.mode.clone(),
        name: input.name.clone(),
        note: input.note.clone(),
        enabled: input.enabled,
        preserve_path: input.preserve_path,
        preserve_query: input.preserve_query,
        priority: input.priority,
        source_pattern: input.source_pattern.clone(),
        target_value: input.target_value.clone(),
        match_type: input
            .match_type
            .clone()
            .unwrap_or_else(|| "contains".to_string()),
    };

    let state = Arc::clone(state.inner());
    // Persist to DB on the blocking pool.
    run_blocking_command("save_map_rule", {
        let state = Arc::clone(&state);
        move || {
            let conn_guard = state.lock_db_for_ipc()?;
            aiproxy_db::rules::save_map_rule(&conn_guard, &row)
                .map_err(|error| app_error(ERR_INTERNAL, format!("Save map rule: {error}")))?;
            Ok(())
        }
    })
    .await?;

    Ok(state.read_map_manager().save_rule(input))
}

fn validate_map_rule(input: &MapRule) -> Result<(), String> {
    if input.name.trim().is_empty() {
        return Err(app_error(ERR_INVALID_INPUT, "Map rule name is required."));
    }
    if input.source_pattern.trim().is_empty() {
        return Err(app_error(
            ERR_INVALID_INPUT,
            "Map rule source pattern is required.",
        ));
    }
    if input.target_value.trim().is_empty() {
        return Err(app_error(
            ERR_INVALID_INPUT,
            "Map rule target value is required.",
        ));
    }

    match input.mode.as_str() {
        "remote" => {
            let url = Url::parse(input.target_value.trim()).map_err(|error| {
                app_error(
                    ERR_INVALID_INPUT,
                    format!("Map remote target URL is invalid: {error}"),
                )
            })?;
            if url.scheme() != "http" && url.scheme() != "https" {
                return Err(app_error(
                    ERR_INVALID_INPUT,
                    "Map remote target URL must start with http:// or https://.",
                ));
            }
        }
        "local" => {
            let path = Path::new(input.target_value.trim());
            if !path.exists() {
                return Err(app_error(
                    ERR_INVALID_INPUT,
                    format!("Map local target path does not exist: {}", path.display()),
                ));
            }
            if !path.is_file() && !path.is_dir() {
                return Err(app_error(
                    ERR_INVALID_INPUT,
                    format!(
                        "Map local target path must be a file or folder: {}",
                        path.display()
                    ),
                ));
            }
        }
        other => {
            return Err(app_error(
                ERR_INVALID_INPUT,
                format!("Unsupported map rule mode: {other}"),
            ))
        }
    }

    Ok(())
}

// --- Script rule commands ---

#[tauri::command]
pub fn list_script_rules(
    input: ListScriptRulesInput,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<ScriptRule>, String> {
    Ok(state
        .read_script_manager()
        .list_rules()
        .into_iter()
        .filter(|rule| rule.workspace_id == input.workspace_id)
        .collect())
}

#[tauri::command]
pub async fn save_script_rule(
    input: ScriptRule,
    state: State<'_, Arc<AppState>>,
) -> Result<ScriptRule, String> {
    let compiled = compile_script_rule(input)?;

    // Build the DB row up front from `compiled`; the manager mutation still
    // needs `compiled` outside the closure.
    let row = aiproxy_db::rules::ScriptRuleRow {
        id: compiled.rule.id.clone(),
        workspace_id: compiled.rule.workspace_id.clone(),
        name: compiled.rule.name.clone(),
        note: compiled.rule.note.clone(),
        enabled: compiled.rule.enabled,
        priority: compiled.rule.priority,
        match_methods: serde_json::to_string(&compiled.rule.r#match.methods).unwrap_or_default(),
        match_stage: compiled.rule.r#match.stage.clone(),
        match_url_pattern: compiled.rule.r#match.url_pattern.clone(),
        match_type: compiled
            .rule
            .r#match
            .match_type
            .clone()
            .unwrap_or_else(|| "contains".to_string()),
        language: match compiled.rule.language {
            ScriptRuleLanguage::JavaScript => "javascript".to_string(),
            ScriptRuleLanguage::TypeScript => "typescript".to_string(),
        },
        source_type: match compiled.rule.source_type {
            ScriptRuleSourceType::Inline => "inline".to_string(),
            ScriptRuleSourceType::FileImport => "fileImport".to_string(),
        },
        source_code: compiled.rule.source_code.clone(),
        source_path: compiled.rule.source_path.clone(),
        entrypoints: serde_json::to_string(&compiled.rule.entrypoints)
            .unwrap_or_else(|_| "{}".to_string()),
        // M10: `compiled_code`/`source_map` are `Arc<String>`; deref to
        // owned String for the DB row.
        compiled_code: (*compiled.compiled_code).clone(),
        source_map: compiled.source_map.as_ref().map(|arc| (**arc).clone()),
        updated_at: chrono::Utc::now().to_rfc3339(),
    };

    let state = Arc::clone(state.inner());
    // Persist to DB on the blocking pool.
    run_blocking_command("save_script_rule", {
        let state = Arc::clone(&state);
        move || {
            let conn_guard = state.lock_db_for_ipc()?;
            aiproxy_db::rules::save_script_rule(&conn_guard, &row)
                .map_err(|error| app_error(ERR_INTERNAL, format!("Save script rule: {error}")))?;
            Ok(())
        }
    })
    .await?;

    Ok(state.read_script_manager().save_rule(compiled))
}

/// H10 (closed): the backend owns the file dialog. The renderer supplies only a
/// localized dialog title — never a path — and the OS file picker is driven from
/// the Rust side via `tauri-plugin-dialog`. This closes the arbitrary-file-read
/// primitive under the compromised-renderer threat model: a malicious renderer
/// can trigger the dialog but cannot inject a path, because the picker result
/// never crosses the IPC boundary as input. Symlinks are resolved by
/// canonicalizing the picker result before read, so a swapped link target does
/// not redirect the read after selection. Returns `None` when the user cancels.
#[tauri::command]
pub async fn pick_and_read_script_file(
    app: tauri::AppHandle,
    input: PickScriptFileInput,
) -> Result<Option<ScriptSourceFileOutput>, String> {
    use tauri_plugin_dialog::DialogExt;

    // Bridge the callback-based picker into an awaitable future.
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Script", &["js", "mjs", "ts", "mts"])
        .set_title(input.title)
        .pick_file(move |picked| {
            let _ = tx.send(picked);
        });
    let Some(picked) = rx
        .await
        .map_err(|e| app_error(ERR_INTERNAL, format!("dialog channel closed: {e}")))?
    else {
        // User cancelled the picker.
        return Ok(None);
    };

    // Resolve the FilePath (Path or Url) to a filesystem path. The picker is
    // single-select, so this is always one path.
    let path_buf = match picked.into_path() {
        Ok(p) => p,
        Err(_) => return Err(err_invalid()),
    };

    // Canonicalize to resolve any symlink at the picked location, then verify
    // the extension on the canonical target (a symlink `innocent.js` pointing
    // at a non-script must still be rejected).
    let canon = std::fs::canonicalize(&path_buf).map_err(|_| err_invalid())?;
    let language = script_language_for(&canon).ok_or_else(err_invalid)?;

    // The actual file read happens off the async worker thread.
    let bytes = run_blocking_command("pick_and_read_script_file_read", move || {
        std::fs::read(&canon).map_err(|_| err_invalid())
    })
    .await?;
    if bytes.len() > MAX_IMPORTED_SCRIPT_BYTES {
        return Err(app_error(
            ERR_INVALID_INPUT,
            format!(
                "Script file exceeds the {} KB limit",
                MAX_IMPORTED_SCRIPT_BYTES / 1024
            ),
        ));
    }

    let source_code = String::from_utf8(bytes).map_err(|_| err_invalid())?;
    let file_name = path_buf
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("script")
        .to_string();

    Ok(Some(ScriptSourceFileOutput {
        file_name,
        language: language.to_string(),
        path: path_buf.to_string_lossy().into_owned(),
        source_code,
    }))
}

fn err_invalid() -> String {
    app_error(ERR_INVALID_INPUT, "Unsupported script file path.")
}

/// Resolve `path` to a script extension language, or `None` if not a script.
fn script_language_for(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "js" | "mjs" => Some("javascript"),
        "ts" | "mts" => Some("typescript"),
        _ => None,
    }
}

// --- Delete rule (shared for rewrite/map) ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRuleInput {
    pub rule_id: String,
    pub rule_type: String,
}

#[tauri::command]
pub async fn delete_rule(
    input: DeleteRuleInput,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    // Validate rule_type early to avoid double-wrapping with app_error
    match input.rule_type.as_str() {
        "rewrite" | "map" | "dns" | "script" => {}
        _ => {
            return Err(app_error(
                ERR_INVALID_INPUT,
                format!("Unknown rule type: {}", input.rule_type),
            ))
        }
    }

    // Capture owned copies for the closure; `input` is reused for the
    // post-DB manager dispatch.
    let rule_type = input.rule_type.clone();
    let rule_id = input.rule_id.clone();
    let state = Arc::clone(state.inner());
    // Persist to DB on the blocking pool.
    run_blocking_command("delete_rule", {
        let state = Arc::clone(&state);
        move || {
            let conn_guard = state.lock_db_for_ipc()?;
            let db_result = match rule_type.as_str() {
                "rewrite" => aiproxy_db::rules::delete_rewrite_rule(&conn_guard, &rule_id),
                "map" => aiproxy_db::rules::delete_map_rule(&conn_guard, &rule_id),
                "dns" => aiproxy_db::rules::delete_dns_mapping(&conn_guard, &rule_id),
                "script" => aiproxy_db::rules::delete_script_rule(&conn_guard, &rule_id),
                _ => unreachable!("validated above"),
            };
            db_result.map_err(|error| app_error(ERR_INTERNAL, format!("Delete rule: {error}")))?;
            Ok(())
        }
    })
    .await?;

    match input.rule_type.as_str() {
        "rewrite" => state.read_rewrite_manager().delete_rule(&input.rule_id),
        "map" => state.read_map_manager().delete_rule(&input.rule_id),
        "dns" => state.read_dns_manager().delete_rule(&input.rule_id),
        "script" => state.read_script_manager().delete_rule(&input.rule_id),
        _ => unreachable!("validated above"),
    }

    Ok(())
}

// --- DNS mapping commands ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListDnsMappingsInput {
    pub workspace_id: String,
}

#[tauri::command]
pub fn list_dns_mappings(
    input: ListDnsMappingsInput,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<DnsMappingRule>, String> {
    let rules = state.read_dns_manager().list_rules();
    Ok(rules
        .into_iter()
        .filter(|r| r.workspace_id == input.workspace_id)
        .collect())
}

#[tauri::command]
pub async fn save_dns_mapping(
    input: DnsMappingRule,
    state: State<'_, Arc<AppState>>,
) -> Result<DnsMappingRule, String> {
    validate_dns_mapping(&input)?;

    let rule = input;

    // Build the DB row up front; `rule` is reused for the manager mutation and
    // the return value outside the closure.
    let row = aiproxy_db::rules::DnsMappingRow {
        id: rule.id.clone(),
        workspace_id: rule.workspace_id.clone(),
        name: rule.name.clone(),
        note: rule.note.clone(),
        enabled: rule.enabled,
        priority: rule.priority,
        host_pattern: rule.host_pattern.clone(),
        target_ip: rule.target_ip.clone(),
        match_type: rule
            .match_type
            .clone()
            .unwrap_or_else(|| "contains".to_string()),
    };

    let state = Arc::clone(state.inner());
    // Persist to DB on the blocking pool.
    run_blocking_command("save_dns_mapping", {
        let state = Arc::clone(&state);
        move || {
            let conn_guard = state.lock_db_for_ipc()?;
            aiproxy_db::rules::save_dns_mapping(&conn_guard, &row)
                .map_err(|error| app_error(ERR_INTERNAL, format!("Save DNS mapping: {error}")))?;
            Ok(())
        }
    })
    .await?;

    // Update in-memory manager
    state.read_dns_manager().save_rule(rule.clone());
    Ok(rule)
}

/// Validates a DNS mapping rule before persistence. Mirrors `validate_map_rule`:
/// required fields are checked, and `target_ip` must parse as a legal `IpAddr`.
/// Without this guard, a malformed IP is stored "successfully" but the runtime
/// resolver (`proxy-core/src/rules/mod.rs`) does `target_ip.parse().ok()` and
/// silently never matches, leaving the user with dead config and no feedback.
fn validate_dns_mapping(input: &DnsMappingRule) -> Result<(), String> {
    if input.name.trim().is_empty() {
        return Err(app_error(
            ERR_INVALID_INPUT,
            "DNS mapping name is required.",
        ));
    }
    if input.host_pattern.trim().is_empty() {
        return Err(app_error(
            ERR_INVALID_INPUT,
            "DNS mapping host pattern is required.",
        ));
    }
    let target_ip = input.target_ip.trim();
    if target_ip.is_empty() {
        return Err(app_error(
            ERR_INVALID_INPUT,
            "DNS mapping target IP is required.",
        ));
    }
    if target_ip.parse::<std::net::IpAddr>().is_err() {
        return Err(app_error(
            ERR_INVALID_INPUT,
            format!("DNS mapping target IP is not a valid IP address: {target_ip}"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_dns_mapping(target_ip: &str) -> DnsMappingRule {
        DnsMappingRule {
            id: "dns-1".to_string(),
            enabled: true,
            name: "Test DNS".to_string(),
            note: None,
            priority: 1,
            host_pattern: "example.com".to_string(),
            target_ip: target_ip.to_string(),
            match_type: None,
            workspace_id: "ws-1".to_string(),
        }
    }

    /// Parses an app_error() JSON string back into (code, message) for assertions.
    fn err_parts(err: &str) -> (String, String) {
        let parsed: serde_json::Value = serde_json::from_str(err).expect("valid JSON error");
        (
            parsed["code"].as_str().unwrap().to_string(),
            parsed["message"].as_str().unwrap().to_string(),
        )
    }

    #[test]
    fn validate_dns_mapping_accepts_valid_ipv4_and_ipv6() {
        assert!(validate_dns_mapping(&sample_dns_mapping("127.0.0.1")).is_ok());
        assert!(validate_dns_mapping(&sample_dns_mapping("10.0.0.1")).is_ok());
        assert!(validate_dns_mapping(&sample_dns_mapping("::1")).is_ok());
        assert!(validate_dns_mapping(&sample_dns_mapping("::ffff:192.0.2.1")).is_ok());
    }

    #[test]
    fn validate_dns_mapping_rejects_garbage_target_ip_with_structured_error() {
        let err = validate_dns_mapping(&sample_dns_mapping("not-an-ip"))
            .expect_err("garbage IP must be rejected");
        let (code, message) = err_parts(&err);
        assert_eq!(code, ERR_INVALID_INPUT);
        assert!(
            message.contains("not a valid IP address"),
            "message should explain the validation failure, got: {message}"
        );
        assert!(
            message.contains("not-an-ip"),
            "message should include the bad value"
        );
    }

    #[test]
    fn validate_dns_mapping_rejects_non_ip_strings_that_look_ipish() {
        // Hostnames, partial segments, and out-of-range octets must all be rejected.
        for bad in &[
            "localhost",
            "999.999.999.999",
            "1.2.3",
            "192.168.0.0/24",
            "[::1]",
        ] {
            let err =
                validate_dns_mapping(&sample_dns_mapping(bad)).expect_err("should be rejected");
            let (code, _msg) = err_parts(&err);
            assert_eq!(code, ERR_INVALID_INPUT, "rejected value: {bad}");
        }
    }

    #[test]
    fn validate_dns_mapping_rejects_empty_target_ip() {
        let err = validate_dns_mapping(&sample_dns_mapping("   "))
            .expect_err("empty IP must be rejected");
        let (code, message) = err_parts(&err);
        assert_eq!(code, ERR_INVALID_INPUT);
        assert!(message.contains("target IP is required"));
    }

    #[test]
    fn validate_dns_mapping_rejects_empty_name_and_host_pattern() {
        let mut rule = sample_dns_mapping("127.0.0.1");
        rule.name = "  ".to_string();
        let (code, _) = err_parts(&validate_dns_mapping(&rule).expect_err("empty name rejected"));
        assert_eq!(code, ERR_INVALID_INPUT);

        let mut rule = sample_dns_mapping("127.0.0.1");
        rule.host_pattern = "".to_string();
        let (code, _) =
            err_parts(&validate_dns_mapping(&rule).expect_err("empty host pattern rejected"));
        assert_eq!(code, ERR_INVALID_INPUT);
    }

    // H10 (closed): the dialog-owned command (pick_and_read_script_file) drives
    // the OS file picker from Rust and is covered end-to-end. The pure
    // extension classifier it shares with that command is unit-tested here.
    #[test]
    fn script_language_for_classifies_script_extensions_case_insensitively() {
        assert_eq!(script_language_for(Path::new("a.js")), Some("javascript"));
        assert_eq!(script_language_for(Path::new("a.MJS")), Some("javascript"));
        assert_eq!(script_language_for(Path::new("a.ts")), Some("typescript"));
        assert_eq!(
            script_language_for(Path::new("/x/y/z script.MTS")),
            Some("typescript")
        );
        // Non-script extensions and no extension are rejected.
        assert_eq!(script_language_for(Path::new("notes.txt")), None);
        assert_eq!(script_language_for(Path::new("id_rsa")), None);
        assert_eq!(script_language_for(Path::new(".js")), None);
    }

    #[test]
    fn err_invalid_returns_structured_invalid_input_error() {
        let (code, message) = err_parts(&err_invalid());
        assert_eq!(code, ERR_INVALID_INPUT);
        assert_eq!(message, "Unsupported script file path.");
    }
}

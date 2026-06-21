use super::common::*;

#[tauri::command]
pub fn list_script_session_trace(
    input: ListScriptSessionTraceInput,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<ScriptSessionTraceOutput>, String> {
    let conn = state
        .read_db_connection()
        .lock()
        .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
    let runs = aiproxy_db::rules::load_script_runs_for_session(&conn, &input.session_id)
        .map_err(|error| app_error(ERR_INTERNAL, format!("Load script runs: {error}")))?;
    let run_ids: Vec<String> = runs.iter().map(|run| run.id.clone()).collect();
    let entries = aiproxy_db::rules::load_script_run_entries(&conn, &run_ids)
        .map_err(|error| app_error(ERR_INTERNAL, format!("Load script run entries: {error}")))?;

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
}

#[tauri::command]
pub fn list_rewrite_session_trace(
    input: ListRewriteSessionTraceInput,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<RewriteSessionTraceOutput>, String> {
    let conn = state
        .read_db_connection()
        .lock()
        .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
    let runs = aiproxy_db::rules::load_rewrite_runs_for_session(&conn, &input.session_id)
        .map_err(|error| app_error(ERR_INTERNAL, format!("Load rewrite runs: {error}")))?;
    let run_ids: Vec<String> = runs.iter().map(|run| run.id.clone()).collect();
    let entries = aiproxy_db::rules::load_rewrite_run_entries(&conn, &run_ids)
        .map_err(|error| app_error(ERR_INTERNAL, format!("Load rewrite run entries: {error}")))?;

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
}

#[tauri::command]
pub fn list_map_session_trace(
    input: ListMapSessionTraceInput,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<MapSessionTraceOutput>, String> {
    let conn = state
        .read_db_connection()
        .lock()
        .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
    let runs = aiproxy_db::rules::load_map_runs_for_session(&conn, &input.session_id)
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
}

#[tauri::command]
pub fn list_throttle_session_trace(
    input: ListThrottleSessionTraceInput,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<ThrottleSessionTraceOutput>, String> {
    let conn = state
        .read_db_connection()
        .lock()
        .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
    let runs = aiproxy_db::rules::load_throttle_runs_for_session(&conn, &input.session_id)
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
}

#[tauri::command]
pub fn list_throttled_session_ids(
    input: ListThrottledSessionIdsInput,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<String>, String> {
    let conn = state
        .read_db_connection()
        .lock()
        .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
    aiproxy_db::rules::load_throttled_session_ids(&conn, &input.workspace_id)
        .map_err(|error| app_error(ERR_INTERNAL, format!("Load throttled session IDs: {error}")))
}

#[tauri::command]
pub fn list_breakpoint_rules(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<BreakpointRule>, String> {
    Ok(state.read_breakpoint_manager().list_rules())
}

#[tauri::command]
pub fn set_breakpoint_rules(
    rules: Vec<BreakpointRule>,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    // Persist to DB first
    {
        let conn = state
            .read_db_connection()
            .lock()
            .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
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
        aiproxy_db::rules::replace_breakpoint_rules(&conn, &rows)
            .map_err(|error| app_error(ERR_INTERNAL, format!("Set breakpoint rules: {error}")))?;
    }

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
pub fn save_rewrite_rule(
    input: RewriteRule,
    state: State<'_, Arc<AppState>>,
) -> Result<RewriteRule, String> {
    // Persist to DB first
    {
        let conn = state
            .read_db_connection()
            .lock()
            .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
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
            payload: input.payload.to_string(),
        };
        aiproxy_db::rules::save_rewrite_rule(&conn, &row)
            .map_err(|error| app_error(ERR_INTERNAL, format!("Save rewrite rule: {error}")))?;
    }

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
pub struct ReadScriptSourceFileInput {
    pub path: String,
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
pub fn save_map_rule(input: MapRule, state: State<'_, Arc<AppState>>) -> Result<MapRule, String> {
    validate_map_rule(&input)?;

    // Persist to DB first
    {
        let conn = state
            .read_db_connection()
            .lock()
            .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
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
        };
        aiproxy_db::rules::save_map_rule(&conn, &row)
            .map_err(|error| app_error(ERR_INTERNAL, format!("Save map rule: {error}")))?;
    }

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
pub fn save_script_rule(
    input: ScriptRule,
    state: State<'_, Arc<AppState>>,
) -> Result<ScriptRule, String> {
    let compiled = compile_script_rule(input)?;

    {
        let conn = state
            .read_db_connection()
            .lock()
            .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
        let row = aiproxy_db::rules::ScriptRuleRow {
            id: compiled.rule.id.clone(),
            workspace_id: compiled.rule.workspace_id.clone(),
            name: compiled.rule.name.clone(),
            note: compiled.rule.note.clone(),
            enabled: compiled.rule.enabled,
            priority: compiled.rule.priority,
            match_methods: serde_json::to_string(&compiled.rule.r#match.methods)
                .unwrap_or_default(),
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
            compiled_code: compiled.compiled_code.clone(),
            source_map: compiled.source_map.clone(),
            updated_at: chrono::Utc::now().to_rfc3339(),
        };

        aiproxy_db::rules::save_script_rule(&conn, &row)
            .map_err(|error| app_error(ERR_INTERNAL, format!("Save script rule: {error}")))?;
    }

    Ok(state.read_script_manager().save_rule(compiled))
}

#[tauri::command]
pub fn read_script_source_file(
    input: ReadScriptSourceFileInput,
) -> Result<ScriptSourceFileOutput, String> {
    let path = Path::new(&input.path);
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .ok_or_else(|| {
            app_error(
                ERR_INVALID_INPUT,
                "Script file must end with .js, .mjs, .ts, or .mts.",
            )
        })?;
    let language = match extension.as_str() {
        "js" | "mjs" => "javascript",
        "ts" | "mts" => "typescript",
        _ => {
            return Err(app_error(
                ERR_INVALID_INPUT,
                "Unsupported script file extension.",
            ))
        }
    };

    let bytes = std::fs::read(path)
        .map_err(|error| app_error(ERR_INTERNAL, format!("Read script file: {error}")))?;
    if bytes.len() > MAX_IMPORTED_SCRIPT_BYTES {
        return Err(app_error(
            ERR_INVALID_INPUT,
            format!(
                "Script file exceeds the {} KB limit",
                MAX_IMPORTED_SCRIPT_BYTES / 1024
            ),
        ));
    }

    let source_code = String::from_utf8(bytes).map_err(|error| {
        app_error(
            ERR_INTERNAL,
            format!("Decode script file as UTF-8: {error}"),
        )
    })?;

    Ok(ScriptSourceFileOutput {
        file_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("script")
            .to_string(),
        language: language.to_string(),
        path: input.path,
        source_code,
    })
}

// --- Delete rule (shared for rewrite/map) ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRuleInput {
    pub rule_id: String,
    pub rule_type: String,
}

#[tauri::command]
pub fn delete_rule(input: DeleteRuleInput, state: State<'_, Arc<AppState>>) -> Result<(), String> {
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

    // Persist to DB first
    {
        let conn = state
            .read_db_connection()
            .lock()
            .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
        let db_result = match input.rule_type.as_str() {
            "rewrite" => aiproxy_db::rules::delete_rewrite_rule(&conn, &input.rule_id),
            "map" => aiproxy_db::rules::delete_map_rule(&conn, &input.rule_id),
            "dns" => aiproxy_db::rules::delete_dns_mapping(&conn, &input.rule_id),
            "script" => aiproxy_db::rules::delete_script_rule(&conn, &input.rule_id),
            _ => unreachable!("validated above"),
        };
        db_result.map_err(|error| app_error(ERR_INTERNAL, format!("Delete rule: {error}")))?;
    }

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
pub fn save_dns_mapping(
    input: DnsMappingRule,
    state: State<'_, Arc<AppState>>,
) -> Result<DnsMappingRule, String> {
    let rule = input;

    // Persist to DB
    {
        let conn = state
            .read_db_connection()
            .lock()
            .map_err(|_| app_error(ERR_INTERNAL, "db mutex poisoned"))?;
        let row = aiproxy_db::rules::DnsMappingRow {
            id: rule.id.clone(),
            workspace_id: rule.workspace_id.clone(),
            name: rule.name.clone(),
            note: rule.note.clone(),
            enabled: rule.enabled,
            priority: rule.priority,
            host_pattern: rule.host_pattern.clone(),
            target_ip: rule.target_ip.clone(),
        };
        aiproxy_db::rules::save_dns_mapping(&conn, &row)
            .map_err(|error| app_error(ERR_INTERNAL, format!("Save DNS mapping: {error}")))?;
    }

    // Update in-memory manager
    state.read_dns_manager().save_rule(rule.clone());
    Ok(rule)
}

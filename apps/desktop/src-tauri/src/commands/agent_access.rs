use super::agent_access_probe::probe_sidecar;
use super::common::*;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use aiproxy_mcp::config::{
    read_config, write_config, AgentAccessConfig, AgentAccessLimits, AgentAccessPermissions,
    AgentAccessRedaction, AppPaths, ConfigReadError, AGENT_ACCESS_CONFIG_VERSION,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use toml_edit::{value, Array, DocumentMut, Item, Table};

const SKILL_MARKER: &str = "<!-- aiproxy-managed-skill: v1 -->";
const AGENT_SKILL_VERSION: &str = "2.3";
const SKILL_CONTENT: &str = include_str!("../../resources/agent-skill/aiproxy/SKILL.md");
const MAX_AUDIT_ENTRIES: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentClient {
    Codex,
    Claude,
    Cursor,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentClientInfo {
    pub client: AgentClient,
    pub config_path: String,
    pub config_exists: bool,
    pub config_installed: bool,
    pub skill_path: String,
    pub skill_installed: bool,
    pub skill_managed: bool,
    pub skill_version: Option<String>,
    pub bundled_skill_version: String,
    pub config_format: String,
    pub config_snippet: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccessSettings {
    pub version: u32,
    pub enabled: bool,
    pub transport: String,
    pub permissions: AgentAccessPermissions,
    pub limits: AgentAccessLimits,
    pub redaction: AgentAccessRedaction,
    pub updated_at: Option<String>,
    pub data_dir: String,
    pub database_path: String,
    pub config_path: String,
    pub audit_path: String,
    pub config_exists: bool,
    pub config_error: Option<String>,
    pub sidecar_path: Option<String>,
    pub sidecar_available: bool,
    pub sidecar_version: Option<String>,
    pub clients: Vec<AgentClientInfo>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateAgentAccessSettingsInput {
    pub enabled: bool,
    pub permissions: AgentAccessPermissions,
    pub limits: AgentAccessLimits,
    pub redaction: AgentAccessRedaction,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccessCheck {
    pub id: String,
    pub status: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccessTestResult {
    pub ok: bool,
    pub message: String,
    pub sidecar_path: Option<String>,
    pub sidecar_version: Option<String>,
    pub checks: Vec<AgentAccessCheck>,
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallAgentSkillInput {
    pub client: AgentClient,
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallAgentSkillResult {
    pub status: String,
    pub client: AgentClient,
    pub path: String,
    pub managed_existing: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallAgentClientConfigInput {
    pub client: AgentClient,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallAgentClientConfigResult {
    pub status: String,
    pub client: AgentClient,
    pub path: String,
    pub backup_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAuditEntry {
    pub timestamp: Option<String>,
    pub client_name: Option<String>,
    pub client_version: Option<String>,
    pub tool: Option<String>,
    pub outcome: Option<String>,
    pub duration_ms: Option<u64>,
    pub returned_bytes: Option<usize>,
    pub redacted: Option<bool>,
    pub truncated: Option<bool>,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAuditLog {
    pub entries: Vec<AgentAuditEntry>,
    pub path: String,
    pub truncated: bool,
}

#[tauri::command]
pub async fn get_agent_access_settings() -> Result<AgentAccessSettings, String> {
    run_blocking_command("get_agent_access_settings", build_settings).await
}

#[tauri::command]
pub async fn update_agent_access_settings(
    input: UpdateAgentAccessSettingsInput,
) -> Result<AgentAccessSettings, String> {
    run_blocking_command("update_agent_access_settings", move || {
        let paths = resolved_paths()?;
        let mut config = read_existing_config(&paths);
        config.version = AGENT_ACCESS_CONFIG_VERSION;
        config.enabled = input.enabled;
        config.permissions = input.permissions;
        config.limits = input.limits;
        config.redaction = input.redaction;
        config.updated_at = Some(chrono::Utc::now().to_rfc3339());
        write_config(&paths.config_path, &config).map_err(|error| {
            tracing::error!(
                component = "desktop.agent_access",
                event = "agent_access_config_write_failed",
                error = %error,
                "agent_access_config_write_failed"
            );
            app_error(ERR_INTERNAL, error)
        })?;

        tracing::info!(
            component = "desktop.agent_access",
            event = "agent_access_config_updated",
            enabled = config.enabled,
            read_bodies = config.permissions.read_bodies,
            read_raw_bodies = config.permissions.read_raw_bodies,
            read_web_socket = config.permissions.read_web_socket,
            detect_sensitive_values = config.redaction.detect_sensitive_values,
            hash_identifiers = config.redaction.hash_identifiers,
            "agent_access_config_updated"
        );
        build_settings()
    })
    .await
}

#[tauri::command]
pub async fn test_agent_access() -> AgentAccessTestResult {
    run_blocking_command("test_agent_access", test_agent_access_blocking)
        .await
        .unwrap_or_else(|error| AgentAccessTestResult {
            ok: false,
            message: error,
            sidecar_path: None,
            sidecar_version: None,
            checks: vec![AgentAccessCheck {
                id: "sidecar".to_string(),
                status: "error".to_string(),
                detail: None,
            }],
            details: None,
        })
}

fn check(id: &str, status: &str, detail: Option<String>) -> AgentAccessCheck {
    AgentAccessCheck {
        id: id.to_string(),
        status: status.to_string(),
        detail,
    }
}

fn test_agent_access_blocking() -> Result<AgentAccessTestResult, String> {
    let sidecar = resolve_sidecar_path();
    let Some(sidecar_path) = sidecar.path else {
        let message = sidecar
            .error
            .clone()
            .unwrap_or_else(|| "aiproxy-mcp sidecar is unavailable.".into());
        return Ok(AgentAccessTestResult {
            ok: false,
            message,
            sidecar_path: None,
            sidecar_version: None,
            checks: vec![check("sidecar", "error", sidecar.error)],
            details: None,
        });
    };
    let paths = match resolved_paths() {
        Ok(paths) => paths,
        Err(error) => {
            return Ok(AgentAccessTestResult {
                ok: false,
                message: error,
                sidecar_path: Some(sidecar_path.display().to_string()),
                sidecar_version: None,
                checks: vec![check("dataDirectory", "error", None)],
                details: None,
            });
        }
    };

    let mut checks = Vec::new();
    let mut first_error: Option<String> = None;
    let mut push = |check: AgentAccessCheck| {
        if check.status == "error" && first_error.is_none() {
            first_error = check.detail.clone();
        }
        checks.push(check);
    };

    if !sidecar.available || !sidecar_path.is_file() {
        push(check("sidecar", "error", sidecar.error.clone()));
        return Ok(AgentAccessTestResult {
            ok: false,
            message: sidecar
                .error
                .unwrap_or_else(|| "aiproxy-mcp sidecar is unavailable.".into()),
            sidecar_path: Some(sidecar_path.display().to_string()),
            sidecar_version: None,
            checks,
            details: None,
        });
    }
    push(check("sidecar", "ok", None));

    let sidecar_version = run_sidecar(&sidecar_path, &["--version"]).version;
    let output = run_sidecar(
        &sidecar_path,
        &[
            "--data-dir",
            &paths.data_dir.display().to_string(),
            "--doctor",
        ],
    );
    let details = output
        .stdout
        .as_deref()
        .and_then(|stdout| serde_json::from_str::<Value>(stdout).ok());

    let doctor_data = details.as_ref().and_then(|value| value.get("data"));
    let enabled = doctor_data
        .and_then(|data| data.get("agentAccessEnabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let database_readable = doctor_data
        .and_then(|data| data.get("databaseReadable"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let schema_compatible = doctor_data
        .and_then(|data| data.get("schemaCompatible"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let doctor_error = details
        .as_ref()
        .and_then(|value| value.get("error"))
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .map(str::to_string);

    if details.is_none() {
        let detail = output
            .stderr
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string);
        push(check("doctor", "error", detail));
    } else {
        push(check("doctor", "ok", doctor_error));
    }

    push(check(
        "database",
        if database_readable { "ok" } else { "error" },
        None,
    ));
    push(check(
        "schema",
        if schema_compatible { "ok" } else { "error" },
        details
            .as_ref()
            .and_then(|value| value.get("issues"))
            .and_then(Value::as_array)
            .and_then(|issues| {
                let message = issues
                    .iter()
                    .find(|issue| issue["code"] == "SCHEMA_INCOMPATIBLE")
                    .and_then(|issue| issue["message"].as_str());
                message.map(str::to_string)
            }),
    ));
    push(check(
        "agentAccessEnabled",
        if enabled { "ok" } else { "error" },
        None,
    ));

    if enabled {
        let body_access = doctor_data
            .and_then(|data| data.get("permissions"))
            .and_then(|permissions| permissions.get("readBodies"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if body_access {
            push(check("bodyAccess", "ok", None));
        } else {
            push(check(
                "bodyAccess",
                "warning",
                Some(
                    "Body reading is disabled, so the Agent cannot inspect response payloads."
                        .into(),
                ),
            ));
        }

        match probe_sidecar(&sidecar_path, &paths.data_dir) {
            Ok(probe) => {
                push(check("handshake", "ok", probe.protocol_version.clone()));
                push(check(
                    "tools",
                    if probe.tool_count == 8 {
                        "ok"
                    } else {
                        "warning"
                    },
                    Some(format!("{} tools", probe.tool_count)),
                ));
                push(check(
                    "sessions",
                    if probe.session_count > 0 {
                        "ok"
                    } else {
                        "warning"
                    },
                    Some(match (probe.session_count, &probe.latest_session_at) {
                        (0, _) => "search_sessions returned no sessions".to_string(),
                        (count, Some(timestamp)) => {
                            format!(
                                "search_sessions returned {count} session(s), latest {timestamp}"
                            )
                        }
                        (count, None) => format!("search_sessions returned {count} session(s)"),
                    }),
                ));
            }
            Err(error) => {
                let status = if error.starts_with("PERMISSION_DENIED") {
                    "warning"
                } else {
                    "error"
                };
                push(check("handshake", status, Some(error)));
            }
        }
    } else {
        push(check(
            "handshake",
            "warning",
            Some("Skipped: Agent Access is off.".into()),
        ));
    }

    if let Ok(settings) = build_settings() {
        let installed = settings
            .clients
            .iter()
            .filter(|client| client.config_installed && client.skill_installed)
            .count();
        push(check(
            "clients",
            if installed > 0 { "ok" } else { "warning" },
            Some(format!("{installed}/3 clients configured")),
        ));
    }

    let ok = !checks.iter().any(|entry| entry.status == "error");
    let has_warnings = checks.iter().any(|entry| entry.status == "warning");
    let message = if ok && has_warnings {
        "Agent Access checks completed with warnings.".to_string()
    } else if ok {
        "All Agent Access checks passed.".to_string()
    } else {
        first_error
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| {
                "Agent Access checks failed. See the details for the failing step.".into()
            })
    };

    Ok(AgentAccessTestResult {
        ok,
        message,
        sidecar_path: Some(sidecar_path.display().to_string()),
        sidecar_version,
        checks,
        details,
    })
}

#[tauri::command]
pub async fn install_agent_skill(
    input: InstallAgentSkillInput,
) -> Result<InstallAgentSkillResult, String> {
    run_blocking_command("install_agent_skill", move || {
        install_agent_skill_blocking(input)
    })
    .await
}

fn install_agent_skill_blocking(
    input: InstallAgentSkillInput,
) -> Result<InstallAgentSkillResult, String> {
    let skill_path = skill_path(input.client)?;
    let existing = std::fs::read_to_string(&skill_path).ok();
    let managed_existing = existing.as_deref().is_some_and(is_managed_skill);
    let path_label = skill_path.display().to_string();

    if let Some(existing) = existing.as_deref() {
        if existing == SKILL_CONTENT {
            return Ok(InstallAgentSkillResult {
                status: "upToDate".to_string(),
                client: input.client,
                path: path_label,
                managed_existing,
            });
        }
        if !managed_existing && !input.overwrite {
            return Ok(InstallAgentSkillResult {
                status: "overwriteRequired".to_string(),
                client: input.client,
                path: path_label,
                managed_existing: false,
            });
        }
    }

    write_skill_file(&skill_path, SKILL_CONTENT.as_bytes()).map_err(|error| {
        app_error(
            ERR_INTERNAL,
            format!("install Agent Skill at {}: {error}", skill_path.display()),
        )
    })?;
    tracing::info!(
        component = "desktop.agent_access",
        event = "agent_skill_installed",
        client = ?input.client,
        path = %skill_path.display(),
        "agent_skill_installed"
    );
    Ok(InstallAgentSkillResult {
        status: "installed".to_string(),
        client: input.client,
        path: path_label,
        managed_existing,
    })
}

#[tauri::command]
pub async fn install_agent_client_config(
    input: InstallAgentClientConfigInput,
) -> Result<InstallAgentClientConfigResult, String> {
    run_blocking_command("install_agent_client_config", move || {
        install_agent_client_config_blocking(input)
    })
    .await
}

fn install_agent_client_config_blocking(
    input: InstallAgentClientConfigInput,
) -> Result<InstallAgentClientConfigResult, String> {
    let paths = resolved_paths()?;
    let sidecar = resolve_sidecar_path();
    let Some(sidecar_path) = sidecar.path.filter(|path| path.is_file()) else {
        return Err(app_error(
            ERR_INVALID_INPUT,
            sidecar
                .error
                .unwrap_or_else(|| "aiproxy-mcp sidecar is unavailable".to_string()),
        ));
    };

    let target_path = config_path(input.client)?;
    let command = sidecar_path.display().to_string();
    let data_dir = paths.data_dir.display().to_string();
    let result = install_client_config_at(&target_path, input.client, &command, &data_dir)?;
    if result.status == "installed" {
        tracing::info!(
            component = "desktop.agent_access",
            event = "agent_client_config_installed",
            client = ?input.client,
            path = %target_path.display(),
            "agent_client_config_installed"
        );
    }
    Ok(result)
}

fn install_client_config_at(
    target_path: &Path,
    client: AgentClient,
    command: &str,
    data_dir: &str,
) -> Result<InstallAgentClientConfigResult, String> {
    if std::fs::symlink_metadata(target_path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(app_error(
            ERR_INVALID_INPUT,
            format!(
                "refusing to replace a symlinked client configuration: {}",
                target_path.display()
            ),
        ));
    }

    let existing = match std::fs::read_to_string(target_path) {
        Ok(contents) => Some(contents),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(app_error(
                ERR_INTERNAL,
                format!("read Agent client configuration: {error}"),
            ))
        }
    };
    let (contents, changed) = render_client_config(client, existing.as_deref(), command, data_dir)?;

    let backup_path = if changed && existing.is_some() {
        let backup = next_backup_path(target_path);
        write_private_file_atomic(&backup, existing.as_deref().unwrap_or_default().as_bytes())?;
        Some(backup)
    } else {
        None
    };
    if changed {
        write_private_file_atomic(target_path, contents.as_bytes())?;
    }

    Ok(InstallAgentClientConfigResult {
        status: if changed { "installed" } else { "upToDate" }.to_string(),
        client,
        path: target_path.display().to_string(),
        backup_path: backup_path.map(|path| path.display().to_string()),
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveAgentClientConfigInput {
    pub client: AgentClient,
    #[serde(default)]
    pub remove_skill: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveAgentClientConfigResult {
    pub status: String,
    pub client: AgentClient,
    pub path: String,
    pub backup_path: Option<String>,
    pub skill_removed: bool,
    pub skill_skipped: bool,
    pub skill_error: Option<String>,
}

#[derive(Debug)]
struct ConfigRemoval {
    status: String,
    path: String,
    backup_path: Option<String>,
}

#[tauri::command]
pub async fn remove_agent_client_config(
    input: RemoveAgentClientConfigInput,
) -> Result<RemoveAgentClientConfigResult, String> {
    run_blocking_command("remove_agent_client_config", move || {
        remove_agent_client_config_blocking(input)
    })
    .await
}

fn remove_agent_client_config_blocking(
    input: RemoveAgentClientConfigInput,
) -> Result<RemoveAgentClientConfigResult, String> {
    let target_path = config_path(input.client)?;
    let removal = remove_client_config_at(&target_path, input.client)?;
    // The configuration entry is already gone at this point. A Skill removal
    // failure must be reported as a partial success instead of failing the
    // whole command and leaving the UI thinking the client is still configured.
    let (skill_removed, skill_skipped, skill_error) = if input.remove_skill {
        match remove_managed_skill(input.client) {
            Ok((removed, skipped)) => (removed, skipped, None),
            Err(error) => (false, false, Some(error)),
        }
    } else {
        (false, false, None)
    };
    if removal.status == "removed" {
        tracing::info!(
            component = "desktop.agent_access",
            event = "agent_client_config_removed",
            client = ?input.client,
            path = %target_path.display(),
            skill_removed = skill_removed,
            "agent_client_config_removed"
        );
    }
    Ok(RemoveAgentClientConfigResult {
        status: removal.status,
        client: input.client,
        path: removal.path,
        backup_path: removal.backup_path,
        skill_removed,
        skill_skipped,
        skill_error,
    })
}

fn remove_client_config_at(
    target_path: &Path,
    client: AgentClient,
) -> Result<ConfigRemoval, String> {
    if std::fs::symlink_metadata(target_path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(app_error(
            ERR_INVALID_INPUT,
            format!(
                "refusing to modify a symlinked client configuration: {}",
                target_path.display()
            ),
        ));
    }

    let existing = match std::fs::read_to_string(target_path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ConfigRemoval {
                status: "notInstalled".to_string(),
                path: target_path.display().to_string(),
                backup_path: None,
            })
        }
        Err(error) => {
            return Err(app_error(
                ERR_INTERNAL,
                format!("read Agent client configuration: {error}"),
            ))
        }
    };

    let (contents, changed) = strip_client_config(client, &existing)?;
    if !changed {
        return Ok(ConfigRemoval {
            status: "notInstalled".to_string(),
            path: target_path.display().to_string(),
            backup_path: None,
        });
    }

    let backup = next_backup_path(target_path);
    write_private_file_atomic(&backup, existing.as_bytes())?;
    write_private_file_atomic(target_path, contents.as_bytes())?;

    Ok(ConfigRemoval {
        status: "removed".to_string(),
        path: target_path.display().to_string(),
        backup_path: Some(backup.display().to_string()),
    })
}

fn strip_client_config(client: AgentClient, existing: &str) -> Result<(String, bool), String> {
    match client {
        AgentClient::Codex => strip_codex_config(existing),
        AgentClient::Claude | AgentClient::Cursor => strip_json_config(existing),
    }
}

fn strip_codex_config(existing: &str) -> Result<(String, bool), String> {
    let mut document = existing.parse::<DocumentMut>().map_err(|error| {
        app_error(
            ERR_INVALID_INPUT,
            format!("parse Codex config.toml: {error}"),
        )
    })?;
    let Some(servers_item) = document.get_mut("mcp_servers") else {
        return Ok((existing.to_string(), false));
    };
    let servers = servers_item.as_table_mut().ok_or_else(|| {
        app_error(
            ERR_INVALID_INPUT,
            "Codex config.toml has a non-table mcp_servers value",
        )
    })?;
    if servers.remove("aiproxy").is_none() {
        return Ok((existing.to_string(), false));
    }
    if servers.is_empty() {
        document.as_table_mut().remove("mcp_servers");
    }

    let mut rendered = document.to_string();
    if !rendered.ends_with('\n') {
        rendered.push('\n');
    }
    Ok((rendered, true))
}

fn strip_json_config(existing: &str) -> Result<(String, bool), String> {
    let mut root: Value = serde_json::from_str(existing).map_err(|error| {
        app_error(
            ERR_INVALID_INPUT,
            format!("parse Agent client JSON configuration: {error}"),
        )
    })?;
    let object = root.as_object_mut().ok_or_else(|| {
        app_error(
            ERR_INVALID_INPUT,
            "Agent client configuration root must be a JSON object",
        )
    })?;
    let Some(servers_value) = object.get_mut("mcpServers") else {
        return Ok((existing.to_string(), false));
    };
    let servers = servers_value.as_object_mut().ok_or_else(|| {
        app_error(
            ERR_INVALID_INPUT,
            "Agent client configuration mcpServers must be a JSON object",
        )
    })?;
    if servers.remove("aiproxy").is_none() {
        return Ok((existing.to_string(), false));
    }
    if servers.is_empty() {
        object.remove("mcpServers");
    }

    let mut rendered = serde_json::to_string_pretty(&root).map_err(|error| {
        app_error(
            ERR_INTERNAL,
            format!("serialize Agent client configuration: {error}"),
        )
    })?;
    rendered.push('\n');
    Ok((rendered, true))
}

fn remove_managed_skill(client: AgentClient) -> Result<(bool, bool), String> {
    remove_skill_at(&skill_path(client)?)
}

fn remove_skill_at(path: &Path) -> Result<(bool, bool), String> {
    match std::fs::read_to_string(path) {
        Ok(contents) if is_managed_skill(&contents) => {
            std::fs::remove_file(path).map_err(|error| {
                app_error(
                    ERR_INTERNAL,
                    format!("remove Agent Skill at {}: {error}", path.display()),
                )
            })?;
            Ok((true, false))
        }
        Ok(_) => Ok((false, true)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok((false, false)),
        Err(error) => Err(app_error(
            ERR_INTERNAL,
            format!("read Agent Skill at {}: {error}", path.display()),
        )),
    }
}

#[tauri::command]
pub async fn get_agent_audit_log(limit: Option<usize>) -> Result<AgentAuditLog, String> {
    run_blocking_command("get_agent_audit_log", move || {
        get_agent_audit_log_blocking(limit)
    })
    .await
}

fn get_agent_audit_log_blocking(limit: Option<usize>) -> Result<AgentAuditLog, String> {
    let paths = resolved_paths()?;
    let path_label = paths.audit_path.display().to_string();
    let contents = match std::fs::read_to_string(&paths.audit_path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AgentAuditLog {
                entries: Vec::new(),
                path: path_label,
                truncated: false,
            })
        }
        Err(error) => {
            return Err(app_error(
                ERR_INTERNAL,
                format!("read Agent Access audit log: {error}"),
            ))
        }
    };
    let limit = limit.unwrap_or(50).clamp(1, MAX_AUDIT_ENTRIES);
    let mut entries = contents
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<AgentAuditEntry>(line).ok())
        .collect::<Vec<_>>();
    let truncated = entries.len() > limit;
    if truncated {
        entries = entries.split_off(entries.len() - limit);
    }
    entries.reverse();
    Ok(AgentAuditLog {
        entries,
        path: path_label,
        truncated,
    })
}

fn build_settings() -> Result<AgentAccessSettings, String> {
    let paths = resolved_paths()?;
    let config_exists = paths.config_path.is_file();
    let (config, config_error) = match read_config(&paths.config_path) {
        Ok(config) => (config, None),
        Err(ConfigReadError::Missing) => (AgentAccessConfig::default(), None),
        Err(ConfigReadError::Invalid(message)) => (AgentAccessConfig::default(), Some(message)),
    };
    let sidecar = resolve_sidecar_path();
    let sidecar_version = sidecar
        .path
        .as_deref()
        .and_then(|path| run_sidecar(path, &["--version"]).version);

    let clients = [AgentClient::Codex, AgentClient::Claude, AgentClient::Cursor]
        .into_iter()
        .map(|client| client_info(client, sidecar.path.as_deref(), &paths.data_dir))
        .collect::<Result<Vec<_>, String>>()?;

    Ok(AgentAccessSettings {
        version: config.version,
        enabled: config.enabled,
        transport: config.transport,
        permissions: config.permissions,
        limits: config.limits,
        redaction: config.redaction,
        updated_at: config.updated_at,
        data_dir: paths.data_dir.display().to_string(),
        database_path: paths.db_path.display().to_string(),
        config_path: paths.config_path.display().to_string(),
        audit_path: paths.audit_path.display().to_string(),
        config_exists,
        config_error,
        sidecar_path: sidecar.path.map(|path| path.display().to_string()),
        sidecar_available: sidecar.available,
        sidecar_version,
        clients,
    })
}

fn resolved_paths() -> Result<AppPaths, String> {
    AppPaths::resolve(None, None).map_err(|error| app_error(ERR_INTERNAL, error))
}

fn read_existing_config(paths: &AppPaths) -> AgentAccessConfig {
    read_config(&paths.config_path).unwrap_or_default()
}

struct SidecarResolution {
    path: Option<PathBuf>,
    available: bool,
    error: Option<String>,
}

fn resolve_sidecar_path() -> SidecarResolution {
    if let Some(path) = std::env::var_os("AIPROXY_MCP_PATH") {
        let path = PathBuf::from(path);
        let available = path.is_file();
        return SidecarResolution {
            error: (!available).then(|| {
                format!(
                    "AIPROXY_MCP_PATH points to a missing file: {}",
                    path.display()
                )
            }),
            path: Some(path),
            available,
        };
    }

    let executable = match std::env::current_exe() {
        Ok(path) => path,
        Err(error) => {
            return SidecarResolution {
                path: None,
                available: false,
                error: Some(format!("resolve desktop executable: {error}")),
            }
        }
    };
    let Some(parent) = executable.parent() else {
        return SidecarResolution {
            path: None,
            available: false,
            error: Some("desktop executable has no parent directory".to_string()),
        };
    };
    let name = if cfg!(windows) {
        "aiproxy-mcp.exe"
    } else {
        "aiproxy-mcp"
    };
    let path = parent.join(name);
    let available = path.is_file();
    SidecarResolution {
        error: (!available).then(|| {
            format!(
                "aiproxy-mcp sidecar is missing next to the desktop executable: {}",
                path.display()
            )
        }),
        path: Some(path),
        available,
    }
}

struct SidecarOutput {
    stdout: Option<String>,
    stderr: Option<String>,
    version: Option<String>,
}

fn run_sidecar(path: &Path, args: &[&str]) -> SidecarOutput {
    let mut command = Command::new(path);
    command.args(args);
    configure_hidden_process(&mut command);
    match command.output() {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let version = stdout.lines().next().and_then(|line| {
                let line = line.trim();
                (!line.is_empty()).then(|| line.to_string())
            });
            SidecarOutput {
                stdout: (!stdout.is_empty()).then_some(stdout),
                stderr: (!stderr.is_empty()).then_some(stderr),
                version,
            }
        }
        Err(error) => SidecarOutput {
            stdout: None,
            stderr: Some(format!("failed to start aiproxy-mcp: {error}")),
            version: None,
        },
    }
}

#[cfg(windows)]
fn configure_hidden_process(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn configure_hidden_process(_command: &mut Command) {}

fn client_info(
    client: AgentClient,
    sidecar_path: Option<&Path>,
    data_dir: &Path,
) -> Result<AgentClientInfo, String> {
    let skill_path = skill_path(client)?;
    let skill_contents = std::fs::read_to_string(&skill_path).ok();
    let config_path = config_path(client)?;
    let command = sidecar_path
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "<path-to-aiproxy-mcp>".to_string());
    let data_dir = data_dir.display().to_string();
    let config_installed = std::fs::read_to_string(&config_path)
        .ok()
        .and_then(|existing| {
            render_client_config(client, Some(&existing), &command, &data_dir)
                .ok()
                .map(|(_, changed)| !changed)
        })
        .unwrap_or(false);
    let (config_format, config_snippet) = match client {
        AgentClient::Codex => (
            "toml".to_string(),
            format!(
                "[mcp_servers.aiproxy]\ncommand = {}\nargs = [\"--data-dir\", {}]\n",
                toml_string(&command),
                toml_string(&data_dir)
            ),
        ),
        AgentClient::Claude => (
            "json".to_string(),
            serde_json::to_string_pretty(&json!({
                "mcpServers": {
                    "aiproxy": {
                        "type": "stdio",
                        "command": command,
                        "args": ["--data-dir", data_dir],
                    }
                }
            }))
            .map_err(|error| app_error(ERR_INTERNAL, format!("serialize Agent config: {error}")))?,
        ),
        AgentClient::Cursor => (
            "json".to_string(),
            serde_json::to_string_pretty(&json!({
                "mcpServers": {
                    "aiproxy": {
                        "command": command,
                        "args": ["--data-dir", data_dir],
                    }
                }
            }))
            .map_err(|error| app_error(ERR_INTERNAL, format!("serialize Agent config: {error}")))?,
        ),
    };

    Ok(AgentClientInfo {
        client,
        config_path: config_path.display().to_string(),
        config_exists: config_path.is_file(),
        config_installed,
        skill_path: skill_path.display().to_string(),
        skill_installed: skill_is_current(skill_contents.as_deref()),
        skill_managed: skill_contents.as_deref().is_some_and(is_managed_skill),
        skill_version: skill_contents.as_deref().and_then(skill_version),
        bundled_skill_version: AGENT_SKILL_VERSION.to_string(),
        config_format,
        config_snippet,
    })
}

fn config_path(client: AgentClient) -> Result<PathBuf, String> {
    match client {
        AgentClient::Codex => Ok(codex_home()?.join("config.toml")),
        AgentClient::Claude => claude_config_path(),
        AgentClient::Cursor => Ok(home_dir()?.join(".cursor").join("mcp.json")),
    }
}

fn render_client_config(
    client: AgentClient,
    existing: Option<&str>,
    command: &str,
    data_dir: &str,
) -> Result<(String, bool), String> {
    match client {
        AgentClient::Codex => merge_codex_config(existing.unwrap_or_default(), command, data_dir),
        AgentClient::Claude => merge_json_config(
            existing.unwrap_or_default(),
            command,
            data_dir,
            Some("stdio"),
        ),
        AgentClient::Cursor => {
            merge_json_config(existing.unwrap_or_default(), command, data_dir, None)
        }
    }
}

fn merge_codex_config(
    existing: &str,
    command: &str,
    data_dir: &str,
) -> Result<(String, bool), String> {
    let mut document = if existing.trim().is_empty() {
        DocumentMut::new()
    } else {
        existing.parse::<DocumentMut>().map_err(|error| {
            app_error(
                ERR_INVALID_INPUT,
                format!("parse Codex config.toml: {error}"),
            )
        })?
    };

    let servers_item = document
        .as_table_mut()
        .entry("mcp_servers")
        .or_insert(Item::Table(Table::new()));
    let servers = servers_item.as_table_mut().ok_or_else(|| {
        app_error(
            ERR_INVALID_INPUT,
            "Codex config.toml has a non-table mcp_servers value",
        )
    })?;
    let server_item = servers
        .entry("aiproxy")
        .or_insert(Item::Table(Table::new()));
    let server = server_item.as_table_mut().ok_or_else(|| {
        app_error(
            ERR_INVALID_INPUT,
            "Codex config.toml has a non-table mcp_servers.aiproxy value",
        )
    })?;

    let already_configured = server.get("command").and_then(Item::as_str) == Some(command)
        && server
            .get("args")
            .and_then(Item::as_array)
            .is_some_and(|args| {
                args.len() == 2
                    && args.get(0).and_then(toml_edit::Value::as_str) == Some("--data-dir")
                    && args.get(1).and_then(toml_edit::Value::as_str) == Some(data_dir)
            });
    if already_configured {
        return Ok((existing.to_string(), false));
    }

    server.insert("command", value(command));
    let mut args = Array::new();
    args.push("--data-dir");
    args.push(data_dir);
    server.insert("args", value(args));

    let mut rendered = document.to_string();
    if !rendered.ends_with('\n') {
        rendered.push('\n');
    }
    Ok((rendered, true))
}

fn merge_json_config(
    existing: &str,
    command: &str,
    data_dir: &str,
    server_type: Option<&str>,
) -> Result<(String, bool), String> {
    let mut root: Value = if existing.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(existing).map_err(|error| {
            app_error(
                ERR_INVALID_INPUT,
                format!("parse Agent client JSON configuration: {error}"),
            )
        })?
    };
    let before = root.clone();
    let object = root.as_object_mut().ok_or_else(|| {
        app_error(
            ERR_INVALID_INPUT,
            "Agent client configuration root must be a JSON object",
        )
    })?;
    let servers = object
        .entry("mcpServers")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| {
            app_error(
                ERR_INVALID_INPUT,
                "Agent client configuration mcpServers must be a JSON object",
            )
        })?;
    let server = servers
        .entry("aiproxy")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| {
            app_error(
                ERR_INVALID_INPUT,
                "Agent client configuration mcpServers.aiproxy must be a JSON object",
            )
        })?;
    server.insert("command".to_string(), Value::String(command.to_string()));
    server.insert("args".to_string(), json!(["--data-dir", data_dir]));
    match server_type {
        Some(server_type) => {
            server.insert("type".to_string(), Value::String(server_type.to_string()));
        }
        None => {
            server.remove("type");
        }
    }

    if root == before {
        return Ok((existing.to_string(), false));
    }
    let mut rendered = serde_json::to_string_pretty(&root).map_err(|error| {
        app_error(
            ERR_INTERNAL,
            format!("serialize Agent client configuration: {error}"),
        )
    })?;
    rendered.push('\n');
    Ok((rendered, true))
}

fn next_backup_path(path: &Path) -> PathBuf {
    let timestamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
    let mut file_name = path
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_default();
    file_name.push(format!(".aiproxy-backup-{timestamp}"));
    path.with_file_name(file_name)
}

fn write_private_file_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            app_error(
                ERR_INTERNAL,
                format!("create Agent client configuration directory: {error}"),
            )
        })?;
    }
    let mut file_name = path
        .file_name()
        .ok_or_else(|| app_error(ERR_INVALID_INPUT, "invalid Agent client configuration path"))?
        .to_os_string();
    file_name.push(format!(".tmp-{}", std::process::id()));
    let temp_path = path.with_file_name(file_name);

    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temp_path)?;
        file.write_all(contents)?;
        file.sync_all()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temp_path, std::fs::Permissions::from_mode(0o600))?;
        }
        replace_file(&temp_path, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    result.map_err(|error| {
        app_error(
            ERR_INTERNAL,
            format!(
                "write Agent client configuration at {}: {error}",
                path.display()
            ),
        )
    })
}

fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(error) if cfg!(windows) && to.exists() => {
            std::fs::remove_file(to)?;
            std::fs::rename(from, to).map_err(|_| error)
        }
        Err(error) => Err(error),
    }
}

fn skill_path(client: AgentClient) -> Result<PathBuf, String> {
    let base = match client {
        AgentClient::Codex => codex_home()?,
        AgentClient::Claude => claude_home()?,
        AgentClient::Cursor => home_dir()?.join(".cursor"),
    };
    Ok(base.join("skills").join("aiproxy").join("SKILL.md"))
}

fn codex_home() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("CODEX_HOME") {
        return Ok(PathBuf::from(path));
    }
    Ok(home_dir()?.join(".codex"))
}

fn claude_home() -> Result<PathBuf, String> {
    Ok(claude_home_for(
        std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from),
        &home_dir()?,
    ))
}

fn claude_config_path() -> Result<PathBuf, String> {
    Ok(claude_config_path_for(
        std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from),
        &home_dir()?,
    ))
}

fn claude_home_for(config_dir: Option<PathBuf>, home: &Path) -> PathBuf {
    config_dir.unwrap_or_else(|| home.join(".claude"))
}

fn claude_config_path_for(config_dir: Option<PathBuf>, home: &Path) -> PathBuf {
    config_dir
        .map(|path| path.join(".claude.json"))
        .unwrap_or_else(|| home.join(".claude.json"))
}

fn home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| app_error(ERR_INTERNAL, "resolve user home directory"))
}

fn is_managed_skill(contents: &str) -> bool {
    contents.contains(SKILL_MARKER)
}

/// Read `version:` from the YAML frontmatter of an installed Skill.
fn skill_version(contents: &str) -> Option<String> {
    let mut in_frontmatter = false;
    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed == "---" {
            if in_frontmatter {
                break;
            }
            in_frontmatter = true;
            continue;
        }
        if !in_frontmatter {
            continue;
        }
        if let Some(value) = trimmed.strip_prefix("version:") {
            let value = value.trim().trim_matches('"').trim_matches('\'');
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn skill_is_current(contents: Option<&str>) -> bool {
    contents == Some(SKILL_CONTENT)
}

fn write_skill_file(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file_name = path
        .file_name()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid skill path"))?
        .to_os_string();
    file_name.push(format!(".tmp-{}", std::process::id()));
    let temp_path = path.with_file_name(file_name);
    std::fs::write(&temp_path, contents)?;
    match std::fs::rename(&temp_path, path) {
        Ok(()) => Ok(()),
        Err(error) if cfg!(windows) && path.exists() => {
            std::fs::remove_file(path)?;
            std::fs::rename(&temp_path, path).map_err(|_| error)
        }
        Err(error) => {
            let _ = std::fs::remove_file(&temp_path);
            Err(error)
        }
    }
}

fn toml_string(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_snippets_escape_paths_and_use_stdio() {
        let path = Path::new("/tmp/AI Proxy/aiproxy-mcp");
        let data_dir = Path::new("/tmp/AI Proxy/data");
        let codex = client_info(AgentClient::Codex, Some(path), data_dir).unwrap();
        assert!(codex.config_snippet.contains("[mcp_servers.aiproxy]"));
        assert!(codex.config_snippet.contains("--data-dir"));

        let cursor = client_info(AgentClient::Cursor, Some(path), data_dir).unwrap();
        let parsed: Value = serde_json::from_str(&cursor.config_snippet).unwrap();
        assert_eq!(
            parsed["mcpServers"]["aiproxy"]["command"],
            path.display().to_string()
        );
        assert!(parsed["mcpServers"]["aiproxy"].get("type").is_none());
    }

    #[test]
    fn windows_style_toml_paths_are_escaped() {
        assert_eq!(
            toml_string(r"C:\Users\dev\aiproxy-mcp.exe"),
            r#""C:\\Users\\dev\\aiproxy-mcp.exe""#
        );
    }

    #[test]
    fn claude_paths_respect_config_dir_override() {
        let home = Path::new("/home/dev");
        assert_eq!(
            claude_home_for(None, home),
            PathBuf::from("/home/dev/.claude")
        );
        assert_eq!(
            claude_home_for(Some(PathBuf::from("/tmp/claude-work")), home),
            PathBuf::from("/tmp/claude-work")
        );
        assert_eq!(
            claude_config_path_for(None, home),
            PathBuf::from("/home/dev/.claude.json")
        );
        assert_eq!(
            claude_config_path_for(Some(PathBuf::from("/tmp/claude-work")), home),
            PathBuf::from("/tmp/claude-work/.claude.json")
        );
    }

    #[test]
    fn skill_marker_detects_managed_content() {
        assert!(is_managed_skill(SKILL_CONTENT));
        assert!(!is_managed_skill("# my custom skill"));
    }

    #[test]
    fn skill_version_is_read_from_frontmatter() {
        assert_eq!(
            skill_version(SKILL_CONTENT).as_deref(),
            Some(AGENT_SKILL_VERSION)
        );
        assert_eq!(
            skill_version("---\nname: aiproxy\nversion: 9.9\n---\nbody"),
            Some("9.9".to_string())
        );
        assert_eq!(skill_version("# no frontmatter"), None);
    }

    #[test]
    fn skill_installation_requires_current_content() {
        assert!(skill_is_current(Some(SKILL_CONTENT)));
        assert!(!skill_is_current(Some("# my custom skill")));
        assert!(!skill_is_current(None));
    }

    #[test]
    fn codex_config_merge_preserves_other_sections_and_is_idempotent() {
        let existing = r#"model = "gpt-5"

# keep this comment
[mcp_servers.other]
command = "other-mcp"
"#;
        let (rendered, changed) =
            merge_codex_config(existing, "/tmp/aiproxy-mcp", "/tmp/aiproxy-data").unwrap();
        assert!(changed);
        assert!(rendered.contains("model = \"gpt-5\""));
        assert!(rendered.contains("# keep this comment"));
        assert!(rendered.contains("[mcp_servers.other]"));
        assert!(rendered.contains("[mcp_servers.aiproxy]"));
        assert!(rendered.contains("--data-dir"));

        let (again, changed) =
            merge_codex_config(&rendered, "/tmp/aiproxy-mcp", "/tmp/aiproxy-data").unwrap();
        assert!(!changed);
        assert_eq!(again, rendered);
    }

    #[test]
    fn codex_config_merge_updates_existing_server_without_dropping_extra_keys() {
        let existing = r#"[mcp_servers.aiproxy]
command = "old"
args = []
env = { RUST_LOG = "info" }
"#;
        let (rendered, changed) =
            merge_codex_config(existing, "/tmp/aiproxy-mcp", "/tmp/aiproxy-data").unwrap();
        assert!(changed);
        assert!(rendered.contains("/tmp/aiproxy-mcp"));
        assert!(rendered.contains("RUST_LOG = \"info\""));
    }

    #[test]
    fn json_config_merge_preserves_other_servers_and_fields() {
        let existing = r#"{
  "mcpServers": {
    "other": { "command": "other-mcp" },
    "aiproxy": { "command": "old", "args": [], "env": { "A": "B" } }
  }
}"#;
        let (cursor, changed) =
            merge_json_config(existing, "/tmp/aiproxy-mcp", "/tmp/aiproxy-data", None).unwrap();
        assert!(changed);
        assert!(cursor.contains("other-mcp"));
        assert!(cursor.contains("\"A\": \"B\""));
        assert!(!cursor.contains("\"type\""));

        let (claude, _) = merge_json_config(
            &cursor,
            "/tmp/aiproxy-mcp",
            "/tmp/aiproxy-data",
            Some("stdio"),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&claude).unwrap();
        assert_eq!(parsed["mcpServers"]["aiproxy"]["type"], "stdio");
        assert_eq!(parsed["mcpServers"]["aiproxy"]["env"]["A"], "B");
    }

    #[test]
    fn malformed_client_config_is_not_overwritten() {
        assert!(merge_codex_config("not = [valid", "mcp", "data").is_err());
        assert!(merge_json_config("{", "mcp", "data", None).is_err());
        assert!(merge_json_config("[]", "mcp", "data", None).is_err());
    }

    fn backup_files(dir: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.contains(".aiproxy-backup-"))
            })
            .collect()
    }

    #[test]
    fn codex_install_writes_config_file_without_backup_for_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("config.toml");

        let result = install_client_config_at(
            &target,
            AgentClient::Codex,
            "/opt/aiproxy/aiproxy-mcp",
            "/tmp/aiproxy-data",
        )
        .unwrap();

        assert_eq!(result.status, "installed");
        assert!(result.backup_path.is_none());
        let written = std::fs::read_to_string(&target).unwrap();
        assert!(written.contains("[mcp_servers.aiproxy]"));
        assert!(written.contains("/opt/aiproxy/aiproxy-mcp"));
        assert!(backup_files(dir.path()).is_empty());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&target).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn codex_install_backs_up_original_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("config.toml");
        let original = "model = \"gpt-5\"\n";
        std::fs::write(&target, original).unwrap();

        let first = install_client_config_at(
            &target,
            AgentClient::Codex,
            "/opt/aiproxy/aiproxy-mcp",
            "/tmp/aiproxy-data",
        )
        .unwrap();
        assert_eq!(first.status, "installed");
        let backup_path = PathBuf::from(first.backup_path.clone().unwrap());
        assert_eq!(std::fs::read_to_string(&backup_path).unwrap(), original);
        assert_eq!(backup_files(dir.path()).len(), 1);
        let after_first = std::fs::read_to_string(&target).unwrap();

        let second = install_client_config_at(
            &target,
            AgentClient::Codex,
            "/opt/aiproxy/aiproxy-mcp",
            "/tmp/aiproxy-data",
        )
        .unwrap();
        assert_eq!(second.status, "upToDate");
        assert!(second.backup_path.is_none());
        assert_eq!(backup_files(dir.path()).len(), 1);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), after_first);
    }

    #[test]
    fn cursor_install_merges_into_existing_mcp_json() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("mcp.json");
        std::fs::write(&target, r#"{"mcpServers":{"other":{"command":"other"}}}"#).unwrap();

        let result = install_client_config_at(
            &target,
            AgentClient::Cursor,
            "/opt/aiproxy/aiproxy-mcp",
            "/tmp/aiproxy-data",
        )
        .unwrap();

        assert_eq!(result.status, "installed");
        let parsed: Value =
            serde_json::from_str(&std::fs::read_to_string(&target).unwrap()).unwrap();
        assert_eq!(parsed["mcpServers"]["other"]["command"], "other");
        assert_eq!(
            parsed["mcpServers"]["aiproxy"]["command"],
            "/opt/aiproxy/aiproxy-mcp"
        );
        assert!(parsed["mcpServers"]["aiproxy"].get("type").is_none());
    }

    #[test]
    fn claude_install_merges_user_config_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join(".claude.json");
        std::fs::write(
            &target,
            r#"{
  "numStartups": 12,
  "projects": { "/work/app": { "allowedTools": [] } },
  "mcpServers": { "other": { "command": "other" } }
}"#,
        )
        .unwrap();

        let first = install_client_config_at(
            &target,
            AgentClient::Claude,
            "/opt/aiproxy/aiproxy-mcp",
            "/tmp/aiproxy-data",
        )
        .unwrap();

        assert_eq!(first.status, "installed");
        let parsed: Value =
            serde_json::from_str(&std::fs::read_to_string(&target).unwrap()).unwrap();
        assert_eq!(parsed["numStartups"], 12);
        assert_eq!(parsed["projects"]["/work/app"]["allowedTools"], json!([]));
        assert_eq!(parsed["mcpServers"]["other"]["command"], "other");
        assert_eq!(parsed["mcpServers"]["aiproxy"]["type"], "stdio");
        assert_eq!(
            parsed["mcpServers"]["aiproxy"]["command"],
            "/opt/aiproxy/aiproxy-mcp"
        );

        let second = install_client_config_at(
            &target,
            AgentClient::Claude,
            "/opt/aiproxy/aiproxy-mcp",
            "/tmp/aiproxy-data",
        )
        .unwrap();
        assert_eq!(second.status, "upToDate");
        assert!(second.backup_path.is_none());
        assert_eq!(backup_files(dir.path()).len(), 1);
    }

    #[test]
    fn install_refuses_to_follow_symlinked_config() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.toml");
        let link = dir.path().join("config.toml");
        std::fs::write(&real, "model = \"gpt-5\"\n").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &link).unwrap();
        #[cfg(windows)]
        {
            if std::os::windows::fs::symlink_file(&real, &link).is_err() {
                return;
            }
        }

        let error = install_client_config_at(
            &link,
            AgentClient::Codex,
            "/opt/aiproxy/aiproxy-mcp",
            "/tmp/aiproxy-data",
        )
        .unwrap_err();

        assert!(error.contains("symlinked"));
        assert_eq!(
            std::fs::read_to_string(&real).unwrap(),
            "model = \"gpt-5\"\n"
        );
    }

    #[test]
    fn codex_removal_strips_only_aiproxy_and_keeps_other_config() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("config.toml");
        let original = r#"model = "gpt-5"

# keep this comment
[mcp_servers.other]
command = "other-mcp"

[mcp_servers.aiproxy]
command = "/opt/aiproxy/aiproxy-mcp"
args = ["--data-dir", "/tmp/aiproxy-data"]
"#;
        std::fs::write(&target, original).unwrap();

        let result = remove_client_config_at(&target, AgentClient::Codex).unwrap();
        assert_eq!(result.status, "removed");
        assert_eq!(backup_files(dir.path()).len(), 1);
        let written = std::fs::read_to_string(&target).unwrap();
        assert!(written.contains("model = \"gpt-5\""));
        assert!(written.contains("# keep this comment"));
        assert!(written.contains("[mcp_servers.other]"));
        assert!(!written.contains("aiproxy"));

        let again = remove_client_config_at(&target, AgentClient::Codex).unwrap();
        assert_eq!(again.status, "notInstalled");
        assert!(again.backup_path.is_none());
        assert_eq!(backup_files(dir.path()).len(), 1);
    }

    #[test]
    fn json_removal_preserves_other_servers_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("mcp.json");
        std::fs::write(
            &target,
            r#"{
  "mcpServers": {
    "other": { "command": "other-mcp" },
    "aiproxy": { "command": "aiproxy-mcp", "args": [] }
  },
  "theme": "dark"
}"#,
        )
        .unwrap();

        let result = remove_client_config_at(&target, AgentClient::Cursor).unwrap();
        assert_eq!(result.status, "removed");
        let parsed: Value =
            serde_json::from_str(&std::fs::read_to_string(&target).unwrap()).unwrap();
        assert_eq!(parsed["mcpServers"]["other"]["command"], "other-mcp");
        assert!(parsed["mcpServers"].get("aiproxy").is_none());
        assert_eq!(parsed["theme"], "dark");

        let again = remove_client_config_at(&target, AgentClient::Cursor).unwrap();
        assert_eq!(again.status, "notInstalled");
    }

    #[test]
    fn removal_clears_empty_mcp_servers_container() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("mcp.json");
        std::fs::write(
            &target,
            r#"{"mcpServers":{"aiproxy":{"command":"aiproxy-mcp"}}}"#,
        )
        .unwrap();

        remove_client_config_at(&target, AgentClient::Cursor).unwrap();
        let parsed: Value =
            serde_json::from_str(&std::fs::read_to_string(&target).unwrap()).unwrap();
        assert!(parsed.get("mcpServers").is_none());
    }

    #[test]
    fn removal_refuses_to_follow_symlinked_config() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.toml");
        let link = dir.path().join("config.toml");
        std::fs::write(&real, "[mcp_servers.aiproxy]\ncommand = \"mcp\"\n").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &link).unwrap();
        #[cfg(windows)]
        {
            if std::os::windows::fs::symlink_file(&real, &link).is_err() {
                return;
            }
        }

        let error = remove_client_config_at(&link, AgentClient::Codex).unwrap_err();
        assert!(error.contains("symlinked"));
        assert!(std::fs::read_to_string(&real)
            .unwrap()
            .contains("[mcp_servers.aiproxy]"));
    }

    #[test]
    fn removal_only_deletes_managed_skill_files() {
        let dir = tempfile::tempdir().unwrap();
        let managed = dir.path().join("managed.md");
        let custom = dir.path().join("custom.md");
        std::fs::write(&managed, SKILL_CONTENT).unwrap();
        std::fs::write(&custom, "# my own skill\n").unwrap();

        assert_eq!(remove_skill_at(&managed).unwrap(), (true, false));
        assert!(!managed.exists());
        assert_eq!(remove_skill_at(&custom).unwrap(), (false, true));
        assert!(custom.exists());
        assert_eq!(
            remove_skill_at(&dir.path().join("missing.md")).unwrap(),
            (false, false)
        );
    }
}

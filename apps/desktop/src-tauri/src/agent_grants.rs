use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::Duration;

use aiproxy_agent_control::{
    AgentCapability, AgentGrant, AgentGrantApprovalOption, AgentGrantRequest, AgentGrantStatus,
    ConsumeAgentGrantParams,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

const MAX_GRANTS: usize = 200;
const DEFAULT_APPROVAL_TIMEOUT_SECS: u64 = 30;
const ONCE_EXECUTION_WINDOW_SECS: i64 = 60;
const FIFTEEN_MINUTES_SECS: i64 = 15 * 60;
const FIFTEEN_MINUTE_MAX_USES: u32 = 50;
const DENIAL_COOLDOWN_SECS: i64 = 60;

#[derive(Debug, Default)]
struct GrantStore {
    grants: Vec<AgentGrant>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrantFile {
    version: u32,
    grants: Vec<AgentGrant>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccessGrantList {
    pub grants: Vec<AgentGrant>,
    pub pending_count: usize,
    pub store_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApproveAgentAccessGrantInput {
    pub request_id: String,
    pub option: AgentGrantApprovalOption,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentAccessGrantInput {
    pub request_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevokeAgentAccessGrantInput {
    pub grant_id: String,
}

#[derive(Debug, Clone)]
pub struct GrantRequester {
    pub client_name: String,
    pub client_version: String,
    pub agent_instance_id: String,
}

static STORE: OnceLock<Mutex<GrantStore>> = OnceLock::new();
static STORE_PATH: OnceLock<PathBuf> = OnceLock::new();
static GRANT_CHANGED: OnceLock<Condvar> = OnceLock::new();

fn store() -> &'static Mutex<GrantStore> {
    STORE.get_or_init(|| Mutex::new(GrantStore::default()))
}

fn changed() -> &'static Condvar {
    GRANT_CHANGED.get_or_init(Condvar::new)
}

pub fn initialize(data_dir: &Path) -> Result<(), String> {
    let path = data_dir.join("agent-grants.json");
    let _ = STORE_PATH.set(path.clone());
    // Grants are intentionally process-scoped. A restart invalidates pending
    // and active approvals instead of silently restoring authority.
    let mut guard = store().lock().unwrap_or_else(|error| error.into_inner());
    guard.grants.clear();
    persist(&path, &guard.grants)
}

pub fn list() -> AgentAccessGrantList {
    let path = STORE_PATH.get().cloned().unwrap_or_default();
    let mut guard = store().lock().unwrap_or_else(|error| error.into_inner());
    refresh_expired(&mut guard.grants);
    let pending_count = guard
        .grants
        .iter()
        .filter(|grant| grant.status == AgentGrantStatus::Pending)
        .count();
    AgentAccessGrantList {
        grants: guard.grants.clone(),
        pending_count,
        store_path: path.display().to_string(),
    }
}

pub fn request(
    app: &AppHandle,
    request: AgentGrantRequest,
    requester: GrantRequester,
) -> Result<AgentGrant, String> {
    validate_request(&request)?;
    validate_approval_options(&request)?;
    let now = chrono::Utc::now();
    let key = grant_key(
        &requester.agent_instance_id,
        &requester.client_name,
        &requester.client_version,
        request.capability,
        &request.action_fingerprint,
    );
    let mut guard = store().lock().unwrap_or_else(|error| error.into_inner());
    refresh_expired(&mut guard.grants);
    if let Some(existing) = guard
        .grants
        .iter()
        .rev()
        .find(|grant| grant_key_from_grant(grant) == key && denied_recently(grant, &now))
    {
        return Ok(existing.clone());
    }
    if let Some(existing) = guard
        .grants
        .iter()
        .rev()
        .find(|grant| grant_key_from_grant(grant) == key && is_usable(grant, &now))
    {
        let existing = existing.clone();
        if existing.status == AgentGrantStatus::Pending {
            return wait_for_grant(app, guard, existing.id);
        }
        return Ok(existing);
    }

    let id = format!("grant_{}", uuid::Uuid::new_v4().simple());
    let expires_at = now
        + chrono::Duration::seconds(
            request
                .expires_in_seconds
                .clamp(1, DEFAULT_APPROVAL_TIMEOUT_SECS) as i64,
        );
    let grant = AgentGrant {
        id: id.clone(),
        request_id: id.clone(),
        capability: request.capability,
        client_name: requester.client_name,
        client_version: requester.client_version,
        agent_instance_id: requester.agent_instance_id,
        action_fingerprint: request.action_fingerprint,
        action_summary: request.action_summary,
        scope: request.scope,
        reason: request.reason,
        created_at: now.to_rfc3339(),
        approved_at: None,
        expires_at: expires_at.to_rfc3339(),
        max_uses: 0,
        remaining_uses: 0,
        resource_policy: request.resource_policy,
        status: AgentGrantStatus::Pending,
        approval_option: AgentGrantApprovalOption::Once,
        non_idempotent: request.non_idempotent,
        approval_options: request.approval_options,
    };
    trim_grants(&mut guard.grants);
    guard.grants.push(grant.clone());
    persist_path(&guard.grants)?;
    let _ = app.emit("agent-access-grant-requested", &grant);

    wait_for_grant(app, guard, id)
}

fn wait_for_grant(
    app: &AppHandle,
    mut guard: std::sync::MutexGuard<'_, GrantStore>,
    id: String,
) -> Result<AgentGrant, String> {
    let Some(initial) = guard.grants.iter().find(|grant| grant.id == id).cloned() else {
        return Err("Agent grant request was not found".to_string());
    };
    let deadline = chrono::DateTime::parse_from_rfc3339(&initial.expires_at)
        .map(|expires| {
            let remaining = expires.with_timezone(&chrono::Utc) - chrono::Utc::now();
            std::time::Instant::now()
                + std::time::Duration::from_secs(remaining.num_seconds().max(0) as u64)
        })
        .unwrap_or_else(|_| std::time::Instant::now() + Duration::from_secs(1));
    let mut grant = initial;
    while grant.status == AgentGrantStatus::Pending {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            grant.status = AgentGrantStatus::Expired;
            replace_grant(&mut guard.grants, grant.clone());
            let _ = persist_path(&guard.grants);
            changed().notify_all();
            let _ = app.emit("agent-access-grant-changed", &grant);
            return Ok(grant);
        }
        let (next_guard, wait_result) = changed()
            .wait_timeout(guard, remaining)
            .map_err(|_| "Agent grant wait lock was poisoned".to_string())?;
        guard = next_guard;
        if wait_result.timed_out() {
            continue;
        }
        if let Some(updated) = guard.grants.iter().find(|candidate| candidate.id == id) {
            grant = updated.clone();
        } else {
            grant.status = AgentGrantStatus::Cancelled;
            grant.remaining_uses = 0;
            return Ok(grant);
        }
    }
    Ok(grant)
}

pub fn approve(input: ApproveAgentAccessGrantInput) -> Result<AgentGrant, String> {
    let mut guard = store().lock().unwrap_or_else(|error| error.into_inner());
    let now = chrono::Utc::now();
    let grant = guard
        .grants
        .iter_mut()
        .find(|grant| grant.request_id == input.request_id)
        .ok_or_else(|| "Agent grant request was not found".to_string())?;
    if grant.status != AgentGrantStatus::Pending {
        return Err(format!(
            "Agent grant request is no longer pending ({:?})",
            grant.status
        ));
    }
    if chrono::DateTime::parse_from_rfc3339(&grant.expires_at)
        .map(|expires| expires.with_timezone(&chrono::Utc) <= now)
        .unwrap_or(true)
    {
        grant.status = AgentGrantStatus::Expired;
        persist_path(&guard.grants)?;
        changed().notify_all();
        return Err("Agent grant request expired before it was approved".to_string());
    }
    if !grant.approval_options.contains(&input.option) {
        return Err("This approval option is not allowed for the requested action".to_string());
    }
    // Re-check against the capability policy instead of trusting the options
    // supplied in the original request: a client must not be able to widen a
    // high-risk grant to the 15-minute quota.
    if !aiproxy_agent_control::allowed_approval_options(grant.capability, grant.non_idempotent)
        .contains(&input.option)
    {
        return Err("This approval option is not allowed for the requested capability".to_string());
    }
    let (ttl, max_uses) = match input.option {
        AgentGrantApprovalOption::Once => (ONCE_EXECUTION_WINDOW_SECS, 1),
        AgentGrantApprovalOption::FifteenMinutes => (FIFTEEN_MINUTES_SECS, FIFTEEN_MINUTE_MAX_USES),
    };
    grant.approval_option = input.option;
    grant.status = AgentGrantStatus::Approved;
    grant.approved_at = Some(now.to_rfc3339());
    grant.expires_at = (now + chrono::Duration::seconds(ttl)).to_rfc3339();
    grant.max_uses = max_uses;
    grant.remaining_uses = max_uses;
    let updated = grant.clone();
    persist_path(&guard.grants)?;
    changed().notify_all();
    Ok(updated)
}

pub fn deny(input: AgentAccessGrantInput) -> Result<AgentGrant, String> {
    finish_pending(input.request_id, AgentGrantStatus::Denied)
}

fn finish_pending(request_id: String, status: AgentGrantStatus) -> Result<AgentGrant, String> {
    let mut guard = store().lock().unwrap_or_else(|error| error.into_inner());
    let grant = guard
        .grants
        .iter_mut()
        .find(|grant| grant.request_id == request_id)
        .ok_or_else(|| "Agent grant request was not found".to_string())?;
    if grant.status == AgentGrantStatus::Pending {
        grant.status = status;
        if status == AgentGrantStatus::Denied {
            grant.expires_at =
                (chrono::Utc::now() + chrono::Duration::seconds(DENIAL_COOLDOWN_SECS)).to_rfc3339();
        }
    }
    let updated = grant.clone();
    persist_path(&guard.grants)?;
    changed().notify_all();
    Ok(updated)
}

pub fn revoke(input: RevokeAgentAccessGrantInput) -> Result<AgentGrant, String> {
    let mut guard = store().lock().unwrap_or_else(|error| error.into_inner());
    let grant = guard
        .grants
        .iter_mut()
        .find(|grant| grant.id == input.grant_id)
        .ok_or_else(|| "Agent grant was not found".to_string())?;
    if matches!(
        grant.status,
        AgentGrantStatus::Pending | AgentGrantStatus::Approved | AgentGrantStatus::Executing
    ) {
        grant.status = AgentGrantStatus::Revoked;
        grant.remaining_uses = 0;
    }
    let updated = grant.clone();
    persist_path(&guard.grants)?;
    changed().notify_all();
    Ok(updated)
}

pub fn authorize(
    agent_instance_id: &str,
    client_name: &str,
    client_version: &str,
    capability: AgentCapability,
    fingerprint: &str,
    grant_ids: &[String],
) -> Result<String, String> {
    let mut guard = store().lock().unwrap_or_else(|error| error.into_inner());
    refresh_expired(&mut guard.grants);
    authorized_grant_id(
        &guard.grants,
        agent_instance_id,
        client_name,
        client_version,
        capability,
        fingerprint,
        grant_ids,
    )
}

/// Whether the request already carries a grant for this capability. Used to
/// distinguish "the client did not request this capability yet" (return
/// APPROVAL_REQUIRED so it can ask) from "the grant does not match this action"
/// (a real approval error).
pub fn has_grant_for_capability(grant_ids: &[String], capability: AgentCapability) -> bool {
    let guard = store().lock().unwrap_or_else(|error| error.into_inner());
    let now = chrono::Utc::now();
    grant_ids.iter().any(|id| {
        guard.grants.iter().any(|grant| {
            grant.id == *id
                && grant.capability == capability
                && grant.remaining_uses > 0
                && matches!(
                    grant.status,
                    AgentGrantStatus::Approved | AgentGrantStatus::Executing
                )
                && chrono::DateTime::parse_from_rfc3339(&grant.expires_at)
                    .map(|expires| expires.with_timezone(&chrono::Utc) > now)
                    .unwrap_or(false)
        })
    })
}

fn authorized_grant_id(
    grants: &[AgentGrant],
    agent_instance_id: &str,
    client_name: &str,
    client_version: &str,
    capability: AgentCapability,
    fingerprint: &str,
    grant_ids: &[String],
) -> Result<String, String> {
    for id in grant_ids {
        let Some(grant) = grants.iter().find(|grant| grant.id == *id) else {
            return Err("The approved Agent grant no longer exists".to_string());
        };
        // A multi-permission action carries one grant per capability. Ignore
        // grants for other capabilities so each required permission can find
        // its own exact match without invalidating the sibling grant.
        if grant.capability != capability {
            continue;
        }
        if grant.agent_instance_id != agent_instance_id
            || grant.client_name != client_name
            || grant.client_version != client_version
            || grant.action_fingerprint != fingerprint
            || grant.remaining_uses == 0
            || !matches!(
                grant.status,
                AgentGrantStatus::Approved | AgentGrantStatus::Executing
            )
        {
            return Err("The approved Agent grant does not match this action".to_string());
        }
        return Ok(grant.id.clone());
    }
    Err("The approved Agent grant does not cover this capability".to_string())
}

pub fn mark_executing(grant_ids: &[String]) -> Result<(), String> {
    let mut guard = store().lock().unwrap_or_else(|error| error.into_inner());
    reserve_grants(&mut guard.grants, grant_ids)?;
    persist_path(&guard.grants)
}

pub fn consume(
    params: ConsumeAgentGrantParams,
    requester: GrantRequester,
) -> Result<AgentGrant, String> {
    let mut guard = store().lock().unwrap_or_else(|error| error.into_inner());
    refresh_expired(&mut guard.grants);
    let grant = guard
        .grants
        .iter_mut()
        .find(|grant| grant.id == params.grant_id)
        .ok_or_else(|| "The approved Agent grant no longer exists".to_string())?;
    if grant.agent_instance_id != requester.agent_instance_id
        || grant.client_name != requester.client_name
        || grant.client_version != requester.client_version
        || grant.capability != params.capability
        || grant.action_fingerprint != params.action_fingerprint
    {
        return Err("The approved Agent grant does not match this action".to_string());
    }
    if grant.status != AgentGrantStatus::Approved || grant.remaining_uses == 0 {
        return Err("The approved Agent grant is no longer usable".to_string());
    }
    grant.remaining_uses = grant.remaining_uses.saturating_sub(1);
    if grant.remaining_uses == 0 {
        grant.status = AgentGrantStatus::Expired;
    }
    let updated = grant.clone();
    persist_path(&guard.grants)?;
    changed().notify_all();
    Ok(updated)
}

pub fn finish(grant_ids: &[String], status: AgentGrantStatus) -> Result<(), String> {
    let mut guard = store().lock().unwrap_or_else(|error| error.into_inner());
    for grant in guard
        .grants
        .iter_mut()
        .filter(|grant| grant_ids.contains(&grant.id))
    {
        // `mark_executing` already reserved one use. Preserve a revocation or
        // expiry that happened while the action was running instead of
        // reviving the grant with a late success.
        if grant.status == AgentGrantStatus::Executing {
            grant.status = completed_grant_status(status, grant.remaining_uses);
        }
    }
    changed().notify_all();
    persist_path(&guard.grants)
}

pub fn clear() -> Result<(), String> {
    let mut guard = store().lock().unwrap_or_else(|error| error.into_inner());
    guard.grants.clear();
    changed().notify_all();
    persist_path(&guard.grants)
}

fn validate_request(request: &AgentGrantRequest) -> Result<(), String> {
    if request.action_fingerprint.trim().is_empty() || request.action_fingerprint.len() > 256 {
        return Err("Agent grant action fingerprint is invalid".to_string());
    }
    if request.action_summary.trim().is_empty() || request.action_summary.len() > 512 {
        return Err("Agent grant action summary is invalid".to_string());
    }
    if request.reason.trim().is_empty() || request.reason.len() > 1024 {
        return Err("Agent grant reason is invalid".to_string());
    }
    if request.approval_options.is_empty() || request.approval_options.len() > 2 {
        return Err("Agent grant approval options are invalid".to_string());
    }
    if request.non_idempotent
        && request
            .approval_options
            .iter()
            .any(|option| *option != AgentGrantApprovalOption::Once)
    {
        return Err("Non-idempotent actions can only be approved once".to_string());
    }
    Ok(())
}

/// The desktop owns the safety policy: a client may ask for the 15-minute
/// quota only when the capability is repeatable and the action is idempotent.
/// Reject instead of silently trimming so a misbehaving client gets a clear
/// error rather than a weaker approval than it displayed.
fn validate_approval_options(request: &AgentGrantRequest) -> Result<(), String> {
    let allowed =
        aiproxy_agent_control::allowed_approval_options(request.capability, request.non_idempotent);
    if let Some(option) = request
        .approval_options
        .iter()
        .find(|option| !allowed.contains(option))
    {
        return Err(format!(
            "Approval option {:?} is not allowed for capability {}",
            option,
            request.capability.as_str()
        ));
    }
    Ok(())
}

fn grant_key(
    agent_instance_id: &str,
    client_name: &str,
    client_version: &str,
    capability: AgentCapability,
    fingerprint: &str,
) -> String {
    format!(
        "{agent_instance_id}\0{client_name}\0{client_version}\0{}\0{fingerprint}",
        capability.as_str()
    )
}

fn grant_key_from_grant(grant: &AgentGrant) -> String {
    grant_key(
        &grant.agent_instance_id,
        &grant.client_name,
        &grant.client_version,
        grant.capability,
        &grant.action_fingerprint,
    )
}

fn is_usable(grant: &AgentGrant, now: &chrono::DateTime<chrono::Utc>) -> bool {
    matches!(
        grant.status,
        AgentGrantStatus::Pending | AgentGrantStatus::Approved | AgentGrantStatus::Executing
    ) && chrono::DateTime::parse_from_rfc3339(&grant.expires_at)
        .map(|expires| expires.with_timezone(&chrono::Utc) > *now)
        .unwrap_or(false)
}

fn reserve_grants(grants: &mut [AgentGrant], grant_ids: &[String]) -> Result<(), String> {
    let mut indexes = Vec::with_capacity(grant_ids.len());
    for id in grant_ids {
        let index = grants
            .iter()
            .position(|grant| grant.id == *id)
            .ok_or_else(|| "The approved Agent grant no longer exists".to_string())?;
        if indexes.contains(&index) {
            return Err("The approved Agent grant was provided more than once".to_string());
        }
        let grant = &grants[index];
        if !matches!(
            grant.status,
            AgentGrantStatus::Approved | AgentGrantStatus::Executing
        ) || grant.remaining_uses == 0
        {
            return Err("The approved Agent grant is no longer usable".to_string());
        }
        indexes.push(index);
    }
    for index in indexes {
        grants[index].remaining_uses = grants[index].remaining_uses.saturating_sub(1);
        grants[index].status = AgentGrantStatus::Executing;
    }
    Ok(())
}

fn completed_grant_status(status: AgentGrantStatus, remaining_uses: u32) -> AgentGrantStatus {
    match status {
        AgentGrantStatus::Succeeded | AgentGrantStatus::Failed if remaining_uses > 0 => {
            AgentGrantStatus::Approved
        }
        AgentGrantStatus::Succeeded | AgentGrantStatus::Failed => AgentGrantStatus::Expired,
        other => other,
    }
}

fn denied_recently(grant: &AgentGrant, now: &chrono::DateTime<chrono::Utc>) -> bool {
    grant.status == AgentGrantStatus::Denied
        && chrono::DateTime::parse_from_rfc3339(&grant.expires_at)
            .map(|expires| expires.with_timezone(&chrono::Utc) > *now)
            .unwrap_or(false)
}

fn refresh_expired(grants: &mut [AgentGrant]) {
    let now = chrono::Utc::now();
    for grant in grants {
        if matches!(
            grant.status,
            AgentGrantStatus::Pending | AgentGrantStatus::Approved | AgentGrantStatus::Executing
        ) && chrono::DateTime::parse_from_rfc3339(&grant.expires_at)
            .map(|expires| expires.with_timezone(&chrono::Utc) <= now)
            .unwrap_or(true)
        {
            grant.status = AgentGrantStatus::Expired;
            grant.remaining_uses = 0;
        }
    }
}

fn trim_grants(grants: &mut Vec<AgentGrant>) {
    if grants.len() < MAX_GRANTS {
        return;
    }
    let mut keep = VecDeque::from(std::mem::take(grants));
    while keep.len() >= MAX_GRANTS {
        keep.pop_front();
    }
    *grants = keep.into();
}

fn replace_grant(grants: &mut [AgentGrant], updated: AgentGrant) {
    if let Some(current) = grants.iter_mut().find(|grant| grant.id == updated.id) {
        *current = updated;
    }
}

fn persist_path(grants: &[AgentGrant]) -> Result<(), String> {
    let Some(path) = STORE_PATH.get() else {
        return Ok(());
    };
    persist(path, grants)
}

fn persist(path: &Path, grants: &[AgentGrant]) -> Result<(), String> {
    let payload = GrantFile {
        version: 1,
        grants: grants.to_vec(),
    };
    let bytes = serde_json::to_vec_pretty(&payload)
        .map_err(|error| format!("serialize Agent grants: {error}"))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("create Agent grant directory: {error}"))?;
    }
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        use std::io::Write;
        let mut file = options
            .open(&temp)
            .map_err(|error| format!("open {}: {error}", temp.display()))?;
        file.write_all(&bytes)
            .map_err(|error| format!("write {}: {error}", temp.display()))?;
        file.sync_all()
            .map_err(|error| format!("sync {}: {error}", temp.display()))?;
        replace_file(&temp, path)?;
        #[cfg(windows)]
        if let Err(error) = restrict_windows_acl(path) {
            // Never leave a grant store readable by other local accounts. The
            // in-memory store is authoritative for this process, so skipping
            // the on-disk copy keeps approvals working without leaking data.
            let _ = std::fs::remove_file(path);
            tracing::warn!(
                component = "desktop.agent_grants",
                event = "grant_store_acl_failed",
                error = %error,
                "grant_store_acl_failed"
            );
            return Ok(());
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[cfg(windows)]
fn restrict_windows_acl(path: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let user = std::env::var("USERNAME").unwrap_or_default();
    if user.trim().is_empty() {
        return Err(
            "could not restrict Agent grant store ACL: USERNAME is unavailable".to_string(),
        );
    }
    let domain = std::env::var("USERDOMAIN").unwrap_or_default();
    let principal = if domain.trim().is_empty() {
        user
    } else {
        format!("{domain}\\{user}")
    };
    let output = std::process::Command::new("icacls")
        .arg(path)
        .arg("/inheritance:r")
        .arg("/grant:r")
        .arg(format!("{principal}:F"))
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| format!("run icacls for Agent grant store: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "restrict Agent grant store ACL: icacls exited with {:?}: {}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

fn replace_file(from: &Path, to: &Path) -> Result<(), String> {
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(error) if cfg!(windows) && to.exists() => {
            std::fs::remove_file(to).map_err(|remove| remove.to_string())?;
            std::fs::rename(from, to).map_err(|_| error.to_string())
        }
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub fn list_agent_access_grants() -> AgentAccessGrantList {
    list()
}

#[tauri::command]
pub fn approve_agent_access_grant(
    app: AppHandle,
    input: ApproveAgentAccessGrantInput,
) -> Result<AgentGrant, String> {
    let grant = approve(input)?;
    let _ = app.emit("agent-access-grant-changed", &grant);
    Ok(grant)
}

#[tauri::command]
pub fn deny_agent_access_grant(
    app: AppHandle,
    input: AgentAccessGrantInput,
) -> Result<AgentGrant, String> {
    let grant = deny(input)?;
    let _ = app.emit("agent-access-grant-changed", &grant);
    Ok(grant)
}

#[tauri::command]
pub fn revoke_agent_access_grant(
    app: AppHandle,
    input: RevokeAgentAccessGrantInput,
) -> Result<AgentGrant, String> {
    let grant = revoke(input)?;
    let _ = app.emit("agent-access-grant-changed", &grant);
    Ok(grant)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_grant(status: AgentGrantStatus, remaining_uses: u32) -> AgentGrant {
        let now = chrono::Utc::now();
        AgentGrant {
            id: "grant_1".to_string(),
            request_id: "grant_1".to_string(),
            capability: AgentCapability::ReadBodies,
            client_name: "Codex".to_string(),
            client_version: "1.0".to_string(),
            agent_instance_id: "mcp_1".to_string(),
            action_fingerprint: "sha256:a".to_string(),
            action_summary: "Read a body".to_string(),
            scope: Default::default(),
            reason: "Inspect the response".to_string(),
            created_at: (now - chrono::Duration::seconds(30)).to_rfc3339(),
            approved_at: None,
            expires_at: (now + chrono::Duration::seconds(DENIAL_COOLDOWN_SECS)).to_rfc3339(),
            max_uses: remaining_uses,
            remaining_uses,
            resource_policy: None,
            status,
            approval_option: AgentGrantApprovalOption::Once,
            non_idempotent: false,
            approval_options: vec![AgentGrantApprovalOption::Once],
        }
    }

    #[test]
    fn grant_key_binds_instance_client_and_fingerprint() {
        let first = grant_key(
            "mcp-1",
            "Codex",
            "1.0",
            AgentCapability::ReadBodies,
            "sha256:a",
        );
        let second = grant_key(
            "mcp-2",
            "Codex",
            "1.0",
            AgentCapability::ReadBodies,
            "sha256:a",
        );
        let third = grant_key(
            "mcp-1",
            "Codex",
            "1.0",
            AgentCapability::ReadBodies,
            "sha256:b",
        );
        assert_ne!(first, second);
        assert_ne!(first, third);
    }

    #[test]
    fn authorization_selects_one_grant_per_capability() {
        let mut read = test_grant(AgentGrantStatus::Approved, 2);
        read.id = "grant_read".to_string();
        read.request_id = read.id.clone();

        let mut automation = test_grant(AgentGrantStatus::Approved, 2);
        automation.id = "grant_automation".to_string();
        automation.request_id = automation.id.clone();
        automation.capability = AgentCapability::ManageAutomation;

        let grants = vec![read, automation];
        let ids = vec!["grant_read".to_string(), "grant_automation".to_string()];
        let read_id = authorized_grant_id(
            &grants,
            "mcp_1",
            "Codex",
            "1.0",
            AgentCapability::ReadBodies,
            "sha256:a",
            &ids,
        )
        .unwrap();
        let automation_id = authorized_grant_id(
            &grants,
            "mcp_1",
            "Codex",
            "1.0",
            AgentCapability::ManageAutomation,
            "sha256:a",
            &ids,
        )
        .unwrap();

        assert_eq!(read_id, "grant_read");
        assert_eq!(automation_id, "grant_automation");
    }

    #[test]
    fn rejects_repeatable_approval_for_non_idempotent_actions() {
        let request = AgentGrantRequest {
            capability: AgentCapability::SendRequests,
            action_fingerprint: "sha256:a".to_string(),
            action_summary: "Replay POST /orders".to_string(),
            scope: Default::default(),
            reason: "Compare the response".to_string(),
            approval_options: vec![
                AgentGrantApprovalOption::Once,
                AgentGrantApprovalOption::FifteenMinutes,
            ],
            expires_in_seconds: 30,
            non_idempotent: true,
            resource_policy: None,
        };
        assert!(validate_request(&request).is_err());
    }

    #[test]
    fn denial_cooldown_is_scoped_to_the_same_action_key() {
        let now = chrono::Utc::now();
        let grant = test_grant(AgentGrantStatus::Denied, 0);
        assert!(denied_recently(&grant, &now));
        assert!(!denied_recently(
            &grant,
            &(now + chrono::Duration::seconds(DENIAL_COOLDOWN_SECS + 1))
        ));
    }

    #[test]
    fn reservation_consumes_one_use_before_execution() {
        let mut grants = vec![test_grant(AgentGrantStatus::Approved, 2)];
        reserve_grants(&mut grants, &["grant_1".to_string()]).unwrap();
        assert_eq!(grants[0].remaining_uses, 1);
        assert_eq!(grants[0].status, AgentGrantStatus::Executing);
    }

    #[test]
    fn reservation_rejects_a_second_once_execution() {
        let mut grants = vec![test_grant(AgentGrantStatus::Approved, 1)];
        reserve_grants(&mut grants, &["grant_1".to_string()]).unwrap();
        assert!(reserve_grants(&mut grants, &["grant_1".to_string()]).is_err());
        assert_eq!(grants[0].remaining_uses, 0);
    }

    #[test]
    fn high_risk_capabilities_reject_reusable_approval() {
        let both = vec![
            AgentGrantApprovalOption::Once,
            AgentGrantApprovalOption::FifteenMinutes,
        ];
        let once = vec![AgentGrantApprovalOption::Once];

        assert!(validate_approval_options(&request_for(
            AgentCapability::ReadBodies,
            both.clone(),
            false,
        ))
        .is_ok());
        assert!(validate_approval_options(&request_for(
            AgentCapability::DeleteSessions,
            both.clone(),
            false,
        ))
        .is_err());
        assert!(validate_approval_options(&request_for(
            AgentCapability::DeleteSessions,
            once.clone(),
            false,
        ))
        .is_ok());
        assert!(
            validate_approval_options(&request_for(AgentCapability::ReadBodies, both, true,))
                .is_err()
        );
    }

    fn request_for(
        capability: AgentCapability,
        approval_options: Vec<AgentGrantApprovalOption>,
        non_idempotent: bool,
    ) -> AgentGrantRequest {
        AgentGrantRequest {
            capability,
            action_fingerprint: "sha256:a".to_string(),
            action_summary: "Delete the selected sessions".to_string(),
            scope: Default::default(),
            reason: "Clean up after the task".to_string(),
            approval_options,
            expires_in_seconds: 30,
            non_idempotent,
            resource_policy: None,
        }
    }

    #[test]
    fn reusable_grants_return_to_approved_after_success() {
        assert_eq!(
            completed_grant_status(AgentGrantStatus::Succeeded, 1),
            AgentGrantStatus::Approved
        );
        assert_eq!(
            completed_grant_status(AgentGrantStatus::Succeeded, 0),
            AgentGrantStatus::Expired
        );
        assert_eq!(
            completed_grant_status(AgentGrantStatus::Unknown, 1),
            AgentGrantStatus::Unknown
        );
    }
}

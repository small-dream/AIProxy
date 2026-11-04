use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::DbError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationResourceRow {
    pub resource_kind: String,
    pub resource_id: String,
    pub scope: String,
    pub scope_key: String,
    pub workspace_id: Option<String>,
    pub owner_kind: String,
    pub created_by_client: Option<String>,
    pub created_by_version: Option<String>,
    pub change_id: Option<String>,
    pub expires_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct AutomationChangeSetRow {
    pub id: String,
    pub scope: String,
    pub scope_key: String,
    pub workspace_id: Option<String>,
    pub idempotency_key: String,
    pub plan_hash: String,
    pub expected_plan_hash: String,
    pub scope_hash_before: String,
    pub scope_hash_after: String,
    pub lifecycle: String,
    pub status: String,
    pub runtime_generation: Option<u64>,
    pub client_name: Option<String>,
    pub client_version: Option<String>,
    pub summary_json: String,
    pub created_at: String,
    pub committed_at: Option<String>,
    pub activated_at: Option<String>,
    pub reverted_at: Option<String>,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AutomationChangeItemRow {
    pub change_id: String,
    pub sequence: u32,
    pub resource_kind: String,
    pub resource_id: String,
    pub operation: String,
    pub version_before: Option<String>,
    pub version_after: Option<String>,
    pub before_json: Option<String>,
    pub after_json: Option<String>,
    pub dependencies_json: String,
}

#[derive(Debug, Clone)]
pub struct AutomationExperimentRow {
    pub id: String,
    pub change_id: String,
    pub objective: String,
    pub baseline_session_ids: String,
    pub status: String,
    pub cleanup_state: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct AutomationVerificationRow {
    pub id: String,
    pub experiment_id: String,
    pub mode: String,
    pub request_json: String,
    pub assertions_json: String,
    pub result_json: String,
    pub evidence_session_ids: String,
    pub limitations_json: String,
    pub created_at: String,
}

pub fn save_automation_resource(
    conn: &Connection,
    resource: &AutomationResourceRow,
) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO automation_resources
            (resource_kind, resource_id, scope, scope_key, workspace_id, owner_kind,
             created_by_client, created_by_version, change_id, expires_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(resource_kind, resource_id) DO UPDATE SET
             scope=excluded.scope,
             scope_key=excluded.scope_key,
             workspace_id=excluded.workspace_id,
             owner_kind=excluded.owner_kind,
             created_by_client=COALESCE(automation_resources.created_by_client, excluded.created_by_client),
             created_by_version=COALESCE(automation_resources.created_by_version, excluded.created_by_version),
             change_id=excluded.change_id,
             expires_at=excluded.expires_at,
             updated_at=excluded.updated_at",
        params![
            resource.resource_kind,
            resource.resource_id,
            resource.scope,
            resource.scope_key,
            resource.workspace_id,
            resource.owner_kind,
            resource.created_by_client,
            resource.created_by_version,
            resource.change_id,
            resource.expires_at,
            resource.created_at,
            resource.updated_at,
        ],
    )
    .map_err(|error| DbError::query("save automation resource", error))?;
    Ok(())
}

pub fn load_automation_resource(
    conn: &Connection,
    kind: &str,
    id: &str,
) -> Result<Option<AutomationResourceRow>, DbError> {
    conn.query_row(
        "SELECT resource_kind, resource_id, scope, scope_key, workspace_id, owner_kind,
                created_by_client, created_by_version, change_id, expires_at, created_at, updated_at
         FROM automation_resources WHERE resource_kind=?1 AND resource_id=?2",
        params![kind, id],
        |row| {
            Ok(AutomationResourceRow {
                resource_kind: row.get(0)?,
                resource_id: row.get(1)?,
                scope: row.get(2)?,
                scope_key: row.get(3)?,
                workspace_id: row.get(4)?,
                owner_kind: row.get(5)?,
                created_by_client: row.get(6)?,
                created_by_version: row.get(7)?,
                change_id: row.get(8)?,
                expires_at: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        },
    )
    .optional()
    .map_err(|error| DbError::query("load automation resource", error))
}

pub fn list_automation_resources(
    conn: &Connection,
    scope_key: Option<&str>,
    kind: Option<&str>,
    lifecycle: Option<&str>,
    limit: usize,
) -> Result<Vec<AutomationResourceRow>, DbError> {
    let mut stmt = conn
        .prepare(
            "SELECT r.resource_kind, r.resource_id, r.scope, r.scope_key, r.workspace_id,
                    r.owner_kind, r.created_by_client, r.created_by_version, r.change_id,
                    r.expires_at, r.created_at, r.updated_at
             FROM automation_resources r
             LEFT JOIN automation_change_sets c ON c.id = r.change_id
             WHERE (?1 IS NULL OR r.scope_key = ?1)
               AND (?2 IS NULL OR r.resource_kind = ?2)
               AND (?3 IS NULL OR COALESCE(c.lifecycle, 'persistent') = ?3)
             ORDER BY r.updated_at DESC, r.resource_kind ASC, r.resource_id ASC
             LIMIT ?4",
        )
        .map_err(|error| DbError::query("prepare list automation resources", error))?;
    let rows = stmt
        .query_map(params![scope_key, kind, lifecycle, limit as i64], |row| {
            Ok(AutomationResourceRow {
                resource_kind: row.get(0)?,
                resource_id: row.get(1)?,
                scope: row.get(2)?,
                scope_key: row.get(3)?,
                workspace_id: row.get(4)?,
                owner_kind: row.get(5)?,
                created_by_client: row.get(6)?,
                created_by_version: row.get(7)?,
                change_id: row.get(8)?,
                expires_at: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        })
        .map_err(|error| DbError::query("query automation resources", error))?;
    rows.map(|row| row.map_err(|error| DbError::query("decode automation resource", error)))
        .collect()
}

pub fn delete_automation_resource(conn: &Connection, kind: &str, id: &str) -> Result<(), DbError> {
    conn.execute(
        "DELETE FROM automation_resources WHERE resource_kind=?1 AND resource_id=?2",
        params![kind, id],
    )
    .map_err(|error| DbError::query("delete automation resource", error))?;
    Ok(())
}

pub fn list_automation_change_ids_for_resource(
    conn: &Connection,
    kind: &str,
    id: &str,
) -> Result<Vec<String>, DbError> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT change_id FROM automation_change_items
             WHERE resource_kind=?1 AND resource_id=?2
             ORDER BY change_id ASC",
        )
        .map_err(|error| DbError::query("prepare automation resource history", error))?;
    let rows = stmt
        .query_map(params![kind, id], |row| row.get(0))
        .map_err(|error| DbError::query("query automation resource history", error))?;
    rows.map(|row| row.map_err(|error| DbError::query("decode automation resource history", error)))
        .collect()
}

pub fn insert_automation_change_set(
    conn: &Connection,
    change: &AutomationChangeSetRow,
) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO automation_change_sets
            (id, scope, scope_key, workspace_id, idempotency_key, plan_hash,
             expected_plan_hash, scope_hash_before, scope_hash_after, lifecycle, status,
             runtime_generation, client_name, client_version, summary_json, created_at,
             committed_at, activated_at, reverted_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                 ?17, ?18, ?19, ?20)",
        params![
            change.id,
            change.scope,
            change.scope_key,
            change.workspace_id,
            change.idempotency_key,
            change.plan_hash,
            change.expected_plan_hash,
            change.scope_hash_before,
            change.scope_hash_after,
            change.lifecycle,
            change.status,
            change.runtime_generation.map(|value| value as i64),
            change.client_name,
            change.client_version,
            change.summary_json,
            change.created_at,
            change.committed_at,
            change.activated_at,
            change.reverted_at,
            change.expires_at,
        ],
    )
    .map_err(|error| DbError::query("insert automation change set", error))?;
    Ok(())
}

fn decode_change_set(row: &rusqlite::Row<'_>) -> rusqlite::Result<AutomationChangeSetRow> {
    Ok(AutomationChangeSetRow {
        id: row.get(0)?,
        scope: row.get(1)?,
        scope_key: row.get(2)?,
        workspace_id: row.get(3)?,
        idempotency_key: row.get(4)?,
        plan_hash: row.get(5)?,
        expected_plan_hash: row.get(6)?,
        scope_hash_before: row.get(7)?,
        scope_hash_after: row.get(8)?,
        lifecycle: row.get(9)?,
        status: row.get(10)?,
        runtime_generation: row.get::<_, Option<i64>>(11)?.map(|value| value as u64),
        client_name: row.get(12)?,
        client_version: row.get(13)?,
        summary_json: row.get(14)?,
        created_at: row.get(15)?,
        committed_at: row.get(16)?,
        activated_at: row.get(17)?,
        reverted_at: row.get(18)?,
        expires_at: row.get(19)?,
    })
}

const CHANGE_SET_COLUMNS: &str = "id, scope, scope_key, workspace_id, idempotency_key,
    plan_hash, expected_plan_hash, scope_hash_before, scope_hash_after, lifecycle, status,
    runtime_generation, client_name, client_version, summary_json, created_at,
    committed_at, activated_at, reverted_at, expires_at";

pub fn load_automation_change_set(
    conn: &Connection,
    id: &str,
) -> Result<Option<AutomationChangeSetRow>, DbError> {
    conn.query_row(
        &format!("SELECT {CHANGE_SET_COLUMNS} FROM automation_change_sets WHERE id=?1"),
        params![id],
        decode_change_set,
    )
    .optional()
    .map_err(|error| DbError::query("load automation change set", error))
}

pub fn load_automation_change_by_idempotency(
    conn: &Connection,
    scope_key: &str,
    idempotency_key: &str,
) -> Result<Option<AutomationChangeSetRow>, DbError> {
    conn.query_row(
        &format!(
            "SELECT {CHANGE_SET_COLUMNS} FROM automation_change_sets
             WHERE scope_key=?1 AND idempotency_key=?2"
        ),
        params![scope_key, idempotency_key],
        decode_change_set,
    )
    .optional()
    .map_err(|error| DbError::query("load automation idempotency record", error))
}

pub fn list_recent_automation_changes(
    conn: &Connection,
    limit: u32,
) -> Result<Vec<AutomationChangeSetRow>, DbError> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {CHANGE_SET_COLUMNS} FROM automation_change_sets
             ORDER BY created_at DESC LIMIT ?1"
        ))
        .map_err(|error| DbError::query("prepare recent automation changes", error))?;
    let rows = stmt
        .query_map(params![i64::from(limit)], decode_change_set)
        .map_err(|error| DbError::query("query recent automation changes", error))?;
    rows.map(|row| row.map_err(|error| DbError::query("decode recent change", error)))
        .collect()
}

pub fn set_automation_change_owner(
    conn: &Connection,
    change_id: &str,
    owner_kind: &str,
    updated_at: &str,
) -> Result<usize, DbError> {
    conn.execute(
        "UPDATE automation_resources SET owner_kind=?2, updated_at=?3 WHERE change_id=?1",
        params![change_id, owner_kind, updated_at],
    )
    .map_err(|error| DbError::query("update automation resource owner", error))
}

pub fn update_automation_change_status(
    conn: &Connection,
    id: &str,
    status: &str,
    runtime_generation: Option<u64>,
    committed_at: Option<&str>,
    activated_at: Option<&str>,
    reverted_at: Option<&str>,
) -> Result<(), DbError> {
    conn.execute(
        "UPDATE automation_change_sets SET
             status=?2,
             runtime_generation=COALESCE(?3, runtime_generation),
             committed_at=COALESCE(?4, committed_at),
             activated_at=COALESCE(?5, activated_at),
             reverted_at=COALESCE(?6, reverted_at)
         WHERE id=?1",
        params![
            id,
            status,
            runtime_generation.map(|value| value as i64),
            committed_at,
            activated_at,
            reverted_at,
        ],
    )
    .map_err(|error| DbError::query("update automation change status", error))?;
    Ok(())
}

pub fn list_unfinished_automation_changes(
    conn: &Connection,
) -> Result<Vec<AutomationChangeSetRow>, DbError> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {CHANGE_SET_COLUMNS} FROM automation_change_sets
             WHERE status IN ('committed', 'publish_failed', 'reverting')
             ORDER BY created_at ASC"
        ))
        .map_err(|error| DbError::query("prepare unfinished automation changes", error))?;
    let rows = stmt
        .query_map([], decode_change_set)
        .map_err(|error| DbError::query("query unfinished automation changes", error))?;
    rows.map(|row| row.map_err(|error| DbError::query("decode unfinished change", error)))
        .collect()
}

pub fn list_expired_ephemeral_changes(
    conn: &Connection,
    now: &str,
) -> Result<Vec<AutomationChangeSetRow>, DbError> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {CHANGE_SET_COLUMNS} FROM automation_change_sets
             WHERE lifecycle='ephemeral'
               AND status IN ('committed', 'active', 'publish_failed')
               AND expires_at IS NOT NULL
               AND expires_at <= ?1
             ORDER BY expires_at ASC"
        ))
        .map_err(|error| DbError::query("prepare expired automation changes", error))?;
    let rows = stmt
        .query_map(params![now], decode_change_set)
        .map_err(|error| DbError::query("query expired automation changes", error))?;
    rows.map(|row| row.map_err(|error| DbError::query("decode expired change", error)))
        .collect()
}

pub fn list_active_ephemeral_changes(
    conn: &Connection,
) -> Result<Vec<AutomationChangeSetRow>, DbError> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {CHANGE_SET_COLUMNS} FROM automation_change_sets
             WHERE lifecycle='ephemeral' AND status='active'
             ORDER BY created_at ASC"
        ))
        .map_err(|error| DbError::query("prepare active ephemeral changes", error))?;
    let rows = stmt
        .query_map([], decode_change_set)
        .map_err(|error| DbError::query("query active ephemeral changes", error))?;
    rows.map(|row| row.map_err(|error| DbError::query("decode active ephemeral change", error)))
        .collect()
}

pub fn list_ephemeral_changes_for_restart_cleanup(
    conn: &Connection,
) -> Result<Vec<AutomationChangeSetRow>, DbError> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {CHANGE_SET_COLUMNS} FROM automation_change_sets
             WHERE lifecycle='ephemeral'
               AND status IN ('prepared', 'committed', 'active', 'publish_failed', 'reverting')
             ORDER BY created_at ASC"
        ))
        .map_err(|error| DbError::query("prepare ephemeral restart cleanup", error))?;
    let rows = stmt
        .query_map([], decode_change_set)
        .map_err(|error| DbError::query("query ephemeral restart cleanup", error))?;
    rows.map(|row| row.map_err(|error| DbError::query("decode ephemeral cleanup change", error)))
        .collect()
}

pub fn delete_automation_resources_for_change(
    conn: &Connection,
    change_id: &str,
) -> Result<(), DbError> {
    conn.execute(
        "DELETE FROM automation_resources WHERE change_id=?1",
        params![change_id],
    )
    .map_err(|error| DbError::query("delete automation resources for change", error))?;
    Ok(())
}

pub fn insert_automation_change_item(
    conn: &Connection,
    item: &AutomationChangeItemRow,
) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO automation_change_items
            (change_id, sequence, resource_kind, resource_id, operation, version_before,
             version_after, before_json, after_json, dependencies_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            item.change_id,
            item.sequence,
            item.resource_kind,
            item.resource_id,
            item.operation,
            item.version_before,
            item.version_after,
            item.before_json,
            item.after_json,
            item.dependencies_json,
        ],
    )
    .map_err(|error| DbError::query("insert automation change item", error))?;
    Ok(())
}

pub fn load_automation_change_items(
    conn: &Connection,
    change_id: &str,
) -> Result<Vec<AutomationChangeItemRow>, DbError> {
    let mut stmt = conn
        .prepare(
            "SELECT change_id, sequence, resource_kind, resource_id, operation,
                    version_before, version_after, before_json, after_json, dependencies_json
             FROM automation_change_items WHERE change_id=?1 ORDER BY sequence ASC",
        )
        .map_err(|error| DbError::query("prepare automation change items", error))?;
    let rows = stmt
        .query_map(params![change_id], |row| {
            Ok(AutomationChangeItemRow {
                change_id: row.get(0)?,
                sequence: row.get(1)?,
                resource_kind: row.get(2)?,
                resource_id: row.get(3)?,
                operation: row.get(4)?,
                version_before: row.get(5)?,
                version_after: row.get(6)?,
                before_json: row.get(7)?,
                after_json: row.get(8)?,
                dependencies_json: row.get(9)?,
            })
        })
        .map_err(|error| DbError::query("query automation change items", error))?;
    rows.map(|row| row.map_err(|error| DbError::query("decode automation change item", error)))
        .collect()
}

pub fn insert_automation_experiment(
    conn: &Connection,
    experiment: &AutomationExperimentRow,
) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO automation_experiments
            (id, change_id, objective, baseline_session_ids, status, cleanup_state, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            experiment.id,
            experiment.change_id,
            experiment.objective,
            experiment.baseline_session_ids,
            experiment.status,
            experiment.cleanup_state,
            experiment.created_at,
            experiment.updated_at,
        ],
    )
    .map_err(|error| DbError::query("insert automation experiment", error))?;
    Ok(())
}

pub fn load_automation_experiment_by_change(
    conn: &Connection,
    change_id: &str,
) -> Result<Option<AutomationExperimentRow>, DbError> {
    conn.query_row(
        "SELECT id, change_id, objective, baseline_session_ids, status, cleanup_state,
                created_at, updated_at
         FROM automation_experiments WHERE change_id=?1 ORDER BY created_at DESC LIMIT 1",
        params![change_id],
        |row| {
            Ok(AutomationExperimentRow {
                id: row.get(0)?,
                change_id: row.get(1)?,
                objective: row.get(2)?,
                baseline_session_ids: row.get(3)?,
                status: row.get(4)?,
                cleanup_state: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        },
    )
    .optional()
    .map_err(|error| DbError::query("load automation experiment", error))
}

pub fn update_automation_experiment_state(
    conn: &Connection,
    change_id: &str,
    status: &str,
    cleanup_state: &str,
    updated_at: &str,
) -> Result<(), DbError> {
    conn.execute(
        "UPDATE automation_experiments
         SET status=?2, cleanup_state=?3, updated_at=?4
         WHERE change_id=?1",
        params![change_id, status, cleanup_state, updated_at],
    )
    .map_err(|error| DbError::query("update automation experiment state", error))?;
    Ok(())
}

pub fn insert_automation_verification(
    conn: &Connection,
    verification: &AutomationVerificationRow,
) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO automation_verifications
            (id, experiment_id, mode, request_json, assertions_json, result_json,
             evidence_session_ids, limitations_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            verification.id,
            verification.experiment_id,
            verification.mode,
            verification.request_json,
            verification.assertions_json,
            verification.result_json,
            verification.evidence_session_ids,
            verification.limitations_json,
            verification.created_at,
        ],
    )
    .map_err(|error| DbError::query("insert automation verification", error))?;
    Ok(())
}

pub fn load_automation_verifications(
    conn: &Connection,
    experiment_id: &str,
) -> Result<Vec<AutomationVerificationRow>, DbError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, experiment_id, mode, request_json, assertions_json, result_json,
                    evidence_session_ids, limitations_json, created_at
             FROM automation_verifications WHERE experiment_id=?1
             ORDER BY created_at ASC",
        )
        .map_err(|error| DbError::query("prepare automation verifications", error))?;
    let rows = stmt
        .query_map(params![experiment_id], |row| {
            Ok(AutomationVerificationRow {
                id: row.get(0)?,
                experiment_id: row.get(1)?,
                mode: row.get(2)?,
                request_json: row.get(3)?,
                assertions_json: row.get(4)?,
                result_json: row.get(5)?,
                evidence_session_ids: row.get(6)?,
                limitations_json: row.get(7)?,
                created_at: row.get(8)?,
            })
        })
        .map_err(|error| DbError::query("query automation verifications", error))?;
    rows.map(|row| row.map_err(|error| DbError::query("decode automation verification", error)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resource(id: &str, kind: &str) -> AutomationResourceRow {
        AutomationResourceRow {
            resource_kind: kind.to_string(),
            resource_id: id.to_string(),
            scope: "workspace".to_string(),
            scope_key: "workspace:default".to_string(),
            workspace_id: Some("default".to_string()),
            owner_kind: "agent".to_string(),
            created_by_client: Some("codex".to_string()),
            created_by_version: Some("1.0".to_string()),
            change_id: Some("change-1".to_string()),
            expires_at: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn resource_metadata_round_trips_and_filters_by_kind() {
        let conn = crate::connection::open_in_memory().unwrap();
        save_automation_resource(&conn, &resource("rewrite-1", "rewrite")).unwrap();
        save_automation_resource(&conn, &resource("map-1", "map")).unwrap();

        let loaded = load_automation_resource(&conn, "rewrite", "rewrite-1")
            .unwrap()
            .unwrap();
        assert_eq!(loaded.owner_kind, "agent");
        assert_eq!(loaded.workspace_id.as_deref(), Some("default"));

        let maps =
            list_automation_resources(&conn, Some("workspace:default"), Some("map"), None, 20)
                .unwrap();
        assert_eq!(maps.len(), 1);
        assert_eq!(maps[0].resource_id, "map-1");
    }

    #[test]
    fn idempotency_key_is_unique_inside_a_scope() {
        let conn = crate::connection::open_in_memory().unwrap();
        let change = AutomationChangeSetRow {
            id: "change-1".to_string(),
            scope: "workspace".to_string(),
            scope_key: "workspace:default".to_string(),
            workspace_id: Some("default".to_string()),
            idempotency_key: "same-key".to_string(),
            plan_hash: "plan".to_string(),
            expected_plan_hash: "plan".to_string(),
            scope_hash_before: "before".to_string(),
            scope_hash_after: "after".to_string(),
            lifecycle: "persistent".to_string(),
            status: "prepared".to_string(),
            runtime_generation: None,
            client_name: Some("codex".to_string()),
            client_version: Some("1.0".to_string()),
            summary_json: "{}".to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            committed_at: None,
            activated_at: None,
            reverted_at: None,
            expires_at: None,
        };
        insert_automation_change_set(&conn, &change).unwrap();
        assert!(insert_automation_change_set(
            &conn,
            &AutomationChangeSetRow {
                id: "change-2".to_string(),
                ..change.clone()
            }
        )
        .is_err());

        let loaded = load_automation_change_by_idempotency(&conn, "workspace:default", "same-key")
            .unwrap()
            .unwrap();
        assert_eq!(loaded.id, "change-1");
    }
}

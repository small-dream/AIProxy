use rusqlite::{params, Connection};

use crate::DbError;

/// Clamp a stored i32 port into a valid u16 (0..=65535). Guards against
/// truncation if a corrupt/out-of-range value is read back (L2).
fn i32_to_port(value: i32) -> u16 {
    value.clamp(0, 65535) as u16
}

/// Workspace row matching `WorkspaceData` from the desktop app.
#[derive(Debug, Clone)]
pub struct WorkspaceRow {
    pub id: String,
    pub name: String,
    pub proxy_port: u16,
    pub ssl_enabled: bool,
    pub http2_enabled: bool,
    pub system_proxy_enabled: bool,
    pub storage_path: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Insert or update a workspace row.
///
/// Uses UPDATE-or-INSERT rather than INSERT OR REPLACE: a REPLACE on
/// workspaces fails with a FOREIGN KEY constraint error when child rows
/// exist (rewrite_rules/map_rules/throttle_profiles/etc. reference it with
/// the default NO ACTION), so any re-save of a workspace that already has
/// rules would error out.
pub fn upsert_workspace(conn: &Connection, ws: &WorkspaceRow) -> Result<(), DbError> {
    let affected = conn
        .execute(
            "UPDATE workspaces
                SET name=?2, proxy_port=?3, ssl_enabled=?4, http2_enabled=?5,
                    system_proxy_enabled=?6, storage_path=?7, created_at=?8, updated_at=?9
             WHERE id=?1",
            params![
                ws.id,
                ws.name,
                ws.proxy_port,
                ws.ssl_enabled as i32,
                ws.http2_enabled as i32,
                ws.system_proxy_enabled as i32,
                ws.storage_path,
                ws.created_at,
                ws.updated_at,
            ],
        )
        .map_err(|e| DbError::query("update workspace", e))?;

    if affected == 0 {
        conn.execute(
            "INSERT INTO workspaces
                (id, name, proxy_port, ssl_enabled, http2_enabled, system_proxy_enabled, storage_path, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                ws.id,
                ws.name,
                ws.proxy_port,
                ws.ssl_enabled as i32,
                ws.http2_enabled as i32,
                ws.system_proxy_enabled as i32,
                ws.storage_path,
                ws.created_at,
                ws.updated_at,
            ],
        )
        .map_err(|e| DbError::query("insert workspace", e))?;
    }
    Ok(())
}

/// Update mutable fields of a workspace.
pub fn update_workspace(
    conn: &Connection,
    id: &str,
    name: Option<&str>,
    proxy_port: Option<u16>,
    ssl_enabled: Option<bool>,
    http2_enabled: Option<bool>,
    updated_at: &str,
) -> Result<(), DbError> {
    let existing = load_workspace(conn, id)?.ok_or_else(|| DbError::not_found("workspace", id))?;

    let name = name.unwrap_or(&existing.name);
    let proxy_port = proxy_port.unwrap_or(existing.proxy_port);
    let ssl_enabled = ssl_enabled.unwrap_or(existing.ssl_enabled);
    let http2_enabled = http2_enabled.unwrap_or(existing.http2_enabled);

    conn.execute(
        "UPDATE workspaces SET name=?1, proxy_port=?2, ssl_enabled=?3, http2_enabled=?4, updated_at=?5 WHERE id=?6",
        params![name, proxy_port, ssl_enabled as i32, http2_enabled as i32, updated_at, id],
    )
    .map_err(|e| DbError::query("update workspace", e))?;
    Ok(())
}

/// Load a single workspace by ID.
pub fn load_workspace(conn: &Connection, id: &str) -> Result<Option<WorkspaceRow>, DbError> {
    conn.query_row(
        "SELECT id, name, proxy_port, ssl_enabled, http2_enabled, system_proxy_enabled, storage_path, created_at, updated_at
         FROM workspaces WHERE id=?1",
        params![id],
        row_to_workspace,
    )
    .map(Some)
    .or_else(|err| {
        if matches!(err, rusqlite::Error::QueryReturnedNoRows) {
            Ok(None)
        } else {
            Err(DbError::query("load workspace", err))
        }
    })
}

/// Load all workspaces.
pub fn load_all_workspaces(conn: &Connection) -> Result<Vec<WorkspaceRow>, DbError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, proxy_port, ssl_enabled, http2_enabled, system_proxy_enabled, storage_path, created_at, updated_at
             FROM workspaces ORDER BY created_at",
        )
        .map_err(|e| DbError::query("prepare load workspaces", e))?;

    let rows: Result<Vec<WorkspaceRow>, DbError> = stmt
        .query_map([], row_to_workspace)
        .map_err(|e| DbError::query("query workspaces", e))?
        .map(|r| r.map_err(|e| DbError::query("decode workspace row", e)))
        .collect();

    Ok(rows?)
}

/// Check if the workspaces table is empty (for seeding the default).
pub fn is_empty(conn: &Connection) -> bool {
    match load_all_workspaces(conn) {
        Ok(workspaces) => workspaces.is_empty(),
        Err(err) => {
            eprintln!("[warn] failed to load workspaces for is_empty check: {err}");
            true
        }
    }
}

fn row_to_workspace(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkspaceRow> {
    Ok(WorkspaceRow {
        id: row.get("id")?,
        name: row.get("name")?,
        // Clamp i32 → u16 to avoid truncation if a corrupt/out-of-range value
        // ever lands in the column (L2). Valid ports are 0..=65535.
        proxy_port: i32_to_port(row.get::<_, i32>("proxy_port")?),
        ssl_enabled: row.get::<_, i32>("ssl_enabled")? != 0,
        http2_enabled: row.get::<_, i32>("http2_enabled")? != 0,
        system_proxy_enabled: row.get::<_, i32>("system_proxy_enabled")? != 0,
        storage_path: row.get("storage_path")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::run_migrations(&conn).unwrap();
        conn
    }

    #[test]
    fn seed_default_and_load() {
        let conn = test_conn();
        assert!(is_empty(&conn));

        let ws = WorkspaceRow {
            id: "default".into(),
            name: "Default".into(),
            proxy_port: 8888,
            ssl_enabled: true,
            http2_enabled: true,
            system_proxy_enabled: false,
            storage_path: String::new(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        upsert_workspace(&conn, &ws).unwrap();

        let loaded = load_all_workspaces(&conn).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "default");
        assert_eq!(loaded[0].proxy_port, 8888);
        assert!(loaded[0].http2_enabled);
    }

    #[test]
    fn update_workspace_fields() {
        let conn = test_conn();
        let ws = WorkspaceRow {
            id: "ws-1".into(),
            name: "Old".into(),
            proxy_port: 8080,
            ssl_enabled: true,
            http2_enabled: true,
            system_proxy_enabled: false,
            storage_path: String::new(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        upsert_workspace(&conn, &ws).unwrap();

        update_workspace(
            &conn,
            "ws-1",
            Some("New"),
            Some(9999),
            Some(true),
            Some(false),
            "2026-01-02T00:00:00Z",
        )
        .unwrap();

        let loaded = load_workspace(&conn, "ws-1").unwrap().unwrap();
        assert_eq!(loaded.name, "New");
        assert_eq!(loaded.proxy_port, 9999);
        assert!(loaded.ssl_enabled);
        assert!(!loaded.http2_enabled);
    }

    #[test]
    fn http2_enabled_defaults_to_true() {
        let conn = test_conn();
        // Insert without http2_enabled to verify DB default
        conn.execute(
            "INSERT INTO workspaces (id, name, proxy_port, ssl_enabled, system_proxy_enabled, storage_path, created_at, updated_at)
             VALUES ('ws-d', 'Default', 8888, 1, 0, '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();

        let loaded = load_workspace(&conn, "ws-d").unwrap().unwrap();
        assert!(
            loaded.http2_enabled,
            "http2_enabled should default to true (1)"
        );
    }

    #[test]
    fn update_preserves_http2_when_not_provided() {
        let conn = test_conn();
        let ws = WorkspaceRow {
            id: "ws-p".into(),
            name: "Preserve".into(),
            proxy_port: 8080,
            ssl_enabled: true,
            http2_enabled: false,
            system_proxy_enabled: false,
            storage_path: String::new(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        upsert_workspace(&conn, &ws).unwrap();

        // Update name only, http2_enabled should be preserved
        update_workspace(
            &conn,
            "ws-p",
            Some("Updated"),
            None,
            None,
            None,
            "2026-01-02T00:00:00Z",
        )
        .unwrap();

        let loaded = load_workspace(&conn, "ws-p").unwrap().unwrap();
        assert_eq!(loaded.name, "Updated");
        assert!(
            !loaded.http2_enabled,
            "http2_enabled should be preserved as false"
        );
    }

    // Regression for H8: re-upserting a workspace that already has child rows
    // (referenced via NO ACTION FK) must NOT error. The old INSERT OR REPLACE
    // implementation failed with a FOREIGN KEY constraint error because the
    // implicit delete violated the NO ACTION reference from rewrite_rules.
    #[test]
    fn upsert_workspace_succeeds_when_child_rules_exist() {
        let conn = test_conn();
        let ws = WorkspaceRow {
            id: "ws-fk".into(),
            name: "FK".into(),
            proxy_port: 8080,
            ssl_enabled: true,
            http2_enabled: true,
            system_proxy_enabled: false,
            storage_path: String::new(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        upsert_workspace(&conn, &ws).unwrap();

        // Add a child row referencing the workspace via NO ACTION FK.
        conn.execute(
            "INSERT INTO rewrite_rules
                (id, workspace_id, name, note, enabled, priority,
                 match_methods, match_stage, match_url_pattern, match_type, rewrite_type, payload)
             VALUES ('rw-1', 'ws-fk', 'rule', NULL, 1, 0, '[]', '', '*.example.com', 'contains', 'add_header', '{}')",
            [],
        )
        .unwrap();

        // Re-upsert the same workspace (e.g. user edits proxy_port). Under the
        // old INSERT OR REPLACE this returned a FOREIGN KEY constraint error.
        let mut updated = ws.clone();
        updated.proxy_port = 9090;
        updated.updated_at = "2026-01-02T00:00:00Z".into();
        upsert_workspace(&conn, &updated).expect(
            "re-upserting a workspace with child rules must succeed (H8 regression)",
        );

        // Workspace updated in place, child rule preserved.
        let loaded = load_workspace(&conn, "ws-fk").unwrap().unwrap();
        assert_eq!(loaded.proxy_port, 9090);
        let rule_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM rewrite_rules WHERE workspace_id = 'ws-fk'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rule_count, 1, "child rule must survive workspace re-upsert");
    }
}

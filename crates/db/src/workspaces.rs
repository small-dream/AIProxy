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
    /// H3: when true the proxy verifies upstream TLS certificates against the
    /// system root store on new connections. Defaults to false (NoOp verifier)
    /// to preserve the historical debug-proxy behavior.
    pub verify_upstream_tls: bool,
    /// H3: JSON-encoded array of hostnames that are always TLS-verified even
    /// when `verify_upstream_tls` is false (a "verify these hosts regardless"
    /// allowlist). Stored as a JSON string to mirror other list columns.
    pub tls_verify_hosts: String,
    /// Hostnames for which SSL decryption is disabled while the workspace
    /// keeps `ssl_enabled` on (privacy / certificate-pinning escape hatch).
    /// JSON-encoded array of hostnames, mirroring `tls_verify_hosts`.
    pub ssl_blind_hosts: String,
    /// JSON-encoded upstream (chained) proxy settings, or an empty string when
    /// the workspace has never configured one. Stored as a single JSON object
    /// because the fields are always read and written together.
    pub upstream_proxy: String,
    /// JSON-encoded per-host SSL proxying policy, or an empty string when the
    /// workspace has never configured one — which resolves to the built-in
    /// defaults rather than to two empty lists.
    pub ssl_proxying: String,
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
                    system_proxy_enabled=?6, verify_upstream_tls=?7, tls_verify_hosts=?8,
                    ssl_blind_hosts=?9, upstream_proxy=?10, ssl_proxying=?11,
                    storage_path=?12, created_at=?13, updated_at=?14
             WHERE id=?1",
            params![
                ws.id,
                ws.name,
                ws.proxy_port,
                ws.ssl_enabled as i32,
                ws.http2_enabled as i32,
                ws.system_proxy_enabled as i32,
                ws.verify_upstream_tls as i32,
                ws.tls_verify_hosts,
                ws.ssl_blind_hosts,
                ws.upstream_proxy,
                ws.ssl_proxying,
                ws.storage_path,
                ws.created_at,
                ws.updated_at,
            ],
        )
        .map_err(|e| DbError::query("update workspace", e))?;

    if affected == 0 {
        conn.execute(
            "INSERT INTO workspaces
                (id, name, proxy_port, ssl_enabled, http2_enabled, system_proxy_enabled,
                 verify_upstream_tls, tls_verify_hosts, ssl_blind_hosts, upstream_proxy,
                 ssl_proxying, storage_path, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                ws.id,
                ws.name,
                ws.proxy_port,
                ws.ssl_enabled as i32,
                ws.http2_enabled as i32,
                ws.system_proxy_enabled as i32,
                ws.verify_upstream_tls as i32,
                ws.tls_verify_hosts,
                ws.ssl_blind_hosts,
                ws.upstream_proxy,
                ws.ssl_proxying,
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
#[allow(clippy::too_many_arguments)]
pub fn update_workspace(
    conn: &Connection,
    id: &str,
    name: Option<&str>,
    proxy_port: Option<u16>,
    ssl_enabled: Option<bool>,
    http2_enabled: Option<bool>,
    verify_upstream_tls: Option<bool>,
    tls_verify_hosts: Option<&str>,
    ssl_blind_hosts: Option<&str>,
    upstream_proxy: Option<&str>,
    ssl_proxying: Option<&str>,
    updated_at: &str,
) -> Result<(), DbError> {
    let existing = load_workspace(conn, id)?.ok_or_else(|| DbError::not_found("workspace", id))?;

    let name = name.unwrap_or(&existing.name);
    let proxy_port = proxy_port.unwrap_or(existing.proxy_port);
    let ssl_enabled = ssl_enabled.unwrap_or(existing.ssl_enabled);
    let http2_enabled = http2_enabled.unwrap_or(existing.http2_enabled);
    let verify_upstream_tls = verify_upstream_tls.unwrap_or(existing.verify_upstream_tls);
    let tls_verify_hosts = tls_verify_hosts.unwrap_or(&existing.tls_verify_hosts);
    let ssl_blind_hosts = ssl_blind_hosts.unwrap_or(&existing.ssl_blind_hosts);
    let upstream_proxy = upstream_proxy.unwrap_or(&existing.upstream_proxy);
    let ssl_proxying = ssl_proxying.unwrap_or(&existing.ssl_proxying);

    conn.execute(
        "UPDATE workspaces SET name=?1, proxy_port=?2, ssl_enabled=?3, http2_enabled=?4,
            verify_upstream_tls=?5, tls_verify_hosts=?6, ssl_blind_hosts=?7,
            upstream_proxy=?8, ssl_proxying=?9, updated_at=?10
         WHERE id=?11",
        params![
            name,
            proxy_port,
            ssl_enabled as i32,
            http2_enabled as i32,
            verify_upstream_tls as i32,
            tls_verify_hosts,
            ssl_blind_hosts,
            upstream_proxy,
            ssl_proxying,
            updated_at,
            id,
        ],
    )
    .map_err(|e| DbError::query("update workspace", e))?;
    Ok(())
}

/// Persist the `system_proxy_enabled` toggle for a workspace (M9).
///
/// The enable/disable system-proxy commands previously only mutated the
/// in-memory `BootstrapStatus`, so the toggle reverted on restart. This
/// dedicated helper persists it without touching the wide `update_workspace`
/// signature. System-proxy *actual* restoration on restart is handled
/// independently by `system_proxy_recovery.rs`; this column is mainly for UI
/// consistency across restarts.
pub fn set_workspace_system_proxy_enabled(
    conn: &Connection,
    id: &str,
    enabled: bool,
) -> Result<(), DbError> {
    conn.execute(
        "UPDATE workspaces SET system_proxy_enabled=?1 WHERE id=?2",
        params![enabled as i32, id],
    )
    .map_err(|e| DbError::query("set workspace system_proxy_enabled", e))?;
    Ok(())
}

/// Persist the `ssl_enabled` toggle for a workspace.
///
/// Used by the certificate-removal flow: deleting the root CA makes SSL
/// interception impossible, so the workspace flag must not keep claiming SSL
/// is on (the next plain start would die on ERR_CERT_NOT_FOUND). Dedicated
/// helper for the same reason as `set_workspace_system_proxy_enabled` — the
/// wide `update_workspace` signature is not worth dragging one boolean
/// through async command plumbing.
pub fn set_workspace_ssl_enabled(
    conn: &Connection,
    id: &str,
    enabled: bool,
) -> Result<(), DbError> {
    conn.execute(
        "UPDATE workspaces SET ssl_enabled=?1 WHERE id=?2",
        params![enabled as i32, id],
    )
    .map_err(|e| DbError::query("set workspace ssl_enabled", e))?;
    Ok(())
}

/// Load a single workspace by ID.
pub fn load_workspace(conn: &Connection, id: &str) -> Result<Option<WorkspaceRow>, DbError> {
    conn.query_row(
        "SELECT id, name, proxy_port, ssl_enabled, http2_enabled, system_proxy_enabled,
                verify_upstream_tls, tls_verify_hosts, ssl_blind_hosts, upstream_proxy,
                ssl_proxying, storage_path, created_at, updated_at
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
            "SELECT id, name, proxy_port, ssl_enabled, http2_enabled, system_proxy_enabled,
                    verify_upstream_tls, tls_verify_hosts, ssl_blind_hosts, upstream_proxy,
                    ssl_proxying, storage_path, created_at, updated_at
             FROM workspaces ORDER BY created_at",
        )
        .map_err(|e| DbError::query("prepare load workspaces", e))?;

    let rows: Result<Vec<WorkspaceRow>, DbError> = stmt
        .query_map([], row_to_workspace)
        .map_err(|e| DbError::query("query workspaces", e))?
        .map(|r| r.map_err(|e| DbError::query("decode workspace row", e)))
        .collect();

    rows
}

/// Check if the workspaces table is empty (for seeding the default).
///
/// Returns `Result<bool, DbError>` (M5): DB errors are propagated so callers
/// can decide whether to seed. Previously this returned `true` on any error,
/// which misled the desktop app into seeding a default workspace — and
/// potentially overwriting existing data — when the underlying query failed
/// transiently (e.g. a locked/busy DB). The caller must NOT seed on `Err`.
pub fn is_empty(conn: &Connection) -> Result<bool, DbError> {
    let workspaces = load_all_workspaces(conn)?;
    Ok(workspaces.is_empty())
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
        verify_upstream_tls: row.get::<_, i32>("verify_upstream_tls")? != 0,
        tls_verify_hosts: row.get("tls_verify_hosts")?,
        ssl_blind_hosts: row.get("ssl_blind_hosts")?,
        upstream_proxy: row.get("upstream_proxy")?,
        ssl_proxying: row.get("ssl_proxying")?,
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

    // Regression for M5: is_empty must propagate DB errors (e.g. missing
    // workspaces table) instead of masking them as an empty table. The old
    // implementation returned `true` on Err, which misled the desktop app into
    // seeding a default workspace and potentially overwriting existing data on
    // a transient query failure.
    #[test]
    fn is_empty_propagates_db_error() {
        // An in-memory connection WITHOUT the schema migrated: querying the
        // workspaces table errors. is_empty must propagate Err, not return
        // true (which would trigger an unwanted default seed).
        let conn = Connection::open_in_memory().unwrap();
        let result = is_empty(&conn);
        assert!(
            result.is_err(),
            "is_empty must propagate DB errors, not mask as empty"
        );

        // Sanity: load_all_workspaces also errors on a missing table, which is
        // the underlying cause is_empty must surface.
        assert!(
            load_all_workspaces(&conn).is_err(),
            "load_all_workspaces must error when the workspaces table is missing"
        );
    }

    #[test]
    fn seed_default_and_load() {
        let conn = test_conn();
        assert!(is_empty(&conn).expect("is_empty should succeed after migrations"));

        let ws = WorkspaceRow {
            id: "default".into(),
            name: "Default".into(),
            proxy_port: 8888,
            ssl_enabled: true,
            http2_enabled: true,
            system_proxy_enabled: false,
            verify_upstream_tls: false,
            tls_verify_hosts: "[]".into(),
            ssl_blind_hosts: "[]".into(),
            upstream_proxy: String::new(),
            ssl_proxying: String::new(),
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
            verify_upstream_tls: false,
            tls_verify_hosts: "[]".into(),
            ssl_blind_hosts: "[]".into(),
            upstream_proxy: String::new(),
            ssl_proxying: String::new(),
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
            Some(true),
            Some(r#"["example.com"]"#),
            Some(r#"["pinned.example.com"]"#),
            None,
            None,
            "2026-01-02T00:00:00Z",
        )
        .unwrap();

        let loaded = load_workspace(&conn, "ws-1").unwrap().unwrap();
        assert_eq!(loaded.name, "New");
        assert_eq!(loaded.proxy_port, 9999);
        assert!(loaded.ssl_enabled);
        assert!(!loaded.http2_enabled);
        assert!(
            loaded.verify_upstream_tls,
            "verify_upstream_tls should round-trip"
        );
        assert_eq!(
            loaded.tls_verify_hosts, r#"["example.com"]"#,
            "tls_verify_hosts should round-trip"
        );
        assert_eq!(
            loaded.ssl_blind_hosts, r#"["pinned.example.com"]"#,
            "ssl_blind_hosts should round-trip"
        );
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

    // H3: the upstream TLS verification columns must default to off / empty
    // allowlist so existing installs keep the historical NoOp-verifier behavior.
    #[test]
    fn verify_upstream_tls_defaults_to_off() {
        let conn = test_conn();
        conn.execute(
            "INSERT INTO workspaces (id, name, proxy_port, ssl_enabled, system_proxy_enabled, storage_path, created_at, updated_at)
             VALUES ('ws-v', 'Default', 8888, 1, 0, '', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();

        let loaded = load_workspace(&conn, "ws-v").unwrap().unwrap();
        assert!(
            !loaded.verify_upstream_tls,
            "verify_upstream_tls should default to false (0) for compatibility"
        );
        assert_eq!(
            loaded.tls_verify_hosts, "[]",
            "tls_verify_hosts should default to an empty JSON array"
        );
        assert_eq!(
            loaded.upstream_proxy, "",
            "upstream_proxy should default to an empty string (never configured)"
        );
    }

    #[test]
    fn upstream_proxy_json_round_trips() {
        let conn = test_conn();
        let settings = r#"{"enabled":true,"protocol":"socks5","host":"127.0.0.1","port":7891,"username":"alice","password":"s3cret","bypass":["localhost"]}"#;
        let ws = WorkspaceRow {
            id: "ws-up".into(),
            name: "Upstream".into(),
            proxy_port: 8888,
            ssl_enabled: true,
            http2_enabled: true,
            system_proxy_enabled: false,
            verify_upstream_tls: false,
            tls_verify_hosts: "[]".into(),
            ssl_blind_hosts: "[]".into(),
            upstream_proxy: settings.into(),
            ssl_proxying: String::new(),
            storage_path: String::new(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        upsert_workspace(&conn, &ws).unwrap();

        let loaded = load_workspace(&conn, "ws-up").unwrap().unwrap();
        assert_eq!(loaded.upstream_proxy, settings);

        // A re-save (UPDATE branch) must preserve it too.
        upsert_workspace(&conn, &ws).unwrap();
        let reloaded = load_workspace(&conn, "ws-up").unwrap().unwrap();
        assert_eq!(reloaded.upstream_proxy, settings);
    }

    #[test]
    fn ssl_proxying_json_round_trips() {
        let conn = test_conn();
        let settings = r#"{"include":["*.example.com"],"exclude":["*.tiktokv.com"]}"#;
        let ws = WorkspaceRow {
            id: "ws-ssl".into(),
            name: "SslProxying".into(),
            proxy_port: 8888,
            ssl_enabled: true,
            http2_enabled: true,
            system_proxy_enabled: false,
            verify_upstream_tls: false,
            tls_verify_hosts: "[]".into(),
            ssl_blind_hosts: "[]".into(),
            upstream_proxy: String::new(),
            ssl_proxying: settings.into(),
            storage_path: String::new(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        upsert_workspace(&conn, &ws).unwrap();

        let loaded = load_workspace(&conn, "ws-ssl").unwrap().unwrap();
        assert_eq!(loaded.ssl_proxying, settings);

        // A re-save (UPDATE branch) must preserve it too.
        upsert_workspace(&conn, &ws).unwrap();
        let reloaded = load_workspace(&conn, "ws-ssl").unwrap().unwrap();
        assert_eq!(reloaded.ssl_proxying, settings);
    }

    #[test]
    fn update_preserves_ssl_proxying_when_not_provided() {
        let conn = test_conn();
        let settings = r#"{"include":[],"exclude":["*.pinned.com"]}"#;
        let ws = WorkspaceRow {
            id: "ws-ssl-keep".into(),
            name: "Keep".into(),
            proxy_port: 8888,
            ssl_enabled: true,
            http2_enabled: true,
            system_proxy_enabled: false,
            verify_upstream_tls: false,
            tls_verify_hosts: "[]".into(),
            ssl_blind_hosts: "[]".into(),
            upstream_proxy: String::new(),
            ssl_proxying: settings.into(),
            storage_path: String::new(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        upsert_workspace(&conn, &ws).unwrap();

        // Renaming the workspace must not silently wipe the policy.
        update_workspace(
            &conn,
            "ws-ssl-keep",
            Some("Renamed"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            "2026-01-02T00:00:00Z",
        )
        .unwrap();

        let loaded = load_workspace(&conn, "ws-ssl-keep").unwrap().unwrap();
        assert_eq!(loaded.name, "Renamed");
        assert_eq!(
            loaded.ssl_proxying, settings,
            "ssl_proxying should survive an unrelated update"
        );
    }

    #[test]
    fn update_preserves_upstream_proxy_when_not_provided() {
        let conn = test_conn();
        let settings = r#"{"enabled":true,"protocol":"http","host":"127.0.0.1","port":7890,"username":null,"password":null,"bypass":[]}"#;
        let ws = WorkspaceRow {
            id: "ws-keep".into(),
            name: "Keep".into(),
            proxy_port: 8888,
            ssl_enabled: true,
            http2_enabled: true,
            system_proxy_enabled: false,
            verify_upstream_tls: false,
            tls_verify_hosts: "[]".into(),
            ssl_blind_hosts: "[]".into(),
            upstream_proxy: settings.into(),
            ssl_proxying: String::new(),
            storage_path: String::new(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        upsert_workspace(&conn, &ws).unwrap();

        // Rename only — the upstream proxy config must survive untouched.
        update_workspace(
            &conn,
            "ws-keep",
            Some("Renamed"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            "2026-01-02T00:00:00Z",
        )
        .unwrap();

        let loaded = load_workspace(&conn, "ws-keep").unwrap().unwrap();
        assert_eq!(loaded.name, "Renamed");
        assert_eq!(
            loaded.upstream_proxy, settings,
            "an unrelated update must not clear the upstream proxy settings"
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
            verify_upstream_tls: false,
            tls_verify_hosts: "[]".into(),
            ssl_blind_hosts: "[]".into(),
            upstream_proxy: String::new(),
            ssl_proxying: String::new(),
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
            None,
            None,
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
            verify_upstream_tls: false,
            tls_verify_hosts: "[]".into(),
            ssl_blind_hosts: "[]".into(),
            upstream_proxy: String::new(),
            ssl_proxying: String::new(),
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
        upsert_workspace(&conn, &updated)
            .expect("re-upserting a workspace with child rules must succeed (H8 regression)");

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

    // M9: set_workspace_system_proxy_enabled must persist the toggle so it
    // survives restart. The enable/disable commands previously only mutated
    // in-memory status, so the column reverted on restart.
    #[test]
    fn m9_set_workspace_system_proxy_enabled_round_trips() {
        let conn = test_conn();
        let ws = WorkspaceRow {
            id: "ws-m9".into(),
            name: "M9".into(),
            proxy_port: 8888,
            ssl_enabled: false,
            http2_enabled: true,
            system_proxy_enabled: false,
            verify_upstream_tls: false,
            tls_verify_hosts: "[]".into(),
            ssl_blind_hosts: "[]".into(),
            upstream_proxy: String::new(),
            ssl_proxying: String::new(),
            storage_path: String::new(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        upsert_workspace(&conn, &ws).unwrap();
        // Initially false.
        assert!(
            !load_workspace(&conn, "ws-m9")
                .unwrap()
                .unwrap()
                .system_proxy_enabled
        );

        // Enable — must persist.
        set_workspace_system_proxy_enabled(&conn, "ws-m9", true).unwrap();
        assert!(
            load_workspace(&conn, "ws-m9")
                .unwrap()
                .unwrap()
                .system_proxy_enabled,
            "system_proxy_enabled must be persisted as true"
        );

        // Disable — must persist.
        set_workspace_system_proxy_enabled(&conn, "ws-m9", false).unwrap();
        assert!(
            !load_workspace(&conn, "ws-m9")
                .unwrap()
                .unwrap()
                .system_proxy_enabled,
            "system_proxy_enabled must be persisted as false"
        );
    }

    // Certificate-removal flow: set_workspace_ssl_enabled must persist the
    // toggle so a workspace whose root CA was deleted does not claim SSL on.
    #[test]
    fn set_workspace_ssl_enabled_round_trips() {
        let conn = test_conn();
        let ws = WorkspaceRow {
            id: "ws-ssl".into(),
            name: "SSL".into(),
            proxy_port: 8888,
            ssl_enabled: true,
            http2_enabled: true,
            system_proxy_enabled: false,
            verify_upstream_tls: false,
            tls_verify_hosts: "[]".into(),
            ssl_blind_hosts: "[]".into(),
            upstream_proxy: String::new(),
            ssl_proxying: String::new(),
            storage_path: String::new(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        upsert_workspace(&conn, &ws).unwrap();
        assert!(
            load_workspace(&conn, "ws-ssl")
                .unwrap()
                .unwrap()
                .ssl_enabled,
            "precondition: ssl_enabled starts true"
        );

        set_workspace_ssl_enabled(&conn, "ws-ssl", false).unwrap();
        assert!(
            !load_workspace(&conn, "ws-ssl")
                .unwrap()
                .unwrap()
                .ssl_enabled,
            "ssl_enabled must be persisted as false"
        );
    }
}

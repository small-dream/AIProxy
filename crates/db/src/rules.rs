use rusqlite::{params, Connection};

// ---------------------------------------------------------------------------
// Rewrite rules
// ---------------------------------------------------------------------------

pub struct RewriteRuleRow {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub note: Option<String>,
    pub enabled: bool,
    pub priority: u32,
    pub match_methods: String,      // JSON array
    pub match_stage: String,
    pub match_url_pattern: String,
    pub rewrite_type: String,
    pub payload: String,            // JSON value
}

pub fn save_rewrite_rule(conn: &Connection, r: &RewriteRuleRow) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO rewrite_rules
            (id, workspace_id, name, note, enabled, priority,
             match_methods, match_stage, match_url_pattern, rewrite_type, payload)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            r.id, r.workspace_id, r.name, r.note,
            r.enabled as i32, r.priority,
            r.match_methods, r.match_stage, r.match_url_pattern,
            r.rewrite_type, r.payload,
        ],
    )
    .map_err(|e| format!("save rewrite rule: {e}"))?;
    Ok(())
}

pub fn load_rewrite_rules(conn: &Connection, workspace_id: &str) -> Result<Vec<RewriteRuleRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, workspace_id, name, note, enabled, priority,
                    match_methods, match_stage, match_url_pattern, rewrite_type, payload
             FROM rewrite_rules WHERE workspace_id=?1 ORDER BY priority",
        )
        .map_err(|e| format!("prepare load rewrite rules: {e}"))?;

    let rows = stmt
        .query_map(params![workspace_id], |row| {
            Ok(RewriteRuleRow {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                name: row.get(2)?,
                note: row.get(3)?,
                enabled: row.get::<_, i32>(4)? != 0,
                priority: row.get::<_, i32>(5)? as u32,
                match_methods: row.get(6)?,
                match_stage: row.get(7)?,
                match_url_pattern: row.get(8)?,
                rewrite_type: row.get(9)?,
                payload: row.get(10)?,
            })
        })
        .map_err(|e| format!("query rewrite rules: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

pub fn load_all_rewrite_rules(conn: &Connection) -> Result<Vec<RewriteRuleRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, workspace_id, name, note, enabled, priority,
                    match_methods, match_stage, match_url_pattern, rewrite_type, payload
             FROM rewrite_rules ORDER BY priority",
        )
        .map_err(|e| format!("prepare load all rewrite rules: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(RewriteRuleRow {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                name: row.get(2)?,
                note: row.get(3)?,
                enabled: row.get::<_, i32>(4)? != 0,
                priority: row.get::<_, i32>(5)? as u32,
                match_methods: row.get(6)?,
                match_stage: row.get(7)?,
                match_url_pattern: row.get(8)?,
                rewrite_type: row.get(9)?,
                payload: row.get(10)?,
            })
        })
        .map_err(|e| format!("query all rewrite rules: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

pub fn delete_rewrite_rule(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM rewrite_rules WHERE id=?1", params![id])
        .map_err(|e| format!("delete rewrite rule: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Map rules
// ---------------------------------------------------------------------------

pub struct MapRuleRow {
    pub id: String,
    pub workspace_id: String,
    pub mode: String,
    pub name: String,
    pub note: Option<String>,
    pub enabled: bool,
    pub preserve_path: bool,
    pub preserve_query: bool,
    pub priority: u32,
    pub source_pattern: String,
    pub target_value: String,
}

pub fn save_map_rule(conn: &Connection, r: &MapRuleRow) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO map_rules
            (id, workspace_id, mode, name, note, enabled, preserve_path,
             preserve_query, priority, source_pattern, target_value)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            r.id, r.workspace_id, r.mode, r.name, r.note,
            r.enabled as i32, r.preserve_path as i32, r.preserve_query as i32,
            r.priority, r.source_pattern, r.target_value,
        ],
    )
    .map_err(|e| format!("save map rule: {e}"))?;
    Ok(())
}

pub fn load_all_map_rules(conn: &Connection) -> Result<Vec<MapRuleRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, workspace_id, mode, name, note, enabled, preserve_path,
                    preserve_query, priority, source_pattern, target_value
             FROM map_rules ORDER BY priority",
        )
        .map_err(|e| format!("prepare load map rules: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(MapRuleRow {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                mode: row.get(2)?,
                name: row.get(3)?,
                note: row.get(4)?,
                enabled: row.get::<_, i32>(5)? != 0,
                preserve_path: row.get::<_, i32>(6)? != 0,
                preserve_query: row.get::<_, i32>(7)? != 0,
                priority: row.get::<_, i32>(8)? as u32,
                source_pattern: row.get(9)?,
                target_value: row.get(10)?,
            })
        })
        .map_err(|e| format!("query map rules: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

pub fn delete_map_rule(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM map_rules WHERE id=?1", params![id])
        .map_err(|e| format!("delete map rule: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Throttle profiles
// ---------------------------------------------------------------------------

pub struct ThrottleProfileRow {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub note: Option<String>,
    pub enabled: bool,
    pub preset: bool,
    pub latency_ms: u32,
    pub upload_kbps: u32,
    pub download_kbps: u32,
    pub packet_loss_ratio: f32,
}

pub fn save_throttle_profile(conn: &Connection, p: &ThrottleProfileRow) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO throttle_profiles
            (id, workspace_id, name, note, enabled, preset, latency_ms,
             upload_kbps, download_kbps, packet_loss_ratio)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            p.id, p.workspace_id, p.name, p.note,
            p.enabled as i32, p.preset as i32,
            p.latency_ms, p.upload_kbps, p.download_kbps, p.packet_loss_ratio,
        ],
    )
    .map_err(|e| format!("save throttle profile: {e}"))?;
    Ok(())
}

pub fn load_all_throttle_profiles(conn: &Connection) -> Result<Vec<ThrottleProfileRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, workspace_id, name, note, enabled, preset, latency_ms,
                    upload_kbps, download_kbps, packet_loss_ratio
             FROM throttle_profiles ORDER BY name",
        )
        .map_err(|e| format!("prepare load throttle profiles: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(ThrottleProfileRow {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                name: row.get(2)?,
                note: row.get(3)?,
                enabled: row.get::<_, i32>(4)? != 0,
                preset: row.get::<_, i32>(5)? != 0,
                latency_ms: row.get::<_, i32>(6)? as u32,
                upload_kbps: row.get::<_, i32>(7)? as u32,
                download_kbps: row.get::<_, i32>(8)? as u32,
                packet_loss_ratio: row.get(9)?,
            })
        })
        .map_err(|e| format!("query throttle profiles: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

// ---------------------------------------------------------------------------
// Breakpoint rules
// ---------------------------------------------------------------------------

pub struct BreakpointRuleRow {
    pub id: String,
    pub enabled: bool,
    pub url_pattern: String,
    pub methods: String,  // JSON array
    pub stage: String,
}

/// Replace all breakpoint rules atomically.
pub fn replace_breakpoint_rules(conn: &Connection, rules: &[BreakpointRuleRow]) -> Result<(), String> {
    conn.execute("DELETE FROM breakpoint_rules", [])
        .map_err(|e| format!("clear breakpoint rules: {e}"))?;

    for r in rules {
        conn.execute(
            "INSERT INTO breakpoint_rules (id, enabled, url_pattern, methods, stage)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![r.id, r.enabled as i32, r.url_pattern, r.methods, r.stage],
        )
        .map_err(|e| format!("insert breakpoint rule: {e}"))?;
    }

    Ok(())
}

pub fn load_breakpoint_rules(conn: &Connection) -> Result<Vec<BreakpointRuleRow>, String> {
    let mut stmt = conn
        .prepare("SELECT id, enabled, url_pattern, methods, stage FROM breakpoint_rules")
        .map_err(|e| format!("prepare load breakpoint rules: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(BreakpointRuleRow {
                id: row.get(0)?,
                enabled: row.get::<_, i32>(1)? != 0,
                url_pattern: row.get(2)?,
                methods: row.get(3)?,
                stage: row.get(4)?,
            })
        })
        .map_err(|e| format!("query breakpoint rules: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

// ---------------------------------------------------------------------------
// DNS mappings
// ---------------------------------------------------------------------------

pub struct DnsMappingRow {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub note: Option<String>,
    pub enabled: bool,
    pub priority: u32,
    pub host_pattern: String,
    pub target_ip: String,
}

pub fn save_dns_mapping(conn: &Connection, r: &DnsMappingRow) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO dns_mappings
            (id, workspace_id, name, note, enabled, priority, host_pattern, target_ip)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            r.id, r.workspace_id, r.name, r.note,
            r.enabled as i32, r.priority, r.host_pattern, r.target_ip,
        ],
    )
    .map_err(|e| format!("save dns mapping: {e}"))?;
    Ok(())
}

pub fn load_all_dns_mappings(conn: &Connection) -> Result<Vec<DnsMappingRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, workspace_id, name, note, enabled, priority, host_pattern, target_ip
             FROM dns_mappings ORDER BY priority DESC, name",
        )
        .map_err(|e| format!("prepare load dns mappings: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(DnsMappingRow {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                name: row.get(2)?,
                note: row.get(3)?,
                enabled: row.get::<_, i32>(4)? != 0,
                priority: row.get::<_, i32>(5)? as u32,
                host_pattern: row.get(6)?,
                target_ip: row.get(7)?,
            })
        })
        .map_err(|e| format!("query dns mappings: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

pub fn delete_dns_mapping(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM dns_mappings WHERE id=?1", params![id])
        .map_err(|e| format!("delete dns mapping: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::run_migrations(&conn).unwrap();
        // Seed a default workspace for FK constraints
        let ws = crate::workspaces::WorkspaceRow {
            id: "default".into(),
            name: "Default".into(),
            proxy_port: 8888,
            ssl_enabled: false,
            system_proxy_enabled: false,
            storage_path: String::new(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        crate::workspaces::upsert_workspace(&conn, &ws).unwrap();
        conn
    }

    #[test]
    fn rewrite_rule_round_trip() {
        let conn = test_conn();
        let rule = RewriteRuleRow {
            id: "r1".into(),
            workspace_id: "default".into(),
            name: "Test".into(),
            note: Some("a note".into()),
            enabled: true,
            priority: 10,
            match_methods: "[\"GET\",\"POST\"]".into(),
            match_stage: "request".into(),
            match_url_pattern: "example.com".into(),
            rewrite_type: "header".into(),
            payload: r#"{"headerName":"X-Test","operation":"set","target":"request","value":"1"}"#.into(),
        };

        save_rewrite_rule(&conn, &rule).unwrap();
        let loaded = load_all_rewrite_rules(&conn).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "r1");
        assert_eq!(loaded[0].match_methods, "[\"GET\",\"POST\"]");

        delete_rewrite_rule(&conn, "r1").unwrap();
        assert!(load_all_rewrite_rules(&conn).unwrap().is_empty());
    }

    #[test]
    fn map_rule_round_trip() {
        let conn = test_conn();
        let rule = MapRuleRow {
            id: "m1".into(),
            workspace_id: "default".into(),
            mode: "local".into(),
            name: "Map Test".into(),
            note: None,
            enabled: true,
            preserve_path: true,
            preserve_query: false,
            priority: 5,
            source_pattern: "api.example.com".into(),
            target_value: "/path/to/file.json".into(),
        };

        save_map_rule(&conn, &rule).unwrap();
        let loaded = load_all_map_rules(&conn).unwrap();
        assert_eq!(loaded.len(), 1);
        assert!(loaded[0].preserve_path);
        assert!(!loaded[0].preserve_query);
    }

    #[test]
    fn throttle_profile_round_trip() {
        let conn = test_conn();
        let profile = ThrottleProfileRow {
            id: "t1".into(),
            workspace_id: "default".into(),
            name: "Slow 3G".into(),
            note: None,
            enabled: true,
            preset: true,
            latency_ms: 100,
            upload_kbps: 300,
            download_kbps: 500,
            packet_loss_ratio: 0.0,
        };

        save_throttle_profile(&conn, &profile).unwrap();
        let loaded = load_all_throttle_profiles(&conn).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].download_kbps, 500);
    }

    #[test]
    fn breakpoint_replace_and_load() {
        let conn = test_conn();
        let rules = vec![
            BreakpointRuleRow {
                id: "b1".into(),
                enabled: true,
                url_pattern: "example.com".into(),
                methods: "[\"GET\"]".into(),
                stage: "Request".into(),
            },
            BreakpointRuleRow {
                id: "b2".into(),
                enabled: false,
                url_pattern: "*".into(),
                methods: "[]".into(),
                stage: "Response".into(),
            },
        ];

        replace_breakpoint_rules(&conn, &rules).unwrap();
        let loaded = load_breakpoint_rules(&conn).unwrap();
        assert_eq!(loaded.len(), 2);

        // Replace with fewer rules
        replace_breakpoint_rules(&conn, &rules[..1]).unwrap();
        let loaded = load_breakpoint_rules(&conn).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "b1");
    }

    #[test]
    fn dns_mapping_round_trip() {
        let conn = test_conn();
        let mapping = DnsMappingRow {
            id: "d1".into(),
            workspace_id: "default".into(),
            name: "Local API".into(),
            note: Some("redirect to local".into()),
            enabled: true,
            priority: 100,
            host_pattern: "api.example.com".into(),
            target_ip: "127.0.0.1".into(),
        };

        save_dns_mapping(&conn, &mapping).unwrap();
        let loaded = load_all_dns_mappings(&conn).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].host_pattern, "api.example.com");
        assert_eq!(loaded[0].target_ip, "127.0.0.1");
        assert_eq!(loaded[0].priority, 100);

        delete_dns_mapping(&conn, "d1").unwrap();
        assert!(load_all_dns_mappings(&conn).unwrap().is_empty());
    }
}

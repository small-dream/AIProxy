use rusqlite::{params, Connection};

use crate::DbError;

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
    pub match_methods: String, // JSON array
    pub match_stage: String,
    pub match_url_pattern: String,
    pub match_type: String,
    pub rewrite_type: String,
    pub payload: String, // JSON value
}

pub fn save_rewrite_rule(conn: &Connection, r: &RewriteRuleRow) -> Result<(), DbError> {
    conn.execute(
        "INSERT OR REPLACE INTO rewrite_rules
            (id, workspace_id, name, note, enabled, priority,
             match_methods, match_stage, match_url_pattern, match_type, rewrite_type, payload)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            r.id,
            r.workspace_id,
            r.name,
            r.note,
            r.enabled as i32,
            r.priority,
            r.match_methods,
            r.match_stage,
            r.match_url_pattern,
            r.match_type,
            r.rewrite_type,
            r.payload,
        ],
    )
    .map_err(|e| DbError::query("save rewrite rule", e))?;
    Ok(())
}

pub fn load_rewrite_rules(
    conn: &Connection,
    workspace_id: &str,
) -> Result<Vec<RewriteRuleRow>, DbError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, workspace_id, name, note, enabled, priority,
                    match_methods, match_stage, match_url_pattern, match_type, rewrite_type, payload
             FROM rewrite_rules WHERE workspace_id=?1 ORDER BY priority",
        )
        .map_err(|e| DbError::query("prepare load rewrite rules", e))?;

    let rows: Result<Vec<RewriteRuleRow>, DbError> = stmt
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
                match_type: row.get(9)?,
                rewrite_type: row.get(10)?,
                payload: row.get(11)?,
            })
        })
        .map_err(|e| DbError::query("query rewrite rules", e))?
        .map(|r| r.map_err(|e| DbError::query("decode rewrite rule row", e)))
        .collect();

    Ok(rows?)
}

pub fn load_all_rewrite_rules(conn: &Connection) -> Result<Vec<RewriteRuleRow>, DbError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, workspace_id, name, note, enabled, priority,
                    match_methods, match_stage, match_url_pattern, match_type, rewrite_type, payload
             FROM rewrite_rules ORDER BY priority",
        )
        .map_err(|e| DbError::query("prepare load all rewrite rules", e))?;

    let rows: Result<Vec<RewriteRuleRow>, DbError> = stmt
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
                match_type: row.get(9)?,
                rewrite_type: row.get(10)?,
                payload: row.get(11)?,
            })
        })
        .map_err(|e| DbError::query("query all rewrite rules", e))?
        .map(|r| r.map_err(|e| DbError::query("decode rewrite rule row", e)))
        .collect();

    Ok(rows?)
}

pub fn delete_rewrite_rule(conn: &Connection, id: &str) -> Result<(), DbError> {
    conn.execute("DELETE FROM rewrite_rules WHERE id=?1", params![id])
        .map_err(|e| DbError::query("delete rewrite rule", e))?;
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

pub fn save_map_rule(conn: &Connection, r: &MapRuleRow) -> Result<(), DbError> {
    conn.execute(
        "INSERT OR REPLACE INTO map_rules
            (id, workspace_id, mode, name, note, enabled, preserve_path,
             preserve_query, priority, source_pattern, target_value)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            r.id,
            r.workspace_id,
            r.mode,
            r.name,
            r.note,
            r.enabled as i32,
            r.preserve_path as i32,
            r.preserve_query as i32,
            r.priority,
            r.source_pattern,
            r.target_value,
        ],
    )
    .map_err(|e| DbError::query("save map rule", e))?;
    Ok(())
}

pub fn load_all_map_rules(conn: &Connection) -> Result<Vec<MapRuleRow>, DbError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, workspace_id, mode, name, note, enabled, preserve_path,
                    preserve_query, priority, source_pattern, target_value
             FROM map_rules ORDER BY priority",
        )
        .map_err(|e| DbError::query("prepare load map rules", e))?;

    let rows: Result<Vec<MapRuleRow>, DbError> = stmt
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
        .map_err(|e| DbError::query("query map rules", e))?
        .map(|r| r.map_err(|e| DbError::query("decode map rule row", e)))
        .collect();

    Ok(rows?)
}

pub fn delete_map_rule(conn: &Connection, id: &str) -> Result<(), DbError> {
    conn.execute("DELETE FROM map_rules WHERE id=?1", params![id])
        .map_err(|e| DbError::query("delete map rule", e))?;
    Ok(())
}

pub struct MapRunRow {
    pub id: String,
    pub session_id: String,
    pub workspace_id: String,
    pub rule_id: String,
    pub rule_name: String,
    pub mode: String,
    pub outcome: String,
    pub source_pattern: String,
    pub target_value: String,
    pub original_url: String,
    pub mapped_url: Option<String>,
    pub local_path: Option<String>,
    pub duration_ms: u128,
    pub sequence: u32,
    pub created_at: String,
}

pub fn replace_map_runs_for_session(
    conn: &Connection,
    session_id: &str,
    runs: &[MapRunRow],
) -> Result<(), DbError> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| DbError::query("begin replace map runs transaction", e))?;

    tx.execute(
        "DELETE FROM map_runs WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|e| DbError::query("delete map runs for session", e))?;

    for run in runs {
        tx.execute(
            "INSERT INTO map_runs
                (id, session_id, workspace_id, rule_id, rule_name, mode, outcome,
                 source_pattern, target_value, original_url, mapped_url, local_path,
                 duration_ms, sequence, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                run.id,
                run.session_id,
                run.workspace_id,
                run.rule_id,
                run.rule_name,
                run.mode,
                run.outcome,
                run.source_pattern,
                run.target_value,
                run.original_url,
                run.mapped_url,
                run.local_path,
                run.duration_ms as i64,
                run.sequence as i64,
                run.created_at,
            ],
        )
        .map_err(|e| DbError::query("insert map run", e))?;
    }

    tx.commit()
        .map_err(|e| DbError::query("commit replace map runs transaction", e))?;
    Ok(())
}

pub fn load_map_runs_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<MapRunRow>, DbError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, workspace_id, rule_id, rule_name, mode, outcome,
                    source_pattern, target_value, original_url, mapped_url, local_path,
                    duration_ms, sequence, created_at
             FROM map_runs WHERE session_id = ?1 ORDER BY sequence ASC, created_at ASC",
        )
        .map_err(|e| DbError::query("prepare load map runs", e))?;

    let rows: Result<Vec<MapRunRow>, DbError> = stmt
        .query_map(params![session_id], |row| {
            Ok(MapRunRow {
                id: row.get(0)?,
                session_id: row.get(1)?,
                workspace_id: row.get(2)?,
                rule_id: row.get(3)?,
                rule_name: row.get(4)?,
                mode: row.get(5)?,
                outcome: row.get(6)?,
                source_pattern: row.get(7)?,
                target_value: row.get(8)?,
                original_url: row.get(9)?,
                mapped_url: row.get(10)?,
                local_path: row.get(11)?,
                duration_ms: row.get::<_, i64>(12)? as u128,
                sequence: row.get::<_, i64>(13)? as u32,
                created_at: row.get(14)?,
            })
        })
        .map_err(|e| DbError::query("query map runs", e))?
        .map(|r| r.map_err(|e| DbError::query("decode map rule row", e)))
        .collect();

    Ok(rows?)
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

pub fn save_throttle_profile(conn: &Connection, p: &ThrottleProfileRow) -> Result<(), DbError> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| DbError::query("begin save throttle profile transaction", e))?;

    if p.enabled {
        tx.execute(
            "UPDATE throttle_profiles SET enabled = 0 WHERE workspace_id = ?1 AND id != ?2",
            params![p.workspace_id, p.id],
        )
        .map_err(|e| DbError::query("deactivate other throttle profiles", e))?;
    }

    tx.execute(
        "INSERT OR REPLACE INTO throttle_profiles
            (id, workspace_id, name, note, enabled, preset, latency_ms,
             upload_kbps, download_kbps, packet_loss_ratio)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            p.id,
            p.workspace_id,
            p.name,
            p.note,
            p.enabled as i32,
            p.preset as i32,
            p.latency_ms,
            p.upload_kbps,
            p.download_kbps,
            p.packet_loss_ratio,
        ],
    )
    .map_err(|e| DbError::query("save throttle profile", e))?;

    tx.commit()
        .map_err(|e| DbError::query("commit save throttle profile transaction", e))?;

    Ok(())
}

pub fn set_active_throttle_profile(
    conn: &Connection,
    workspace_id: &str,
    profile_id: Option<&str>,
) -> Result<(), DbError> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| DbError::query("begin set active throttle profile transaction", e))?;

    tx.execute(
        "UPDATE throttle_profiles SET enabled = 0 WHERE workspace_id = ?1",
        params![workspace_id],
    )
    .map_err(|e| DbError::query("deactivate throttle profiles", e))?;

    if let Some(profile_id) = profile_id {
        let updated = tx
            .execute(
                "UPDATE throttle_profiles SET enabled = 1 WHERE workspace_id = ?1 AND id = ?2",
                params![workspace_id, profile_id],
            )
            .map_err(|e| DbError::query("activate throttle profile", e))?;
        if updated == 0 {
            return Err(DbError::not_found("throttle profile", profile_id));
        }
    }

    tx.commit()
        .map_err(|e| DbError::query("commit set active throttle profile transaction", e))?;

    Ok(())
}

pub fn load_all_throttle_profiles(conn: &Connection) -> Result<Vec<ThrottleProfileRow>, DbError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, workspace_id, name, note, enabled, preset, latency_ms,
                    upload_kbps, download_kbps, packet_loss_ratio
             FROM throttle_profiles ORDER BY name",
        )
        .map_err(|e| DbError::query("prepare load throttle profiles", e))?;

    let rows: Result<Vec<ThrottleProfileRow>, DbError> = stmt
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
        .map_err(|e| DbError::query("query throttle profiles", e))?
        .map(|r| r.map_err(|e| DbError::query("decode throttle profile row", e)))
        .collect();

    Ok(rows?)
}

pub fn delete_throttle_profile(conn: &Connection, id: &str) -> Result<(), DbError> {
    conn.execute("DELETE FROM throttle_profiles WHERE id = ?1", params![id])
        .map_err(|e| DbError::query("delete throttle profile", e))?;
    Ok(())
}

pub struct ThrottleRuleRow {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub note: Option<String>,
    pub enabled: bool,
    pub priority: u32,
    pub profile_id: String,
    pub url_pattern: String,
    pub methods: String,
    pub stage: String,
}

pub fn save_throttle_rule(conn: &Connection, rule: &ThrottleRuleRow) -> Result<(), DbError> {
    conn.execute(
        "INSERT OR REPLACE INTO throttle_rules
            (id, workspace_id, name, note, enabled, priority, profile_id, url_pattern, methods, stage)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            rule.id,
            rule.workspace_id,
            rule.name,
            rule.note,
            rule.enabled as i32,
            rule.priority,
            rule.profile_id,
            rule.url_pattern,
            rule.methods,
            rule.stage,
        ],
    )
    .map_err(|e| DbError::query("save throttle rule", e))?;
    Ok(())
}

pub fn delete_throttle_rule(conn: &Connection, id: &str) -> Result<(), DbError> {
    conn.execute("DELETE FROM throttle_rules WHERE id = ?1", params![id])
        .map_err(|e| DbError::query("delete throttle rule", e))?;
    Ok(())
}

pub fn load_all_throttle_rules(conn: &Connection) -> Result<Vec<ThrottleRuleRow>, DbError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, workspace_id, name, note, enabled, priority, profile_id, url_pattern, methods, stage
             FROM throttle_rules ORDER BY priority DESC, name ASC",
        )
        .map_err(|e| DbError::query("prepare load throttle rules", e))?;

    let rows: Result<Vec<ThrottleRuleRow>, DbError> = stmt
        .query_map([], |row| {
            Ok(ThrottleRuleRow {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                name: row.get(2)?,
                note: row.get(3)?,
                enabled: row.get::<_, i32>(4)? != 0,
                priority: row.get::<_, i32>(5)? as u32,
                profile_id: row.get(6)?,
                url_pattern: row.get(7)?,
                methods: row.get(8)?,
                stage: row.get(9)?,
            })
        })
        .map_err(|e| DbError::query("query throttle rules", e))?
        .map(|r| r.map_err(|e| DbError::query("decode throttle rule row", e)))
        .collect();

    Ok(rows?)
}

pub struct ThrottleRunRow {
    pub id: String,
    pub session_id: String,
    pub workspace_id: String,
    pub profile_id: String,
    pub profile_name: String,
    pub rule_id: Option<String>,
    pub rule_name: Option<String>,
    pub stage: String,
    pub outcome: String,
    pub delay_ms: u64,
    pub latency_ms: u64,
    pub transfer_delay_ms: u64,
    pub body_bytes: usize,
    pub message: Option<String>,
    pub sequence: u32,
    pub created_at: String,
}

pub fn replace_throttle_runs_for_session(
    conn: &Connection,
    session_id: &str,
    runs: &[ThrottleRunRow],
) -> Result<(), DbError> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| DbError::query("begin replace throttle runs transaction", e))?;

    tx.execute(
        "DELETE FROM throttle_runs WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|e| DbError::query("delete throttle runs for session", e))?;

    for run in runs {
        tx.execute(
            "INSERT INTO throttle_runs
                (id, session_id, workspace_id, profile_id, profile_name, rule_id, rule_name,
                 stage, outcome, delay_ms, latency_ms, transfer_delay_ms, body_bytes, message,
                 sequence, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                run.id,
                run.session_id,
                run.workspace_id,
                run.profile_id,
                run.profile_name,
                run.rule_id,
                run.rule_name,
                run.stage,
                run.outcome,
                run.delay_ms as i64,
                run.latency_ms as i64,
                run.transfer_delay_ms as i64,
                run.body_bytes as i64,
                run.message,
                run.sequence as i64,
                run.created_at,
            ],
        )
        .map_err(|e| DbError::query("insert throttle run", e))?;
    }

    tx.commit()
        .map_err(|e| DbError::query("commit replace throttle runs transaction", e))?;
    Ok(())
}

pub fn load_throttle_runs_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<ThrottleRunRow>, DbError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, workspace_id, profile_id, profile_name, rule_id, rule_name,
                    stage, outcome, delay_ms, latency_ms, transfer_delay_ms, body_bytes, message,
                    sequence, created_at
             FROM throttle_runs WHERE session_id = ?1 ORDER BY sequence ASC, created_at ASC",
        )
        .map_err(|e| DbError::query("prepare load throttle runs", e))?;

    let rows: Result<Vec<ThrottleRunRow>, DbError> = stmt
        .query_map(params![session_id], |row| {
            Ok(ThrottleRunRow {
                id: row.get(0)?,
                session_id: row.get(1)?,
                workspace_id: row.get(2)?,
                profile_id: row.get(3)?,
                profile_name: row.get(4)?,
                rule_id: row.get(5)?,
                rule_name: row.get(6)?,
                stage: row.get(7)?,
                outcome: row.get(8)?,
                delay_ms: row.get::<_, i64>(9)? as u64,
                latency_ms: row.get::<_, i64>(10)? as u64,
                transfer_delay_ms: row.get::<_, i64>(11)? as u64,
                body_bytes: row.get::<_, i64>(12)? as usize,
                message: row.get(13)?,
                sequence: row.get::<_, i64>(14)? as u32,
                created_at: row.get(15)?,
            })
        })
        .map_err(|e| DbError::query("query throttle runs", e))?
        .map(|r| r.map_err(|e| DbError::query("decode throttle rule row", e)))
        .collect();

    Ok(rows?)
}

pub fn load_throttled_session_ids(
    conn: &Connection,
    workspace_id: &str,
) -> Result<Vec<String>, DbError> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT session_id FROM throttle_runs
             WHERE workspace_id = ?1
             ORDER BY created_at DESC",
        )
        .map_err(|e| DbError::query("prepare load throttled session ids", e))?;

    let rows: Result<Vec<String>, DbError> = stmt
        .query_map(params![workspace_id], |row| row.get::<_, String>(0))
        .map_err(|e| DbError::query("query throttled session ids", e))?
        .map(|r| r.map_err(|e| DbError::query("decode throttle rule row", e)))
        .collect();

    Ok(rows?)
}

// ---------------------------------------------------------------------------
// Breakpoint rules
// ---------------------------------------------------------------------------

pub struct BreakpointRuleRow {
    pub id: String,
    pub enabled: bool,
    pub url_pattern: String,
    pub methods: String, // JSON array
    pub stage: String,
    pub match_type: String,
}

/// Replace all breakpoint rules atomically.
pub fn replace_breakpoint_rules(
    conn: &Connection,
    rules: &[BreakpointRuleRow],
) -> Result<(), DbError> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| DbError::query("begin replace breakpoint rules transaction", e))?;

    tx.execute("DELETE FROM breakpoint_rules", [])
        .map_err(|e| DbError::query("clear breakpoint rules", e))?;

    for r in rules {
        tx.execute(
            "INSERT INTO breakpoint_rules (id, enabled, url_pattern, methods, stage, match_type)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                r.id,
                r.enabled as i32,
                r.url_pattern,
                r.methods,
                r.stage,
                r.match_type
            ],
        )
        .map_err(|e| DbError::query("insert breakpoint rule", e))?;
    }

    tx.commit()
        .map_err(|e| DbError::query("commit replace breakpoint rules transaction", e))?;

    Ok(())
}

pub fn load_breakpoint_rules(conn: &Connection) -> Result<Vec<BreakpointRuleRow>, DbError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, enabled, url_pattern, methods, stage, match_type FROM breakpoint_rules",
        )
        .map_err(|e| DbError::query("prepare load breakpoint rules", e))?;

    let rows: Result<Vec<BreakpointRuleRow>, DbError> = stmt
        .query_map([], |row| {
            Ok(BreakpointRuleRow {
                id: row.get(0)?,
                enabled: row.get::<_, i32>(1)? != 0,
                url_pattern: row.get(2)?,
                methods: row.get(3)?,
                stage: row.get(4)?,
                match_type: row.get(5)?,
            })
        })
        .map_err(|e| DbError::query("query breakpoint rules", e))?
        .map(|r| r.map_err(|e| DbError::query("decode breakpoint rule row", e)))
        .collect();

    Ok(rows?)
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

pub fn save_dns_mapping(conn: &Connection, r: &DnsMappingRow) -> Result<(), DbError> {
    conn.execute(
        "INSERT OR REPLACE INTO dns_mappings
            (id, workspace_id, name, note, enabled, priority, host_pattern, target_ip)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            r.id,
            r.workspace_id,
            r.name,
            r.note,
            r.enabled as i32,
            r.priority,
            r.host_pattern,
            r.target_ip,
        ],
    )
    .map_err(|e| DbError::query("save dns mapping", e))?;
    Ok(())
}

pub fn load_all_dns_mappings(conn: &Connection) -> Result<Vec<DnsMappingRow>, DbError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, workspace_id, name, note, enabled, priority, host_pattern, target_ip
             FROM dns_mappings ORDER BY priority DESC, name",
        )
        .map_err(|e| DbError::query("prepare load dns mappings", e))?;

    let rows: Result<Vec<DnsMappingRow>, DbError> = stmt
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
        .map_err(|e| DbError::query("query dns mappings", e))?
        .map(|r| r.map_err(|e| DbError::query("decode dns rule row", e)))
        .collect();

    Ok(rows?)
}

pub fn delete_dns_mapping(conn: &Connection, id: &str) -> Result<(), DbError> {
    conn.execute("DELETE FROM dns_mappings WHERE id=?1", params![id])
        .map_err(|e| DbError::query("delete dns mapping", e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Script rules
// ---------------------------------------------------------------------------

pub struct ScriptRuleRow {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub note: Option<String>,
    pub enabled: bool,
    pub priority: u32,
    pub match_methods: String,
    pub match_stage: String,
    pub match_url_pattern: String,
    pub match_type: String,
    pub language: String,
    pub source_type: String,
    pub source_code: String,
    pub source_path: Option<String>,
    pub entrypoints: String,
    pub compiled_code: String,
    pub source_map: Option<String>,
    pub updated_at: String,
}

pub struct ScriptRunRow {
    pub id: String,
    pub session_id: String,
    pub rule_id: String,
    pub workspace_id: String,
    pub stage: String,
    pub outcome: String,
    pub duration_ms: u128,
    pub created_at: String,
}

pub struct ScriptRunEntryRow {
    pub id: String,
    pub run_id: String,
    pub kind: String,
    pub level: Option<String>,
    pub key: Option<String>,
    pub message: Option<String>,
    pub payload_json: Option<String>,
    pub seq: u32,
}

pub struct RewriteRunRow {
    pub id: String,
    pub session_id: String,
    pub rule_id: String,
    pub rule_name: String,
    pub workspace_id: String,
    pub rewrite_type: String,
    pub stage: String,
    pub outcome: String,
    pub duration_ms: u128,
    pub created_at: String,
}

pub struct RewriteRunEntryRow {
    pub id: String,
    pub run_id: String,
    pub kind: String,
    pub key: Option<String>,
    pub before_value: Option<String>,
    pub after_value: Option<String>,
    pub message: Option<String>,
    pub seq: u32,
}

pub fn save_script_rule(conn: &Connection, row: &ScriptRuleRow) -> Result<(), DbError> {
    conn.execute(
        "INSERT OR REPLACE INTO script_rules
            (id, workspace_id, name, note, enabled, priority, match_methods, match_stage,
             match_url_pattern, match_type, language, source_type, source_code, source_path, entrypoints,
             compiled_code, source_map, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
        params![
            row.id,
            row.workspace_id,
            row.name,
            row.note,
            row.enabled as i32,
            row.priority,
            row.match_methods,
            row.match_stage,
            row.match_url_pattern,
            row.match_type,
            row.language,
            row.source_type,
            row.source_code,
            row.source_path,
            row.entrypoints,
            row.compiled_code,
            row.source_map,
            row.updated_at,
        ],
    )
    .map_err(|e| DbError::query("save script rule", e))?;
    Ok(())
}

pub fn load_all_script_rules(conn: &Connection) -> Result<Vec<ScriptRuleRow>, DbError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, workspace_id, name, note, enabled, priority, match_methods, match_stage,
                    match_url_pattern, match_type, language, source_type, source_code, source_path, entrypoints,
                    compiled_code, source_map, updated_at
             FROM script_rules ORDER BY priority DESC, updated_at DESC",
        )
        .map_err(|e| DbError::query("prepare load script rules", e))?;

    let rows: Result<Vec<ScriptRuleRow>, DbError> = stmt
        .query_map([], |row| {
            Ok(ScriptRuleRow {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                name: row.get(2)?,
                note: row.get(3)?,
                enabled: row.get::<_, i32>(4)? != 0,
                priority: row.get::<_, i32>(5)? as u32,
                match_methods: row.get(6)?,
                match_stage: row.get(7)?,
                match_url_pattern: row.get(8)?,
                match_type: row.get(9)?,
                language: row.get(10)?,
                source_type: row.get(11)?,
                source_code: row.get(12)?,
                source_path: row.get(13)?,
                entrypoints: row.get(14)?,
                compiled_code: row.get(15)?,
                source_map: row.get(16)?,
                updated_at: row.get(17)?,
            })
        })
        .map_err(|e| DbError::query("query script rules", e))?
        .map(|row| row.map_err(|e| DbError::query("decode script rule row", e)))
        .collect();

    Ok(rows?)
}

pub fn delete_script_rule(conn: &Connection, id: &str) -> Result<(), DbError> {
    conn.execute("DELETE FROM script_rules WHERE id=?1", params![id])
        .map_err(|e| DbError::query("delete script rule", e))?;
    Ok(())
}

pub fn replace_script_runs_for_session(
    conn: &Connection,
    session_id: &str,
    runs: &[ScriptRunRow],
    entries: &[ScriptRunEntryRow],
) -> Result<(), DbError> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| DbError::query("begin replace script runs transaction", e))?;

    tx.execute(
        "DELETE FROM script_run_entries WHERE run_id IN (SELECT id FROM script_runs WHERE session_id = ?1)",
        params![session_id],
    )
    .map_err(|e| DbError::query("delete script run entries for session", e))?;

    tx.execute(
        "DELETE FROM script_runs WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|e| DbError::query("delete script runs for session", e))?;

    for run in runs {
        tx.execute(
            "INSERT INTO script_runs
                (id, session_id, rule_id, workspace_id, stage, outcome, duration_ms, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                run.id,
                run.session_id,
                run.rule_id,
                run.workspace_id,
                run.stage,
                run.outcome,
                run.duration_ms as i64,
                run.created_at,
            ],
        )
        .map_err(|e| DbError::query("insert script run", e))?;
    }

    for entry in entries {
        tx.execute(
            "INSERT INTO script_run_entries
                (id, run_id, kind, level, key, message, payload_json, seq)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                entry.id,
                entry.run_id,
                entry.kind,
                entry.level,
                entry.key,
                entry.message,
                entry.payload_json,
                entry.seq,
            ],
        )
        .map_err(|e| DbError::query("insert script run entry", e))?;
    }

    tx.commit()
        .map_err(|e| DbError::query("commit replace script runs transaction", e))?;

    Ok(())
}

pub fn load_script_runs_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<ScriptRunRow>, DbError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, rule_id, workspace_id, stage, outcome, duration_ms, created_at
             FROM script_runs WHERE session_id = ?1 ORDER BY created_at ASC, id ASC",
        )
        .map_err(|e| DbError::query("prepare load script runs", e))?;

    let rows: Result<Vec<ScriptRunRow>, DbError> = stmt
        .query_map(params![session_id], |row| {
            Ok(ScriptRunRow {
                id: row.get(0)?,
                session_id: row.get(1)?,
                rule_id: row.get(2)?,
                workspace_id: row.get(3)?,
                stage: row.get(4)?,
                outcome: row.get(5)?,
                duration_ms: row.get::<_, i64>(6)? as u128,
                created_at: row.get(7)?,
            })
        })
        .map_err(|e| DbError::query("query script runs", e))?
        .map(|row| row.map_err(|e| DbError::query("decode rule run row", e)))
        .collect();

    Ok(rows?)
}

pub fn load_script_run_entries(
    conn: &Connection,
    run_ids: &[String],
) -> Result<Vec<ScriptRunEntryRow>, DbError> {
    if run_ids.is_empty() {
        return Ok(Vec::new());
    }

    let placeholders: Vec<String> = run_ids
        .iter()
        .enumerate()
        .map(|(index, _)| format!("?{}", index + 1))
        .collect();
    let sql = format!(
        "SELECT id, run_id, kind, level, key, message, payload_json, seq
         FROM script_run_entries
         WHERE run_id IN ({})
         ORDER BY seq ASC, id ASC",
        placeholders.join(",")
    );
    let params: Vec<&dyn rusqlite::types::ToSql> = run_ids
        .iter()
        .map(|id| id as &dyn rusqlite::types::ToSql)
        .collect();

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| DbError::query("prepare load script run entries", e))?;

    let rows: Result<Vec<ScriptRunEntryRow>, DbError> = stmt
        .query_map(params.as_slice(), |row| {
            Ok(ScriptRunEntryRow {
                id: row.get(0)?,
                run_id: row.get(1)?,
                kind: row.get(2)?,
                level: row.get(3)?,
                key: row.get(4)?,
                message: row.get(5)?,
                payload_json: row.get(6)?,
                seq: row.get::<_, i32>(7)? as u32,
            })
        })
        .map_err(|e| DbError::query("query script run entries", e))?
        .map(|row| row.map_err(|e| DbError::query("decode rule run entry row", e)))
        .collect();

    Ok(rows?)
}

pub fn clear_script_runs(conn: &Connection) -> Result<(), DbError> {
    conn.execute("DELETE FROM script_run_entries", [])
        .map_err(|e| DbError::query("clear script run entries", e))?;
    conn.execute("DELETE FROM script_runs", [])
        .map_err(|e| DbError::query("clear script runs", e))?;
    Ok(())
}

pub fn replace_rewrite_runs_for_session(
    conn: &Connection,
    session_id: &str,
    runs: &[RewriteRunRow],
    entries: &[RewriteRunEntryRow],
) -> Result<(), DbError> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| DbError::query("begin replace rewrite runs transaction", e))?;

    tx.execute(
        "DELETE FROM rewrite_run_entries WHERE run_id IN (SELECT id FROM rewrite_runs WHERE session_id = ?1)",
        params![session_id],
    )
    .map_err(|e| DbError::query("delete rewrite run entries for session", e))?;

    tx.execute(
        "DELETE FROM rewrite_runs WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|e| DbError::query("delete rewrite runs for session", e))?;

    for run in runs {
        tx.execute(
            "INSERT INTO rewrite_runs
                (id, session_id, rule_id, rule_name, workspace_id, rewrite_type, stage, outcome, duration_ms, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                run.id,
                run.session_id,
                run.rule_id,
                run.rule_name,
                run.workspace_id,
                run.rewrite_type,
                run.stage,
                run.outcome,
                run.duration_ms as i64,
                run.created_at,
            ],
        )
        .map_err(|e| DbError::query("insert rewrite run", e))?;
    }

    for entry in entries {
        tx.execute(
            "INSERT INTO rewrite_run_entries
                (id, run_id, kind, key, before_value, after_value, message, seq)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                entry.id,
                entry.run_id,
                entry.kind,
                entry.key,
                entry.before_value,
                entry.after_value,
                entry.message,
                entry.seq,
            ],
        )
        .map_err(|e| DbError::query("insert rewrite run entry", e))?;
    }

    tx.commit()
        .map_err(|e| DbError::query("commit replace rewrite runs transaction", e))?;

    Ok(())
}

pub fn load_rewrite_runs_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<RewriteRunRow>, DbError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, rule_id, rule_name, workspace_id, rewrite_type, stage, outcome, duration_ms, created_at
             FROM rewrite_runs WHERE session_id = ?1 ORDER BY created_at ASC, id ASC",
        )
        .map_err(|e| DbError::query("prepare load rewrite runs", e))?;

    let rows: Result<Vec<RewriteRunRow>, DbError> = stmt
        .query_map(params![session_id], |row| {
            Ok(RewriteRunRow {
                id: row.get(0)?,
                session_id: row.get(1)?,
                rule_id: row.get(2)?,
                rule_name: row.get(3)?,
                workspace_id: row.get(4)?,
                rewrite_type: row.get(5)?,
                stage: row.get(6)?,
                outcome: row.get(7)?,
                duration_ms: row.get::<_, i64>(8)? as u128,
                created_at: row.get(9)?,
            })
        })
        .map_err(|e| DbError::query("query rewrite runs", e))?
        .map(|row| row.map_err(|e| DbError::query("decode rewrite rule row", e)))
        .collect();

    Ok(rows?)
}

pub fn load_rewrite_run_entries(
    conn: &Connection,
    run_ids: &[String],
) -> Result<Vec<RewriteRunEntryRow>, DbError> {
    if run_ids.is_empty() {
        return Ok(Vec::new());
    }

    let placeholders: Vec<String> = run_ids
        .iter()
        .enumerate()
        .map(|(index, _)| format!("?{}", index + 1))
        .collect();
    let sql = format!(
        "SELECT id, run_id, kind, key, before_value, after_value, message, seq
         FROM rewrite_run_entries
         WHERE run_id IN ({})
         ORDER BY seq ASC, id ASC",
        placeholders.join(",")
    );
    let params: Vec<&dyn rusqlite::types::ToSql> = run_ids
        .iter()
        .map(|id| id as &dyn rusqlite::types::ToSql)
        .collect();

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| DbError::query("prepare load rewrite run entries", e))?;

    let rows: Result<Vec<RewriteRunEntryRow>, DbError> = stmt
        .query_map(params.as_slice(), |row| {
            Ok(RewriteRunEntryRow {
                id: row.get(0)?,
                run_id: row.get(1)?,
                kind: row.get(2)?,
                key: row.get(3)?,
                before_value: row.get(4)?,
                after_value: row.get(5)?,
                message: row.get(6)?,
                seq: row.get::<_, i32>(7)? as u32,
            })
        })
        .map_err(|e| DbError::query("query rewrite run entries", e))?
        .map(|row| row.map_err(|e| DbError::query("decode rewrite rule row", e)))
        .collect();

    Ok(rows?)
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
            http2_enabled: true,
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
            match_type: "contains".into(),
            rewrite_type: "header".into(),
            payload: r#"{"headerName":"X-Test","operation":"set","target":"request","value":"1"}"#
                .into(),
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
    fn active_throttle_profile_is_unique_per_workspace() {
        let conn = test_conn();
        let mut first = ThrottleProfileRow {
            id: "t1".into(),
            workspace_id: "default".into(),
            name: "Slow".into(),
            note: None,
            enabled: true,
            preset: false,
            latency_ms: 100,
            upload_kbps: 300,
            download_kbps: 500,
            packet_loss_ratio: 0.0,
        };
        let second = ThrottleProfileRow {
            id: "t2".into(),
            workspace_id: "default".into(),
            name: "Fast".into(),
            note: None,
            enabled: true,
            preset: false,
            latency_ms: 10,
            upload_kbps: 3000,
            download_kbps: 5000,
            packet_loss_ratio: 0.0,
        };

        save_throttle_profile(&conn, &first).unwrap();
        save_throttle_profile(&conn, &second).unwrap();

        let loaded = load_all_throttle_profiles(&conn).unwrap();
        assert!(!loaded.iter().find(|p| p.id == "t1").unwrap().enabled);
        assert!(loaded.iter().find(|p| p.id == "t2").unwrap().enabled);

        set_active_throttle_profile(&conn, "default", Some("t1")).unwrap();
        let loaded = load_all_throttle_profiles(&conn).unwrap();
        assert!(loaded.iter().find(|p| p.id == "t1").unwrap().enabled);
        assert!(!loaded.iter().find(|p| p.id == "t2").unwrap().enabled);

        first.enabled = false;
        save_throttle_profile(&conn, &first).unwrap();
        assert!(
            !load_all_throttle_profiles(&conn)
                .unwrap()
                .iter()
                .find(|p| p.id == "t1")
                .unwrap()
                .enabled
        );
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
                match_type: "contains".into(),
            },
            BreakpointRuleRow {
                id: "b2".into(),
                enabled: false,
                url_pattern: "*".into(),
                methods: "[]".into(),
                stage: "Response".into(),
                match_type: "contains".into(),
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

    #[test]
    fn script_rule_round_trip() {
        let conn = test_conn();
        let rule = ScriptRuleRow {
            id: "s1".into(),
            workspace_id: "default".into(),
            name: "Header Script".into(),
            note: Some("script note".into()),
            enabled: true,
            priority: 90,
            match_methods: "[\"GET\"]".into(),
            match_stage: "either".into(),
            match_url_pattern: "example.com".into(),
            match_type: "contains".into(),
            language: "typescript".into(),
            source_type: "inline".into(),
            source_code: "export function onRequest(ctx) {}".into(),
            source_path: None,
            entrypoints: r#"{"onRequest":true,"onResponse":false}"#.into(),
            compiled_code:
                "globalThis.__aiproxyScriptExports.onRequest = function onRequest(ctx) {}".into(),
            source_map: Some("{}".into()),
            updated_at: "2026-04-20T00:00:00Z".into(),
        };

        save_script_rule(&conn, &rule).unwrap();
        let loaded = load_all_script_rules(&conn).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].language, "typescript");
        assert_eq!(loaded[0].match_url_pattern, "example.com");

        delete_script_rule(&conn, "s1").unwrap();
        assert!(load_all_script_rules(&conn).unwrap().is_empty());
    }

    #[test]
    fn script_runs_round_trip() {
        let conn = test_conn();
        conn.execute(
            "INSERT INTO session_summaries
                (id, method, host, path, protocol, started_at, finished_at,
                 duration_ms, size_bytes, status_code, url, response_mime_type)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                "session-1",
                "GET",
                "example.com",
                "/api",
                "https",
                "2026-04-20T00:00:00Z",
                "2026-04-20T00:00:01Z",
                1,
                0,
                200,
                "https://example.com/api",
                "application/json",
            ],
        )
        .unwrap();

        save_script_rule(
            &conn,
            &ScriptRuleRow {
                id: "rule-1".into(),
                workspace_id: "default".into(),
                name: "Trace Rule".into(),
                note: None,
                enabled: true,
                priority: 10,
                match_methods: "[]".into(),
                match_stage: "either".into(),
                match_url_pattern: "*".into(),
                match_type: "contains".into(),
                language: "javascript".into(),
                source_type: "inline".into(),
                source_code: "export function onRequest(ctx) {}".into(),
                source_path: None,
                entrypoints: r#"{"onRequest":true,"onResponse":false}"#.into(),
                compiled_code:
                    "globalThis.__aiproxyScriptExports.onRequest = function onRequest(ctx) {}"
                        .into(),
                source_map: None,
                updated_at: "2026-04-20T00:00:00Z".into(),
            },
        )
        .unwrap();

        let runs = vec![ScriptRunRow {
            id: "run-1".into(),
            session_id: "session-1".into(),
            rule_id: "rule-1".into(),
            workspace_id: "default".into(),
            stage: "request".into(),
            outcome: "success".into(),
            duration_ms: 12,
            created_at: "2026-04-20T00:00:01Z".into(),
        }];
        let entries = vec![ScriptRunEntryRow {
            id: "entry-1".into(),
            run_id: "run-1".into(),
            kind: "log".into(),
            level: Some("info".into()),
            key: None,
            message: Some("hello".into()),
            payload_json: Some(r#"{"ok":true}"#.into()),
            seq: 0,
        }];

        replace_script_runs_for_session(&conn, "session-1", &runs, &entries).unwrap();

        let loaded_runs = load_script_runs_for_session(&conn, "session-1").unwrap();
        let loaded_entries = load_script_run_entries(&conn, &["run-1".into()]).unwrap();

        assert_eq!(loaded_runs.len(), 1);
        assert_eq!(loaded_runs[0].outcome, "success");
        assert_eq!(loaded_entries.len(), 1);
        assert_eq!(loaded_entries[0].message.as_deref(), Some("hello"));
    }
}

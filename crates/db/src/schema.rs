use rusqlite::Connection;

const CREATE_TABLES: &str = "
CREATE TABLE IF NOT EXISTS workspaces (
    id                   TEXT NOT NULL PRIMARY KEY,
    name                 TEXT NOT NULL,
    proxy_port           INTEGER NOT NULL DEFAULT 8888,
    ssl_enabled          INTEGER NOT NULL DEFAULT 0,
    system_proxy_enabled INTEGER NOT NULL DEFAULT 0,
    storage_path         TEXT NOT NULL DEFAULT '',
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rewrite_rules (
    id                TEXT NOT NULL PRIMARY KEY,
    workspace_id      TEXT NOT NULL,
    name              TEXT NOT NULL,
    note              TEXT,
    enabled           INTEGER NOT NULL DEFAULT 1,
    priority          INTEGER NOT NULL DEFAULT 0,
    match_methods     TEXT NOT NULL DEFAULT '[]',
    match_stage       TEXT NOT NULL DEFAULT '',
    match_url_pattern TEXT NOT NULL DEFAULT '',
    rewrite_type      TEXT NOT NULL,
    payload           TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);
CREATE INDEX IF NOT EXISTS idx_rewrite_rules_workspace ON rewrite_rules(workspace_id);

CREATE TABLE IF NOT EXISTS map_rules (
    id              TEXT NOT NULL PRIMARY KEY,
    workspace_id    TEXT NOT NULL,
    mode            TEXT NOT NULL,
    name            TEXT NOT NULL,
    note            TEXT,
    enabled         INTEGER NOT NULL DEFAULT 1,
    preserve_path   INTEGER NOT NULL DEFAULT 0,
    preserve_query  INTEGER NOT NULL DEFAULT 0,
    priority        INTEGER NOT NULL DEFAULT 0,
    source_pattern  TEXT NOT NULL,
    target_value    TEXT NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);
CREATE INDEX IF NOT EXISTS idx_map_rules_workspace ON map_rules(workspace_id);

CREATE TABLE IF NOT EXISTS throttle_profiles (
    id                TEXT NOT NULL PRIMARY KEY,
    workspace_id      TEXT NOT NULL,
    name              TEXT NOT NULL,
    note              TEXT,
    enabled           INTEGER NOT NULL DEFAULT 0,
    preset            INTEGER NOT NULL DEFAULT 0,
    latency_ms        INTEGER NOT NULL DEFAULT 0,
    upload_kbps       INTEGER NOT NULL DEFAULT 0,
    download_kbps     INTEGER NOT NULL DEFAULT 0,
    packet_loss_ratio REAL NOT NULL DEFAULT 0.0,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);
CREATE INDEX IF NOT EXISTS idx_throttle_profiles_workspace ON throttle_profiles(workspace_id);

CREATE TABLE IF NOT EXISTS breakpoint_rules (
    id          TEXT NOT NULL PRIMARY KEY,
    enabled     INTEGER NOT NULL DEFAULT 1,
    url_pattern TEXT NOT NULL DEFAULT '',
    methods     TEXT NOT NULL DEFAULT '[]',
    stage       TEXT NOT NULL DEFAULT 'Request'
);

CREATE TABLE IF NOT EXISTS session_summaries (
    id                TEXT NOT NULL PRIMARY KEY,
    method            TEXT NOT NULL,
    host              TEXT NOT NULL,
    path              TEXT NOT NULL,
    protocol          TEXT NOT NULL,
    started_at        TEXT NOT NULL,
    finished_at       TEXT NOT NULL,
    duration_ms       INTEGER NOT NULL DEFAULT 0,
    size_bytes        INTEGER NOT NULL DEFAULT 0,
    status_code       INTEGER NOT NULL DEFAULT 0,
    url               TEXT NOT NULL,
    response_mime_type TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_summaries_started_at ON session_summaries(started_at);
CREATE INDEX IF NOT EXISTS idx_session_summaries_host ON session_summaries(host);

CREATE TABLE IF NOT EXISTS session_details (
    id                 TEXT NOT NULL PRIMARY KEY,
    session_summary_id TEXT NOT NULL,
    query_params       TEXT NOT NULL DEFAULT '[]',
    cookies            TEXT NOT NULL DEFAULT '[]',
    request_headers    TEXT NOT NULL DEFAULT '[]',
    response_headers   TEXT NOT NULL DEFAULT '[]',
    raw_request        TEXT,
    raw_response       TEXT,
    server_ip          TEXT,
    request_body_ref   TEXT,
    response_body_ref  TEXT,
    timing             TEXT,
    FOREIGN KEY (session_summary_id) REFERENCES session_summaries(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ws_messages (
    id              TEXT NOT NULL PRIMARY KEY,
    session_id      TEXT NOT NULL,
    direction       TEXT NOT NULL,
    timestamp       TEXT NOT NULL,
    opcode          TEXT NOT NULL,
    payload_text    TEXT,
    payload_size    INTEGER NOT NULL DEFAULT 0,
    fin             INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (session_id) REFERENCES session_summaries(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ws_messages_session ON ws_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_ws_messages_timestamp ON ws_messages(timestamp);

CREATE TABLE IF NOT EXISTS dns_mappings (
    id              TEXT NOT NULL PRIMARY KEY,
    workspace_id    TEXT NOT NULL,
    name            TEXT NOT NULL,
    note            TEXT,
    enabled         INTEGER NOT NULL DEFAULT 1,
    priority        INTEGER NOT NULL DEFAULT 0,
    host_pattern    TEXT NOT NULL,
    target_ip       TEXT NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);
CREATE INDEX IF NOT EXISTS idx_dns_mappings_workspace ON dns_mappings(workspace_id);
";

pub fn run_migrations(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(CREATE_TABLES)
        .map_err(|e| format!("create tables: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_tables_exist_after_init() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();

        let tables: Vec<String> = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        let expected = [
            "breakpoint_rules",
            "dns_mappings",
            "map_rules",
            "rewrite_rules",
            "session_details",
            "session_summaries",
            "throttle_profiles",
            "ws_messages",
            "workspaces",
        ];
        for table in &expected {
            assert!(tables.iter().any(|t| t == *table), "missing table: {table}");
        }
    }
}

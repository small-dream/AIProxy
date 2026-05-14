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

CREATE TABLE IF NOT EXISTS throttle_rules (
    id                TEXT NOT NULL PRIMARY KEY,
    workspace_id      TEXT NOT NULL,
    name              TEXT NOT NULL,
    note              TEXT,
    enabled           INTEGER NOT NULL DEFAULT 1,
    priority          INTEGER NOT NULL DEFAULT 0,
    profile_id        TEXT NOT NULL,
    url_pattern       TEXT NOT NULL DEFAULT '*',
    methods           TEXT NOT NULL DEFAULT '[]',
    stage             TEXT NOT NULL DEFAULT 'both',
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
    FOREIGN KEY (profile_id) REFERENCES throttle_profiles(id)
);
CREATE INDEX IF NOT EXISTS idx_throttle_rules_workspace ON throttle_rules(workspace_id);
CREATE INDEX IF NOT EXISTS idx_throttle_rules_profile ON throttle_rules(profile_id);

CREATE TABLE IF NOT EXISTS throttle_runs (
    id                TEXT NOT NULL PRIMARY KEY,
    session_id        TEXT NOT NULL,
    workspace_id      TEXT NOT NULL,
    profile_id        TEXT NOT NULL,
    profile_name      TEXT NOT NULL,
    rule_id           TEXT,
    rule_name         TEXT,
    stage             TEXT NOT NULL,
    outcome           TEXT NOT NULL,
    delay_ms          INTEGER NOT NULL DEFAULT 0,
    latency_ms        INTEGER NOT NULL DEFAULT 0,
    transfer_delay_ms INTEGER NOT NULL DEFAULT 0,
    body_bytes        INTEGER NOT NULL DEFAULT 0,
    message           TEXT,
    sequence          INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES session_summaries(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_throttle_runs_session ON throttle_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_throttle_runs_workspace ON throttle_runs(workspace_id);

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
    scheme            TEXT NOT NULL DEFAULT 'http',
    http_version      TEXT NOT NULL DEFAULT '1.1',
    transport_protocol TEXT NOT NULL DEFAULT 'tcp',
    application_protocol TEXT NOT NULL DEFAULT 'http',
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
    client_address     TEXT,
    server_ip          TEXT,
    tls_cipher_suite   TEXT,
    tls_protocol       TEXT,
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

CREATE TABLE IF NOT EXISTS script_rules (
    id              TEXT NOT NULL PRIMARY KEY,
    workspace_id    TEXT NOT NULL,
    name            TEXT NOT NULL,
    note            TEXT,
    enabled         INTEGER NOT NULL DEFAULT 1,
    priority        INTEGER NOT NULL DEFAULT 0,
    match_methods   TEXT NOT NULL DEFAULT '[]',
    match_stage     TEXT NOT NULL DEFAULT '',
    match_url_pattern TEXT NOT NULL DEFAULT '',
    language        TEXT NOT NULL,
    source_type     TEXT NOT NULL,
    source_code     TEXT NOT NULL,
    source_path     TEXT,
    entrypoints     TEXT NOT NULL DEFAULT '{}',
    compiled_code   TEXT NOT NULL,
    source_map      TEXT,
    updated_at      TEXT NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);
CREATE INDEX IF NOT EXISTS idx_script_rules_workspace ON script_rules(workspace_id);

CREATE TABLE IF NOT EXISTS script_runs (
    id              TEXT NOT NULL PRIMARY KEY,
    session_id      TEXT NOT NULL,
    rule_id         TEXT NOT NULL,
    workspace_id    TEXT NOT NULL,
    stage           TEXT NOT NULL,
    outcome         TEXT NOT NULL,
    duration_ms     INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES session_summaries(id) ON DELETE CASCADE,
    FOREIGN KEY (rule_id) REFERENCES script_rules(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_script_runs_session ON script_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_script_runs_rule ON script_runs(rule_id);

CREATE TABLE IF NOT EXISTS script_run_entries (
    id              TEXT NOT NULL PRIMARY KEY,
    run_id          TEXT NOT NULL,
    kind            TEXT NOT NULL,
    level           TEXT,
    key             TEXT,
    message         TEXT,
    payload_json    TEXT,
    seq             INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (run_id) REFERENCES script_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_script_run_entries_run ON script_run_entries(run_id);

CREATE TABLE IF NOT EXISTS rewrite_runs (
    id              TEXT NOT NULL PRIMARY KEY,
    session_id      TEXT NOT NULL,
    rule_id         TEXT NOT NULL,
    rule_name       TEXT NOT NULL DEFAULT '',
    workspace_id    TEXT NOT NULL,
    rewrite_type    TEXT NOT NULL,
    stage           TEXT NOT NULL,
    outcome         TEXT NOT NULL,
    duration_ms     INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES session_summaries(id) ON DELETE CASCADE,
    FOREIGN KEY (rule_id) REFERENCES rewrite_rules(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_rewrite_runs_session ON rewrite_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_rewrite_runs_rule ON rewrite_runs(rule_id);

CREATE TABLE IF NOT EXISTS rewrite_run_entries (
    id              TEXT NOT NULL PRIMARY KEY,
    run_id          TEXT NOT NULL,
    kind            TEXT NOT NULL,
    key             TEXT,
    before_value    TEXT,
    after_value     TEXT,
    message         TEXT,
    seq             INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (run_id) REFERENCES rewrite_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_rewrite_run_entries_run ON rewrite_run_entries(run_id);

CREATE TABLE IF NOT EXISTS map_runs (
    id              TEXT NOT NULL PRIMARY KEY,
    session_id      TEXT NOT NULL,
    workspace_id    TEXT NOT NULL,
    rule_id         TEXT NOT NULL,
    rule_name       TEXT NOT NULL DEFAULT '',
    mode            TEXT NOT NULL,
    outcome         TEXT NOT NULL,
    source_pattern  TEXT NOT NULL,
    target_value    TEXT NOT NULL,
    original_url    TEXT NOT NULL,
    mapped_url      TEXT,
    local_path      TEXT,
    duration_ms     INTEGER NOT NULL DEFAULT 0,
    sequence        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES session_summaries(id) ON DELETE CASCADE,
    FOREIGN KEY (rule_id) REFERENCES map_rules(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_map_runs_session ON map_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_map_runs_rule ON map_runs(rule_id);

CREATE TABLE IF NOT EXISTS api_collections (
    id          TEXT NOT NULL PRIMARY KEY,
    parent_id   TEXT,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_collections_parent ON api_collections(parent_id);

CREATE TABLE IF NOT EXISTS api_collection_items (
    id            TEXT NOT NULL PRIMARY KEY,
    collection_id TEXT NOT NULL,
    name          TEXT NOT NULL DEFAULT '',
    description   TEXT NOT NULL DEFAULT '',
    sort_order    INTEGER NOT NULL DEFAULT 0,
    method        TEXT NOT NULL DEFAULT 'GET',
    url           TEXT NOT NULL DEFAULT '',
    headers       TEXT NOT NULL DEFAULT '[]',
    body          TEXT NOT NULL DEFAULT '',
    body_type     TEXT NOT NULL DEFAULT 'none',
    raw_language  TEXT NOT NULL DEFAULT 'json',
    form_data     TEXT NOT NULL DEFAULT '[]',
    url_encoded   TEXT NOT NULL DEFAULT '[]',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    FOREIGN KEY (collection_id) REFERENCES api_collections(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_api_collection_items_coll ON api_collection_items(collection_id);

CREATE TABLE IF NOT EXISTS api_environments (
    id          TEXT NOT NULL PRIMARY KEY,
    name        TEXT NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_environment_variables (
    id             TEXT NOT NULL PRIMARY KEY,
    environment_id TEXT NOT NULL,
    key            TEXT NOT NULL,
    value          TEXT NOT NULL DEFAULT '',
    enabled        INTEGER NOT NULL DEFAULT 1,
    sort_order     INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (environment_id) REFERENCES api_environments(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_api_env_vars_env ON api_environment_variables(environment_id);

CREATE TABLE IF NOT EXISTS api_global_variables (
    id          TEXT NOT NULL PRIMARY KEY,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL DEFAULT '',
    enabled     INTEGER NOT NULL DEFAULT 1,
    sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_api_global_vars_key ON api_global_variables(key);

CREATE TABLE IF NOT EXISTS ai_settings (
    id          TEXT NOT NULL PRIMARY KEY,
    provider    TEXT NOT NULL DEFAULT 'openai-compatible',
    base_url    TEXT NOT NULL,
    model       TEXT NOT NULL,
    api_key     TEXT NOT NULL DEFAULT '',
    temperature REAL NOT NULL DEFAULT 0.2,
    timeout_ms  INTEGER NOT NULL DEFAULT 30000,
    updated_at  TEXT NOT NULL
);
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
            "api_collection_items",
            "api_collections",
            "api_environment_variables",
            "api_environments",
            "api_global_variables",
            "ai_settings",
            "breakpoint_rules",
            "dns_mappings",
            "map_rules",
            "map_runs",
            "script_run_entries",
            "script_runs",
            "script_rules",
            "rewrite_rules",
            "rewrite_run_entries",
            "rewrite_runs",
            "session_details",
            "session_summaries",
            "throttle_profiles",
            "throttle_rules",
            "throttle_runs",
            "ws_messages",
            "workspaces",
        ];
        for table in &expected {
            assert!(tables.iter().any(|t| t == *table), "missing table: {table}");
        }
    }
}

use rusqlite::Connection;

use crate::DbError;

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
-- M11: composite (host, duration_ms) index backs the host-scoped percentile
-- scan and the per-host slow-request ranking in `compute_insights`. Both paths
-- filter by host then order by duration_ms; without this index SQLite full-
-- scans and in-memory-sorts every host's rows on each insights refresh.
CREATE INDEX IF NOT EXISTS idx_session_summaries_host_duration ON session_summaries(host, duration_ms);

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
    trailers           TEXT DEFAULT NULL,
    h2_stream_id       INTEGER DEFAULT NULL,
    via_upstream_proxy INTEGER DEFAULT NULL,
    FOREIGN KEY (session_summary_id) REFERENCES session_summaries(id) ON DELETE CASCADE
);
-- M7: every sibling child table of session_summaries has an index on its FK
-- (idx_ws_messages_session, idx_script_runs_session, ...). session_details was
-- the lone omission, so the hot detail-lookup (load_session_detail) and the
-- cascade-delete path (DELETE ... WHERE session_summary_id IN (...)) both
-- full-scanned it on large DBs.
CREATE INDEX IF NOT EXISTS idx_session_details_session ON session_details(session_summary_id);

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
    match_type      TEXT NOT NULL DEFAULT 'contains',
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

pub fn run_migrations(conn: &Connection) -> Result<(), DbError> {
    conn.execute_batch(CREATE_TABLES)
        .map_err(|e| DbError::query("create tables", e))?;

    // Historical column migrations. All use the strict helper that ignores
    // only the idempotent "duplicate column name" error and propagates
    // everything else (disk full, missing table, permission denied). The
    // previous `.ok()` calls silently swallowed real failures and left the
    // schema half-applied (L3/L4).
    migrate_add_column(
        conn,
        "rewrite_rules",
        "match_type",
        "TEXT NOT NULL DEFAULT 'contains'",
    )?;
    migrate_add_column(
        conn,
        "breakpoint_rules",
        "match_type",
        "TEXT NOT NULL DEFAULT 'contains'",
    )?;
    migrate_add_column(
        conn,
        "script_rules",
        "match_type",
        "TEXT NOT NULL DEFAULT 'contains'",
    )?;
    migrate_add_column(conn, "session_details", "trailers", "TEXT DEFAULT NULL")?;
    migrate_add_column(
        conn,
        "session_details",
        "h2_stream_id",
        "INTEGER DEFAULT NULL",
    )?;
    migrate_add_column(
        conn,
        "session_details",
        "via_upstream_proxy",
        "INTEGER DEFAULT NULL",
    )?;
    migrate_add_column(
        conn,
        "workspaces",
        "http2_enabled",
        "INTEGER NOT NULL DEFAULT 1",
    )?;
    // H3: per-workspace upstream TLS certificate verification opt-out.
    // `verify_upstream_tls` defaults to 0 (off → keep the NoOp verifier the
    // debug proxy has always used, for compatibility). `tls_verify_hosts`
    // stores a JSON array of hostnames that are always verified even when the
    // global switch is off (an allowlist of "trust but verify" hosts).
    migrate_add_column(
        conn,
        "workspaces",
        "verify_upstream_tls",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    migrate_add_column(
        conn,
        "workspaces",
        "tls_verify_hosts",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    // Per-host SSL-decryption opt-out list (JSON array of hostnames stored as
    // TEXT). Hosts in this list are tunneled blindly even when the workspace
    // keeps `ssl_enabled` on — a privacy control and a workaround for
    // certificate-pinning clients. Defaults to the empty list.
    migrate_add_column(
        conn,
        "workspaces",
        "ssl_blind_hosts",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    // Upstream (chained) proxy settings, stored as a single JSON object rather
    // than one column per field: the settings are an internally-consistent unit
    // that is always read and written together, and a JSON column lets the
    // shape evolve without another ALTER TABLE. An empty string means "never
    // configured", which is distinct from a configured-but-disabled object.
    migrate_add_column(
        conn,
        "workspaces",
        "upstream_proxy",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    // Per-host SSL proxying policy (include / exclude pattern lists), stored as
    // JSON for the same reasons as `upstream_proxy` above. An empty string
    // means "never configured", which resolves to the built-in defaults rather
    // than to two empty lists — an existing workspace should pick up the
    // recommended exclusions instead of silently intercepting hosts that can
    // only break.
    migrate_add_column(
        conn,
        "workspaces",
        "ssl_proxying",
        "TEXT NOT NULL DEFAULT ''",
    )?;

    // M30: enforce the "at most one enabled throttle profile per workspace"
    // invariant at the storage layer with a partial UNIQUE index. First
    // collapse any pre-existing duplicates in older databases (keep the
    // smallest-id row enabled per workspace, disable the rest) so the index
    // build does not fail with a UNIQUE violation; then create the index
    // idempotently. The application paths
    // (save_throttle_profile, set_active_throttle_profile) deactivate other
    // profiles first — this index is the last line of defence against an app
    // bug or two racing commands leaving two enabled profiles in one workspace.
    collapse_duplicate_enabled_throttle_profiles(conn)?;
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_throttle_profiles_enabled_per_workspace \
         ON throttle_profiles(workspace_id) WHERE enabled = 1",
        [],
    )
    .map_err(|e| DbError::MigrationFailed(format!("create throttle unique index: {e}")))?;

    // M11: enforce uniqueness of (environment_id, key) for env vars and key for
    // global vars. The old upserts used INSERT OR REPLACE keyed on the row id
    // (a UUID), so two rows with the same natural key but different ids could
    // coexist and variable resolution picked one arbitrarily. First collapse
    // any pre-existing duplicates (keep the smallest-id row per natural key) so
    // the index build does not fail with a UNIQUE violation; then create the
    // indexes idempotently. The upserts have been switched to natural-key
    // ON CONFLICT upserts so they update the existing row instead of colliding.
    collapse_duplicate_env_variables(conn)?;
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_api_env_vars_env_key \
         ON api_environment_variables(environment_id, key)",
        [],
    )
    .map_err(|e| DbError::MigrationFailed(format!("create env vars unique index: {e}")))?;
    collapse_duplicate_global_variables(conn)?;
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_api_global_vars_unique_key \
         ON api_global_variables(key)",
        [],
    )
    .map_err(|e| DbError::MigrationFailed(format!("create global vars unique index: {e}")))?;

    Ok(())
}

/// Add a column to a table idempotently. Pre-checks `pragma_table_info` so the
/// migration is a no-op when the column already exists, and any ALTER error is
/// propagated verbatim (no string matching on SQLite messages, which would
/// break under localization/version changes — L3).
fn migrate_add_column(
    conn: &Connection,
    table: &str,
    column: &str,
    column_def: &str,
) -> Result<(), DbError> {
    if column_exists(conn, table, column)? {
        return Ok(());
    }
    let sql = format!("ALTER TABLE {table} ADD COLUMN {column} {column_def}");
    conn.execute(&sql, [])
        .map_err(|e| DbError::MigrationFailed(format!("migration add {table}.{column}: {e}")))?;
    Ok(())
}

/// Return true if `table` already has a column named `column`.
fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, DbError> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| DbError::query("check column existence", e))?;
    let names: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| DbError::query("read column names", e))?
        .filter_map(Result::ok)
        .collect();
    Ok(names.iter().any(|name| name.eq_ignore_ascii_case(column)))
}

/// M30: collapse any pre-existing duplicates where more than one
/// `throttle_profiles` row in the same workspace has `enabled = 1`. For each
/// affected workspace, keep the row with the smallest `id` enabled and disable
/// the rest. This makes older databases safe to add the partial UNIQUE index
/// `idx_throttle_profiles_enabled_per_workspace`. Idempotent: a no-op once only
/// one enabled profile per workspace remains.
fn collapse_duplicate_enabled_throttle_profiles(conn: &Connection) -> Result<(), DbError> {
    conn.execute_batch(
        "UPDATE throttle_profiles SET enabled = 0 \
         WHERE enabled = 1 AND id NOT IN ( \
             SELECT MIN(id) FROM throttle_profiles \
             WHERE enabled = 1 \
             GROUP BY workspace_id \
         )",
    )
    .map_err(|e| DbError::MigrationFailed(format!("collapse throttle profile duplicates: {e}")))?;
    Ok(())
}

/// M11: collapse pre-existing duplicate `(environment_id, key)` rows in
/// `api_environment_variables` by keeping only the smallest-id row per natural
/// key and deleting the rest. Makes older databases safe to add the
/// `idx_api_env_vars_env_key` UNIQUE index. Idempotent.
fn collapse_duplicate_env_variables(conn: &Connection) -> Result<(), DbError> {
    conn.execute_batch(
        "DELETE FROM api_environment_variables \
         WHERE id NOT IN ( \
             SELECT MIN(id) FROM api_environment_variables \
             GROUP BY environment_id, key \
         )",
    )
    .map_err(|e| DbError::MigrationFailed(format!("collapse env var duplicates: {e}")))?;
    Ok(())
}

/// M11: collapse pre-existing duplicate `key` rows in `api_global_variables`
/// by keeping only the smallest-id row per key and deleting the rest. Makes
/// older databases safe to add the `idx_api_global_vars_unique_key` UNIQUE
/// index. Idempotent.
fn collapse_duplicate_global_variables(conn: &Connection) -> Result<(), DbError> {
    conn.execute_batch(
        "DELETE FROM api_global_variables \
         WHERE id NOT IN ( \
             SELECT MIN(id) FROM api_global_variables \
             GROUP BY key \
         )",
    )
    .map_err(|e| DbError::MigrationFailed(format!("collapse global var duplicates: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_tables_exist_after_init() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();

        let tables: Result<Vec<String>, DbError> = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|r| r.map_err(|e| DbError::query("decode schema row", e)))
            .collect();
        let tables = tables.unwrap();

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

    // M7: session_details must carry an index on session_summary_id (its FK to
    // session_summaries) like every sibling child table. Without it the hot
    // detail lookup and the cascade-delete path full-scanned the table.
    #[test]
    fn session_details_has_index_on_session_summary_id() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();

        let indexes: Vec<String> = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='session_details'",
            )
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert!(
            indexes
                .iter()
                .any(|name| name == "idx_session_details_session"),
            "expected idx_session_details_session, got: {indexes:?}"
        );
    }

    // M11: session_summaries must carry a composite (host, duration_ms) index so
    // the host-scoped percentile scan and slow-request ranking in
    // `compute_insights` avoid a full scan + in-memory sort per refresh.
    #[test]
    fn session_summaries_has_host_duration_index() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();

        let indexes: Vec<String> = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='session_summaries'",
            )
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert!(
            indexes
                .iter()
                .any(|name| name == "idx_session_summaries_host_duration"),
            "expected idx_session_summaries_host_duration, got: {indexes:?}"
        );
    }

    // M30: a partial UNIQUE index on throttle_profiles(workspace_id) WHERE
    // enabled=1 must exist after migration, and a second enabled profile in the
    // same workspace must be rejected at the storage layer.
    #[test]
    fn m30_enabled_throttle_profile_unique_per_workspace_index_exists() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();

        let indexes: Vec<String> = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='throttle_profiles'",
            )
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert!(
            indexes
                .iter()
                .any(|name| name == "idx_throttle_profiles_enabled_per_workspace"),
            "expected M30 partial unique index, got: {indexes:?}"
        );
    }

    #[test]
    fn m30_two_enabled_profiles_same_workspace_rejected_by_index() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        // throttle_profiles.workspace_id is a FK to workspaces(id); insert the
        // parent workspaces so the FK is satisfied.
        conn.execute(
            "INSERT INTO workspaces (id, name, proxy_port, ssl_enabled, system_proxy_enabled, \
             storage_path, created_at, updated_at) \
             VALUES ('ws1', 'WS1', 8888, 0, 0, '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();

        // Insert the first enabled profile directly (bypassing the app-layer
        // deactivation in save_throttle_profile, to exercise the index).
        conn.execute(
            "INSERT INTO throttle_profiles (id, workspace_id, name, note, enabled, preset, \
             latency_ms, upload_kbps, download_kbps, packet_loss_ratio) \
             VALUES ('t1', 'ws1', 'Slow', NULL, 1, 0, 100, 300, 500, 0.0)",
            [],
        )
        .unwrap();
        // A second enabled profile in the same workspace must violate the index.
        let err = conn
            .execute(
                "INSERT INTO throttle_profiles (id, workspace_id, name, note, enabled, preset, \
                 latency_ms, upload_kbps, download_kbps, packet_loss_ratio) \
                 VALUES ('t2', 'ws1', 'Fast', NULL, 1, 0, 10, 3000, 5000, 0.0)",
                [],
            )
            .expect_err("second enabled profile must be rejected");
        let msg = format!("{err}");
        assert!(
            msg.to_lowercase().contains("unique"),
            "expected a UNIQUE constraint failure, got: {msg}"
        );

        // A second profile in a DIFFERENT workspace, and a disabled profile in
        // the same workspace, must both still be allowed.
        conn.execute(
            "INSERT INTO workspaces (id, name, proxy_port, ssl_enabled, system_proxy_enabled, \
             storage_path, created_at, updated_at) \
             VALUES ('ws2', 'WS2', 8889, 0, 0, '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO throttle_profiles (id, workspace_id, name, note, enabled, preset, \
             latency_ms, upload_kbps, download_kbps, packet_loss_ratio) \
             VALUES ('t3', 'ws2', 'Other', NULL, 1, 0, 100, 300, 500, 0.0)",
            [],
        )
        .expect("enabled profile in a different workspace is allowed");
        conn.execute(
            "INSERT INTO throttle_profiles (id, workspace_id, name, note, enabled, preset, \
             latency_ms, upload_kbps, download_kbps, packet_loss_ratio) \
             VALUES ('t4', 'ws1', 'Disabled', NULL, 0, 0, 100, 300, 500, 0.0)",
            [],
        )
        .expect("disabled profile in the same workspace is allowed");
    }

    // M30: an older database with two enabled profiles in one workspace must
    // have the duplicates collapsed (smallest-id kept enabled) so the unique
    // index can be (re)created without a constraint failure.
    #[test]
    fn m30_collapse_duplicate_enabled_throttle_profiles() {
        let conn = Connection::open_in_memory().unwrap();
        // Run CREATE_TABLES to make the table exist, then insert duplicates
        // BEFORE the M30 index/cleanup migration would normally run, to
        // simulate an upgrade from an older schema.
        conn.execute_batch(CREATE_TABLES).unwrap();
        conn.execute(
            "INSERT INTO workspaces (id, name, proxy_port, ssl_enabled, system_proxy_enabled, \
             storage_path, created_at, updated_at) \
             VALUES ('ws1', 'WS1', 8888, 0, 0, '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), \
                    ('ws2', 'WS2', 8889, 0, 0, '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO throttle_profiles (id, workspace_id, name, note, enabled, preset, \
             latency_ms, upload_kbps, download_kbps, packet_loss_ratio) \
             VALUES ('a', 'ws1', 'A', NULL, 1, 0, 0, 0, 0, 0.0), \
                    ('b', 'ws1', 'B', NULL, 1, 0, 0, 0, 0, 0.0), \
                    ('c', 'ws1', 'C', NULL, 0, 0, 0, 0, 0, 0.0), \
                    ('d', 'ws2', 'D', NULL, 1, 0, 0, 0, 0, 0.0)",
            [],
        )
        .unwrap();

        // Run the collapse + index creation (the steps run_migrations performs
        // after CREATE_TABLES).
        collapse_duplicate_enabled_throttle_profiles(&conn).unwrap();
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_throttle_profiles_enabled_per_workspace \
             ON throttle_profiles(workspace_id) WHERE enabled = 1",
            [],
        )
        .expect("index creation must succeed after collapse");

        // ws1: 'a' (smallest id among enabled) kept enabled, 'b' disabled.
        let enabled_ws1: Vec<String> = conn
            .prepare("SELECT id FROM throttle_profiles WHERE workspace_id='ws1' AND enabled=1")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(enabled_ws1, vec!["a".to_string()]);
        // ws2: 'd' untouched.
        let enabled_ws2: Vec<String> = conn
            .prepare("SELECT id FROM throttle_profiles WHERE workspace_id='ws2' AND enabled=1")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(enabled_ws2, vec!["d".to_string()]);
    }
}

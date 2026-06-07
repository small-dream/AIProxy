use std::sync::{Arc, Mutex};

use aiproxy_db::body_store::BodyStore;
use aiproxy_db::rules::{
    MapRunRow, RewriteRunEntryRow, RewriteRunRow, ScriptRunEntryRow, ScriptRunRow, ThrottleRunRow,
};
use aiproxy_proxy_core::{
    MapTrace, ProxySessionSummary, RewriteTrace, ScriptLogLevel, ScriptRunEntryKind,
    ScriptRunOutcome, ScriptTrace, ScriptTraceStage, ThrottleTrace,
};

/// Encapsulates all direct database and body-store I/O.
///
/// `AppState` delegates persistence to this struct so that its own methods
/// focus on coordination (cache updates, event emission, status management).
#[derive(Debug)]
pub(crate) struct Repository {
    db: Arc<Mutex<aiproxy_db::rusqlite::Connection>>,
    body_store: Arc<BodyStore>,
}

#[allow(dead_code)]
impl Repository {
    pub fn new(
        db: Arc<Mutex<aiproxy_db::rusqlite::Connection>>,
        body_store: Arc<BodyStore>,
    ) -> Self {
        Self { db, body_store }
    }

    /// Access the underlying DB connection. Prefer using the dedicated methods
    /// below; this accessor exists for callers that need the raw connection
    /// (e.g. `init_from_db` which populates in-memory managers).
    pub fn db(&self) -> &Arc<Mutex<aiproxy_db::rusqlite::Connection>> {
        &self.db
    }

    /// Access the body store.
    pub fn body_store(&self) -> &Arc<BodyStore> {
        &self.body_store
    }

    // ------------------------------------------------------------------
    // Session storage lifecycle
    // ------------------------------------------------------------------

    /// Clear all session data from SQLite and BodyStore.
    pub fn clear_all_sessions(&self) {
        {
            let conn = self.db.lock().expect("db mutex should not be poisoned");
            if let Err(error) = aiproxy_db::sessions::clear_all_sessions(&conn) {
                tracing::error!(
                    component = "desktop.persistence",
                    event = "clear_session_storage_db_failed",
                    error = %error,
                    "clear_session_storage_db_failed"
                );
            }
        }

        if let Err(error) = self.body_store.clear_all() {
            tracing::error!(
                component = "desktop.persistence",
                event = "clear_session_storage_bodies_failed",
                error = %error,
                "clear_session_storage_bodies_failed"
            );
        }

        tracing::info!(
            component = "desktop.persistence",
            event = "session_storage_cleared",
            "session_storage_cleared"
        );
    }

    /// Delete sessions by ID (DB + body files).
    pub fn delete_sessions_by_ids(&self, ids: &[String]) {
        {
            let conn = self.db.lock().expect("db mutex should not be poisoned");
            if let Err(error) = aiproxy_db::sessions::delete_sessions_by_ids(&conn, ids) {
                tracing::error!(
                    component = "desktop.persistence",
                    event = "clear_sessions_db_failed",
                    error = %error,
                    "clear_sessions_db_failed"
                );
            }
        }

        for id in ids {
            if let Err(error) = self.body_store.remove_bodies(id) {
                tracing::error!(
                    component = "desktop.persistence",
                    event = "clear_sessions_body_remove_failed",
                    session_id = %id,
                    error = %error,
                    "clear_sessions_body_remove_failed"
                );
            }
        }
    }

    /// Load a session detail row from the database.
    pub fn load_session_detail_row(
        &self,
        session_id: &str,
    ) -> Result<Option<aiproxy_db::sessions::SessionDetailRow>, String> {
        let conn = self.db.lock().expect("db mutex should not be poisoned");
        aiproxy_db::sessions::load_session_detail(&conn, session_id)
            .map_err(|e| e.to_string())
    }

    /// Load a session summary row from the database.
    pub fn load_session_summary_row(
        &self,
        session_id: &str,
    ) -> Result<Option<aiproxy_db::sessions::SessionSummaryRow>, String> {
        let conn = self.db.lock().expect("db mutex should not be poisoned");
        aiproxy_db::sessions::load_session_summary(&conn, session_id)
            .map_err(|e| e.to_string())
    }

    /// Persist a single session (summary + detail rows) to SQLite.
    /// Body spill MUST be done by the caller before calling this.
    pub fn upsert_session_rows(
        &self,
        summary_row: &aiproxy_db::sessions::SessionSummaryRow,
        detail_row: &aiproxy_db::sessions::SessionDetailRow,
    ) {
        let conn = self.db.lock().expect("db mutex should not be poisoned");
        if let Err(e) = aiproxy_db::sessions::upsert_session(&conn, summary_row, detail_row) {
            tracing::error!(
                component = "desktop.persistence",
                event = "session_upsert_db_failed",
                error = %e,
                "session_upsert_db_failed"
            );
        }
    }

    // ------------------------------------------------------------------
    // Trace persistence
    // ------------------------------------------------------------------

    pub fn persist_script_traces(
        &self,
        session_id: &str,
        workspace_id: &str,
        summary: &ProxySessionSummary,
        traces: &[ScriptTrace],
    ) -> Result<(), String> {
        let conn = self.db.lock().expect("db mutex should not be poisoned");
        persist_script_traces_impl(&conn, session_id, workspace_id, summary, traces)
    }

    pub fn persist_rewrite_traces(
        &self,
        session_id: &str,
        workspace_id: &str,
        summary: &ProxySessionSummary,
        traces: &[RewriteTrace],
    ) -> Result<(), String> {
        let conn = self.db.lock().expect("db mutex should not be poisoned");
        persist_rewrite_traces_impl(&conn, session_id, workspace_id, summary, traces)
    }

    pub fn persist_map_traces(
        &self,
        session_id: &str,
        workspace_id: &str,
        summary: &ProxySessionSummary,
        traces: &[MapTrace],
    ) -> Result<(), String> {
        let conn = self.db.lock().expect("db mutex should not be poisoned");
        persist_map_traces_impl(&conn, session_id, workspace_id, summary, traces)
    }

    pub fn persist_throttle_traces(
        &self,
        session_id: &str,
        workspace_id: &str,
        traces: &[ThrottleTrace],
    ) -> Result<(), String> {
        let conn = self.db.lock().expect("db mutex should not be poisoned");
        persist_throttle_traces_impl(&conn, session_id, workspace_id, traces)
    }
}

// ---------------------------------------------------------------------------
// Internal trace-persistence helpers (operate on a locked connection)
// ---------------------------------------------------------------------------

fn persist_script_traces_impl(
    conn: &aiproxy_db::rusqlite::Connection,
    session_id: &str,
    workspace_id: &str,
    summary: &ProxySessionSummary,
    traces: &[ScriptTrace],
) -> Result<(), String> {
    let created_at = summary.finished_at.clone();
    let runs: Vec<ScriptRunRow> = traces
        .iter()
        .enumerate()
        .map(|(index, trace)| ScriptRunRow {
            id: format!("{session_id}-script-run-{index}"),
            session_id: session_id.to_string(),
            rule_id: trace.rule_id.clone(),
            workspace_id: workspace_id.to_string(),
            stage: match trace.stage {
                ScriptTraceStage::Request => "request".to_string(),
                ScriptTraceStage::Response => "response".to_string(),
            },
            outcome: match trace.outcome {
                ScriptRunOutcome::Success => "success".to_string(),
                ScriptRunOutcome::Skipped => "skipped".to_string(),
                ScriptRunOutcome::RuntimeError => "runtimeError".to_string(),
                ScriptRunOutcome::TimedOut => "timedOut".to_string(),
                ScriptRunOutcome::InvalidResult => "invalidResult".to_string(),
            },
            duration_ms: trace.duration_ms,
            created_at: created_at.clone(),
        })
        .collect();

    let entries: Vec<ScriptRunEntryRow> = traces
        .iter()
        .enumerate()
        .flat_map(|(run_index, trace)| {
            trace
                .entries
                .iter()
                .enumerate()
                .map(move |(entry_index, entry)| ScriptRunEntryRow {
                    id: format!("{session_id}-script-run-{run_index}-entry-{entry_index}"),
                    run_id: format!("{session_id}-script-run-{run_index}"),
                    kind: match entry.kind {
                        ScriptRunEntryKind::Log => "log".to_string(),
                        ScriptRunEntryKind::Extraction => "extraction".to_string(),
                        ScriptRunEntryKind::Error => "error".to_string(),
                    },
                    level: entry.level.as_ref().map(|level| match level {
                        ScriptLogLevel::Debug => "debug".to_string(),
                        ScriptLogLevel::Info => "info".to_string(),
                        ScriptLogLevel::Warn => "warn".to_string(),
                        ScriptLogLevel::Error => "error".to_string(),
                    }),
                    key: entry.key.clone(),
                    message: entry.message.clone(),
                    payload_json: entry.payload_json.clone(),
                    seq: entry.sequence,
                })
        })
        .collect();

    aiproxy_db::rules::replace_script_runs_for_session(conn, session_id, &runs, &entries)
}

fn persist_rewrite_traces_impl(
    conn: &aiproxy_db::rusqlite::Connection,
    session_id: &str,
    workspace_id: &str,
    summary: &ProxySessionSummary,
    traces: &[RewriteTrace],
) -> Result<(), String> {
    let created_at = summary.finished_at.clone();
    let runs: Vec<RewriteRunRow> = traces
        .iter()
        .enumerate()
        .map(|(index, trace)| RewriteRunRow {
            id: format!("{session_id}-rewrite-run-{index}"),
            session_id: session_id.to_string(),
            rule_id: trace.rule_id.clone(),
            rule_name: trace.rule_name.clone(),
            workspace_id: workspace_id.to_string(),
            rewrite_type: trace.rewrite_type.clone(),
            stage: trace.stage.clone(),
            outcome: trace.outcome.clone(),
            duration_ms: trace.duration_ms,
            created_at: created_at.clone(),
        })
        .collect();

    let entries: Vec<RewriteRunEntryRow> = traces
        .iter()
        .enumerate()
        .flat_map(|(run_index, trace)| {
            trace
                .entries
                .iter()
                .enumerate()
                .map(move |(entry_index, entry)| RewriteRunEntryRow {
                    id: format!("{session_id}-rewrite-run-{run_index}-entry-{entry_index}"),
                    run_id: format!("{session_id}-rewrite-run-{run_index}"),
                    kind: entry.kind.clone(),
                    key: entry.key.clone(),
                    before_value: entry.before.clone(),
                    after_value: entry.after.clone(),
                    message: entry.message.clone(),
                    seq: entry.sequence,
                })
        })
        .collect();

    aiproxy_db::rules::replace_rewrite_runs_for_session(conn, session_id, &runs, &entries)
}

fn persist_map_traces_impl(
    conn: &aiproxy_db::rusqlite::Connection,
    session_id: &str,
    workspace_id: &str,
    summary: &ProxySessionSummary,
    traces: &[MapTrace],
) -> Result<(), String> {
    let created_at = summary.finished_at.clone();
    let runs: Vec<MapRunRow> = traces
        .iter()
        .enumerate()
        .map(|(index, trace)| MapRunRow {
            id: format!("{session_id}-map-run-{index}"),
            session_id: session_id.to_string(),
            workspace_id: workspace_id.to_string(),
            rule_id: trace.rule_id.clone(),
            rule_name: trace.rule_name.clone(),
            mode: trace.mode.clone(),
            outcome: trace.outcome.clone(),
            source_pattern: trace.source_pattern.clone(),
            target_value: trace.target_value.clone(),
            original_url: trace.original_url.clone(),
            mapped_url: trace.mapped_url.clone(),
            local_path: trace.local_path.clone(),
            duration_ms: trace.duration_ms,
            sequence: index as u32,
            created_at: created_at.clone(),
        })
        .collect();

    aiproxy_db::rules::replace_map_runs_for_session(conn, session_id, &runs)
}

fn persist_throttle_traces_impl(
    conn: &aiproxy_db::rusqlite::Connection,
    session_id: &str,
    workspace_id: &str,
    traces: &[ThrottleTrace],
) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let runs: Vec<ThrottleRunRow> = traces
        .iter()
        .enumerate()
        .map(|(index, trace)| ThrottleRunRow {
            id: format!("{session_id}-throttle-{index}"),
            session_id: session_id.to_string(),
            workspace_id: workspace_id.to_string(),
            profile_id: trace.profile_id.clone(),
            profile_name: trace.profile_name.clone(),
            rule_id: trace.rule_id.clone(),
            rule_name: trace.rule_name.clone(),
            stage: trace.stage.clone(),
            outcome: trace.outcome.clone(),
            delay_ms: trace.delay_ms,
            latency_ms: trace.latency_ms,
            transfer_delay_ms: trace.transfer_delay_ms,
            body_bytes: trace.body_bytes,
            message: trace.message.clone(),
            sequence: index as u32,
            created_at: now.clone(),
        })
        .collect();

    aiproxy_db::rules::replace_throttle_runs_for_session(conn, session_id, &runs)
}

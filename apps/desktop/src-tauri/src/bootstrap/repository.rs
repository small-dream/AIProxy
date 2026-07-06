use std::sync::{Arc, Mutex, MutexGuard};

use aiproxy_db::body_store::BodyStore;
use aiproxy_db::rules::{
    MapRunRow, RewriteRunEntryRow, RewriteRunRow, ScriptRunEntryRow, ScriptRunRow, ThrottleRunRow,
};
use aiproxy_proxy_core::{
    MapTrace, ProxySessionSummary, RewriteTrace, ScriptLogLevel, ScriptRunEntryKind,
    ScriptRunOutcome, ScriptTrace, ScriptTraceStage, ThrottleTrace,
};

use crate::bootstrap::lock_recovery::{
    lock_db_best_effort as lock_best_effort_helper, lock_db_for_ipc as lock_for_ipc_helper,
    lock_db_or_recover as lock_db_or_recover_helper,
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

    /// Acquire the DB connection lock for an IPC command handler. Returns a
    /// structured `DB_POISONED` error on poison (fail-closed): a poisoned
    /// `Connection` may have torn statement state and must not be reused for
    /// user-data writes. Use [`Self::lock_best_effort`] for best-effort
    /// internal write paths (which skip on poison) or [`Self::lock_or_recover`]
    /// for read-only paths.
    ///
    /// Thin wrapper over [`lock_recovery::lock_db_for_ipc`]. Command files
    /// that prefer to clone the `Arc` and call inside a `move` closure can
    /// use the free function directly.
    ///
    /// See ADR-005 for the policy rationale.
    pub fn lock_for_ipc(
        &self,
    ) -> Result<MutexGuard<'_, aiproxy_db::rusqlite::Connection>, String> {
        lock_for_ipc_helper(&self.db)
    }

    /// Acquire the DB connection lock for a **read-only** best-effort internal
    /// path (fail-open + log). Use this from session loaders and startup reads
    /// — paths that (a) have no `Result` channel to the user, AND (b) only
    /// **read** the DB. A poisoned `Connection` may return garbage rows, but
    /// the caller already handles DB errors via `tracing::*`.
    ///
    /// **Do NOT use for write paths** — use [`Self::lock_best_effort`] instead,
    /// which skips the write on poison to avoid corrupting user data.
    /// `category` identifies the caller in logs (e.g. `"startup_load"`).
    ///
    /// See ADR-005 for the policy rationale.
    pub fn lock_or_recover(
        &self,
        category: &'static str,
    ) -> MutexGuard<'_, aiproxy_db::rusqlite::Connection> {
        lock_db_or_recover_helper(&self.db, category)
    }

    /// Acquire the DB connection lock for a best-effort **write** path. On
    /// poison, returns `Err(())` (after logging) so the caller can skip the
    /// write — never write through a poisoned `Connection`. Use this from
    /// session persisters, deleters, and the WS collector. `category`
    /// identifies the caller in logs (e.g. `"session_persistence"`).
    ///
    /// See ADR-005 for the policy rationale.
    pub fn lock_best_effort(
        &self,
        category: &'static str,
    ) -> Result<MutexGuard<'_, aiproxy_db::rusqlite::Connection>, ()> {
        lock_best_effort_helper(&self.db, category)
    }

    /// Access the body store.
    pub fn body_store(&self) -> &Arc<BodyStore> {
        &self.body_store
    }

    // ------------------------------------------------------------------
    // Session storage lifecycle
    // ------------------------------------------------------------------

    /// Clear all session data from SQLite and BodyStore.
    ///
    /// M29: the DB clear and the body-store clear are not atomic — if the
    /// body clear fails (e.g. a transient FS error) the DB rows are gone but
    /// orphaned blob files remain on disk. Rather than blocking the UI, spawn
    /// a background rescan that retries `clear_all` once; if it still fails the
    /// orphan blobs persist but are harmless (no DB rows reference them and a
    /// later clear/full session re-run will sweep them again).
    pub fn clear_all_sessions(&self) {
        // Fail-closed on poison: skip the DB clear rather than write through a
        // potentially torn Connection. The body-store clear below still runs
        // (it's independent of the DB Connection).
        if let Ok(conn) = self.lock_best_effort("session_clear") {
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
            // M29: fire-and-forget rescan so a transient FS error does not
            // leave orphan blobs indefinitely. The cloned Arcs keep the store
            // alive for the background task.
            self.spawn_body_rescan();
        }

        tracing::info!(
            component = "desktop.persistence",
            event = "session_storage_cleared",
            "session_storage_cleared"
        );
    }

    /// M29: spawn a background task that retries `body_store.clear_all()` once
    /// after a short delay. Used when the synchronous clear failed, to avoid
    /// leaving orphan blob files behind without blocking the UI/clear command.
    /// Idempotent and best-effort — a second failure is logged and abandoned.
    fn spawn_body_rescan(&self) {
        let body_store = Arc::clone(&self.body_store);
        std::thread::spawn(move || {
            // Brief back-off so a transient FS condition (e.g. an in-flight
            // writer finishing a create_dir_all) can clear before the retry.
            std::thread::sleep(std::time::Duration::from_millis(500));
            if let Err(error) = body_store.clear_all() {
                tracing::error!(
                    component = "desktop.persistence",
                    event = "body_rescan_clear_failed",
                    error = %error,
                    "body rescan retry failed; orphan blobs may persist until next clear"
                );
            } else {
                tracing::info!(
                    component = "desktop.persistence",
                    event = "body_rescan_clear_succeeded",
                    "body rescan retry cleared orphan blobs after initial failure"
                );
            }
        });
    }

    /// Delete sessions by ID (DB + body files).  Synchronous — prefer the
    /// async variant inside Tauri commands unless you are already on a
    /// blocking thread.
    #[allow(dead_code)] // synchronous API; the hot path uses delete_sessions_and_bodies_async
    pub fn delete_sessions_by_ids(&self, ids: &[String]) {
        // Fail-closed on poison: skip the DB delete; the body-file cleanup
        // below still runs (independent of the DB Connection).
        if let Ok(conn) = self.lock_best_effort("session_delete") {
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

    /// Async variant of `delete_sessions_by_ids` that offloads the DB and
    /// file-system work to `spawn_blocking`. Used by `delete_sessions_except`
    /// (M14) to keep DB + file I/O off the IPC thread.
    pub async fn delete_sessions_and_bodies_async(&self, ids: Vec<String>) {
        let db = Arc::clone(&self.db);
        let body_store = Arc::clone(&self.body_store);
        match tauri::async_runtime::spawn_blocking(move || {
            delete_sessions_impl(&db, &body_store, &ids);
        })
        .await
        {
            Ok(()) => {}
            Err(error) => {
                tracing::error!(
                    component = "desktop.persistence",
                    event = "delete_sessions_spawn_failed",
                    error = %error,
                    "delete_sessions spawn_blocking failed"
                );
            }
        }
    }

    /// Fire-and-forget variant for callers that have already updated caches
    /// and emitted events and don't need to wait for DB cleanup.
    pub fn spawn_delete_sessions(&self, ids: Vec<String>) {
        let db = Arc::clone(&self.db);
        let body_store = Arc::clone(&self.body_store);
        std::thread::spawn(move || {
            delete_sessions_impl(&db, &body_store, &ids);
        });
    }

    /// Load a session detail row from the database for an IPC-reachable path,
    /// with tracing. Fail-closed on poison: returns a structured `DB_POISONED`
    /// error so session-detail IPC commands stay consistent with all other IPC
    /// DB commands. Returns `Ok(None)` when the row doesn't exist or a DB
    /// error occurs (both cases are logged). See ADR-005.
    pub fn load_session_detail_for_ipc(
        &self,
        session_id: &str,
    ) -> Result<Option<aiproxy_db::sessions::SessionDetailRow>, String> {
        let conn = self.lock_for_ipc()?;
        match aiproxy_db::sessions::load_session_detail(&conn, session_id) {
            Ok(Some(row)) => {
                tracing::debug!(
                    component = "desktop.persistence",
                    event = "session_detail_db_hit",
                    session_id = %session_id,
                    "session_detail_db_hit"
                );
                Ok(Some(row))
            }
            Ok(None) => {
                tracing::warn!(
                    component = "desktop.persistence",
                    event = "session_detail_db_miss",
                    session_id = %session_id,
                    "session_detail_db_miss"
                );
                Ok(None)
            }
            Err(error) => {
                tracing::error!(
                    component = "desktop.persistence",
                    event = "load_session_detail_failed",
                    session_id = %session_id,
                    error = %error,
                    "load_session_detail_failed"
                );
                Ok(None)
            }
        }
    }

    /// Load a session summary row from the database for an IPC-reachable path,
    /// with tracing. Fail-closed on poison (returns `DB_POISONED`). See
    /// [`load_session_detail_for_ipc`]. See ADR-005.
    pub fn load_session_summary_for_ipc(
        &self,
        session_id: &str,
    ) -> Result<Option<aiproxy_db::sessions::SessionSummaryRow>, String> {
        let conn = self.lock_for_ipc()?;
        match aiproxy_db::sessions::load_session_summary(&conn, session_id) {
            Ok(Some(row)) => {
                tracing::debug!(
                    component = "desktop.persistence",
                    event = "session_summary_db_hit",
                    session_id = %session_id,
                    "session_summary_db_hit"
                );
                Ok(Some(row))
            }
            Ok(None) => {
                tracing::warn!(
                    component = "desktop.persistence",
                    event = "session_summary_db_miss",
                    session_id = %session_id,
                    "session_summary_db_miss"
                );
                Ok(None)
            }
            Err(error) => {
                tracing::error!(
                    component = "desktop.persistence",
                    event = "load_session_summary_failed",
                    session_id = %session_id,
                    error = %error,
                    "load_session_summary_failed"
                );
                Ok(None)
            }
        }
    }

    // -- low-level accessors (kept for callers that need raw Result) -----

    /// Load a session detail row from the database.
    #[allow(dead_code)] // available for callers that want raw Result
    pub fn load_session_detail_row(
        &self,
        session_id: &str,
    ) -> Result<Option<aiproxy_db::sessions::SessionDetailRow>, String> {
        let conn = self.lock_or_recover("session_detail_row_load");
        aiproxy_db::sessions::load_session_detail(&conn, session_id).map_err(|e| e.to_string())
    }

    /// Load a session summary row from the database.
    #[allow(dead_code)] // available for callers that want raw Result
    pub fn load_session_summary_row(
        &self,
        session_id: &str,
    ) -> Result<Option<aiproxy_db::sessions::SessionSummaryRow>, String> {
        let conn = self.lock_or_recover("session_summary_row_load");
        aiproxy_db::sessions::load_session_summary(&conn, session_id).map_err(|e| e.to_string())
    }

    /// Persist a single session (summary + detail rows) to SQLite.
    /// Body spill MUST be done by the caller before calling this.
    #[allow(dead_code)] // transitional
    pub fn upsert_session_rows(
        &self,
        summary_row: &aiproxy_db::sessions::SessionSummaryRow,
        detail_row: &aiproxy_db::sessions::SessionDetailRow,
    ) {
        // Fail-closed on poison: skip the upsert rather than write through a
        // potentially torn Connection.
        let conn = match self.lock_best_effort("session_upsert") {
            Ok(conn) => conn,
            Err(()) => return,
        };
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
    //
    // Low-level per-category methods have been removed in favour of
    // `persist_all_traces` which batches all four categories in one
    // pass and is called from `persist_session_full` /
    // `persist_session_batch_full`.  See the internal `_impl` helpers
    // at the bottom of the file for the actual DB interactions.
    // ------------------------------------------------------------------
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
        .map_err(|e| e.to_string())
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
        .map_err(|e| e.to_string())
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
        .map_err(|e| e.to_string())
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
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// High-level convenience methods — full session persistence
// ---------------------------------------------------------------------------

use std::time::Instant;

use aiproxy_db::sessions::SessionDetailRow;
use aiproxy_proxy_core::ProxySessionDetail;

use crate::session_stats;

impl Repository {
    /// Full persistence of a single session: spill bodies → build rows →
    /// upsert summary+detail → persist all traces.  Runs everything inside
    /// `spawn_blocking` so the async runtime stays free.
    pub async fn persist_session_full(
        &self,
        mut detail: ProxySessionDetail,
        workspace_id: &str,
    ) -> ProxySessionDetail {
        let db = Arc::clone(&self.db);
        let body_store = Arc::clone(&self.body_store);
        let wid = workspace_id.to_string();
        // Keep a fallback copy: if spawn_blocking panics (JoinError), return the
        // session unchanged so the collector task survives instead of crashing
        // (H9). The session simply won't be persisted in that rare case.
        let fallback = detail.clone();

        match tauri::async_runtime::spawn_blocking(move || {
            // Spill bodies
            let spill_started_at = Instant::now();
            if let Err(error) =
                crate::bootstrap::converters::spill_session_bodies_to_disk(&mut detail, &body_store)
            {
                tracing::error!(
                    component = "desktop.persistence",
                    event = "session_body_spill_failed",
                    error = %error,
                    "session_body_spill_failed"
                );
            }
            let spill_elapsed_us = spill_started_at.elapsed().as_micros();

            let summary_row = crate::bootstrap::converters::proxy_summary_to_row(&detail.summary);
            let row_build_started_at = Instant::now();
            let detail_row =
                crate::bootstrap::converters::proxy_detail_to_row(&detail, &body_store);
            let row_build_elapsed_us = row_build_started_at.elapsed().as_micros();
            log_storage_stats(&detail, &detail_row, spill_elapsed_us, row_build_elapsed_us);

            // Fail-closed on poison: skip the write rather than mutate user
            // data through a potentially torn Connection. Return the detail
            // unchanged (same as the JoinError fallback) — the session simply
            // isn't persisted in this rare case.
            let conn = match crate::bootstrap::lock_recovery::lock_db_best_effort(
                &db,
                "session_persist_full",
            ) {
                Ok(conn) => conn,
                Err(()) => return detail,
            };
            if let Err(e) = aiproxy_db::sessions::upsert_session(&conn, &summary_row, &detail_row) {
                tracing::error!(
                    component = "desktop.persistence",
                    event = "session_upsert_db_failed",
                    error = %e,
                    "session_upsert_db_failed"
                );
            }

            persist_all_traces(
                &conn,
                &detail.id,
                &wid,
                &detail.summary,
                &detail.script_traces,
                &detail.rewrite_traces,
                &detail.map_traces,
                &detail.throttle_traces,
            );

            detail
        })
        .await
        {
            Ok(detail) => detail,
            Err(error) => {
                tracing::error!(
                    component = "desktop.persistence",
                    event = "persist_session_spawn_failed",
                    error = %error,
                    "persist_session_full spawn_blocking failed; returning unpersisted session"
                );
                fallback
            }
        }
    }

    /// Full persistence of a batch of sessions.  Same pipeline as
    /// `persist_session_full` but acquires the DB lock once for all sessions.
    pub async fn persist_session_batch_full(
        &self,
        mut sessions: Vec<ProxySessionDetail>,
        workspace_id: &str,
    ) -> Vec<ProxySessionDetail> {
        let db = Arc::clone(&self.db);
        let body_store = Arc::clone(&self.body_store);
        let wid = workspace_id.to_string();
        // Fallback copy in case spawn_blocking panics (H9): return the sessions
        // unchanged so the collector survives instead of crashing.
        let fallback = sessions.clone();

        match tauri::async_runtime::spawn_blocking(move || {
            for session in sessions.iter_mut() {
                if let Err(error) =
                    crate::bootstrap::converters::spill_session_bodies_to_disk(session, &body_store)
                {
                    tracing::error!(
                        component = "desktop.persistence",
                        event = "session_body_spill_failed",
                        error = %error,
                        "session_body_spill_failed"
                    );
                }
            }

            // Fail-closed on poison: skip the batch write rather than mutate
            // user data through a potentially torn Connection. Return sessions
            // unchanged — they simply aren't persisted in this rare case.
            let conn = match crate::bootstrap::lock_recovery::lock_db_best_effort(
                &db,
                "session_persist_batch",
            ) {
                Ok(conn) => conn,
                Err(()) => return sessions,
            };
            for session in sessions.iter() {
                let summary_row =
                    crate::bootstrap::converters::proxy_summary_to_row(&session.summary);
                let detail_row =
                    crate::bootstrap::converters::proxy_detail_to_row(session, &body_store);

                if let Err(e) =
                    aiproxy_db::sessions::upsert_session(&conn, &summary_row, &detail_row)
                {
                    tracing::error!(
                        component = "desktop.persistence",
                        event = "session_upsert_db_failed",
                        error = %e,
                        "session_upsert_db_failed"
                    );
                }

                persist_all_traces(
                    &conn,
                    &session.id,
                    &wid,
                    &session.summary,
                    &session.script_traces,
                    &session.rewrite_traces,
                    &session.map_traces,
                    &session.throttle_traces,
                );
            }

            sessions
        })
        .await
        {
            Ok(sessions) => sessions,
            Err(error) => {
                tracing::error!(
                    component = "desktop.persistence",
                    event = "persist_session_batch_spawn_failed",
                    error = %error,
                    "persist_session_batch_full spawn_blocking failed; returning unpersisted sessions"
                );
                fallback
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn log_storage_stats(
    detail: &ProxySessionDetail,
    row: &SessionDetailRow,
    spill_elapsed_us: u128,
    row_build_elapsed_us: u128,
) {
    if !session_stats::is_enabled() {
        return;
    }

    let request_body_storage = detail
        .request_body
        .as_ref()
        .map_or("none", |body| body.storage_kind());
    let response_body_storage = detail
        .response_body
        .as_ref()
        .map_or("none", |body| body.storage_kind());
    let request_body_resident_bytes = detail
        .request_body
        .as_ref()
        .map_or(0, |body| body.resident_memory_bytes_estimate());
    let response_body_resident_bytes = detail
        .response_body
        .as_ref()
        .map_or(0, |body| body.resident_memory_bytes_estimate());

    session_stats::record(
        "session_storage_stats",
        &[
            ("session_id", detail.id.clone()),
            ("method", detail.summary.method.clone()),
            ("status_code", detail.summary.status_code.to_string()),
            (
                "resident_memory_bytes_estimate",
                detail.resident_memory_bytes_estimate().to_string(),
            ),
            (
                "summary_memory_bytes_estimate",
                detail.summary.resident_memory_bytes_estimate().to_string(),
            ),
            ("request_body_storage", request_body_storage.to_string()),
            (
                "request_body_resident_bytes",
                request_body_resident_bytes.to_string(),
            ),
            ("response_body_storage", response_body_storage.to_string()),
            (
                "response_body_resident_bytes",
                response_body_resident_bytes.to_string(),
            ),
            (
                "db_row_text_bytes",
                crate::bootstrap::converters::estimate_session_detail_row_text_bytes(row)
                    .to_string(),
            ),
            (
                "request_body_ref_bytes",
                row.request_body_ref
                    .as_ref()
                    .map_or(0, |value| value.len())
                    .to_string(),
            ),
            (
                "response_body_ref_bytes",
                row.response_body_ref
                    .as_ref()
                    .map_or(0, |value| value.len())
                    .to_string(),
            ),
            (
                "raw_request_head_bytes",
                row.raw_request
                    .as_ref()
                    .map_or(0, |value| value.len())
                    .to_string(),
            ),
            (
                "raw_response_head_bytes",
                row.raw_response
                    .as_ref()
                    .map_or(0, |value| value.len())
                    .to_string(),
            ),
            ("spill_elapsed_us", spill_elapsed_us.to_string()),
            ("row_build_elapsed_us", row_build_elapsed_us.to_string()),
        ],
    );
}

fn delete_sessions_impl(
    db: &Arc<Mutex<aiproxy_db::rusqlite::Connection>>,
    body_store: &Arc<BodyStore>,
    ids: &[String],
) {
    // Fail-closed on poison: skip the DB delete; the body-file cleanup below
    // still runs (independent of the DB Connection).
    if let Ok(conn) = crate::bootstrap::lock_recovery::lock_db_best_effort(db, "session_delete_impl")
    {
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
        if let Err(error) = body_store.remove_bodies(id) {
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

/// Persist all four trace categories for a session, logging each failure
/// individually (matching the pre-refactor behaviour so operators can see
/// *which* trace type failed).
#[allow(clippy::too_many_arguments)]
fn persist_all_traces(
    conn: &aiproxy_db::rusqlite::Connection,
    session_id: &str,
    workspace_id: &str,
    summary: &ProxySessionSummary,
    script_traces: &[ScriptTrace],
    rewrite_traces: &[RewriteTrace],
    map_traces: &[MapTrace],
    throttle_traces: &[ThrottleTrace],
) {
    if let Err(e) =
        persist_script_traces_impl(conn, session_id, workspace_id, summary, script_traces)
    {
        tracing::error!(
            component = "desktop.persistence",
            event = "script_trace_upsert_db_failed",
            error = %e,
            "script_trace_upsert_db_failed"
        );
    }
    if let Err(e) =
        persist_rewrite_traces_impl(conn, session_id, workspace_id, summary, rewrite_traces)
    {
        tracing::error!(
            component = "desktop.persistence",
            event = "rewrite_trace_upsert_db_failed",
            error = %e,
            "rewrite_trace_upsert_db_failed"
        );
    }
    if let Err(e) = persist_map_traces_impl(conn, session_id, workspace_id, summary, map_traces) {
        tracing::error!(
            component = "desktop.persistence",
            event = "map_trace_upsert_db_failed",
            error = %e,
            "map_trace_upsert_db_failed"
        );
    }
    if let Err(e) = persist_throttle_traces_impl(conn, session_id, workspace_id, throttle_traces) {
        tracing::error!(
            component = "desktop.persistence",
            event = "throttle_trace_upsert_db_failed",
            error = %e,
            "throttle_trace_upsert_db_failed"
        );
    }
}

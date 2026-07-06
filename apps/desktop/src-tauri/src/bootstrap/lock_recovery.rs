//! Centralized mutex-poison recovery helpers.
//!
//! Project policy (ADR-005): under the unwinding panic strategy (ADR-004), a
//! `Mutex` can be poisoned whenever a thread panics while holding the guard.
//! The right response depends on what the mutex protects:
//!
//! - **Fail-open + log** — for in-memory caches, the workspace list, startup
//!   loads, session collectors, and shutdown/snapshot restore. The guarded
//!   state is either rebuildable (next refresh repopulates it from the DB) or
//!   best-effort (a fire-and-forget persist), and a panic during unwinding
//!   must not abort the process (which would skip the system-proxy restore
//!   `Drop` guard). Recovery is safe *because the data is disposable or
//!   read-only on recovery*; we log so the recovery is diagnosable.
//!
//! - **Fail-closed** — for the `Arc<Mutex<Connection>>` used by IPC command
//!   handlers. A poisoned `rusqlite::Connection` may have a torn statement
//!   cache / transaction state, and reusing it for user-data writes risks
//!   corruption. These paths return a structured `DB_POISONED` IPC error
//!   instead of recovering. See [`lock_db_for_ipc`].
//!
//! Other crates (`proxy-core`, `rule-engine`, `tls-manager`) keep their
//! existing silent `unwrap_or_else(|e| e.into_inner())` convention for their
//! own in-memory managers — see ADR-005 "Scope boundary".

use std::sync::{Mutex, MutexGuard, PoisonError};

use aiproxy_db::rusqlite::Connection;

use crate::commands::common::{app_error, ERR_DB_POISONED};

/// Recover a poisoned [`Mutex`] guard and emit a structured error log.
///
/// Use as the `unwrap_or_else` callback for **fail-open** locks — in-memory
/// caches, the workspace list, startup loaders, session collectors, and
/// shutdown paths. The `category` string identifies the mutex in logs (e.g.
/// `"session_cache.summaries"`, `"workspace_list"`).
///
/// This never panics: it extracts the inner guard via
/// [`PoisonError::into_inner`] and returns it, after logging at `error`
/// level so a later "why is this state inconsistent?" investigation has a
/// trace.
///
/// For DB-connection locks reachable from IPC handlers, use
/// [`lock_db_for_ipc`] (fail-closed) instead.
pub fn recover_guard<'a, T>(
    poison: PoisonError<MutexGuard<'a, T>>,
    category: &'static str,
) -> MutexGuard<'a, T> {
    tracing::error!(
        component = "desktop.concurrency",
        event = "mutex_poison_recovered",
        mutex_category = category,
        "mutex poisoned; recovering guard via into_inner() (fail-open, state is rebuildable)"
    );
    poison.into_inner()
}

/// Acquire the DB connection lock for an IPC command handler (fail-closed on
/// poison). Returns a structured `DB_POISONED` error so the frontend can
/// prompt a restart. A poisoned `Connection` may have torn statement state
/// and must not be reused for user-data writes.
///
/// This is a free function (rather than a method on `AppState`) so command
/// handlers can call it on a pre-cloned `Arc<Mutex<Connection>>` inside a
/// `move` closure — the `MutexGuard` borrows the `Arc`, which the closure
/// owns, rather than borrowing `State<'_>` (which can't be moved).
///
/// See ADR-005 for the policy rationale.
pub fn lock_db_for_ipc(
    db: &std::sync::Arc<Mutex<Connection>>,
) -> Result<MutexGuard<'_, Connection>, String> {
    db.lock().map_err(|_| {
        app_error(
            ERR_DB_POISONED,
            "database is unavailable due to a prior panic; please restart the app",
        )
    })
}

/// Acquire the DB connection lock for a **read-only** best-effort internal
/// path (fail-open + log). Use this from session loaders and startup reads —
/// paths that (a) have no `Result` channel to surface poison as a user-visible
/// error, AND (b) only **read** the DB (a poisoned `Connection` may return
/// garbage rows, but the caller already handles DB errors via `tracing::*`).
///
/// **Do NOT use this for write paths.** A poisoned `Connection` may have torn
/// statement/transaction state, and writing through it risks corrupting user
/// data. Write paths (session persist, deletes, WS insert) must use
/// [`lock_db_best_effort`] and skip the write on poison. `category` identifies
/// the caller in logs (e.g. `"startup_load"`). See ADR-005.
pub fn lock_db_or_recover<'a>(
    db: &'a std::sync::Arc<Mutex<Connection>>,
    category: &'static str,
) -> MutexGuard<'a, Connection> {
    db.lock().unwrap_or_else(|e| recover_guard(e, category))
}

/// Acquire the DB connection lock for a best-effort **write** path. On poison,
/// returns `Err(())` after logging at `error` level — the caller should skip
/// the write (persistence / delete / insert) and let the data be re-persisted
/// or cleaned up after an app restart, rather than writing through a poisoned
/// `Connection` that may have torn statement/transaction state.
///
/// Use this from session persisters, session deleters, and the WS collector —
/// background write paths that have no `Result` channel to the user but must
/// not corrupt data. `category` identifies the caller in logs (e.g.
/// `"session_persistence"`, `"ws_collector"`). See ADR-005.
pub fn lock_db_best_effort<'a>(
    db: &'a std::sync::Arc<Mutex<Connection>>,
    category: &'static str,
) -> Result<MutexGuard<'a, Connection>, ()> {
    match db.lock() {
        Ok(guard) => Ok(guard),
        Err(poison) => {
            tracing::error!(
                component = "desktop.concurrency",
                event = "db_poison_skipped_write",
                mutex_category = category,
                "DB mutex poisoned; skipping write to avoid corrupting user data (restart to recover)"
            );
            // Intentionally do NOT call into_inner() — we discard the guard so
            // the poisoned Connection is not reused for the write.
            drop(poison.into_inner());
            Err(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recover_guard_returns_usable_guard() {
        let m = Mutex::new(42);
        // Simulate poison without spawning a panicking thread: construct a
        // PoisonError by locking, then dropping the guard via the error path.
        let guard = m.lock().unwrap();
        let poison = PoisonError::new(guard);
        let recovered = recover_guard(poison, "test_category");
        assert_eq!(*recovered, 42);
    }

    #[test]
    fn recover_guard_recovers_after_real_panic_poison() {
        // Poison the mutex by panicking while holding it on another thread,
        // then verify recover_guard hands back a usable guard.
        let m = std::sync::Arc::new(Mutex::new(7usize));
        let m_clone = std::sync::Arc::clone(&m);
        let handle = std::thread::spawn(move || {
            let _g = m_clone.lock().unwrap();
            panic!("intentional poison for test");
        });
        handle.join().ok(); // discard the panic

        // Mutex is now poisoned; the direct lock() would return Err(PoisonError).
        let poison = m.lock().unwrap_err();
        let guard = recover_guard(poison, "test_recover_after_panic");
        assert_eq!(*guard, 7);
    }

    #[test]
    fn lock_db_for_ipc_returns_db_poisoned_error_on_poison() {
        // Fail-closed: a poisoned DB-connection mutex must surface a structured
        // DB_POISONED error, not recover.
        let conn = aiproxy_db::rusqlite::Connection::open_in_memory().unwrap();
        let db = std::sync::Arc::new(Mutex::new(conn));
        let db_clone = std::sync::Arc::clone(&db);
        let handle = std::thread::spawn(move || {
            let _g = db_clone.lock().unwrap();
            panic!("intentional poison for test");
        });
        handle.join().ok();

        let err = lock_db_for_ipc(&db).unwrap_err();
        // Error is a JSON string; assert it carries the DB_POISONED code.
        assert!(
            err.contains("DB_POISONED"),
            "expected DB_POISONED in error, got: {err}"
        );
    }

    #[test]
    fn lock_db_for_ipc_succeeds_when_unpoisoned() {
        let conn = aiproxy_db::rusqlite::Connection::open_in_memory().unwrap();
        let db = std::sync::Arc::new(Mutex::new(conn));
        let _guard = lock_db_for_ipc(&db).expect("unpoisoned lock must succeed");
    }

    #[test]
    fn lock_db_best_effort_returns_err_and_skips_on_poison() {
        // Write paths must fail-closed: a poisoned DB must NOT hand back a
        // reusable guard (the caller should skip the write).
        let conn = aiproxy_db::rusqlite::Connection::open_in_memory().unwrap();
        let db = std::sync::Arc::new(Mutex::new(conn));
        let db_clone = std::sync::Arc::clone(&db);
        let handle = std::thread::spawn(move || {
            let _g = db_clone.lock().unwrap();
            panic!("intentional poison for test");
        });
        handle.join().ok();

        let result = lock_db_best_effort(&db, "test_write_skip");
        assert!(result.is_err(), "poisoned DB write must be skipped");
    }

    #[test]
    fn lock_db_best_effort_succeeds_when_unpoisoned() {
        let conn = aiproxy_db::rusqlite::Connection::open_in_memory().unwrap();
        let db = std::sync::Arc::new(Mutex::new(conn));
        let _guard = lock_db_best_effort(&db, "test_write_ok")
            .expect("unpoisoned best-effort lock must succeed");
    }
}

use rusqlite::{Connection, OpenFlags};

use crate::DbError;
use std::path::{Path, PathBuf};

const DB_DIR_NAME: &str = "aiproxy";
const DB_FILE_NAME: &str = "aiproxy.db";

/// Resolve the database directory under the platform app data directory.
pub fn resolve_db_dir() -> Result<PathBuf, DbError> {
    let base = dirs::data_dir().ok_or_else(|| {
        DbError::Connection("failed to resolve platform data directory".to_string())
    })?;
    Ok(base.join(DB_DIR_NAME))
}

/// Resolve the default SQLite database file path.
pub fn resolve_db_path() -> Result<PathBuf, DbError> {
    Ok(resolve_db_dir()?.join(DB_FILE_NAME))
}

/// Open an existing SQLite database without creating files or running
/// migrations. This is the entry point for read-only adapters such as MCP.
pub fn open_read_only_database(db_path: &Path) -> Result<Connection, DbError> {
    if !db_path.is_file() {
        return Err(DbError::Connection(format!(
            "database does not exist at {}",
            db_path.display()
        )));
    }

    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(
        |error| {
            DbError::Connection(format!(
                "failed to open read-only database at {}: {error}",
                db_path.display()
            ))
        },
    )?;

    conn.execute_batch("PRAGMA busy_timeout=5000; PRAGMA query_only=ON;")
        .map_err(|error| DbError::query("configure read-only connection", error))?;

    Ok(conn)
}

/// Tables and columns required by optional read-only features.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SchemaCapabilities {
    pub core_sessions: bool,
    pub body_references: bool,
    pub websocket_messages: bool,
    pub rule_traces: bool,
    pub workspaces: bool,
}

/// Inspect the database schema without mutating it.
pub fn inspect_schema(conn: &Connection) -> Result<SchemaCapabilities, DbError> {
    let core_sessions = table_has_columns(
        conn,
        "session_summaries",
        &[
            "id",
            "method",
            "host",
            "path",
            "protocol",
            "started_at",
            "duration_ms",
            "status_code",
            "url",
        ],
    )? && table_has_columns(
        conn,
        "session_details",
        &[
            "session_summary_id",
            "request_headers",
            "response_headers",
            "request_body_ref",
            "response_body_ref",
        ],
    )?;

    let body_references = core_sessions
        && table_has_columns(
            conn,
            "session_details",
            &["request_body_ref", "response_body_ref"],
        )?;
    let websocket_messages = table_has_columns(
        conn,
        "ws_messages",
        &[
            "id",
            "session_id",
            "direction",
            "timestamp",
            "opcode",
            "payload_text",
        ],
    )?;
    let rule_traces = table_exists(conn, "rewrite_runs")?
        && table_exists(conn, "map_runs")?
        && table_exists(conn, "script_runs")?
        && table_exists(conn, "throttle_runs")?;
    let workspaces = table_has_columns(conn, "workspaces", &["id", "name", "proxy_port"])?;

    Ok(SchemaCapabilities {
        core_sessions,
        body_references,
        websocket_messages,
        rule_traces,
        workspaces,
    })
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool, DbError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [table],
        |row| row.get::<_, i64>(0),
    )
    .map(|value| value != 0)
    .map_err(|error| DbError::query("inspect database table", error))
}

fn table_has_columns(
    conn: &Connection,
    table: &str,
    required_columns: &[&str],
) -> Result<bool, DbError> {
    if !table_exists(conn, table)? {
        return Ok(false);
    }

    let mut statement = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| DbError::query("prepare table info", error))?;
    let columns: Result<Vec<String>, DbError> = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| DbError::query("query table info", error))?
        .map(|row| row.map_err(|error| DbError::query("decode table info", error)))
        .collect();
    let columns = columns?;

    Ok(required_columns
        .iter()
        .all(|required| columns.iter().any(|column| column == required)))
}

/// Open (or create) the SQLite database, enable WAL mode and foreign keys,
/// and run pending migrations.
pub fn open_database() -> Result<Connection, DbError> {
    let db_dir = resolve_db_dir()?;
    std::fs::create_dir_all(&db_dir).map_err(DbError::Io)?;

    let db_path = db_dir.join(DB_FILE_NAME);
    let conn = Connection::open(&db_path).map_err(|e| {
        DbError::Connection(format!(
            "failed to open database at {}: {e}",
            db_path.display()
        ))
    })?;

    conn.execute_batch("PRAGMA journal_mode=WAL;")
        .map_err(|e| DbError::query("failed to enable WAL mode", e))?;
    conn.execute_batch("PRAGMA foreign_keys=ON;")
        .map_err(|e| DbError::query("failed to enable foreign keys", e))?;
    // Wait up to 5s for a write lock instead of failing immediately with
    // SQLITE_BUSY. Single-process today (one Mutex-guarded connection), but this
    // defends against multi-process access (two app instances) and any future
    // connection pool (L22).
    conn.execute_batch("PRAGMA busy_timeout=5000;")
        .map_err(|e| DbError::query("failed to set busy_timeout", e))?;

    crate::schema::run_migrations(&conn)?;

    Ok(conn)
}

/// Open an in-memory database for testing, with migrations applied.
pub fn open_in_memory() -> Result<Connection, DbError> {
    let conn = Connection::open_in_memory()
        .map_err(|e| DbError::query("failed to open in-memory database", e))?;
    conn.execute_batch("PRAGMA foreign_keys=ON;")
        .map_err(|e| DbError::query("failed to enable foreign keys", e))?;
    crate::schema::run_migrations(&conn)?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("aiproxy_connection_{name}_{unique}.db"))
    }

    #[test]
    fn read_only_open_does_not_create_missing_database() {
        let path = temp_path("missing");
        let error = open_read_only_database(&path).unwrap_err();
        assert!(matches!(error, DbError::Connection(_)));
        assert!(!path.exists());
    }

    #[test]
    fn read_only_open_detects_schema_and_rejects_writes() {
        let path = temp_path("readonly");
        let connection = Connection::open(&path).unwrap();
        crate::schema::run_migrations(&connection).unwrap();
        drop(connection);

        let readonly = open_read_only_database(&path).unwrap();
        let capabilities = inspect_schema(&readonly).unwrap();
        assert!(capabilities.core_sessions);
        assert!(inspect_schema(&readonly).unwrap().body_references);
        assert!(readonly
            .execute("DELETE FROM session_summaries", [])
            .is_err());
        let _ = std::fs::remove_file(path);
    }
}

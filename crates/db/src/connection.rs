use rusqlite::Connection;

use crate::DbError;
use std::path::PathBuf;

const DB_DIR_NAME: &str = "aiproxy";
const DB_FILE_NAME: &str = "aiproxy.db";

/// Resolve the database directory under the platform app data directory.
pub fn resolve_db_dir() -> Result<PathBuf, DbError> {
    let base =
        dirs::data_dir().ok_or_else(|| DbError::Connection("failed to resolve platform data directory".to_string()))?;
    Ok(base.join(DB_DIR_NAME))
}

/// Open (or create) the SQLite database, enable WAL mode and foreign keys,
/// and run pending migrations.
pub fn open_database() -> Result<Connection, DbError> {
    let db_dir = resolve_db_dir()?;
    std::fs::create_dir_all(&db_dir)
        .map_err(DbError::Io)?;

    let db_path = db_dir.join(DB_FILE_NAME);
    let conn = Connection::open(&db_path)
        .map_err(|e| DbError::Connection(format!("failed to open database at {}: {e}", db_path.display())))?;

    conn.execute_batch("PRAGMA journal_mode=WAL;")
        .map_err(|e| DbError::query("failed to enable WAL mode", e))?;
    conn.execute_batch("PRAGMA foreign_keys=ON;")
        .map_err(|e| DbError::query("failed to enable foreign keys", e))?;

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

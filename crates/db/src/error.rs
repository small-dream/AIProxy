/// Structured error type for the `aiproxy-db` crate.
///
/// All public DB functions are being migrated from `Result<_, String>` to
/// `Result<_, DbError>`.  The Tauri command boundary must explicitly convert
/// `DbError` via `app_error(ERR_INTERNAL, ...)` — never rely on a blanket
/// `From<DbError> for String` impl, which would lose the structured error code.
#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("database connection failed: {0}")]
    Connection(String),

    #[error("{context}: {source}")]
    QueryFailed {
        context: String,
        #[source]
        source: rusqlite::Error,
    },

    #[error("{entity} not found: {id}")]
    NotFound { entity: String, id: String },

    #[error("constraint violation: {0}")]
    ConstraintViolation(String),

    #[error("migration failed: {0}")]
    MigrationFailed(String),

    #[error("validation error: {0}")]
    Validation(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

/// Convenience constructor for the most common variant.
///
/// ```
/// use aiproxy_db::DbError;
/// let err = DbError::query("load_session", rusqlite::Error::InvalidColumnIndex(0));
/// ```
impl DbError {
    pub fn query(context: &str, source: rusqlite::Error) -> Self {
        Self::QueryFailed {
            context: context.to_string(),
            source,
        }
    }

    pub fn not_found(entity: &str, id: &str) -> Self {
        Self::NotFound {
            entity: entity.to_string(),
            id: id.to_string(),
        }
    }
}

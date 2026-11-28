use rusqlite::{Connection, OptionalExtension};

use crate::DbError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletionWatermark {
    database_id: String,
    sequence: i64,
}

impl CompletionWatermark {
    pub fn sequence(&self) -> i64 {
        self.sequence
    }

    pub fn at(&self, sequence: i64) -> Self {
        Self {
            database_id: self.database_id.clone(),
            sequence,
        }
    }

    pub fn encode(&self) -> String {
        format!("w2:{}:{}", self.database_id, self.sequence)
    }

    pub fn validate_against(&self, latest: &Self) -> Result<(), DbError> {
        if self.database_id != latest.database_id {
            return Err(DbError::Validation(
                "Session cursor belongs to another database.".into(),
            ));
        }
        if self.sequence > latest.sequence {
            return Err(DbError::Validation(
                "Session cursor is ahead of this database's completion history.".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompletionCursor {
    Legacy,
    Current(CompletionWatermark),
}

impl CompletionCursor {
    pub fn parse(token: &str) -> Result<Self, DbError> {
        let token = token.trim();
        let invalid = || {
            DbError::Validation(
            "afterWatermark must be a valid AIProxy watermark (w1:<rowid> or w2:<databaseId>:<completionSeq>).".into(),
        )
        };
        if let Some(value) = token.strip_prefix("w1:") {
            parse_sequence(value).ok_or_else(invalid)?;
            return Ok(Self::Legacy);
        }
        let (database_id, sequence) = token
            .strip_prefix("w2:")
            .and_then(|value| value.split_once(':'))
            .ok_or_else(invalid)?;
        if database_id.len() != 32 || !database_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(invalid());
        }
        Ok(Self::Current(CompletionWatermark {
            database_id: database_id.to_ascii_lowercase(),
            sequence: parse_sequence(sequence).ok_or_else(invalid)?,
        }))
    }

    pub fn resolve(self, latest: &CompletionWatermark) -> Result<CompletionWatermark, DbError> {
        match self {
            // A rowid watermark cannot establish which earlier requests
            // had finished. Replay retained matches using the new ordering.
            Self::Legacy => Ok(latest.at(0)),
            Self::Current(watermark) => {
                watermark.validate_against(latest)?;
                Ok(watermark)
            }
        }
    }
}

fn parse_sequence(value: &str) -> Option<i64> {
    value.parse::<i64>().ok().filter(|sequence| *sequence >= 0)
}

pub(crate) fn completion_schema_available(conn: &Connection) -> Result<bool, DbError> {
    conn.query_row(
        "SELECT count(*) = 2 FROM sqlite_master WHERE type = 'table'
         AND name IN ('session_completions', 'session_completion_identity')",
        [],
        |row| row.get(0),
    )
    .map_err(|error| DbError::query("detect session completion schema", error))
}

/// Read the latest committed sequence, including IDs assigned to deleted
/// sessions. Clearing sessions must not make a valid watermark move backwards.
pub fn read_completion_watermark(
    conn: &Connection,
) -> Result<Option<CompletionWatermark>, DbError> {
    if !completion_schema_available(conn)? {
        return Ok(None);
    }
    conn.query_row(
        "SELECT database_id, COALESCE((SELECT seq FROM sqlite_sequence WHERE name='session_completions'), 0)
         FROM session_completion_identity WHERE singleton=1",
        [],
        |row| Ok(CompletionWatermark { database_id: row.get(0)?, sequence: row.get(1)? }),
    )
    .optional()
    .map_err(|error| DbError::query("read session completion watermark", error))
}

pub(crate) fn migrate_session_completions(conn: &Connection) -> Result<(), DbError> {
    let migrate_error =
        |error| DbError::MigrationFailed(format!("migrate session completions: {error}"));
    let tx = conn.unchecked_transaction().map_err(migrate_error)?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS session_completion_identity (
            singleton   INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
            database_id TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS session_completions (
            sequence   INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL UNIQUE REFERENCES session_summaries(id) ON DELETE CASCADE
        );",
    )
    .map_err(migrate_error)?;
    let initialized = tx
        .execute(
            "INSERT OR IGNORE INTO session_completion_identity (singleton, database_id)
         VALUES (1, lower(hex(randomblob(16))))",
            [],
        )
        .map_err(migrate_error)?;
    if initialized == 1 {
        tx.execute(
            "INSERT INTO session_completions (session_id)
             SELECT id FROM session_summaries
             WHERE finished_at <> '' AND (status_code <> 0 OR failure_kind IS NOT NULL)
             ORDER BY julianday(finished_at), finished_at, id",
            [],
        )
        .map_err(migrate_error)?;
    }
    // Triggers are part of the writer transaction, including summary/detail
    // upserts. Retried or enriched snapshots keep their first sequence.
    tx.execute_batch(
        "CREATE TRIGGER IF NOT EXISTS session_completion_after_insert
         AFTER INSERT ON session_summaries
         WHEN NEW.finished_at <> '' AND (NEW.status_code <> 0 OR NEW.failure_kind IS NOT NULL)
         BEGIN
            INSERT INTO session_completions (session_id) VALUES (NEW.id);
         END;
         CREATE TRIGGER IF NOT EXISTS session_completion_after_update
         AFTER UPDATE OF finished_at, status_code, failure_kind ON session_summaries
         WHEN NEW.finished_at <> '' AND (NEW.status_code <> 0 OR NEW.failure_kind IS NOT NULL)
              AND NOT EXISTS (SELECT 1 FROM session_completions WHERE session_id = NEW.id)
         BEGIN
            INSERT INTO session_completions (session_id) VALUES (NEW.id);
         END;",
    )
    .map_err(migrate_error)?;
    tx.commit().map_err(migrate_error)?;
    Ok(())
}

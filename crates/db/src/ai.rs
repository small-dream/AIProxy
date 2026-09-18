use rusqlite::{params, Connection};

use crate::DbError;

pub const AI_SETTINGS_ID: &str = "default";

#[derive(Debug, Clone, PartialEq)]
pub struct AiSettingsRow {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
    pub temperature: f64,
    pub timeout_ms: u64,
    pub updated_at: String,
}

pub fn load_ai_settings(conn: &Connection) -> Result<Option<AiSettingsRow>, DbError> {
    let result = conn.query_row(
        "SELECT provider, base_url, model, api_key, temperature, timeout_ms, updated_at
         FROM ai_settings WHERE id = ?1",
        params![AI_SETTINGS_ID],
        row_to_ai_settings,
    );

    match result {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(DbError::query("load ai settings", error)),
    }
}

/// Save (insert or update) the AI settings singleton row.
///
/// Uses UPDATE-or-INSERT rather than INSERT OR REPLACE (mirrors the other
/// save_* paths): a REPLACE's implicit DELETE is a maintenance trap for any
/// future child table referencing ai_settings with ON DELETE CASCADE.
pub fn upsert_ai_settings(conn: &Connection, settings: &AiSettingsRow) -> Result<(), DbError> {
    let affected = conn
        .execute(
            "UPDATE ai_settings
                SET provider=?2, base_url=?3, model=?4, api_key=?5,
                    temperature=?6, timeout_ms=?7, updated_at=?8
             WHERE id=?1",
            params![
                AI_SETTINGS_ID,
                settings.provider,
                settings.base_url,
                settings.model,
                settings.api_key,
                settings.temperature,
                settings.timeout_ms as i64,
                settings.updated_at,
            ],
        )
        .map_err(|error| DbError::query("update ai settings", error))?;

    if affected == 0 {
        conn.execute(
            "INSERT INTO ai_settings
                (id, provider, base_url, model, api_key, temperature, timeout_ms, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                AI_SETTINGS_ID,
                settings.provider,
                settings.base_url,
                settings.model,
                settings.api_key,
                settings.temperature,
                settings.timeout_ms as i64,
                settings.updated_at,
            ],
        )
        .map_err(|error| DbError::query("insert ai settings", error))?;
    }

    Ok(())
}

fn row_to_ai_settings(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiSettingsRow> {
    let timeout_ms = row.get::<_, i64>("timeout_ms")?;

    Ok(AiSettingsRow {
        provider: row.get("provider")?,
        base_url: row.get("base_url")?,
        model: row.get("model")?,
        api_key: row.get("api_key")?,
        temperature: row.get("temperature")?,
        timeout_ms: timeout_ms.max(0) as u64,
        updated_at: row.get("updated_at")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::run_migrations(&conn).unwrap();
        conn
    }

    #[test]
    fn ai_settings_round_trip() {
        let conn = test_conn();
        assert!(load_ai_settings(&conn).unwrap().is_none());

        let row = AiSettingsRow {
            provider: "openai-compatible".into(),
            base_url: "https://api.openai.com/v1".into(),
            model: "gpt-4.1-mini".into(),
            api_key: "sk-test".into(),
            temperature: 0.2,
            timeout_ms: 30_000,
            updated_at: "2026-05-14T00:00:00Z".into(),
        };

        upsert_ai_settings(&conn, &row).unwrap();
        assert_eq!(load_ai_settings(&conn).unwrap(), Some(row));
    }

    // Re-saving must update the singleton row in place (UPDATE-or-INSERT),
    // never insert a second row.
    #[test]
    fn upsert_ai_settings_updates_singleton_in_place() {
        let conn = test_conn();
        let row = AiSettingsRow {
            provider: "openai-compatible".into(),
            base_url: "https://api.openai.com/v1".into(),
            model: "gpt-4.1-mini".into(),
            api_key: "sk-test".into(),
            temperature: 0.2,
            timeout_ms: 30_000,
            updated_at: "2026-05-14T00:00:00Z".into(),
        };
        upsert_ai_settings(&conn, &row).unwrap();

        let mut updated = row.clone();
        updated.model = "gpt-5".into();
        updated.updated_at = "2026-05-15T00:00:00Z".into();
        upsert_ai_settings(&conn, &updated).unwrap();

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM ai_settings", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "re-save must not duplicate the settings row");
        assert_eq!(load_ai_settings(&conn).unwrap(), Some(updated));
    }
}

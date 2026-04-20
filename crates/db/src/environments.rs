use rusqlite::{params, Connection};

// ---------------------------------------------------------------------------
// Environment row
// ---------------------------------------------------------------------------

pub struct EnvironmentRow {
    pub id: String,
    pub name: String,
    pub sort_order: u32,
    pub created_at: String,
    pub updated_at: String,
}

// ---------------------------------------------------------------------------
// Environment variable row
// ---------------------------------------------------------------------------

pub struct EnvironmentVariableRow {
    pub id: String,
    pub environment_id: String,
    pub key: String,
    pub value: String,
    pub enabled: bool,
    pub sort_order: u32,
}

// ---------------------------------------------------------------------------
// Environment CRUD
// ---------------------------------------------------------------------------

pub fn upsert_environment(conn: &Connection, env: &EnvironmentRow) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO api_environments
            (id, name, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            env.id, env.name, env.sort_order as i32,
            env.created_at, env.updated_at,
        ],
    )
    .map_err(|e| format!("upsert environment: {e}"))?;
    Ok(())
}

pub fn list_environments(conn: &Connection) -> Result<Vec<EnvironmentRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, sort_order, created_at, updated_at
             FROM api_environments ORDER BY sort_order, name",
        )
        .map_err(|e| format!("prepare list environments: {e}"))?;

    let rows = stmt
        .query_map([], row_to_environment)
        .map_err(|e| format!("query environments: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

pub fn delete_environment(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM api_environments WHERE id=?1", params![id])
        .map_err(|e| format!("delete environment: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Environment variable CRUD
// ---------------------------------------------------------------------------

pub fn upsert_environment_variable(conn: &Connection, v: &EnvironmentVariableRow) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO api_environment_variables
            (id, environment_id, key, value, enabled, sort_order)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            v.id, v.environment_id, v.key, v.value,
            v.enabled as i32, v.sort_order as i32,
        ],
    )
    .map_err(|e| format!("upsert environment variable: {e}"))?;
    Ok(())
}

pub fn list_environment_variables(
    conn: &Connection,
    environment_id: &str,
) -> Result<Vec<EnvironmentVariableRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, environment_id, key, value, enabled, sort_order
             FROM api_environment_variables
             WHERE environment_id=?1
             ORDER BY sort_order, key",
        )
        .map_err(|e| format!("prepare list env vars: {e}"))?;

    let rows = stmt
        .query_map(params![environment_id], row_to_env_variable)
        .map_err(|e| format!("query env vars: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

/// Replace all variables for an environment atomically.
pub fn set_environment_variables(
    conn: &Connection,
    environment_id: &str,
    vars: &[EnvironmentVariableRow],
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM api_environment_variables WHERE environment_id=?1",
        params![environment_id],
    )
    .map_err(|e| format!("clear env vars: {e}"))?;

    for v in vars {
        upsert_environment_variable(conn, v)?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

fn row_to_environment(row: &rusqlite::Row<'_>) -> rusqlite::Result<EnvironmentRow> {
    Ok(EnvironmentRow {
        id: row.get("id")?,
        name: row.get("name")?,
        sort_order: row.get::<_, i32>("sort_order")? as u32,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_env_variable(row: &rusqlite::Row<'_>) -> rusqlite::Result<EnvironmentVariableRow> {
    Ok(EnvironmentVariableRow {
        id: row.get("id")?,
        environment_id: row.get("environment_id")?,
        key: row.get("key")?,
        value: row.get("value")?,
        enabled: row.get::<_, i32>("enabled")? != 0,
        sort_order: row.get::<_, i32>("sort_order")? as u32,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::run_migrations(&conn).unwrap();
        conn
    }

    fn now() -> String {
        "2026-04-20T00:00:00Z".into()
    }

    #[test]
    fn environment_round_trip() {
        let conn = test_conn();

        let env = EnvironmentRow {
            id: "env1".into(),
            name: "Development".into(),
            sort_order: 0,
            created_at: now(),
            updated_at: now(),
        };
        upsert_environment(&conn, &env).unwrap();

        let loaded = list_environments(&conn).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "Development");

        delete_environment(&conn, "env1").unwrap();
        assert!(list_environments(&conn).unwrap().is_empty());
    }

    #[test]
    fn environment_variable_round_trip() {
        let conn = test_conn();

        let env = EnvironmentRow {
            id: "env1".into(), name: "Dev".into(), sort_order: 0,
            created_at: now(), updated_at: now(),
        };
        upsert_environment(&conn, &env).unwrap();

        let v1 = EnvironmentVariableRow {
            id: "v1".into(), environment_id: "env1".into(),
            key: "baseUrl".into(), value: "https://dev.api.com".into(),
            enabled: true, sort_order: 0,
        };
        let v2 = EnvironmentVariableRow {
            id: "v2".into(), environment_id: "env1".into(),
            key: "token".into(), value: "dev-token-123".into(),
            enabled: true, sort_order: 1,
        };
        upsert_environment_variable(&conn, &v1).unwrap();
        upsert_environment_variable(&conn, &v2).unwrap();

        let vars = list_environment_variables(&conn, "env1").unwrap();
        assert_eq!(vars.len(), 2);
        assert_eq!(vars[0].key, "baseUrl");
        assert_eq!(vars[1].value, "dev-token-123");
    }

    #[test]
    fn set_variables_replaces_all() {
        let conn = test_conn();

        let env = EnvironmentRow {
            id: "env1".into(), name: "Staging".into(), sort_order: 0,
            created_at: now(), updated_at: now(),
        };
        upsert_environment(&conn, &env).unwrap();

        let v1 = EnvironmentVariableRow {
            id: "v1".into(), environment_id: "env1".into(),
            key: "old".into(), value: "old-val".into(),
            enabled: true, sort_order: 0,
        };
        upsert_environment_variable(&conn, &v1).unwrap();

        let new_vars = vec![
            EnvironmentVariableRow {
                id: "v2".into(), environment_id: "env1".into(),
                key: "baseUrl".into(), value: "https://staging.api.com".into(),
                enabled: true, sort_order: 0,
            },
            EnvironmentVariableRow {
                id: "v3".into(), environment_id: "env1".into(),
                key: "apiKey".into(), value: "staging-key".into(),
                enabled: false, sort_order: 1,
            },
        ];
        set_environment_variables(&conn, "env1", &new_vars).unwrap();

        let vars = list_environment_variables(&conn, "env1").unwrap();
        assert_eq!(vars.len(), 2);
        assert_eq!(vars[0].key, "baseUrl");
        assert!(!vars[1].enabled);
    }

    #[test]
    fn delete_environment_cascades_variables() {
        let conn = test_conn();

        let env = EnvironmentRow {
            id: "env1".into(), name: "Temp".into(), sort_order: 0,
            created_at: now(), updated_at: now(),
        };
        upsert_environment(&conn, &env).unwrap();

        let v = EnvironmentVariableRow {
            id: "v1".into(), environment_id: "env1".into(),
            key: "k".into(), value: "v".into(),
            enabled: true, sort_order: 0,
        };
        upsert_environment_variable(&conn, &v).unwrap();

        delete_environment(&conn, "env1").unwrap();
        let vars = list_environment_variables(&conn, "env1").unwrap();
        assert!(vars.is_empty());
    }
}

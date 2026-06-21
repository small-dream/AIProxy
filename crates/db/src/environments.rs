use rusqlite::{params, Connection};

use crate::DbError;

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
// Global variable row
// ---------------------------------------------------------------------------

pub struct GlobalVariableRow {
    pub id: String,
    pub key: String,
    pub value: String,
    pub enabled: bool,
    pub sort_order: u32,
}

// ---------------------------------------------------------------------------
// Environment CRUD
// ---------------------------------------------------------------------------

pub fn upsert_environment(conn: &Connection, env: &EnvironmentRow) -> Result<(), DbError> {
    // UPDATE-or-INSERT instead of INSERT OR REPLACE: a REPLACE on api_environments
    // triggers ON DELETE CASCADE on api_environment_variables (foreign_keys=ON),
    // silently wiping all variables in the environment on every re-save.
    let affected = conn
        .execute(
            "UPDATE api_environments
                SET name=?2, sort_order=?3, created_at=?4, updated_at=?5
             WHERE id=?1",
            params![
                env.id,
                env.name,
                env.sort_order as i32,
                env.created_at,
                env.updated_at
            ],
        )
        .map_err(|e| DbError::query("update environment", e))?;

    if affected == 0 {
        conn.execute(
            "INSERT INTO api_environments
                (id, name, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                env.id,
                env.name,
                env.sort_order as i32,
                env.created_at,
                env.updated_at
            ],
        )
        .map_err(|e| DbError::query("insert environment", e))?;
    }
    Ok(())
}

pub fn list_environments(conn: &Connection) -> Result<Vec<EnvironmentRow>, DbError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, sort_order, created_at, updated_at
             FROM api_environments ORDER BY sort_order, name",
        )
        .map_err(|e| DbError::query("prepare list environments", e))?;

    let rows: Result<Vec<EnvironmentRow>, DbError> = stmt
        .query_map([], row_to_environment)
        .map_err(|e| DbError::query("query environments", e))?
        .map(|r| r.map_err(|e| DbError::query("decode environment row", e)))
        .collect();

    Ok(rows?)
}

pub fn delete_environment(conn: &Connection, id: &str) -> Result<(), DbError> {
    conn.execute("DELETE FROM api_environments WHERE id=?1", params![id])
        .map_err(|e| DbError::query("delete environment", e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Environment variable CRUD
// ---------------------------------------------------------------------------

pub fn upsert_environment_variable(
    conn: &Connection,
    v: &EnvironmentVariableRow,
) -> Result<(), DbError> {
    conn.execute(
        "INSERT OR REPLACE INTO api_environment_variables
            (id, environment_id, key, value, enabled, sort_order)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            v.id,
            v.environment_id,
            v.key,
            v.value,
            v.enabled as i32,
            v.sort_order as i32,
        ],
    )
    .map_err(|e| DbError::query("upsert environment variable", e))?;
    Ok(())
}

pub fn list_environment_variables(
    conn: &Connection,
    environment_id: &str,
) -> Result<Vec<EnvironmentVariableRow>, DbError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, environment_id, key, value, enabled, sort_order
             FROM api_environment_variables
             WHERE environment_id=?1
             ORDER BY sort_order, key",
        )
        .map_err(|e| DbError::query("prepare list env vars", e))?;

    let rows: Result<Vec<EnvironmentVariableRow>, DbError> = stmt
        .query_map(params![environment_id], row_to_env_variable)
        .map_err(|e| DbError::query("query env vars", e))?
        .map(|r| r.map_err(|e| DbError::query("decode environment variable row", e)))
        .collect();

    Ok(rows?)
}

/// Replace all variables for an environment atomically.
pub fn set_environment_variables(
    conn: &Connection,
    environment_id: &str,
    vars: &[EnvironmentVariableRow],
) -> Result<(), DbError> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| DbError::query("begin set environment variables transaction", e))?;

    tx.execute(
        "DELETE FROM api_environment_variables WHERE environment_id=?1",
        params![environment_id],
    )
    .map_err(|e| DbError::query("clear env vars", e))?;

    for v in vars {
        upsert_environment_variable(&tx, v)?;
    }

    tx.commit()
        .map_err(|e| DbError::query("commit set environment variables transaction", e))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Global variable CRUD
// ---------------------------------------------------------------------------

pub fn upsert_global_variable(conn: &Connection, v: &GlobalVariableRow) -> Result<(), DbError> {
    conn.execute(
        "INSERT OR REPLACE INTO api_global_variables
            (id, key, value, enabled, sort_order)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![v.id, v.key, v.value, v.enabled as i32, v.sort_order as i32,],
    )
    .map_err(|e| DbError::query("upsert global variable", e))?;
    Ok(())
}

pub fn list_global_variables(conn: &Connection) -> Result<Vec<GlobalVariableRow>, DbError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, key, value, enabled, sort_order
             FROM api_global_variables
             ORDER BY sort_order, key",
        )
        .map_err(|e| DbError::query("prepare list global variables", e))?;

    let rows: Result<Vec<GlobalVariableRow>, DbError> = stmt
        .query_map([], row_to_global_variable)
        .map_err(|e| DbError::query("query global variables", e))?
        .map(|r| r.map_err(|e| DbError::query("decode environment variable row", e)))
        .collect();

    Ok(rows?)
}

pub fn set_global_variables(conn: &Connection, vars: &[GlobalVariableRow]) -> Result<(), DbError> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| DbError::query("begin set global variables transaction", e))?;

    tx.execute("DELETE FROM api_global_variables", [])
        .map_err(|e| DbError::query("clear global vars", e))?;

    for v in vars {
        upsert_global_variable(&tx, v)?;
    }

    tx.commit()
        .map_err(|e| DbError::query("commit set global variables transaction", e))?;

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

fn row_to_global_variable(row: &rusqlite::Row<'_>) -> rusqlite::Result<GlobalVariableRow> {
    Ok(GlobalVariableRow {
        id: row.get("id")?,
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
            id: "env1".into(),
            name: "Dev".into(),
            sort_order: 0,
            created_at: now(),
            updated_at: now(),
        };
        upsert_environment(&conn, &env).unwrap();

        let v1 = EnvironmentVariableRow {
            id: "v1".into(),
            environment_id: "env1".into(),
            key: "baseUrl".into(),
            value: "https://dev.api.com".into(),
            enabled: true,
            sort_order: 0,
        };
        let v2 = EnvironmentVariableRow {
            id: "v2".into(),
            environment_id: "env1".into(),
            key: "token".into(),
            value: "dev-token-123".into(),
            enabled: true,
            sort_order: 1,
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
            id: "env1".into(),
            name: "Staging".into(),
            sort_order: 0,
            created_at: now(),
            updated_at: now(),
        };
        upsert_environment(&conn, &env).unwrap();

        let v1 = EnvironmentVariableRow {
            id: "v1".into(),
            environment_id: "env1".into(),
            key: "old".into(),
            value: "old-val".into(),
            enabled: true,
            sort_order: 0,
        };
        upsert_environment_variable(&conn, &v1).unwrap();

        let new_vars = vec![
            EnvironmentVariableRow {
                id: "v2".into(),
                environment_id: "env1".into(),
                key: "baseUrl".into(),
                value: "https://staging.api.com".into(),
                enabled: true,
                sort_order: 0,
            },
            EnvironmentVariableRow {
                id: "v3".into(),
                environment_id: "env1".into(),
                key: "apiKey".into(),
                value: "staging-key".into(),
                enabled: false,
                sort_order: 1,
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
            id: "env1".into(),
            name: "Temp".into(),
            sort_order: 0,
            created_at: now(),
            updated_at: now(),
        };
        upsert_environment(&conn, &env).unwrap();

        let v = EnvironmentVariableRow {
            id: "v1".into(),
            environment_id: "env1".into(),
            key: "k".into(),
            value: "v".into(),
            enabled: true,
            sort_order: 0,
        };
        upsert_environment_variable(&conn, &v).unwrap();

        delete_environment(&conn, "env1").unwrap();
        let vars = list_environment_variables(&conn, "env1").unwrap();
        assert!(vars.is_empty());
    }

    #[test]
    fn global_variable_round_trip() {
        let conn = test_conn();

        let v1 = GlobalVariableRow {
            id: "gv1".into(),
            key: "token".into(),
            value: "global-token".into(),
            enabled: true,
            sort_order: 0,
        };
        let v2 = GlobalVariableRow {
            id: "gv2".into(),
            key: "apiKey".into(),
            value: "global-key".into(),
            enabled: false,
            sort_order: 1,
        };
        upsert_global_variable(&conn, &v1).unwrap();
        upsert_global_variable(&conn, &v2).unwrap();

        let vars = list_global_variables(&conn).unwrap();
        assert_eq!(vars.len(), 2);
        assert_eq!(vars[0].key, "token");
        assert_eq!(vars[0].value, "global-token");
        assert!(vars[0].enabled);
        assert_eq!(vars[1].key, "apiKey");
        assert_eq!(vars[1].value, "global-key");
        assert!(!vars[1].enabled);
    }

    #[test]
    fn set_global_variables_replaces_all() {
        let conn = test_conn();

        let old = GlobalVariableRow {
            id: "gv1".into(),
            key: "old".into(),
            value: "old-val".into(),
            enabled: true,
            sort_order: 0,
        };
        upsert_global_variable(&conn, &old).unwrap();

        let new_vars = vec![GlobalVariableRow {
            id: "gv2".into(),
            key: "token".into(),
            value: "new-token".into(),
            enabled: true,
            sort_order: 0,
        }];
        set_global_variables(&conn, &new_vars).unwrap();

        let vars = list_global_variables(&conn).unwrap();
        assert_eq!(vars.len(), 1);
        assert_eq!(vars[0].key, "token");
    }
}

/// Regression tests for list-query error propagation (P3 #34).
///
/// These tests verify that DB-backed list functions return `Err` when the
/// underlying table is missing (unmigrated DB), not `Ok(vec![])`. This
/// guarantees the command layer's `.map_err(|e| app_error(...))` path is
/// exercised and the frontend can distinguish "no data" from "query failed".
#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    /// Create an in-memory connection WITHOUT running migrations.
    /// All tables are missing, so any query should return Err.
    fn unmigrated_connection() -> Connection {
        Connection::open_in_memory().expect("in-memory SQLite should always open")
    }

    #[test]
    fn list_all_collections_returns_err_when_table_missing() {
        let conn = unmigrated_connection();
        let result = crate::collections::list_all_collections(&conn);
        match result {
            Ok(items) => panic!(
                "list_all_collections should return Err when table missing, got Ok with {} items",
                items.len()
            ),
            Err(msg) => assert!(
                !msg.to_string().is_empty(),
                "error message should be non-empty and descriptive"
            ),
        }
    }

    #[test]
    fn list_environments_returns_err_when_table_missing() {
        let conn = unmigrated_connection();
        let result = crate::environments::list_environments(&conn);
        match result {
            Ok(items) => panic!(
                "list_environments should return Err when table missing, got Ok with {} items",
                items.len()
            ),
            Err(msg) => assert!(!msg.to_string().is_empty()),
        }
    }

    #[test]
    fn load_all_workspaces_returns_err_when_table_missing() {
        let conn = unmigrated_connection();
        let result = crate::workspaces::load_all_workspaces(&conn);
        match result {
            Ok(items) => panic!(
                "load_all_workspaces should return Err when table missing, got Ok with {} items",
                items.len()
            ),
            Err(msg) => assert!(!msg.to_string().is_empty()),
        }
    }

    #[test]
    fn load_all_rewrite_rules_returns_err_when_table_missing() {
        let conn = unmigrated_connection();
        let result = crate::rules::load_all_rewrite_rules(&conn);
        match result {
            Ok(items) => panic!(
                "load_all_rewrite_rules should return Err when table missing, got Ok with {} items",
                items.len()
            ),
            Err(msg) => assert!(!msg.to_string().is_empty()),
        }
    }

    /// Verify the happy path: with a properly migrated DB, list functions
    /// return Ok(empty vec), not Err.
    #[test]
    fn migrated_db_returns_ok_empty_vec() {
        let conn =
            crate::connection::open_in_memory().expect("in-memory DB with migrations should work");
        let result = crate::collections::list_all_collections(&conn);
        assert!(
            result.is_ok(),
            "list_all_collections on a migrated DB should return Ok"
        );
        assert_eq!(
            result.unwrap().len(),
            0,
            "freshly migrated DB should have zero collections"
        );
    }
}

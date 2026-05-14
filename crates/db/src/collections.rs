use rusqlite::{params, Connection};
use std::collections::HashSet;

// ---------------------------------------------------------------------------
// Collection row (collection or folder)
// ---------------------------------------------------------------------------

pub struct CollectionRow {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub description: String,
    pub sort_order: u32,
    pub created_at: String,
    pub updated_at: String,
}

// ---------------------------------------------------------------------------
// Collection item row (saved request)
// ---------------------------------------------------------------------------

pub struct CollectionItemRow {
    pub id: String,
    pub collection_id: String,
    pub name: String,
    pub description: String,
    pub sort_order: u32,
    pub method: String,
    pub url: String,
    pub headers: String,
    pub body: String,
    pub body_type: String,
    pub raw_language: String,
    pub form_data: String,
    pub url_encoded: String,
    pub created_at: String,
    pub updated_at: String,
}

// ---------------------------------------------------------------------------
// Collection CRUD
// ---------------------------------------------------------------------------

pub fn upsert_collection(conn: &Connection, c: &CollectionRow) -> Result<(), String> {
    if let Some(parent_id) = c.parent_id.as_deref() {
        ensure_collection_exists(conn, parent_id, "target parent")?;
    }
    if would_create_cycle(conn, &c.id, c.parent_id.as_deref())? {
        return Err("cannot move a folder into its own descendant".to_string());
    }

    conn.execute(
        "INSERT OR REPLACE INTO api_collections
            (id, parent_id, name, description, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            c.id,
            c.parent_id,
            c.name,
            c.description,
            c.sort_order as i32,
            c.created_at,
            c.updated_at,
        ],
    )
    .map_err(|e| format!("upsert collection: {e}"))?;
    Ok(())
}

pub fn list_all_collections(conn: &Connection) -> Result<Vec<CollectionRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, parent_id, name, description, sort_order, created_at, updated_at
             FROM api_collections ORDER BY sort_order, name",
        )
        .map_err(|e| format!("prepare list collections: {e}"))?;

    let rows = stmt
        .query_map([], row_to_collection)
        .map_err(|e| format!("query collections: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

pub fn list_collections_by_parent(
    conn: &Connection,
    parent_id: Option<&str>,
) -> Result<Vec<CollectionRow>, String> {
    let rows = match parent_id {
        Some(pid) => {
            let mut stmt = conn
                .prepare(
                    "SELECT id, parent_id, name, description, sort_order, created_at, updated_at
                     FROM api_collections WHERE parent_id=?1 ORDER BY sort_order, name",
                )
                .map_err(|e| format!("prepare list collections by parent: {e}"))?;
            let rows: Vec<CollectionRow> = stmt
                .query_map(params![pid], row_to_collection)
                .map_err(|e| format!("query collections by parent: {e}"))?
                .filter_map(|r| r.ok())
                .collect();
            rows
        }
        None => {
            let mut stmt = conn
                .prepare(
                    "SELECT id, parent_id, name, description, sort_order, created_at, updated_at
                     FROM api_collections WHERE parent_id IS NULL ORDER BY sort_order, name",
                )
                .map_err(|e| format!("prepare list root collections: {e}"))?;
            let rows: Vec<CollectionRow> = stmt
                .query_map([], row_to_collection)
                .map_err(|e| format!("query root collections: {e}"))?
                .filter_map(|r| r.ok())
                .collect();
            rows
        }
    };

    Ok(rows)
}

pub fn delete_collection(conn: &Connection, id: &str) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("begin delete collection transaction: {e}"))?;
    delete_collection_tree(&tx, id)?;
    tx.commit()
        .map_err(|e| format!("commit delete collection transaction: {e}"))?;
    Ok(())
}

fn delete_collection_tree(conn: &Connection, id: &str) -> Result<(), String> {
    let mut visited = HashSet::new();
    let mut stack = vec![id.to_string()];

    while let Some(current_id) = stack.pop() {
        if !visited.insert(current_id.clone()) {
            continue;
        }

        let children: Vec<String> = conn
            .prepare("SELECT id FROM api_collections WHERE parent_id=?1")
            .map_err(|e| format!("prepare find children: {e}"))?
            .query_map(params![current_id], |row| row.get(0))
            .map_err(|e| format!("query children: {e}"))?
            .filter_map(|r| r.ok())
            .collect();

        stack.extend(children);
    }

    for collection_id in &visited {
        conn.execute(
            "DELETE FROM api_collection_items WHERE collection_id=?1",
            params![collection_id],
        )
        .map_err(|e| format!("delete collection items: {e}"))?;
    }

    for collection_id in &visited {
        conn.execute(
            "DELETE FROM api_collections WHERE id=?1",
            params![collection_id],
        )
        .map_err(|e| format!("delete collection: {e}"))?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Collection item CRUD
// ---------------------------------------------------------------------------

pub fn upsert_collection_item(conn: &Connection, item: &CollectionItemRow) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO api_collection_items
            (id, collection_id, name, description, sort_order,
             method, url, headers, body, body_type, raw_language, form_data, url_encoded,
             created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            item.id,
            item.collection_id,
            item.name,
            item.description,
            item.sort_order as i32,
            item.method,
            item.url,
            item.headers,
            item.body,
            item.body_type,
            item.raw_language,
            item.form_data,
            item.url_encoded,
            item.created_at,
            item.updated_at,
        ],
    )
    .map_err(|e| format!("upsert collection item: {e}"))?;
    Ok(())
}

pub fn list_collection_items(
    conn: &Connection,
    collection_id: &str,
) -> Result<Vec<CollectionItemRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, collection_id, name, description, sort_order,
                    method, url, headers, body, body_type, raw_language, form_data, url_encoded,
                    created_at, updated_at
             FROM api_collection_items
             WHERE collection_id=?1
             ORDER BY sort_order, name",
        )
        .map_err(|e| format!("prepare list collection items: {e}"))?;

    let rows = stmt
        .query_map(params![collection_id], row_to_collection_item)
        .map_err(|e| format!("query collection items: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

pub fn get_collection_item(
    conn: &Connection,
    id: &str,
) -> Result<Option<CollectionItemRow>, String> {
    let result = conn.query_row(
        "SELECT id, collection_id, name, description, sort_order,
                method, url, headers, body, body_type, raw_language, form_data, url_encoded,
                created_at, updated_at
         FROM api_collection_items WHERE id=?1",
        params![id],
        row_to_collection_item,
    );

    match result {
        Ok(item) => Ok(Some(item)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("get collection item: {e}")),
    }
}

pub fn list_all_collection_items(conn: &Connection) -> Result<Vec<CollectionItemRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, collection_id, name, description, sort_order,
                    method, url, headers, body, body_type, raw_language, form_data, url_encoded,
                    created_at, updated_at
             FROM api_collection_items
             ORDER BY sort_order, name",
        )
        .map_err(|e| format!("prepare list all collection items: {e}"))?;

    let rows = stmt
        .query_map([], row_to_collection_item)
        .map_err(|e| format!("query all collection items: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

pub fn delete_collection_item(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM api_collection_items WHERE id=?1", params![id])
        .map_err(|e| format!("delete collection item: {e}"))?;
    Ok(())
}

pub fn move_collection_item(
    conn: &Connection,
    id: &str,
    target_collection_id: &str,
    sort_order: u32,
    now: &str,
) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("begin move item transaction: {e}"))?;

    let old_collection_id: String = tx
        .query_row(
            "SELECT collection_id FROM api_collection_items WHERE id=?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => format!("collection item {id} not found"),
            other => format!("read collection item: {other}"),
        })?;

    ensure_collection_exists(&tx, target_collection_id, "target")?;

    let same_parent = old_collection_id == target_collection_id;

    if !same_parent {
        tx.execute(
            "UPDATE api_collection_items SET collection_id=?1, updated_at=?2 WHERE id=?3",
            params![target_collection_id, now, id],
        )
        .map_err(|e| format!("update collection item parent: {e}"))?;
    }

    let target_ids = list_collection_item_ids_by_collection(&tx, target_collection_id)?;
    let mut others: Vec<String> = target_ids.into_iter().filter(|s| s != id).collect();
    let target_idx = (sort_order as usize).min(others.len());
    others.insert(target_idx, id.to_string());
    for (idx, item_id) in others.iter().enumerate() {
        tx.execute(
            "UPDATE api_collection_items SET sort_order=?1 WHERE id=?2",
            params![idx as i32, item_id],
        )
        .map_err(|e| format!("renumber target item siblings: {e}"))?;
    }

    if !same_parent {
        let old_ids = list_collection_item_ids_by_collection(&tx, &old_collection_id)?;
        for (idx, item_id) in old_ids.iter().enumerate() {
            tx.execute(
                "UPDATE api_collection_items SET sort_order=?1 WHERE id=?2",
                params![idx as i32, item_id],
            )
            .map_err(|e| format!("renumber old item siblings: {e}"))?;
        }
    }

    tx.commit()
        .map_err(|e| format!("commit move item transaction: {e}"))?;
    Ok(())
}

pub fn move_collection(
    conn: &Connection,
    id: &str,
    target_parent_id: Option<&str>,
    sort_order: u32,
    now: &str,
) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("begin move collection transaction: {e}"))?;

    if let Some(parent_id) = target_parent_id {
        ensure_collection_exists(&tx, parent_id, "target parent")?;
    }
    if would_create_cycle(&tx, id, target_parent_id)? {
        return Err("cannot move a folder into its own descendant".to_string());
    }

    let old_parent_id: Option<String> = tx
        .query_row(
            "SELECT parent_id FROM api_collections WHERE id=?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => format!("collection {id} not found"),
            other => format!("read collection parent: {other}"),
        })?;

    let target_str = target_parent_id.map(|s| s.to_string());
    let same_parent = old_parent_id == target_str;

    if !same_parent {
        tx.execute(
            "UPDATE api_collections SET parent_id=?1, updated_at=?2 WHERE id=?3",
            params![target_parent_id, now, id],
        )
        .map_err(|e| format!("update collection parent: {e}"))?;
    }

    let target_ids = list_collection_ids_by_parent(&tx, target_parent_id)?;
    let mut others: Vec<String> = target_ids.into_iter().filter(|s| s != id).collect();
    let target_idx = (sort_order as usize).min(others.len());
    others.insert(target_idx, id.to_string());
    for (idx, sibling_id) in others.iter().enumerate() {
        tx.execute(
            "UPDATE api_collections SET sort_order=?1 WHERE id=?2",
            params![idx as i32, sibling_id],
        )
        .map_err(|e| format!("renumber target collection siblings: {e}"))?;
    }

    if !same_parent {
        let old_ids = list_collection_ids_by_parent(&tx, old_parent_id.as_deref())?;
        for (idx, sibling_id) in old_ids.iter().enumerate() {
            tx.execute(
                "UPDATE api_collections SET sort_order=?1 WHERE id=?2",
                params![idx as i32, sibling_id],
            )
            .map_err(|e| format!("renumber old collection siblings: {e}"))?;
        }
    }

    tx.commit()
        .map_err(|e| format!("commit move collection transaction: {e}"))?;
    Ok(())
}

fn would_create_cycle(
    conn: &Connection,
    moved_id: &str,
    target_parent_id: Option<&str>,
) -> Result<bool, String> {
    let mut current = match target_parent_id {
        Some(id) => Some(id.to_string()),
        None => return Ok(false),
    };

    let mut visited = HashSet::new();
    while let Some(cur) = current {
        if cur == moved_id {
            return Ok(true);
        }
        if !visited.insert(cur.clone()) {
            return Err("collection tree contains a pre-existing cycle".to_string());
        }
        let parent: Option<String> = conn
            .query_row(
                "SELECT parent_id FROM api_collections WHERE id=?1",
                params![cur],
                |row| row.get(0),
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    format!("collection parent {cur} not found")
                }
                other => format!("read collection parent: {other}"),
            })?;
        current = parent;
    }
    Ok(false)
}

fn collection_exists(conn: &Connection, id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM api_collections WHERE id=?1)",
        params![id],
        |row| row.get::<_, i64>(0),
    )
    .map(|exists| exists != 0)
    .map_err(|e| format!("check collection exists: {e}"))
}

fn ensure_collection_exists(conn: &Connection, id: &str, label: &str) -> Result<(), String> {
    if collection_exists(conn, id)? {
        Ok(())
    } else {
        Err(format!("{label} collection {id} not found"))
    }
}

fn list_collection_ids_by_parent(
    conn: &Connection,
    parent_id: Option<&str>,
) -> Result<Vec<String>, String> {
    let rows: Vec<String> = match parent_id {
        Some(p) => conn
            .prepare("SELECT id FROM api_collections WHERE parent_id=?1 ORDER BY sort_order, name")
            .map_err(|e| format!("prepare list collection ids by parent: {e}"))?
            .query_map(params![p], |row| row.get::<_, String>(0))
            .map_err(|e| format!("query collection ids: {e}"))?
            .filter_map(|r| r.ok())
            .collect(),
        None => conn
            .prepare(
                "SELECT id FROM api_collections WHERE parent_id IS NULL ORDER BY sort_order, name",
            )
            .map_err(|e| format!("prepare list root collection ids: {e}"))?
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| format!("query root collection ids: {e}"))?
            .filter_map(|r| r.ok())
            .collect(),
    };
    Ok(rows)
}

fn list_collection_item_ids_by_collection(
    conn: &Connection,
    collection_id: &str,
) -> Result<Vec<String>, String> {
    let rows: Vec<String> = conn
        .prepare(
            "SELECT id FROM api_collection_items WHERE collection_id=?1 ORDER BY sort_order, name",
        )
        .map_err(|e| format!("prepare list item ids: {e}"))?
        .query_map(params![collection_id], |row| row.get::<_, String>(0))
        .map_err(|e| format!("query item ids: {e}"))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

fn row_to_collection(row: &rusqlite::Row<'_>) -> rusqlite::Result<CollectionRow> {
    Ok(CollectionRow {
        id: row.get("id")?,
        parent_id: row.get("parent_id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        sort_order: row.get::<_, i32>("sort_order")? as u32,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_collection_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<CollectionItemRow> {
    Ok(CollectionItemRow {
        id: row.get("id")?,
        collection_id: row.get("collection_id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        sort_order: row.get::<_, i32>("sort_order")? as u32,
        method: row.get("method")?,
        url: row.get("url")?,
        headers: row.get("headers")?,
        body: row.get("body")?,
        body_type: row.get("body_type")?,
        raw_language: row.get("raw_language")?,
        form_data: row.get("form_data")?,
        url_encoded: row.get("url_encoded")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
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
    fn collection_round_trip() {
        let conn = test_conn();

        let c = CollectionRow {
            id: "c1".into(),
            parent_id: None,
            name: "Auth API".into(),
            description: "Authentication endpoints".into(),
            sort_order: 0,
            created_at: now(),
            updated_at: now(),
        };
        upsert_collection(&conn, &c).unwrap();

        let loaded = list_all_collections(&conn).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "Auth API");
        assert!(loaded[0].parent_id.is_none());

        let root = list_collections_by_parent(&conn, None).unwrap();
        assert_eq!(root.len(), 1);
    }

    #[test]
    fn nested_folders() {
        let conn = test_conn();

        let parent = CollectionRow {
            id: "c1".into(),
            parent_id: None,
            name: "Parent".into(),
            description: String::new(),
            sort_order: 0,
            created_at: now(),
            updated_at: now(),
        };
        let child = CollectionRow {
            id: "c2".into(),
            parent_id: Some("c1".into()),
            name: "Child".into(),
            description: String::new(),
            sort_order: 0,
            created_at: now(),
            updated_at: now(),
        };
        upsert_collection(&conn, &parent).unwrap();
        upsert_collection(&conn, &child).unwrap();

        let children = list_collections_by_parent(&conn, Some("c1")).unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].name, "Child");
    }

    #[test]
    fn collection_item_round_trip() {
        let conn = test_conn();

        let c = CollectionRow {
            id: "c1".into(),
            parent_id: None,
            name: "Test".into(),
            description: String::new(),
            sort_order: 0,
            created_at: now(),
            updated_at: now(),
        };
        upsert_collection(&conn, &c).unwrap();

        let item = CollectionItemRow {
            id: "i1".into(),
            collection_id: "c1".into(),
            name: "Login".into(),
            description: "Login request".into(),
            sort_order: 0,
            method: "POST".into(),
            url: "https://api.example.com/login".into(),
            headers: r#"[{"name":"Content-Type","value":"application/json"}]"#.into(),
            body: r#"{"user":"test"}"#.into(),
            body_type: "raw".into(),
            raw_language: "json".into(),
            form_data: "[]".into(),
            url_encoded: "[]".into(),
            created_at: now(),
            updated_at: now(),
        };
        upsert_collection_item(&conn, &item).unwrap();

        let loaded = list_collection_items(&conn, "c1").unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].method, "POST");
        assert_eq!(loaded[0].url, "https://api.example.com/login");

        let single = get_collection_item(&conn, "i1").unwrap().unwrap();
        assert_eq!(single.name, "Login");

        delete_collection_item(&conn, "i1").unwrap();
        assert!(list_collection_items(&conn, "c1").unwrap().is_empty());
    }

    #[test]
    fn delete_collection_cascades() {
        let conn = test_conn();

        let c = CollectionRow {
            id: "c1".into(),
            parent_id: None,
            name: "To Delete".into(),
            description: String::new(),
            sort_order: 0,
            created_at: now(),
            updated_at: now(),
        };
        upsert_collection(&conn, &c).unwrap();

        let item = CollectionItemRow {
            id: "i1".into(),
            collection_id: "c1".into(),
            name: "Item".into(),
            description: String::new(),
            sort_order: 0,
            method: "GET".into(),
            url: "https://example.com".into(),
            headers: "[]".into(),
            body: String::new(),
            body_type: "none".into(),
            raw_language: "json".into(),
            form_data: "[]".into(),
            url_encoded: "[]".into(),
            created_at: now(),
            updated_at: now(),
        };
        upsert_collection_item(&conn, &item).unwrap();

        delete_collection(&conn, "c1").unwrap();
        assert!(list_all_collections(&conn).unwrap().is_empty());
        assert!(list_all_collection_items(&conn).unwrap().is_empty());
    }

    #[test]
    fn move_item_between_collections() {
        let conn = test_conn();

        let c1 = CollectionRow {
            id: "c1".into(),
            parent_id: None,
            name: "Src".into(),
            description: String::new(),
            sort_order: 0,
            created_at: now(),
            updated_at: now(),
        };
        let c2 = CollectionRow {
            id: "c2".into(),
            parent_id: None,
            name: "Dst".into(),
            description: String::new(),
            sort_order: 1,
            created_at: now(),
            updated_at: now(),
        };
        upsert_collection(&conn, &c1).unwrap();
        upsert_collection(&conn, &c2).unwrap();

        let item = CollectionItemRow {
            id: "i1".into(),
            collection_id: "c1".into(),
            name: "Item".into(),
            description: String::new(),
            sort_order: 0,
            method: "GET".into(),
            url: "https://example.com".into(),
            headers: "[]".into(),
            body: String::new(),
            body_type: "none".into(),
            raw_language: "json".into(),
            form_data: "[]".into(),
            url_encoded: "[]".into(),
            created_at: now(),
            updated_at: now(),
        };
        upsert_collection_item(&conn, &item).unwrap();

        move_collection_item(&conn, "i1", "c2", 0, &now()).unwrap();

        assert!(list_collection_items(&conn, "c1").unwrap().is_empty());
        let dst = list_collection_items(&conn, "c2").unwrap();
        assert_eq!(dst.len(), 1);
        assert_eq!(dst[0].id, "i1");
        assert_eq!(dst[0].sort_order, 0);
    }

    #[test]
    fn move_collection_rejects_self() {
        let conn = test_conn();

        let c = CollectionRow {
            id: "c1".into(),
            parent_id: None,
            name: "Self".into(),
            description: String::new(),
            sort_order: 0,
            created_at: now(),
            updated_at: now(),
        };
        upsert_collection(&conn, &c).unwrap();

        let err = move_collection(&conn, "c1", Some("c1"), 0, &now()).unwrap_err();
        assert!(
            err.contains("descendant"),
            "expected cycle error, got: {err}"
        );
    }

    #[test]
    fn move_collection_rejects_descendant_target() {
        let conn = test_conn();

        // c1 (root) -> c2 -> c3
        for (id, parent) in [("c1", None), ("c2", Some("c1")), ("c3", Some("c2"))] {
            let row = CollectionRow {
                id: id.into(),
                parent_id: parent.map(String::from),
                name: id.into(),
                description: String::new(),
                sort_order: 0,
                created_at: now(),
                updated_at: now(),
            };
            upsert_collection(&conn, &row).unwrap();
        }

        // Try to move c1 under c3 (its grandchild) — must fail.
        let err = move_collection(&conn, "c1", Some("c3"), 0, &now()).unwrap_err();
        assert!(
            err.contains("descendant"),
            "expected cycle error, got: {err}"
        );

        // Original parents unchanged.
        let parents: Vec<Option<String>> = list_all_collections(&conn)
            .unwrap()
            .into_iter()
            .map(|r| r.parent_id)
            .collect();
        assert!(parents.contains(&None));
        assert!(parents.contains(&Some("c1".into())));
        assert!(parents.contains(&Some("c2".into())));
    }

    #[test]
    fn move_collection_reorder_same_parent() {
        let conn = test_conn();

        // Three roots: A(0), B(1), C(2).
        for (i, id) in ["a", "b", "c"].iter().enumerate() {
            let row = CollectionRow {
                id: (*id).into(),
                parent_id: None,
                name: (*id).into(),
                description: String::new(),
                sort_order: i as u32,
                created_at: now(),
                updated_at: now(),
            };
            upsert_collection(&conn, &row).unwrap();
        }

        // Move A from 0 to 2 → expect b, c, a with sort_order 0, 1, 2.
        move_collection(&conn, "a", None, 2, &now()).unwrap();

        let roots = list_collections_by_parent(&conn, None).unwrap();
        let order: Vec<String> = roots.iter().map(|r| r.id.clone()).collect();
        assert_eq!(
            order,
            vec!["b".to_string(), "c".to_string(), "a".to_string()]
        );
        assert_eq!(roots[0].sort_order, 0);
        assert_eq!(roots[1].sort_order, 1);
        assert_eq!(roots[2].sort_order, 2);
    }

    #[test]
    fn move_collection_cross_parent_renumbers_both() {
        let conn = test_conn();

        // Two parents P1, P2, each at root.
        for id in ["p1", "p2"] {
            let row = CollectionRow {
                id: id.into(),
                parent_id: None,
                name: id.into(),
                description: String::new(),
                sort_order: 0,
                created_at: now(),
                updated_at: now(),
            };
            upsert_collection(&conn, &row).unwrap();
        }
        // P1 has children a(0), b(1). P2 has child c(0).
        for (id, parent, sort) in [("a", "p1", 0), ("b", "p1", 1), ("c", "p2", 0)] {
            let row = CollectionRow {
                id: id.into(),
                parent_id: Some(parent.into()),
                name: id.into(),
                description: String::new(),
                sort_order: sort,
                created_at: now(),
                updated_at: now(),
            };
            upsert_collection(&conn, &row).unwrap();
        }

        // Move b from P1 to P2 at index 0 → P2 becomes [b, c]; P1 becomes [a].
        move_collection(&conn, "b", Some("p2"), 0, &now()).unwrap();

        let p1_children = list_collections_by_parent(&conn, Some("p1")).unwrap();
        assert_eq!(p1_children.len(), 1);
        assert_eq!(p1_children[0].id, "a");
        assert_eq!(p1_children[0].sort_order, 0);

        let p2_children = list_collections_by_parent(&conn, Some("p2")).unwrap();
        let order: Vec<String> = p2_children.iter().map(|r| r.id.clone()).collect();
        assert_eq!(order, vec!["b".to_string(), "c".to_string()]);
        assert_eq!(p2_children[0].sort_order, 0);
        assert_eq!(p2_children[1].sort_order, 1);
    }

    #[test]
    fn move_collection_rejects_missing_parent() {
        let conn = test_conn();

        let row = CollectionRow {
            id: "c1".into(),
            parent_id: None,
            name: "Folder".into(),
            description: String::new(),
            sort_order: 0,
            created_at: now(),
            updated_at: now(),
        };
        upsert_collection(&conn, &row).unwrap();

        let err = move_collection(&conn, "c1", Some("missing"), 0, &now()).unwrap_err();
        assert!(
            err.contains("not found"),
            "expected missing parent error, got: {err}"
        );

        let roots = list_collections_by_parent(&conn, None).unwrap();
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].id, "c1");
    }

    #[test]
    fn move_item_with_sort_order_reorders() {
        let conn = test_conn();

        let c = CollectionRow {
            id: "c1".into(),
            parent_id: None,
            name: "Folder".into(),
            description: String::new(),
            sort_order: 0,
            created_at: now(),
            updated_at: now(),
        };
        upsert_collection(&conn, &c).unwrap();

        // Three items: A, B, C in c1 with sort_order 0,1,2.
        for (i, id) in ["a", "b", "c"].iter().enumerate() {
            let item = CollectionItemRow {
                id: (*id).into(),
                collection_id: "c1".into(),
                name: (*id).into(),
                description: String::new(),
                sort_order: i as u32,
                method: "GET".into(),
                url: "https://example.com".into(),
                headers: "[]".into(),
                body: String::new(),
                body_type: "none".into(),
                raw_language: "json".into(),
                form_data: "[]".into(),
                url_encoded: "[]".into(),
                created_at: now(),
                updated_at: now(),
            };
            upsert_collection_item(&conn, &item).unwrap();
        }

        // Move A to position 2 → expect b, c, a with sort_order 0,1,2.
        move_collection_item(&conn, "a", "c1", 2, &now()).unwrap();

        let items = list_collection_items(&conn, "c1").unwrap();
        let order: Vec<String> = items.iter().map(|r| r.id.clone()).collect();
        assert_eq!(
            order,
            vec!["b".to_string(), "c".to_string(), "a".to_string()]
        );
    }

    #[test]
    fn move_item_cross_folder_with_existing_items() {
        let conn = test_conn();

        // Two folders: src and dst, both at root.
        for id in ["src", "dst"] {
            let row = CollectionRow {
                id: id.into(),
                parent_id: None,
                name: id.into(),
                description: String::new(),
                sort_order: 0,
                created_at: now(),
                updated_at: now(),
            };
            upsert_collection(&conn, &row).unwrap();
        }

        // src has [a, b]. dst has [x, y].
        for (id, coll, sort) in [
            ("a", "src", 0),
            ("b", "src", 1),
            ("x", "dst", 0),
            ("y", "dst", 1),
        ] {
            let item = CollectionItemRow {
                id: id.into(),
                collection_id: coll.into(),
                name: id.into(),
                description: String::new(),
                sort_order: sort,
                method: "GET".into(),
                url: "https://example.com".into(),
                headers: "[]".into(),
                body: String::new(),
                body_type: "none".into(),
                raw_language: "json".into(),
                form_data: "[]".into(),
                url_encoded: "[]".into(),
                created_at: now(),
                updated_at: now(),
            };
            upsert_collection_item(&conn, &item).unwrap();
        }

        // Move 'a' from src to dst at position 0. Expect dst = [a, x, y], src = [b].
        move_collection_item(&conn, "a", "dst", 0, &now()).unwrap();

        let src_items = list_collection_items(&conn, "src").unwrap();
        assert_eq!(src_items.len(), 1);
        assert_eq!(src_items[0].id, "b");
        assert_eq!(src_items[0].sort_order, 0);

        let dst_items = list_collection_items(&conn, "dst").unwrap();
        let dst_order: Vec<String> = dst_items.iter().map(|r| r.id.clone()).collect();
        assert_eq!(
            dst_order,
            vec!["a".to_string(), "x".to_string(), "y".to_string()]
        );
        assert_eq!(dst_items[0].sort_order, 0);
        assert_eq!(dst_items[1].sort_order, 1);
        assert_eq!(dst_items[2].sort_order, 2);

        // Sanity: total of 4 items, all reachable, none lost.
        let all = list_all_collection_items(&conn).unwrap();
        assert_eq!(all.len(), 4);
    }

    #[test]
    fn move_item_large_sort_order_appends_to_target() {
        let conn = test_conn();

        for id in ["src", "dst"] {
            let row = CollectionRow {
                id: id.into(),
                parent_id: None,
                name: id.into(),
                description: String::new(),
                sort_order: 0,
                created_at: now(),
                updated_at: now(),
            };
            upsert_collection(&conn, &row).unwrap();
        }

        for (id, coll, sort) in [("a", "src", 0), ("x", "dst", 0), ("y", "dst", 1)] {
            let item = CollectionItemRow {
                id: id.into(),
                collection_id: coll.into(),
                name: id.into(),
                description: String::new(),
                sort_order: sort,
                method: "GET".into(),
                url: "https://example.com".into(),
                headers: "[]".into(),
                body: String::new(),
                body_type: "none".into(),
                raw_language: "json".into(),
                form_data: "[]".into(),
                url_encoded: "[]".into(),
                created_at: now(),
                updated_at: now(),
            };
            upsert_collection_item(&conn, &item).unwrap();
        }

        move_collection_item(&conn, "a", "dst", u32::MAX, &now()).unwrap();

        let dst_items = list_collection_items(&conn, "dst").unwrap();
        let dst_order: Vec<String> = dst_items.iter().map(|r| r.id.clone()).collect();
        assert_eq!(
            dst_order,
            vec!["x".to_string(), "y".to_string(), "a".to_string()]
        );
        assert_eq!(dst_items[0].sort_order, 0);
        assert_eq!(dst_items[1].sort_order, 1);
        assert_eq!(dst_items[2].sort_order, 2);
    }

    #[test]
    fn move_item_rejects_missing_target_collection() {
        let conn = test_conn();

        let row = CollectionRow {
            id: "src".into(),
            parent_id: None,
            name: "Source".into(),
            description: String::new(),
            sort_order: 0,
            created_at: now(),
            updated_at: now(),
        };
        upsert_collection(&conn, &row).unwrap();

        let item = CollectionItemRow {
            id: "a".into(),
            collection_id: "src".into(),
            name: "a".into(),
            description: String::new(),
            sort_order: 0,
            method: "GET".into(),
            url: "https://example.com".into(),
            headers: "[]".into(),
            body: String::new(),
            body_type: "none".into(),
            raw_language: "json".into(),
            form_data: "[]".into(),
            url_encoded: "[]".into(),
            created_at: now(),
            updated_at: now(),
        };
        upsert_collection_item(&conn, &item).unwrap();

        let err = move_collection_item(&conn, "a", "missing", 0, &now()).unwrap_err();
        assert!(
            err.contains("not found"),
            "expected missing target error, got: {err}"
        );

        let src_items = list_collection_items(&conn, "src").unwrap();
        assert_eq!(src_items.len(), 1);
        assert_eq!(src_items[0].id, "a");
    }

    #[test]
    fn upsert_collection_rejects_cycle_via_parent() {
        let conn = test_conn();

        // c1 -> c2 -> c3
        for (id, parent) in [("c1", None), ("c2", Some("c1")), ("c3", Some("c2"))] {
            let row = CollectionRow {
                id: id.into(),
                parent_id: parent.map(String::from),
                name: id.into(),
                description: String::new(),
                sort_order: 0,
                created_at: now(),
                updated_at: now(),
            };
            upsert_collection(&conn, &row).unwrap();
        }

        // Try to upsert c1 with parent_id = c3 (its descendant) — must fail.
        let bad = CollectionRow {
            id: "c1".into(),
            parent_id: Some("c3".into()),
            name: "c1".into(),
            description: String::new(),
            sort_order: 0,
            created_at: now(),
            updated_at: now(),
        };
        let err = upsert_collection(&conn, &bad).unwrap_err();
        assert!(err.contains("descendant"));
    }

    #[test]
    fn upsert_collection_rejects_missing_parent() {
        let conn = test_conn();

        let bad = CollectionRow {
            id: "c1".into(),
            parent_id: Some("missing".into()),
            name: "c1".into(),
            description: String::new(),
            sort_order: 0,
            created_at: now(),
            updated_at: now(),
        };

        let err = upsert_collection(&conn, &bad).unwrap_err();
        assert!(
            err.contains("not found"),
            "expected missing parent error, got: {err}"
        );
        assert!(list_all_collections(&conn).unwrap().is_empty());
    }
}

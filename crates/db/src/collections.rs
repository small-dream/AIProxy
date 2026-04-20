use rusqlite::{params, Connection};

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
    conn.execute(
        "INSERT OR REPLACE INTO api_collections
            (id, parent_id, name, description, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            c.id, c.parent_id, c.name, c.description,
            c.sort_order as i32, c.created_at, c.updated_at,
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
            let rows: Vec<CollectionRow> = stmt.query_map(params![pid], row_to_collection)
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
            let rows: Vec<CollectionRow> = stmt.query_map([], row_to_collection)
                .map_err(|e| format!("query root collections: {e}"))?
                .filter_map(|r| r.ok())
                .collect();
            rows
        }
    };

    Ok(rows)
}

pub fn delete_collection(conn: &Connection, id: &str) -> Result<(), String> {
    // CASCADE will delete child items and sub-collections' items.
    // But self-referencing parent_id does NOT cascade, so we must delete recursively.
    delete_collection_tree(conn, id)?;
    Ok(())
}

fn delete_collection_tree(conn: &Connection, id: &str) -> Result<(), String> {
    // Find direct children (sub-collections / folders)
    let children: Vec<String> = conn
        .prepare("SELECT id FROM api_collections WHERE parent_id=?1")
        .map_err(|e| format!("prepare find children: {e}"))?
        .query_map(params![id], |row| row.get(0))
        .map_err(|e| format!("query children: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    // Recurse into children first
    for child_id in children {
        delete_collection_tree(conn, &child_id)?;
    }

    // Delete items in this collection (explicit, since CASCADE may not cover self-ref)
    conn.execute("DELETE FROM api_collection_items WHERE collection_id=?1", params![id])
        .map_err(|e| format!("delete collection items: {e}"))?;

    // Delete the collection itself
    conn.execute("DELETE FROM api_collections WHERE id=?1", params![id])
        .map_err(|e| format!("delete collection: {e}"))?;

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

pub fn get_collection_item(conn: &Connection, id: &str) -> Result<Option<CollectionItemRow>, String> {
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
) -> Result<(), String> {
    conn.execute(
        "UPDATE api_collection_items SET collection_id=?1 WHERE id=?2",
        params![target_collection_id, id],
    )
    .map_err(|e| format!("move collection item: {e}"))?;
    Ok(())
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
            id: "c1".into(), parent_id: None, name: "Parent".into(),
            description: String::new(), sort_order: 0, created_at: now(), updated_at: now(),
        };
        let child = CollectionRow {
            id: "c2".into(), parent_id: Some("c1".into()), name: "Child".into(),
            description: String::new(), sort_order: 0, created_at: now(), updated_at: now(),
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
            id: "c1".into(), parent_id: None, name: "Test".into(),
            description: String::new(), sort_order: 0, created_at: now(), updated_at: now(),
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
            id: "c1".into(), parent_id: None, name: "To Delete".into(),
            description: String::new(), sort_order: 0, created_at: now(), updated_at: now(),
        };
        upsert_collection(&conn, &c).unwrap();

        let item = CollectionItemRow {
            id: "i1".into(), collection_id: "c1".into(), name: "Item".into(),
            description: String::new(), sort_order: 0, method: "GET".into(),
            url: "https://example.com".into(), headers: "[]".into(), body: String::new(),
            body_type: "none".into(), raw_language: "json".into(), form_data: "[]".into(),
            url_encoded: "[]".into(), created_at: now(), updated_at: now(),
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
            id: "c1".into(), parent_id: None, name: "Src".into(),
            description: String::new(), sort_order: 0, created_at: now(), updated_at: now(),
        };
        let c2 = CollectionRow {
            id: "c2".into(), parent_id: None, name: "Dst".into(),
            description: String::new(), sort_order: 0, created_at: now(), updated_at: now(),
        };
        upsert_collection(&conn, &c1).unwrap();
        upsert_collection(&conn, &c2).unwrap();

        let item = CollectionItemRow {
            id: "i1".into(), collection_id: "c1".into(), name: "Item".into(),
            description: String::new(), sort_order: 0, method: "GET".into(),
            url: "https://example.com".into(), headers: "[]".into(), body: String::new(),
            body_type: "none".into(), raw_language: "json".into(), form_data: "[]".into(),
            url_encoded: "[]".into(), created_at: now(), updated_at: now(),
        };
        upsert_collection_item(&conn, &item).unwrap();

        move_collection_item(&conn, "i1", "c2").unwrap();

        assert!(list_collection_items(&conn, "c1").unwrap().is_empty());
        let dst = list_collection_items(&conn, "c2").unwrap();
        assert_eq!(dst.len(), 1);
        assert_eq!(dst[0].id, "i1");
    }
}

use std::fs::{self, File};

use aiproxy_agent_control::{AgentCapability, AgentGrantRequestPolicy};
use aiproxy_db::rusqlite::{params, Connection};
use aiproxy_mcp::config::{write_config, AgentAccessConfig, AgentAccessPermissions, AppPaths};
use aiproxy_mcp::control_client::ControlCaller;
use aiproxy_mcp::protocol::{ToolError, ToolMeta};
use aiproxy_mcp::tools::session_field_search::{search_session_fields, SearchSessionFieldsRequest};
use aiproxy_mcp::AppContext;
use chrono::{Duration, Utc};
use serde_json::{json, Value};
use tempfile::TempDir;

const CALLER: ControlCaller<'static> = ControlCaller {
    name: "field-search-test",
    version: "1.0",
};

struct Fixture {
    _directory: TempDir,
    context: AppContext,
    writer: Connection,
    started_at: String,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let paths = AppPaths::resolve(Some(directory.path().to_owned()), None).unwrap();
        let writer = Connection::open(&paths.db_path).unwrap();
        writer
            .execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .unwrap();
        aiproxy_db::schema::run_migrations(&writer).unwrap();
        let fixture = Self {
            _directory: directory,
            context: AppContext::new(paths),
            writer,
            started_at: (Utc::now() - Duration::seconds(2)).to_rfc3339(),
        };
        fixture.set_permissions(true, true);
        fixture
    }

    fn set_permissions(&self, sessions: bool, bodies: bool) {
        let mut config = AgentAccessConfig {
            enabled: true,
            permissions: AgentAccessPermissions {
                read_sessions: sessions,
                read_bodies: bodies,
                ..AgentAccessPermissions::default()
            },
            ..AgentAccessConfig::default()
        };
        config
            .grant_request_policy
            .insert(AgentCapability::ReadBodies, AgentGrantRequestPolicy::Deny);
        write_config(&self.context.paths.config_path, &config).unwrap();
    }

    fn body(&self, id: &str, json: Value) {
        self.add(id, None, Some(json!({ "inline_text": json.to_string() })));
    }

    fn add(&self, id: &str, request: Option<Value>, response: Option<Value>) {
        self.writer
            .execute(
                "INSERT INTO session_summaries
               (id, method, host, path, protocol, started_at, finished_at, status_code, url)
             VALUES (?1, 'GET', 'api.example.test', '/api/', 'HTTPS', ?2, ?2, 200,
                     'https://api.example.test/api/')",
                params![id, self.started_at],
            )
            .unwrap();
        self.writer
            .execute(
                "INSERT INTO session_details
               (id, session_summary_id, request_body_ref, response_body_ref, query_params)
             VALUES (?1, ?1, ?2, ?3, ?4)",
                params![
                    id,
                    request.map(|value| value.to_string()),
                    response.map(|value| value.to_string()),
                    json!([{"name":"_method","value":"test.drawer"}]).to_string()
                ],
            )
            .unwrap();
    }

    async fn search(&self, request: Value) -> Result<(Value, ToolMeta), ToolError> {
        search_session_fields(
            &self.context,
            serde_json::from_value(request).unwrap(),
            CALLER,
        )
        .await
    }
}

fn query(target: Value, condition: Value) -> Value {
    json!({
        "filter": { "host": "api.example.test", "queryParams": {"_method": "test.drawer"}, "since": "10m" },
        "part": "response",
        "target": target,
        "condition": condition,
    })
}

fn ids(data: &Value) -> Vec<&str> {
    data["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["sessionId"].as_str().unwrap())
        .collect()
}

#[tokio::test]
async fn discovers_exact_keys_and_resolves_array_wildcards_to_concrete_paths() {
    let fixture = Fixture::new();
    fixture.body(
        "drawer",
        json!({
            "hide_user_name": 0,
            "items": [{"hide_user_name": 1}, {"HIDE_USER_NAME": 2}, {"hide_user_name": 3}],
            "custom.key": {"hide_user_name": 4}
        }),
    );

    let (data, _) = fixture
        .search(query(
            json!({"key":"hide_user_name"}),
            json!({"operator":"exists"}),
        ))
        .await
        .unwrap();
    let matches = data["items"][0]["matches"].as_array().unwrap();
    assert_eq!(
        matches
            .iter()
            .map(|item| item["jsonPath"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "$.hide_user_name",
            "$.items[0].hide_user_name",
            "$.items[2].hide_user_name",
            "$['custom.key'].hide_user_name"
        ]
    );
    let (data, _) = fixture
        .search(query(
            json!({"jsonPath":"$.items[*].hide_user_name"}),
            json!({"operator":"exists"}),
        ))
        .await
        .unwrap();
    let matches = data["items"][0]["matches"].as_array().unwrap();
    assert_eq!(matches.len(), 2);
    assert_eq!(
        matches[0],
        json!({"jsonPath":"$.items[0].hide_user_name","valueType":"number","value":1})
    );
    assert_eq!(matches[1]["jsonPath"], "$.items[2].hide_user_name");
}

#[tokio::test]
async fn equals_keeps_json_types_distinct_and_exists_includes_null_and_containers() {
    let fixture = Fixture::new();
    for (id, value) in [
        ("number", json!(0)),
        ("numericFloat", json!(0.0)),
        ("string", json!("0")),
        ("boolean", json!(false)),
        ("null", Value::Null),
        ("array", json!([0])),
        ("object", json!({"nested":0})),
        ("large", json!(9007199254740993u64)),
    ] {
        fixture.body(id, json!({"flag":value}));
    }
    fixture.body("missing", json!({"other":0}));

    for (value, expected) in [
        (json!(0), vec!["numericFloat", "number"]),
        (json!("0"), vec!["string"]),
        (json!(false), vec!["boolean"]),
        (Value::Null, vec!["null"]),
        (json!(9007199254740992.0), vec![]),
    ] {
        let (data, _) = fixture
            .search(query(
                json!({"key":"flag"}),
                json!({"operator":"equals","value":value}),
            ))
            .await
            .unwrap();
        assert_eq!(ids(&data), expected);
    }

    let (data, _) = fixture
        .search(query(json!({"key":"flag"}), json!({"operator":"exists"})))
        .await
        .unwrap();
    assert_eq!(ids(&data).len(), 8);
    let matches_for = |id| {
        data["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["sessionId"] == id)
            .unwrap()["matches"][0]
            .clone()
    };
    assert_eq!(
        matches_for("null"),
        json!({"jsonPath":"$.flag","valueType":"null","value":null})
    );
    assert_eq!(
        matches_for("array"),
        json!({"jsonPath":"$.flag","valueType":"array"})
    );
    assert_eq!(
        matches_for("object"),
        json!({"jsonPath":"$.flag","valueType":"object"})
    );
}

#[tokio::test]
async fn protected_paths_and_value_masks_do_not_participate_in_predicates() {
    let fixture = Fixture::new();
    fixture.body(
        "private",
        json!({
            "password": "fake-test-value",
            "authorization": {"flag": "hidden"},
            "qa-user@example.test": {"flag": "hidden"},
            "visible": {"flag": "user@example.com"},
            "safe": {"flag":"public"}
        }),
    );

    for target in [
        json!({"key":"password"}),
        json!({"jsonPath":"$.authorization.flag"}),
        json!({"jsonPath":"$['qa-user@example.test'].flag"}),
        json!({"jsonPath":"$.visible.flag"}),
    ] {
        let (data, meta) = fixture
            .search(query(target, json!({"operator":"exists"})))
            .await
            .unwrap();
        assert!(meta.redacted);
        assert!(ids(&data).is_empty());
        assert_eq!(data["scan"]["skipped"]["redacted"], 1);
    }
    let mut responses = Vec::new();
    for value in ["user@example.com", "not-the-value", "[REDACTED]"] {
        let (data, _) = fixture
            .search(query(
                json!({"jsonPath":"$.visible.flag"}),
                json!({"operator":"equals","value":value}),
            ))
            .await
            .unwrap();
        assert!(ids(&data).is_empty());
        responses.push(data);
    }
    assert!(responses.windows(2).all(|pair| pair[0] == pair[1]));
    let (data, _) = fixture
        .search(query(json!({"key":"flag"}), json!({"operator":"exists"})))
        .await
        .unwrap();
    assert_eq!(
        data["items"][0]["matches"],
        json!([{"jsonPath":"$.safe.flag","valueType":"string","value":"public"}])
    );
    let serialization = data.to_string();
    for hidden in [
        "fake-test-value",
        "user@example.com",
        "qa-user@example.test",
        "authorization",
    ] {
        assert!(!serialization.contains(hidden));
    }
}

#[tokio::test]
async fn reports_unavailable_invalid_truncated_and_oversize_bodies_separately() {
    let fixture = Fixture::new();
    fixture.add("missing", None, None);
    fixture.add(
        "truncated",
        None,
        Some(json!({"inline_text":"{\"flag\":1}", "truncated":true})),
    );
    fixture.add(
        "broken",
        None,
        Some(json!({"inline_text":"{\"flag\":1} trailing"})),
    );
    fixture.add(
        "lost-file",
        None,
        Some(json!({"file_path":"missing/response.bin"})),
    );
    let directory = fixture.context.paths.body_dir.join("big");
    fs::create_dir_all(&directory).unwrap();
    File::create(directory.join("response.bin"))
        .unwrap()
        .set_len(64 * 1024 * 1024 + 1)
        .unwrap();
    fixture.add(
        "big",
        None,
        Some(json!({"file_path":"big/response.bin", "size_bytes":1})),
    );

    let (data, meta) = fixture
        .search(query(json!({"key":"flag"}), json!({"operator":"exists"})))
        .await
        .unwrap();
    assert!(ids(&data).is_empty());
    assert!(meta.next_cursor.is_none());
    assert_eq!(data["scan"]["status"], "noMatch");
    assert_eq!(data["scan"]["processedSessions"], 5);
    assert_eq!(data["scan"]["scannedSessions"], 1);
    assert_eq!(data["scan"]["scannedBytes"], "{\"flag\":1} trailing".len());
    assert_eq!(data["scan"]["skipped"]["bodyUnavailable"], 2);
    assert_eq!(data["scan"]["skipped"]["captureTruncated"], 1);
    assert_eq!(data["scan"]["skipped"]["bodyTooLarge"], 1);
    assert_eq!(data["scan"]["skipped"]["nonJson"], 1);
}

#[tokio::test]
async fn an_empty_candidate_budget_page_can_resume_to_a_match() {
    let fixture = Fixture::new();
    fixture.body("oldest", json!({"flag":0}));
    for index in 0..100 {
        fixture.body(&format!("noise-{index}"), json!({}));
    }
    let mut request = query(json!({"key":"flag"}), json!({"operator":"exists"}));

    let (first, meta) = fixture.search(request.clone()).await.unwrap();
    assert!(ids(&first).is_empty());
    assert!(meta.truncated);
    assert_eq!(first["scan"]["status"], "partial");
    assert_eq!(first["scan"]["stopReason"], "candidateBudget");
    assert_eq!(first["scan"]["processedSessions"], 100);
    request["cursor"] = json!(meta.next_cursor.unwrap());
    let (second, meta) = fixture.search(request).await.unwrap();
    assert_eq!(ids(&second), ["oldest"]);
    assert!(meta.next_cursor.is_none());
    assert_eq!(second["scan"]["processedSessions"], 1);
}

#[tokio::test]
async fn resumes_by_completion_sequence_without_admitting_later_completions() {
    let fixture = Fixture::new();
    for id in ["one", "two", "three"] {
        fixture.body(id, json!({"flag":0}));
    }
    fixture
        .writer
        .execute(
            "INSERT INTO session_summaries
           (id, method, host, path, protocol, started_at, finished_at, url)
         VALUES ('pending', 'GET', 'api.example.test', '/api/', 'HTTPS', ?1, '',
                 'https://api.example.test/api/')",
            [&fixture.started_at],
        )
        .unwrap();
    fixture.writer.execute(
        "INSERT INTO session_details (id, session_summary_id, response_body_ref, query_params)
         SELECT 'pending', 'pending', response_body_ref, query_params FROM session_details WHERE id='one'",
        [],
    ).unwrap();
    let mut request = query(
        json!({"jsonPath":"$.flag"}),
        json!({"operator":"equals","value":0}),
    );
    request["limit"] = json!(1);
    let (first, meta) = fixture.search(request.clone()).await.unwrap();
    assert_eq!(ids(&first), ["three"]);
    assert_eq!(first["scan"]["stopReason"], "resultLimit");
    let token = meta.next_cursor.unwrap();
    assert!(token.starts_with("sf1."));
    assert!(!token.contains("flag") && !token.contains("test.drawer"));

    fixture
        .writer
        .execute(
            "UPDATE session_summaries SET finished_at=started_at WHERE id='pending'",
            [],
        )
        .unwrap();
    fixture.body("new", json!({"flag":0}));

    let mut resumed = request.clone();
    resumed["cursor"] = json!(token);
    resumed["filter"]["since"] = json!("600s");
    resumed["filter"]["host"] = json!(" API.EXAMPLE.TEST ");
    resumed["target"] = json!({"jsonPath":"$['flag']"});
    resumed["limit"] = json!(2);
    let (second, meta) = fixture.search(resumed.clone()).await.unwrap();
    assert_eq!(ids(&second), ["two", "one"]);
    assert!(meta.next_cursor.is_none());

    resumed["condition"]["value"] = json!("0");
    assert_eq!(
        fixture.search(resumed).await.unwrap_err().code,
        "CURSOR_INVALID"
    );
    let (fresh, _) = fixture.search(request).await.unwrap();
    assert_eq!(ids(&fresh), ["new"]);
}

#[tokio::test]
async fn uses_requested_part_time_bounds_and_metadata_scope() {
    let fixture = Fixture::new();
    fixture.add(
        "request",
        Some(json!({"inline_text":"{\"flag\":true}"})),
        None,
    );
    let mut request = query(json!({"key":"flag"}), json!({"operator":"exists"}));
    request["part"] = json!("request");
    request["filter"] = json!({
        "method":"get", "statusMin":200, "statusMax":200,
        "startedAfter": (Utc::now() - Duration::minutes(1)).to_rfc3339(),
    });
    let (data, _) = fixture.search(request.clone()).await.unwrap();
    assert_eq!(ids(&data), ["request"]);
    request["filter"]["statusMin"] = json!(404);
    request["filter"]["statusMax"] = json!(404);
    let (data, _) = fixture.search(request).await.unwrap();
    assert_eq!(data["scan"]["status"], "noCandidates");
}

#[tokio::test]
async fn field_search_requires_session_and_body_permissions() {
    let fixture = Fixture::new();
    fixture.body("test", json!({"flag":true}));
    let request = query(json!({"key":"flag"}), json!({"operator":"exists"}));
    for (sessions, bodies) in [(false, true), (true, false)] {
        fixture.set_permissions(sessions, bodies);
        assert_eq!(
            fixture.search(request.clone()).await.unwrap_err().code,
            "PERMISSION_DENIED"
        );
    }
}

#[test]
fn rejects_ambiguous_targets_and_missing_equals_value() {
    for request in [
        query(
            json!({"key":"flag","jsonPath":"$.flag"}),
            json!({"operator":"exists"}),
        ),
        query(json!({}), json!({"operator":"exists"})),
        query(json!({"key":"flag"}), json!({"operator":"equals"})),
    ] {
        assert!(serde_json::from_value::<SearchSessionFieldsRequest>(request).is_err());
    }
}

#[tokio::test]
async fn charges_decoded_file_bytes_and_base64_bytes_instead_of_wire_size() {
    let fixture = Fixture::new();
    let payload = r#"{"flag":true}"#;
    fs::create_dir_all(fixture.context.paths.body_dir.join("file")).unwrap();
    fs::write(
        fixture.context.paths.body_dir.join("file/response.bin"),
        payload,
    )
    .unwrap();
    fixture.add(
        "file",
        None,
        Some(json!({"file_path":"file/response.bin", "size_bytes":1000})),
    );
    fixture.add(
        "base64",
        None,
        Some(json!({"base64_text":"eyJmbGFnIjp0cnVlfQ==", "size_bytes":1000})),
    );

    let (data, _) = fixture
        .search(query(json!({"key":"flag"}), json!({"operator":"exists"})))
        .await
        .unwrap();
    assert_eq!(ids(&data), ["base64", "file"]);
    assert_eq!(data["scan"]["scannedBytes"], 2 * payload.len());
}

#[tokio::test]
async fn changed_database_or_cursor_signature_is_rejected() {
    let source = Fixture::new();
    source.body("a", json!({"flag":true}));
    source.body("b", json!({"flag":true}));
    let mut request = query(json!({"key":"flag"}), json!({"operator":"exists"}));
    request["limit"] = json!(1);
    let (_, meta) = source.search(request.clone()).await.unwrap();
    let token = meta.next_cursor.unwrap();

    let other = Fixture::new();
    request["cursor"] = json!(token);
    assert_eq!(
        other.search(request.clone()).await.unwrap_err().code,
        "CURSOR_INVALID"
    );
    let last = if token.ends_with('A') { 'B' } else { 'A' };
    request["cursor"] = json!(format!("{}{last}", &token[..token.len() - 1]));
    assert_eq!(
        source.search(request).await.unwrap_err().code,
        "CURSOR_INVALID"
    );
}

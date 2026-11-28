use std::path::Path;

use aiproxy_db::connection::open_read_only_database;
use aiproxy_db::rusqlite::{params, Connection};
use aiproxy_db::session_completion::read_completion_watermark;
use aiproxy_db::session_search::{search_completed_sessions, SessionSearchFilter};
use aiproxy_mcp::config::{write_config, AgentAccessConfig, AgentAccessPermissions, AppPaths};
use aiproxy_mcp::tools::sessions::{
    search, wait_for_sessions, SearchSessionsRequest, WaitForSessionsRequest,
};
use aiproxy_mcp::AppContext;
use serde_json::Value;
use tempfile::TempDir;

const HOST: &str = "api.example.test";

struct Fixture {
    _directory: TempDir,
    context: AppContext,
    writer: Connection,
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
        write_config(
            &paths.config_path,
            &AgentAccessConfig {
                enabled: true,
                permissions: AgentAccessPermissions {
                    read_sessions: true,
                    ..Default::default()
                },
                ..Default::default()
            },
        )
        .unwrap();
        Self {
            _directory: directory,
            context: AppContext::new(paths),
            writer,
        }
    }

    fn start(&self, id: &str) {
        insert_pending(&self.writer, id);
    }

    fn finish(&self, id: &str) {
        complete(&self.writer, id);
    }

    async fn history_watermark(&self) -> String {
        let (_, meta) = search(&self.context, SearchSessionsRequest::default())
            .await
            .unwrap();
        meta.watermark.unwrap()
    }

    async fn wait(&self, watermark: &str, min_count: usize, limit: Option<usize>) -> Value {
        let (data, meta) = wait_for_sessions(
            &self.context,
            WaitForSessionsRequest {
                host: Some(HOST.to_owned()),
                after_watermark: Some(watermark.to_owned()),
                min_count: Some(min_count),
                limit,
                timeout_ms: Some(1000),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
        assert_eq!(data["watermark"].as_str(), meta.watermark.as_deref());
        data
    }

    fn db_path(&self) -> &Path {
        &self.context.paths.db_path
    }
}

fn insert_pending(conn: &Connection, id: &str) {
    conn.execute(
        "INSERT INTO session_summaries
           (id, method, host, path, protocol, started_at, finished_at, status_code, url)
         VALUES (?1, 'GET', ?2, '/api/', 'HTTPS', '2026-01-01T00:00:01Z', '', 0,
                 'https://api.example.test/api/')",
        params![id, HOST],
    )
    .unwrap();
}

fn complete(conn: &Connection, id: &str) {
    conn.execute(
        "UPDATE session_summaries SET finished_at='2026-01-01T00:00:02Z', status_code=200 WHERE id=?1",
        [id],
    ).unwrap();
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
async fn wait_follows_completion_order_when_an_earlier_request_finishes_later() {
    let fixture = Fixture::new();
    fixture.start("A");
    fixture.start("B");
    let initial = fixture.history_watermark().await;

    fixture.finish("B");
    let first = fixture.wait(&initial, 1, None).await;
    fixture.finish("A");
    let second = fixture
        .wait(first["watermark"].as_str().unwrap(), 1, None)
        .await;

    assert_eq!(ids(&first), ["B"]);
    assert_eq!(ids(&second), ["A"]);
    assert!(second["watermark"].as_str().unwrap().starts_with("w2:"));
}

#[tokio::test]
async fn wait_resumes_unreturned_matches_across_limited_pages() {
    let fixture = Fixture::new();
    let initial = fixture.history_watermark().await;
    for id in ["E", "D", "C", "B", "A"] {
        fixture.start(id);
    }
    for id in ["B", "D", "A", "E", "C"] {
        fixture.finish(id);
    }

    let first = fixture.wait(&initial, 1, Some(2)).await;
    let second = fixture
        .wait(first["watermark"].as_str().unwrap(), 1, Some(2))
        .await;
    let last = fixture
        .wait(second["watermark"].as_str().unwrap(), 1, Some(2))
        .await;

    assert_eq!(ids(&first), ["B", "D"]);
    assert_eq!(ids(&second), ["A", "E"]);
    assert_eq!(ids(&last), ["C"]);
}

#[tokio::test]
async fn timeout_advances_only_for_partial_results_that_were_delivered() {
    let fixture = Fixture::new();
    let initial = fixture.history_watermark().await;
    fixture.start("partial");
    fixture.finish("partial");

    let partial = fixture.wait(&initial, 2, Some(2)).await;
    let next = partial["watermark"].as_str().unwrap();
    fixture.start("unrelated");
    fixture
        .writer
        .execute(
            "UPDATE session_summaries SET host='other.example.test' WHERE id='unrelated'",
            [],
        )
        .unwrap();
    fixture.finish("unrelated");
    let empty = fixture.wait(next, 2, Some(2)).await;

    assert_eq!(partial["satisfied"], false);
    assert_eq!(partial["timedOut"], true);
    assert_eq!(ids(&partial), ["partial"]);
    assert_ne!(next, initial);
    assert_eq!(empty["timedOut"], true);
    assert!(ids(&empty).is_empty());
    assert_eq!(empty["watermark"], next);

    fixture.start("after-timeout");
    fixture.finish("after-timeout");
    let resumed = fixture.wait(next, 1, None).await;
    assert_eq!(ids(&resumed), ["after-timeout"]);
}

#[tokio::test]
async fn legacy_watermark_replays_retained_matches_and_transitions_to_w2() {
    let fixture = Fixture::new();
    fixture.start("A");
    fixture.start("B");
    fixture.finish("B");
    fixture.finish("A");

    let first = fixture.wait("w1:2", 1, None).await;
    let resumed = fixture
        .wait(first["watermark"].as_str().unwrap(), 1, None)
        .await;

    assert_eq!(first["cursorCompatibility"], "legacyReplay");
    assert!(first["watermark"].as_str().unwrap().starts_with("w2:"));
    assert_eq!(ids(&first), ["B"]);
    assert!(resumed.get("cursorCompatibility").is_none());
    assert_eq!(ids(&resumed), ["A"]);
}

#[tokio::test]
async fn no_watermark_starts_at_the_current_completed_watermark() {
    let fixture = Fixture::new();
    fixture.start("old");
    fixture.finish("old");
    let initial = fixture.history_watermark().await;

    let (data, _) = wait_for_sessions(
        &fixture.context,
        WaitForSessionsRequest {
            timeout_ms: Some(1000),
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();

    assert_eq!(data["timedOut"], true);
    assert_eq!(data["watermark"], initial);
    assert!(ids(&data).is_empty());
}

#[tokio::test]
async fn wait_rejects_a_watermark_from_another_database() {
    let fixture = Fixture::new();
    let foreign = Fixture::new().history_watermark().await;
    let error = wait_for_sessions(
        &fixture.context,
        WaitForSessionsRequest {
            after_watermark: Some(foreign),
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "CURSOR_INVALID");
}

#[tokio::test]
async fn old_database_keeps_history_search_available_until_desktop_migrates() {
    let fixture = Fixture::new();
    fixture.start("legacy");
    fixture.finish("legacy");
    // Simulate a previously installed schema using only this temporary fixture.
    fixture
        .writer
        .execute_batch(
            "DROP TRIGGER session_completion_after_insert;
         DROP TRIGGER session_completion_after_update;
         DROP TABLE session_completions;
         DROP TABLE session_completion_identity;",
        )
        .unwrap();

    let (data, meta) = search(&fixture.context, SearchSessionsRequest::default())
        .await
        .unwrap();
    assert_eq!(ids(&data), ["legacy"]);
    assert!(meta.watermark.is_none());
    let error = wait_for_sessions(&fixture.context, WaitForSessionsRequest::default(), None)
        .await
        .unwrap_err();
    assert_eq!(error.code, "SCHEMA_INCOMPATIBLE");
}

#[test]
fn a_search_snapshot_cannot_skip_a_concurrent_completion_at_handoff() {
    let fixture = Fixture::new();
    fixture.start("during-search");
    let reader = open_read_only_database(fixture.db_path()).unwrap();
    let snapshot = reader.unchecked_transaction().unwrap();
    let filter = SessionSearchFilter::default();
    let history =
        aiproxy_db::session_search::search_sessions(&snapshot, &filter, 10, None).unwrap();
    assert_eq!(history.items[0].status_code, 0);

    fixture.finish("during-search");
    let watermark = read_completion_watermark(&snapshot).unwrap().unwrap();
    snapshot.commit().unwrap();
    let next = search_completed_sessions(&reader, &filter, 10, watermark.sequence()).unwrap();

    assert_eq!(next.items[0].summary.id, "during-search");
    assert_eq!(next.items[0].summary.status_code, 200);
}

#[test]
fn completion_events_follow_transaction_commit_and_survive_session_cleanup() {
    let fixture = Fixture::new();
    fixture.start("first");
    let initial = read_completion_watermark(&fixture.writer).unwrap().unwrap();
    let abandoned_write = fixture.writer.unchecked_transaction().unwrap();
    complete(&abandoned_write, "first");
    abandoned_write.rollback().unwrap();
    assert_eq!(
        read_completion_watermark(&fixture.writer).unwrap().unwrap(),
        initial
    );

    fixture.finish("first");
    let delivered = read_completion_watermark(&fixture.writer).unwrap().unwrap();
    fixture.finish("first");
    assert_eq!(
        read_completion_watermark(&fixture.writer).unwrap().unwrap(),
        delivered
    );

    aiproxy_db::sessions::clear_all_sessions(&fixture.writer).unwrap();
    assert_eq!(
        read_completion_watermark(&fixture.writer).unwrap().unwrap(),
        delivered
    );
    fixture.start("next");
    fixture.finish("next");
    let page = search_completed_sessions(
        &fixture.writer,
        &SessionSearchFilter::default(),
        10,
        delivered.sequence(),
    )
    .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].summary.id, "next");
    assert!(page.items[0].sequence > delivered.sequence());
}

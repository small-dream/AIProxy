use aiproxy_agent_control::{ExtendSessionJsonRewriteParams, WaitForSessionJsonRewriteParams};
use aiproxy_proxy_core::{
    ProxyBodyReference, ProxyHeaderEntry, ProxySessionDetail, RewriteTrace, RewriteTraceEntry,
    AUTOMATION_VERIFICATION_HEADER,
};

use super::super::tests::{automation_permissions, session_fixture, test_harness, WORKSPACE_ID};
use super::*;

const CLIENT: (&str, &str) = ("test-agent", "1.0");
const PATH: &str = "$.mydeals.hide_user_name";
const SOURCE: &str = "phase-two-source";
const URL: &str = "https://api.example.test/api/?_method=drawer&_timestamp=source";

fn capture(id: &str, url: &str, time: &str, protocol: &str) -> ProxySessionDetail {
    let mut session = session_fixture(id, time, Some("proxy"));
    let parsed = Url::parse(url).unwrap();
    session.summary.url = url.to_owned();
    session.summary.host = parsed.host_str().unwrap().to_owned();
    session.summary.path = parsed.path().to_owned();
    session.summary.method = "POST".to_owned();
    session.summary.http_version = protocol.to_owned();
    session.query_params = parsed
        .query_pairs()
        .map(|(name, value)| ProxyHeaderEntry {
            name: name.into_owned(),
            value: value.into_owned(),
            is_pseudo: None,
        })
        .collect();
    session
}

async fn create(state: &AppState) -> Value {
    state
        .upsert_session_async(capture(SOURCE, URL, "2020-01-01T00:00:00Z", "2"))
        .await;
    state.start_proxy(8888, true, false, WORKSPACE_ID.to_owned());
    state
        .create_session_json_rewrite(
            CreateSessionJsonRewriteParams {
                mode: SessionJsonRewriteMode::Create,
                session_id: SOURCE.into(),
                json_path: PATH.into(),
                value: json!(1),
                match_query_keys: None,
                ttl_seconds: 600,
                idempotency_key: Some("second-phase-creation-1".into()),
            },
            CLIENT,
            automation_permissions(),
        )
        .await
        .unwrap()
}

fn extension(created: &Value, key: &str) -> ExtendSessionJsonRewriteParams {
    ExtendSessionJsonRewriteParams {
        rule_id: created["ruleId"].as_str().unwrap().into(),
        additional_seconds: 600,
        idempotency_key: key.into(),
    }
}

fn wait(created: &Value, after_watermark: Option<String>) -> WaitForSessionJsonRewriteParams {
    WaitForSessionJsonRewriteParams {
        change_id: created["changeId"].as_str().unwrap().into(),
        after_watermark,
        after_rowid: None,
        timeout_ms: 1000,
    }
}

fn force_deadline(state: &AppState, created: &Value, deadline: DateTime<Utc>) {
    let conn = state.lock_db_for_ipc().unwrap();
    conn.execute(
        "UPDATE automation_change_sets SET expires_at=?1 WHERE id=?2",
        [
            deadline.to_rfc3339().as_str(),
            created["changeId"].as_str().unwrap(),
        ],
    )
    .unwrap();
    drop(conn);
    state.republish_automation_runtime().unwrap();
}

fn trace(session: &mut ProxySessionDetail, created: &Value, outcome: &str) {
    session.rewrite_traces.push(RewriteTrace {
        duration_ms: 1,
        outcome: outcome.into(),
        entries: vec![RewriteTraceEntry {
            after: (outcome == "success").then(|| "1".into()),
            before: Some("0".into()),
            kind: if outcome == "skipped" {
                "skip"
            } else {
                "body-field"
            }
            .into(),
            key: Some(PATH.into()),
            message: Some("test rewrite trace".into()),
            sequence: 0,
        }],
        rule_id: created["ruleId"].as_str().unwrap().into(),
        rule_name: "Session JSON response rewrite".into(),
        rewrite_type: "body".into(),
        stage: "response".into(),
    });
}

fn evidence(
    id: &str,
    time: &str,
    created: &Value,
    outcome: &str,
    body_value: Value,
) -> ProxySessionDetail {
    let mut session = capture(id, URL, time, "1.1");
    trace(&mut session, created, outcome);
    let body = json!({ "mydeals": { "hide_user_name": body_value } }).to_string();
    session.response_body = Some(ProxyBodyReference::from_decoded_bytes(
        body.as_bytes().to_vec(),
        Some("application/json".into()),
        body.len(),
        false,
        true,
    ));
    session
}

#[tokio::test]
async fn active_renewal_extends_the_original_deadline_once_under_concurrent_retries() {
    let harness = test_harness();
    let state = &harness.state;
    let created = create(state).await;
    let request = extension(&created, "active-renewal-test-1");
    let (a, b) = tokio::join!(
        state.extend_session_json_rewrite(request.clone(), CLIENT, automation_permissions()),
        state.extend_session_json_rewrite(request.clone(), CLIENT, automation_permissions()),
    );
    let (a, b) = (a.unwrap(), b.unwrap());

    assert_eq!(a["ruleId"], created["ruleId"]);
    assert_eq!(a["changeId"], created["changeId"]);
    assert_eq!(a["activatedAt"], created["activatedAt"]);
    assert_eq!(a["previousExpiresAt"], created["expiresAt"]);
    assert_eq!(a["expiresAt"], b["expiresAt"]);
    assert_ne!(a["idempotent"], b["idempotent"]);
    assert_eq!(
        parse_time(a["expiresAt"].as_str().unwrap()).unwrap()
            - parse_time(created["expiresAt"].as_str().unwrap()).unwrap(),
        chrono::Duration::minutes(10)
    );
    assert_eq!(state.read_rewrite_manager().list_rules().len(), 1);
}

#[tokio::test]
async fn renewal_rejects_conflicting_retry_and_remaining_lifetime_over_an_hour() {
    let harness = test_harness();
    let state = &harness.state;
    let created = create(state).await;
    let request = extension(&created, "renewal-conflict-test");
    state
        .extend_session_json_rewrite(request.clone(), CLIENT, automation_permissions())
        .await
        .unwrap();

    let changed = ExtendSessionJsonRewriteParams {
        additional_seconds: 120,
        ..request
    };
    assert_eq!(
        state
            .extend_session_json_rewrite(changed, CLIENT, automation_permissions())
            .await
            .unwrap_err()
            .code,
        "IDEMPOTENCY_CONFLICT"
    );

    let long = ExtendSessionJsonRewriteParams {
        additional_seconds: 3600,
        ..extension(&created, "renewal-too-long-test")
    };
    assert_eq!(
        state
            .extend_session_json_rewrite(long, CLIENT, automation_permissions())
            .await
            .unwrap_err()
            .code,
        "TTL_LIMIT_EXCEEDED"
    );
    assert_eq!(state.read_rewrite_manager().list_rules().len(), 1);
}

#[tokio::test]
async fn expired_and_cleaned_rule_reactivates_once_from_the_new_activation() {
    let harness = test_harness();
    let state = &harness.state;
    let created = create(state).await;
    force_deadline(state, &created, Utc::now() - chrono::Duration::seconds(2));
    assert_eq!(state.cleanup_expired_automation().await.unwrap(), 1);
    assert!(state.read_rewrite_manager().list_rules().is_empty());
    let request = extension(&created, "expired-renewal-test-1");

    let restored = state
        .extend_session_json_rewrite(request.clone(), CLIENT, automation_permissions())
        .await
        .unwrap();
    let repeat = state
        .extend_session_json_rewrite(request, CLIENT, automation_permissions())
        .await
        .unwrap();

    assert_eq!(restored["status"], "active");
    assert_eq!(restored["reactivated"], true);
    assert_eq!(restored["ruleId"], created["ruleId"]);
    assert_eq!(restored["changeId"], created["changeId"]);
    assert_ne!(restored["activatedAt"], created["activatedAt"]);
    assert_eq!(restored["expiresAt"], repeat["expiresAt"]);
    assert_eq!(repeat["idempotent"], true);
    assert_eq!(
        parse_time(restored["expiresAt"].as_str().unwrap()).unwrap()
            - parse_time(restored["activatedAt"].as_str().unwrap()).unwrap(),
        chrono::Duration::minutes(10)
    );
    assert_eq!(state.read_rewrite_manager().list_rules().len(), 1);
}

#[tokio::test]
async fn expired_rule_reactivation_checks_current_http2_before_writing() {
    let harness = test_harness();
    let state = &harness.state;
    let created = create(state).await;
    force_deadline(state, &created, Utc::now() - chrono::Duration::seconds(2));
    assert_eq!(state.cleanup_expired_automation().await.unwrap(), 1);
    state.start_proxy(8888, true, true, WORKSPACE_ID.to_owned());
    state
        .upsert_session_async(capture(
            "blocking-http2",
            URL,
            &Utc::now().to_rfc3339(),
            "2",
        ))
        .await;

    let result = state
        .extend_session_json_rewrite(
            extension(&created, "blocked-expired-test1"),
            CLIENT,
            automation_permissions(),
        )
        .await
        .unwrap();

    assert_eq!(result["status"], "blocked");
    assert_eq!(
        result["preflight"]["code"],
        "HTTP2_BODY_REWRITE_UNSUPPORTED"
    );
    assert_eq!(result["preflight"]["evidenceSessionId"], "blocking-http2");
    assert!(state.read_rewrite_manager().list_rules().is_empty());
}

#[tokio::test]
async fn renewal_database_failure_keeps_the_original_deadline_and_snapshot() {
    let harness = test_harness();
    let state = &harness.state;
    let created = create(state).await;
    let generation = state.read_rewrite_manager().runtime_generation();
    state
        .lock_db_for_ipc()
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER reject_renewal BEFORE UPDATE OF expires_at ON automation_resources
         BEGIN SELECT RAISE(ABORT, 'test renewal failure'); END;",
        )
        .unwrap();

    let result = state
        .extend_session_json_rewrite(
            extension(&created, "renewal-write-failure"),
            CLIENT,
            automation_permissions(),
        )
        .await;

    assert!(result.is_err());
    let conn = state.lock_db_for_ipc().unwrap();
    let stored =
        automation::load_automation_change_set(&conn, created["changeId"].as_str().unwrap())
            .unwrap()
            .unwrap();
    assert_eq!(stored.expires_at.as_deref(), created["expiresAt"].as_str());
    assert!(serde_json::from_str::<Value>(&stored.summary_json)
        .unwrap()
        .get("renewals")
        .is_none());
    assert_eq!(
        state.read_rewrite_manager().runtime_generation(),
        generation
    );
}

#[tokio::test]
async fn matching_http2_skip_is_not_verified_even_when_the_body_has_the_expected_value() {
    let harness = test_harness();
    let state = &harness.state;
    let created = create(state).await;
    let mut session = evidence(
        "h2-skipped",
        &Utc::now().to_rfc3339(),
        &created,
        "skipped",
        json!(1),
    );
    session.summary.http_version = "2".into();
    state.upsert_session_async(session).await;

    let result = state
        .wait_for_session_json_rewrite(wait(&created, None), automation_permissions())
        .await
        .unwrap();

    assert_eq!(result["status"], "skipped");
    assert_eq!(result["code"], "HTTP2_BODY_REWRITE_UNSUPPORTED");
    assert_eq!(result["ruleTrace"]["outcome"], "skipped");
    assert_eq!(result["assertion"]["actual"], 1);
    assert_eq!(result["evidenceLevel"], "external");
}

#[tokio::test]
async fn verification_compares_json_types_and_persists_the_failed_assertion() {
    let harness = test_harness();
    let state = &harness.state;
    let created = create(state).await;
    let session = evidence(
        "typed-mismatch",
        &Utc::now().to_rfc3339(),
        &created,
        "success",
        json!("1"),
    );
    state.upsert_session_async(session).await;

    let result = state
        .wait_for_session_json_rewrite(wait(&created, None), automation_permissions())
        .await
        .unwrap();

    assert_eq!(result["status"], "mismatch");
    assert_eq!(result["code"], "VALUE_MISMATCH");
    assert_eq!(result["assertion"]["actual"], "1");
    assert_eq!(result["assertion"]["expected"], 1);
    assert_eq!(result["assertion"]["passed"], false);
    let change = state
        .get_automation_change(GetAutomationChangeParams {
            change_id: created["changeId"].as_str().unwrap().into(),
        })
        .unwrap();
    assert_eq!(change.verifications.len(), 1);
}

#[tokio::test]
async fn waiting_ignores_stale_replayed_controlled_and_other_route_captures() {
    let harness = test_harness();
    let state = &harness.state;
    let created = create(state).await;
    let now = &Utc::now().to_rfc3339();
    let mut replay = evidence("direct-replay", now, &created, "success", json!(1));
    replay.timing_source = Some("agentReplay".into());
    let mut controlled = evidence("controlled-probe", now, &created, "success", json!(1));
    controlled.request_headers.push(ProxyHeaderEntry {
        name: AUTOMATION_VERIFICATION_HEADER.into(),
        value: "1".into(),
        is_pseudo: None,
    });
    let stale = evidence(
        "old-capture",
        "2020-01-01T00:00:00Z",
        &created,
        "success",
        json!(1),
    );
    let other = capture(
        "different-route",
        "https://api.example.test/api/?_method=launch",
        now,
        "1.1",
    );
    for session in [replay, controlled, stale, other] {
        state.upsert_session_async(session).await;
    }

    let result = state
        .wait_for_session_json_rewrite(wait(&created, None), automation_permissions())
        .await
        .unwrap();

    assert_eq!(result["status"], "timed_out");
    assert!(result.get("verificationId").is_none());
}

#[tokio::test]
async fn verification_cursor_ignores_preceding_captures() {
    let harness = test_harness();
    let state = &harness.state;
    let created = create(state).await;
    let first = evidence(
        "first-matching",
        &Utc::now().to_rfc3339(),
        &created,
        "success",
        json!(1),
    );
    state.upsert_session_async(first).await;
    let cursor = aiproxy_db::session_completion::read_completion_watermark(
        &state.lock_db_for_ipc().unwrap(),
    )
    .unwrap()
    .unwrap()
    .encode();
    let second = evidence(
        "second-matching",
        &Utc::now().to_rfc3339(),
        &created,
        "success",
        json!(1),
    );
    state.upsert_session_async(second).await;

    let result = state
        .wait_for_session_json_rewrite(
            wait(&created, Some(cursor.clone())),
            automation_permissions(),
        )
        .await
        .unwrap();

    assert_eq!(result["status"], "verified");
    assert_eq!(result["sessionId"], "second-matching");
    assert_ne!(result["watermark"], cursor);

    let legacy = serde_json::from_value(json!({
        "changeId": created["changeId"],
        "afterRowid": 1000,
        "timeoutMs": 1000,
    }))
    .unwrap();
    let replay = state
        .wait_for_session_json_rewrite(legacy, automation_permissions())
        .await
        .unwrap();
    assert_eq!(replay["cursorCompatibility"], "legacyReplay");
    assert_eq!(replay["sessionId"], "first-matching");
    assert!(replay["watermark"].as_str().unwrap().starts_with("w2:"));
}

#[tokio::test]
async fn waiting_returns_expired_when_the_rule_reaches_its_deadline() {
    let harness = test_harness();
    let state = &harness.state;
    let created = create(state).await;
    force_deadline(
        state,
        &created,
        Utc::now() + chrono::Duration::milliseconds(120),
    );

    let result = state
        .wait_for_session_json_rewrite(wait(&created, None), automation_permissions())
        .await
        .unwrap();

    assert_eq!(result["status"], "expired");
    assert!(result.get("verificationId").is_none());
}

#[tokio::test]
async fn reactivation_verifies_only_logs_from_the_new_activation() {
    let harness = test_harness();
    let state = &harness.state;
    let created = create(state).await;
    let old = evidence(
        "previous-activation",
        &Utc::now().to_rfc3339(),
        &created,
        "success",
        json!(1),
    );
    state.upsert_session_async(old).await;
    force_deadline(state, &created, Utc::now() - chrono::Duration::seconds(1));
    assert_eq!(state.cleanup_expired_automation().await.unwrap(), 1);
    let restored = state
        .extend_session_json_rewrite(
            extension(&created, "verification-after-renewal"),
            CLIENT,
            automation_permissions(),
        )
        .await
        .unwrap();
    let fresh = evidence(
        "new-activation",
        &Utc::now().to_rfc3339(),
        &restored,
        "success",
        json!(1),
    );
    state.upsert_session_async(fresh).await;

    let result = state
        .wait_for_session_json_rewrite(wait(&restored, None), automation_permissions())
        .await
        .unwrap();

    assert_eq!(result["status"], "verified");
    assert_eq!(result["sessionId"], "new-activation");
}

#[tokio::test]
async fn renewed_deadline_allows_an_existing_wait_to_receive_later_evidence() {
    let harness = test_harness();
    let state = &harness.state;
    let created = create(state).await;
    force_deadline(
        state,
        &created,
        Utc::now() + chrono::Duration::milliseconds(150),
    );
    let wait = state.wait_for_session_json_rewrite(wait(&created, None), automation_permissions());
    let live_traffic = async {
        let restored = state
            .extend_session_json_rewrite(
                extension(&created, "renew-while-waiting"),
                CLIENT,
                automation_permissions(),
            )
            .await
            .unwrap();
        assert_eq!(restored["reactivated"], false);
        tokio::time::sleep(Duration::from_millis(200)).await;
        let session = evidence(
            "later-matching",
            &Utc::now().to_rfc3339(),
            &created,
            "success",
            json!(1),
        );
        state.upsert_session_async(session).await;
    };
    let (result, ()) = tokio::join!(wait, live_traffic);

    assert_eq!(result.unwrap()["status"], "verified");
}

use aiproxy_agent_control::WaitForSessionJsonRewriteParams;
use aiproxy_db::rules::{
    load_rewrite_run_entries, load_rewrite_runs_for_session, RewriteRunEntryRow, RewriteRunRow,
};
use aiproxy_db::rusqlite::OptionalExtension;
use aiproxy_db::session_search::{search_sessions, SessionSearchFilter, SortOrder};
use aiproxy_proxy_core::{read_json_field, ProxySessionDetail, AUTOMATION_VERIFICATION_HEADER};

use super::*;

const POLL_INTERVAL: Duration = Duration::from_millis(300);
const PAGE_SIZE: usize = 100;
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
const MAX_SCALAR_BYTES: usize = 1024;

struct CapturedRewriteTrace {
    run: RewriteRunRow,
    entries: Vec<RewriteRunEntryRow>,
}

impl AppState {
    pub(crate) async fn wait_for_session_json_rewrite(
        &self,
        params: WaitForSessionJsonRewriteParams,
        permissions: AutomationPermissions,
    ) -> Result<Value, AutomationError> {
        if !permissions.manage_automation {
            return Err(AutomationError::new(
                "CONTROL_PERMISSION_DENIED",
                "manageAutomation is disabled.",
            ));
        }
        if params.change_id.is_empty()
            || params.change_id.len() > 128
            || !(1000..=30_000).contains(&params.timeout_ms)
            || params.after_rowid.is_some_and(|rowid| rowid < 0)
        {
            return Err(AutomationError::new(
                "INVALID_ARGUMENT",
                "changeId, timeoutMs, or session watermark is invalid.",
            ));
        }
        let target = {
            let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
            let change = load_wait_change(&conn, &params.change_id)?.ok_or_else(|| {
                AutomationError::new("NOT_FOUND", "Temporary rewrite change not found.")
            })?;
            load_session_rewrite_target(&conn, change)?
        };
        let Some(activated_at) = target.change.activated_at.as_deref().and_then(parse_time) else {
            return Ok(wait_result(&target, "expired", params.after_rowid));
        };
        let filter = SessionSearchFilter {
            host: target.pattern.host_str().map(str::to_owned),
            method: Some(target.method.clone()),
            path_contains: Some(target.pattern.path().to_owned()),
            query_params: target.pattern.query_pairs().into_owned().collect(),
            started_after: Some(activated_at.to_rfc3339()),
            after_rowid: params.after_rowid,
            completed_only: true,
            sort_order: SortOrder::Asc,
            ..SessionSearchFilter::default()
        };
        let deadline = tokio::time::Instant::now() + Duration::from_millis(params.timeout_ms);
        let mut examined = HashSet::new();

        loop {
            let Some(expires_at) = self.wait_expiry(&target)? else {
                return Ok(wait_result(&target, "expired", params.after_rowid));
            };
            let mut cursor = None;
            loop {
                let page = {
                    let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
                    search_sessions(&conn, &filter, PAGE_SIZE, cursor.as_deref()).map_err(
                        |error| {
                            AutomationError::internal(format!("search rewrite evidence: {error}"))
                        },
                    )?
                };
                for row in page.items {
                    let eligible = parse_time(&row.started_at)
                        .is_some_and(|start| start >= activated_at)
                        && Url::parse(&row.url)
                            .is_ok_and(|url| session_rewrite_url_matches(&target.pattern, &url));
                    if !eligible || !examined.insert(row.id.clone()) {
                        continue;
                    }
                    let Some(detail) = self
                        .read_session_detail(&row.id)
                        .map_err(AutomationError::internal)?
                    else {
                        continue;
                    };
                    if !is_external_capture(&detail) {
                        continue;
                    }
                    let trace = self.captured_rewrite_trace(&target, &detail.id)?;
                    if trace.is_none() && !current_listener_capture(self, &target, &detail) {
                        continue;
                    }

                    // All wait time stays outside the mutation lock. Once a
                    // candidate exists, recheck the activation before recording it.
                    let _automation = self.automation_mutation_lock().lock().await;
                    if self.wait_expiry(&target)?.is_none() {
                        return Ok(wait_result(&target, "expired", params.after_rowid));
                    }
                    self.ensure_verification_targets_current(&target.change)?;
                    return self.record_session_rewrite_verification(
                        &target,
                        &detail,
                        trace.as_ref(),
                        params.after_rowid,
                    );
                }
                if tokio::time::Instant::now() >= deadline {
                    return Ok(wait_result(&target, "timed_out", params.after_rowid));
                }
                let Some(next) = page.next_cursor else { break };
                cursor = Some(next);
            }
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let until_expiry = (expires_at - Utc::now()).to_std().unwrap_or_default();
            tokio::time::sleep(POLL_INTERVAL.min(remaining).min(until_expiry)).await;
        }
    }

    fn wait_expiry(
        &self,
        target: &SessionRewriteTarget,
    ) -> Result<Option<DateTime<Utc>>, AutomationError> {
        let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
        let expiry = load_wait_change(&conn, &target.change.id)?
            .filter(|change| {
                change.status == "active" && change.activated_at == target.change.activated_at
            })
            .and_then(|change| change.expires_at.as_deref().and_then(parse_time))
            .filter(|deadline| *deadline > Utc::now());
        Ok(expiry)
    }

    fn captured_rewrite_trace(
        &self,
        target: &SessionRewriteTarget,
        session_id: &str,
    ) -> Result<Option<CapturedRewriteTrace>, AutomationError> {
        // Session details loaded from SQLite omit rule traces, which have
        // their own persisted rows. Fetch the same trace the inspector shows.
        let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
        let map_error =
            |error| AutomationError::internal(format!("read captured rewrite trace: {error}"));
        let run = load_rewrite_runs_for_session(&conn, session_id)
            .map_err(map_error)?
            .into_iter()
            .find(|run| {
                run.rule_id == target.rule.id
                    && run.workspace_id == target.rule.workspace_id
                    && run.stage == "response"
            });
        let Some(run) = run else { return Ok(None) };
        let entries =
            load_rewrite_run_entries(&conn, std::slice::from_ref(&run.id)).map_err(map_error)?;
        Ok(Some(CapturedRewriteTrace { run, entries }))
    }

    fn record_session_rewrite_verification(
        &self,
        target: &SessionRewriteTarget,
        detail: &ProxySessionDetail,
        trace: Option<&CapturedRewriteTrace>,
        after_rowid: Option<i64>,
    ) -> Result<Value, AutomationError> {
        let actual = captured_field(detail, &target.path);
        let equal = actual
            .as_ref()
            .is_some_and(|value| value == &target.expected);
        if self.wait_expiry(target)?.is_none() {
            return Ok(wait_result(target, "expired", after_rowid));
        }
        let (status, code, verification_status) = match trace
            .map(|trace| trace.run.outcome.as_str())
        {
            Some("skipped") => (
                "skipped",
                if is_http2(&detail.summary.http_version) && !supports_response_body_rewrite(true) {
                    "HTTP2_BODY_REWRITE_UNSUPPORTED"
                } else {
                    "REWRITE_SKIPPED"
                },
                "rule_failed",
            ),
            Some("success") if equal => ("verified", "VERIFIED", "passed"),
            Some("success") => (
                "mismatch",
                if actual.is_some() {
                    "VALUE_MISMATCH"
                } else {
                    "RESPONSE_FIELD_UNAVAILABLE"
                },
                "assertion_failed",
            ),
            Some(_) => ("mismatch", "REWRITE_FAILED", "rule_failed"),
            None if detail
                .failure
                .as_ref()
                .is_some_and(|failure| failure.origin == "upstream") =>
            {
                ("mismatch", "UPSTREAM_FAILED", "upstream_failed")
            }
            None => ("mismatch", "RULE_NOT_MATCHED", "not_matched"),
        };

        let session_id = detail.id.clone();
        let matched = trace
            .map(|trace| trace.run.rule_id.clone())
            .into_iter()
            .collect::<Vec<_>>();
        let actual = actual.filter(is_displayable_scalar);
        let expectation = AutomationAssertion {
            id: "response-json-field".into(),
            subject: "responseBody".into(),
            path: Some(target.path.clone()),
            operator: "equals".into(),
            expected: Some(target.expected.clone()),
        };
        let options = VerifyAutomationChangeParams {
            change_id: target.change.id.clone(),
            mode: "external".into(),
            baseline_session_ids: Vec::new(),
            requests: Vec::new(),
            external_session_ids: vec![session_id.clone()],
            assertions: vec![expectation],
        };
        let evidence = AutomationVerificationRequestResult {
            r#ref: session_id.clone(),
            status: verification_status.into(),
            matched_rule_ids: matched,
            rule_trace_refs: trace
                .map(|trace| trace.run.id.clone())
                .into_iter()
                .collect(),
            assertions: vec![AutomationAssertionResult {
                id: "response-json-field".into(),
                subject: "responseBody".into(),
                path: Some(target.path.clone()),
                passed: equal,
                message: if equal {
                    "The captured JSON value matches."
                } else {
                    "The captured JSON value could not be confirmed."
                }
                .into(),
                actual: actual.clone(),
            }],
            evidence_session_ids: vec![session_id.clone()],
            response_status: Some(detail.summary.status_code),
            final_url: None,
            conflict: None,
        };
        let watermark = {
            let conn = self.lock_db_for_ipc().map_err(AutomationError::internal)?;
            conn.query_row(
                "SELECT rowid FROM session_summaries WHERE id=?1",
                [&session_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| {
                AutomationError::internal(format!("read evidence watermark: {error}"))
            })?
        };
        let verified = self.persist_verification(
            &target.change,
            &options,
            &[evidence],
            std::slice::from_ref(&session_id),
            &["External evidence covers the captured HTTP response and its rewrite trace.".into()],
        )?;
        let mut result = wait_result(target, status, watermark);
        result["code"] = json!(code);
        result["sessionId"] = json!(session_id);
        result["responseStatus"] = json!(detail.summary.status_code);
        result["evidenceLevel"] = json!("external");
        result["verificationId"] = json!(verified.verification_id);
        result["assertion"] = json!({
            "subject": "responseBody", "path": target.path, "actual": actual,
            "expected": target.expected, "valueAvailable": actual.is_some(), "passed": equal,
        });
        result["ruleTrace"] = json!(trace.map(|trace| {
            json!({
                "id": trace.run.id, "ruleId": trace.run.rule_id,
                "outcome": trace.run.outcome, "stage": trace.run.stage,
                "entries": trace.entries.iter().map(|entry| {
                    json!({ "kind": entry.kind, "key": entry.key, "message": entry.message })
                }).collect::<Vec<_>>(),
            })
        }));
        Ok(result)
    }
}

fn load_wait_change(
    conn: &aiproxy_db::rusqlite::Connection,
    id: &str,
) -> Result<Option<AutomationChangeSetRow>, AutomationError> {
    automation::load_automation_change_set(conn, id)
        .map_err(|error| AutomationError::internal(format!("load temporary rewrite: {error}")))
}

fn wait_result(target: &SessionRewriteTarget, status: &str, watermark: Option<i64>) -> Value {
    json!({
        "status": status, "ruleId": target.rule.id, "changeId": target.change.id,
        "watermark": watermark.map(|rowid| format!("w1:{rowid}")),
    })
}

fn is_external_capture(detail: &ProxySessionDetail) -> bool {
    detail.timing_source.as_deref() != Some("agentReplay")
        && !detail.request_headers.iter().any(|header| {
            header
                .name
                .eq_ignore_ascii_case(AUTOMATION_VERIFICATION_HEADER)
        })
}

fn current_listener_capture(
    state: &AppState,
    target: &SessionRewriteTarget,
    detail: &ProxySessionDetail,
) -> bool {
    // Without a trace, use only the current listener to attribute the request
    // to the target workspace. Older sessions have no persisted workspace ID.
    let status = state.read_status();
    status.running
        && status.active_workspace_id.as_deref() == Some(target.rule.workspace_id.as_str())
        && status
            .started_at
            .as_deref()
            .and_then(parse_time)
            .zip(parse_time(&detail.summary.started_at))
            .is_some_and(|(listener_start, request_start)| request_start >= listener_start)
}

fn captured_field(detail: &ProxySessionDetail, path: &str) -> Option<Value> {
    let body = detail.response_body.as_ref()?;
    if body.truncated {
        return None;
    }
    let document: Value = if let Some(bytes) = body.in_memory_bytes() {
        if bytes.len() > MAX_BODY_BYTES {
            return None;
        }
        serde_json::from_slice(bytes).ok()?
    } else {
        let file = std::fs::File::open(body.file_path()?).ok()?;
        if file.metadata().ok()?.len() > MAX_BODY_BYTES as u64 {
            return None;
        }
        serde_json::from_reader(std::io::BufReader::new(file)).ok()?
    };
    read_json_field(&document, path).cloned()
}

fn is_displayable_scalar(value: &Value) -> bool {
    !value.is_array()
        && !value.is_object()
        && value
            .as_str()
            .is_none_or(|text| text.len() <= MAX_SCALAR_BYTES)
}

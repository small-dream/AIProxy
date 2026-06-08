use aiproxy_db::body_store::{BodyStore, BODY_FILE_THRESHOLD};
use aiproxy_db::rules::{
    BreakpointRuleRow, DnsMappingRow, MapRuleRow, RewriteRuleRow, ScriptRuleRow,
    ThrottleProfileRow, ThrottleRuleRow,
};
use aiproxy_db::sessions::{SessionDetailRow, SessionSummaryRow};
use aiproxy_db::workspaces::WorkspaceRow;
use aiproxy_proxy_core::{
    BreakpointRule, BreakpointStage, CompiledScriptRule, DnsMappingRule, MapRule,
    ProxyBodyReference, ProxyHeaderEntry, ProxySessionDetail, ProxySessionSummary,
    ProxyTimingBreakdown, RewriteRule, RewriteRuleMatch, ScriptEntrypoints, ScriptRule,
    ScriptRuleLanguage, ScriptRuleSourceType, ThrottleProfileData, ThrottleRuleData,
};

use crate::workspace::WorkspaceData;

// ---------------------------------------------------------------------------
// Conversion helpers: DB rows <-> domain types
// ---------------------------------------------------------------------------

pub(crate) fn workspace_row_to_data(row: WorkspaceRow) -> WorkspaceData {
    WorkspaceData {
        id: row.id,
        name: row.name,
        proxy_port: row.proxy_port,
        ssl_enabled: row.ssl_enabled,
        http2_enabled: row.http2_enabled,
        system_proxy_enabled: row.system_proxy_enabled,
        storage_path: row.storage_path,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

pub(crate) fn rewrite_row_to_rule(row: RewriteRuleRow) -> RewriteRule {
    RewriteRule {
        id: row.id,
        enabled: row.enabled,
        name: row.name,
        note: row.note,
        priority: row.priority,
        r#match: RewriteRuleMatch {
            methods: serde_json::from_str(&row.match_methods).unwrap_or_default(),
            stage: row.match_stage,
            url_pattern: row.match_url_pattern,
            match_type: if row.match_type.is_empty() {
                None
            } else {
                Some(row.match_type)
            },
        },
        rewrite_type: row.rewrite_type,
        workspace_id: row.workspace_id,
        payload: serde_json::from_str(&row.payload).unwrap_or(serde_json::Value::Null),
    }
}

pub(crate) fn map_row_to_rule(row: MapRuleRow) -> MapRule {
    MapRule {
        id: row.id,
        enabled: row.enabled,
        mode: row.mode,
        name: row.name,
        note: row.note,
        preserve_path: row.preserve_path,
        preserve_query: row.preserve_query,
        priority: row.priority,
        source_pattern: row.source_pattern,
        target_value: row.target_value,
        workspace_id: row.workspace_id,
    }
}

pub(crate) fn throttle_row_to_profile(row: ThrottleProfileRow) -> ThrottleProfileData {
    ThrottleProfileData {
        id: row.id,
        download_kbps: row.download_kbps,
        enabled: row.enabled,
        latency_ms: row.latency_ms,
        name: row.name,
        note: row.note,
        packet_loss_ratio: row.packet_loss_ratio,
        preset: row.preset,
        upload_kbps: row.upload_kbps,
        workspace_id: row.workspace_id,
    }
}

pub(crate) fn throttle_row_to_rule(row: ThrottleRuleRow) -> ThrottleRuleData {
    ThrottleRuleData {
        id: row.id,
        enabled: row.enabled,
        methods: serde_json::from_str(&row.methods).unwrap_or_default(),
        name: row.name,
        note: row.note,
        priority: row.priority,
        profile_id: row.profile_id,
        stage: row.stage,
        url_pattern: row.url_pattern,
        workspace_id: row.workspace_id,
    }
}

pub(crate) fn breakpoint_row_to_rule(row: BreakpointRuleRow) -> BreakpointRule {
    BreakpointRule {
        id: row.id,
        enabled: row.enabled,
        url_pattern: row.url_pattern,
        methods: serde_json::from_str(&row.methods).unwrap_or_default(),
        stage: match row.stage.as_str() {
            "Response" => BreakpointStage::Response,
            _ => BreakpointStage::Request,
        },
        match_type: if row.match_type.is_empty() {
            None
        } else {
            Some(row.match_type)
        },
    }
}

pub(crate) fn summary_row_to_proxy(row: SessionSummaryRow) -> ProxySessionSummary {
    ProxySessionSummary {
        id: row.id,
        method: row.method,
        host: row.host,
        path: row.path,
        protocol: row.protocol,
        scheme: row.scheme,
        http_version: row.http_version,
        transport_protocol: row.transport_protocol,
        application_protocol: row.application_protocol,
        started_at: row.started_at,
        finished_at: row.finished_at,
        duration_ms: row.duration_ms,
        size_bytes: row.size_bytes,
        status_code: row.status_code,
        url: row.url,
        response_mime_type: row.response_mime_type,
    }
}

fn headers_from_json(json: &str) -> Vec<ProxyHeaderEntry> {
    serde_json::from_str(json).unwrap_or_default()
}

fn body_ref_from_json(json: Option<&str>, body_store: &BodyStore) -> Option<ProxyBodyReference> {
    json.and_then(|j| {
        let v: serde_json::Value = serde_json::from_str(j).ok()?;
        let file_path = v
            .get("file_path")
            .and_then(|value| value.as_str())
            .map(|path| {
                body_store
                    .resolve_body_path(path)
                    .to_string_lossy()
                    .into_owned()
            });

        ProxyBodyReference::from_serialized_fields(
            v.get("inline_text")
                .and_then(|value| value.as_str())
                .map(String::from),
            v.get("base64_text")
                .and_then(|value| value.as_str())
                .map(String::from),
            v.get("mime_type")
                .and_then(|value| value.as_str())
                .map(String::from),
            v.get("encoding")
                .and_then(|value| value.as_str())
                .map(String::from),
            v.get("size_bytes")
                .and_then(|value| value.as_u64())
                .unwrap_or(0) as usize,
            v.get("truncated")
                .and_then(|value| value.as_bool())
                .unwrap_or(false),
            file_path,
        )
    })
}

pub(crate) fn detail_row_to_proxy(
    row: &SessionDetailRow,
    summary: ProxySessionSummary,
    body_store: &BodyStore,
) -> ProxySessionDetail {
    let timing_json_value = row.timing.as_ref().and_then(|j| {
        let v: serde_json::Value = serde_json::from_str(j).ok()?;
        Some(v)
    });

    let timing = timing_json_value.as_ref().map(|v| ProxyTimingBreakdown {
        connect_ms: v
            .get("connect_ms")
            .and_then(|v| v.as_u64())
            .map(|v| v as u128),
        dns_ms: v.get("dns_ms").and_then(|v| v.as_u64()).map(|v| v as u128),
        request_send_ms: v
            .get("request_send_ms")
            .and_then(|v| v.as_u64())
            .map(|v| v as u128),
        response_read_ms: v
            .get("response_read_ms")
            .and_then(|v| v.as_u64())
            .map(|v| v as u128),
        tls_ms: v.get("tls_ms").and_then(|v| v.as_u64()).map(|v| v as u128),
        total_ms: v
            .get("total_ms")
            .and_then(|v| v.as_u64())
            .map(|v| v as u128),
        waiting_ms: v
            .get("waiting_ms")
            .and_then(|v| v.as_u64())
            .map(|v| v as u128),
    });

    let timing_source = timing_json_value
        .as_ref()
        .and_then(|v| v.get("timing_source"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let trailers = row
        .trailers
        .as_ref()
        .and_then(|json| serde_json::from_str(json).ok());

    ProxySessionDetail {
        client_address: row.client_address.clone(),
        id: row.session_summary_id.clone(),
        query_params: headers_from_json(&row.query_params),
        cookies: headers_from_json(&row.cookies),
        raw_request_head: row.raw_request.as_deref().map(extract_raw_message_head),
        raw_response_head: row.raw_response.as_deref().map(extract_raw_message_head),
        request_body: body_ref_from_json(row.request_body_ref.as_deref(), body_store),
        request_headers: headers_from_json(&row.request_headers),
        response_body: body_ref_from_json(row.response_body_ref.as_deref(), body_store),
        response_headers: headers_from_json(&row.response_headers),
        map_traces: Vec::new(),
        rewrite_traces: Vec::new(),
        server_ip: row.server_ip.clone(),
        script_traces: Vec::new(),
        summary,
        throttle_traces: Vec::new(),
        tls_cipher_suite: row.tls_cipher_suite.clone(),
        tls_protocol: row.tls_protocol.clone(),
        timing,
        timing_source,
        trailers,
        h2_stream_id: row.h2_stream_id,
    }
}

fn body_to_json(body: &Option<ProxyBodyReference>, body_store: &BodyStore) -> Option<String> {
    body.as_ref().map(|b| {
        let mut body_json = serde_json::json!({
            "size_bytes": b.size_bytes,
            "truncated": b.truncated,
        });
        if let Some(ref mime) = b.mime_type {
            body_json["mime_type"] = serde_json::Value::String(mime.clone());
        }
        if let Some(ref enc) = b.encoding {
            body_json["encoding"] = serde_json::Value::String(enc.clone());
        }
        if let Some(file_path) = b.file_path() {
            if let Some(relative_path) =
                body_store.relative_body_path(std::path::Path::new(file_path))
            {
                body_json["file_path"] = serde_json::Value::String(relative_path);
            }
        } else {
            if let Some(text) = b.inline_text() {
                body_json["inline_text"] = serde_json::Value::String(text);
            }
            if let Some(b64) = b.base64_text() {
                body_json["base64_text"] = serde_json::Value::String(b64);
            }
        }
        body_json.to_string()
    })
}

pub(crate) fn proxy_summary_to_row(summary: &ProxySessionSummary) -> SessionSummaryRow {
    SessionSummaryRow {
        id: summary.id.clone(),
        method: summary.method.clone(),
        host: summary.host.clone(),
        path: summary.path.clone(),
        protocol: summary.protocol.clone(),
        scheme: summary.scheme.clone(),
        http_version: summary.http_version.clone(),
        transport_protocol: summary.transport_protocol.clone(),
        application_protocol: summary.application_protocol.clone(),
        started_at: summary.started_at.clone(),
        finished_at: summary.finished_at.clone(),
        duration_ms: summary.duration_ms,
        size_bytes: summary.size_bytes,
        status_code: summary.status_code,
        url: summary.url.clone(),
        response_mime_type: summary.response_mime_type.clone(),
    }
}

pub(crate) fn proxy_detail_to_row(
    detail: &ProxySessionDetail,
    body_store: &BodyStore,
) -> SessionDetailRow {
    let timing_json = detail.timing.as_ref().map(|t| {
        let mut v = serde_json::json!({});
        if let Some(ms) = t.connect_ms {
            v["connect_ms"] = serde_json::json!(ms);
        }
        if let Some(ms) = t.dns_ms {
            v["dns_ms"] = serde_json::json!(ms);
        }
        if let Some(ms) = t.request_send_ms {
            v["request_send_ms"] = serde_json::json!(ms);
        }
        if let Some(ms) = t.response_read_ms {
            v["response_read_ms"] = serde_json::json!(ms);
        }
        if let Some(ms) = t.tls_ms {
            v["tls_ms"] = serde_json::json!(ms);
        }
        if let Some(ms) = t.total_ms {
            v["total_ms"] = serde_json::json!(ms);
        }
        if let Some(ms) = t.waiting_ms {
            v["waiting_ms"] = serde_json::json!(ms);
        }
        if let Some(ref source) = detail.timing_source {
            v["timing_source"] = serde_json::json!(source);
        }
        v.to_string()
    });

    SessionDetailRow {
        id: format!("{}-detail", detail.id),
        session_summary_id: detail.id.clone(),
        query_params: serde_json::to_string(&detail.query_params).unwrap_or_else(|_| "[]".into()),
        cookies: serde_json::to_string(&detail.cookies).unwrap_or_else(|_| "[]".into()),
        request_headers: serde_json::to_string(&detail.request_headers)
            .unwrap_or_else(|_| "[]".into()),
        response_headers: serde_json::to_string(&detail.response_headers)
            .unwrap_or_else(|_| "[]".into()),
        raw_request: detail.raw_request_head.clone(),
        raw_response: detail.raw_response_head.clone(),
        client_address: detail.client_address.clone(),
        server_ip: detail.server_ip.clone(),
        tls_cipher_suite: detail.tls_cipher_suite.clone(),
        tls_protocol: detail.tls_protocol.clone(),
        request_body_ref: body_to_json(&detail.request_body, body_store),
        response_body_ref: body_to_json(&detail.response_body, body_store),
        timing: timing_json,
        trailers: detail
            .trailers
            .as_ref()
            .map(|t| serde_json::to_string(t).unwrap_or_else(|_| "[]".into())),
        h2_stream_id: detail.h2_stream_id,
    }
}

pub(crate) fn extract_raw_message_head(raw_message: &str) -> String {
    match raw_message.find("\r\n\r\n") {
        Some(index) => raw_message[..index + 4].to_string(),
        None => raw_message.to_string(),
    }
}

pub(crate) fn spill_session_bodies_to_disk(
    detail: &mut ProxySessionDetail,
    body_store: &BodyStore,
) -> Result<(), String> {
    spill_body_reference_to_disk(&detail.id, "request", &mut detail.request_body, body_store)?;
    spill_body_reference_to_disk(
        &detail.id,
        "response",
        &mut detail.response_body,
        body_store,
    )?;
    Ok(())
}

fn spill_body_reference_to_disk(
    session_id: &str,
    kind: &str,
    body: &mut Option<ProxyBodyReference>,
    body_store: &BodyStore,
) -> Result<(), String> {
    let Some(body) = body.as_mut() else {
        return Ok(());
    };

    if body.file_path().is_some() || body.size_bytes < BODY_FILE_THRESHOLD {
        return Ok(());
    }

    let Some(bytes) = body.in_memory_bytes() else {
        return Ok(());
    };

    let relative_path = body_store.write_body(session_id, kind, bytes).map_err(|e| e.to_string())?;
    let full_path = body_store.resolve_body_path(&relative_path);
    body.replace_with_file_path(full_path.to_string_lossy().into_owned());
    Ok(())
}

pub(crate) fn dns_mapping_row_to_rule(row: DnsMappingRow) -> DnsMappingRule {
    DnsMappingRule {
        id: row.id,
        enabled: row.enabled,
        name: row.name,
        note: row.note,
        priority: row.priority,
        host_pattern: row.host_pattern,
        target_ip: row.target_ip,
        workspace_id: row.workspace_id,
    }
}

pub(crate) fn script_row_to_rule(row: ScriptRuleRow) -> CompiledScriptRule {
    let language = match row.language.as_str() {
        "typescript" => ScriptRuleLanguage::TypeScript,
        _ => ScriptRuleLanguage::JavaScript,
    };
    let source_type = match row.source_type.as_str() {
        "fileImport" => ScriptRuleSourceType::FileImport,
        _ => ScriptRuleSourceType::Inline,
    };
    let entrypoints: ScriptEntrypoints =
        serde_json::from_str(&row.entrypoints).unwrap_or(ScriptEntrypoints {
            on_request: false,
            on_response: false,
        });

    CompiledScriptRule {
        rule: ScriptRule {
            id: row.id,
            workspace_id: row.workspace_id,
            name: row.name,
            note: row.note,
            enabled: row.enabled,
            priority: row.priority,
            r#match: aiproxy_proxy_core::ScriptRuleMatch {
                url_pattern: row.match_url_pattern,
                methods: serde_json::from_str(&row.match_methods).unwrap_or_default(),
                stage: row.match_stage,
                match_type: if row.match_type.is_empty() {
                    None
                } else {
                    Some(row.match_type)
                },
            },
            language,
            source_type,
            source_code: row.source_code,
            source_path: row.source_path,
            entrypoints,
        },
        compiled_code: row.compiled_code,
        source_map: row.source_map,
        compiled_match: None,
    }
}

/// Estimate the text bytes of a session detail row for logging purposes.
pub(crate) fn estimate_session_detail_row_text_bytes(row: &SessionDetailRow) -> usize {
    row.id.len()
        + row.session_summary_id.len()
        + row.query_params.len()
        + row.cookies.len()
        + row.request_headers.len()
        + row.response_headers.len()
        + row.raw_request.as_ref().map_or(0, |value| value.len())
        + row.raw_response.as_ref().map_or(0, |value| value.len())
        + row.client_address.as_ref().map_or(0, |value| value.len())
        + row.server_ip.as_ref().map_or(0, |value| value.len())
        + row.tls_cipher_suite.as_ref().map_or(0, |value| value.len())
        + row.tls_protocol.as_ref().map_or(0, |value| value.len())
        + row.request_body_ref.as_ref().map_or(0, |value| value.len())
        + row
            .response_body_ref
            .as_ref()
            .map_or(0, |value| value.len())
        + row.timing.as_ref().map_or(0, |value| value.len())
        + row.trailers.as_ref().map_or(0, |value| value.len())
}

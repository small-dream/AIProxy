use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use serde::{Deserialize, Serialize};
use url::Url;

use super::{
    apply_map_rules_with_snapshot, apply_request_rewrite_rules_with_snapshot,
    apply_response_rewrite_rules_with_snapshot, capture_rule_snapshot,
};
use crate::{
    build_query_params, build_raw_http_head, build_upstream_headers_from_entries, MapManager,
    MapTrace, ParsedProxyRequest, ProxyHeaderEntry, RewriteManager, RewriteTrace, UpstreamResponse,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OfflineHeader {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OfflineRequestInput {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<OfflineHeader>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_base64: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OfflineResponseInput {
    pub status: u16,
    #[serde(default)]
    pub headers: Vec<OfflineHeader>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_base64: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OfflineEvaluationInput {
    pub workspace_id: String,
    pub request: OfflineRequestInput,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_response: Option<OfflineResponseInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OfflineEvaluationResult {
    pub evidence_level: String,
    pub final_url: String,
    pub request_method: String,
    pub request_headers: Vec<OfflineHeader>,
    pub request_body_base64: String,
    pub response_status: Option<u16>,
    pub response_headers: Vec<OfflineHeader>,
    pub response_body_base64: String,
    pub rewrite_traces: Vec<RewriteTrace>,
    pub map_traces: Vec<MapTrace>,
    pub limitations: Vec<String>,
}

pub fn evaluate_offline(
    input: OfflineEvaluationInput,
    rewrite_manager: Arc<RewriteManager>,
    map_manager: Arc<MapManager>,
) -> Result<OfflineEvaluationResult, String> {
    let url = Url::parse(input.request.url.trim())
        .map_err(|error| format!("offline request URL is invalid: {error}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("offline request URL must use http or https".to_string());
    }
    let method = Method::from_bytes(input.request.method.trim().to_ascii_uppercase().as_bytes())
        .map_err(|error| format!("offline request method is invalid: {error}"))?;
    let body = decode_body(input.request.body_base64.as_deref())?;
    let mut request_headers = input
        .request
        .headers
        .into_iter()
        .map(|header| ProxyHeaderEntry {
            name: header.name,
            value: header.value,
            is_pseudo: None,
        })
        .collect::<Vec<_>>();
    if !request_headers
        .iter()
        .any(|header| header.name.eq_ignore_ascii_case("host"))
    {
        request_headers.push(ProxyHeaderEntry {
            name: "Host".to_string(),
            value: host_header(&url),
            is_pseudo: None,
        });
    }
    let headers = build_upstream_headers_from_entries(&request_headers)?;
    let mut request = ParsedProxyRequest {
        body,
        client_address: None,
        headers,
        host: url
            .host_str()
            .ok_or_else(|| "offline request URL does not contain a host".to_string())?
            .to_string(),
        method,
        path: crate::build_request_path(&url),
        protocol: url.scheme().to_string(),
        query_params: build_query_params(&url),
        raw_request: build_raw_http_head(
            &format!("{} {} HTTP/1.1", "GET", crate::build_request_path(&url)),
            &request_headers,
        ),
        request_headers,
        request_id: "offline-preview".to_string(),
        url,
        tls_cipher_suite: None,
        tls_protocol: None,
    };

    let snapshot = capture_rule_snapshot(&Some(rewrite_manager), &Some(map_manager));
    let rewrite_traces = apply_request_rewrite_rules_with_snapshot(
        &snapshot,
        &input.workspace_id,
        &mut request,
        false,
    )?;
    let (local_response, map_traces) =
        apply_map_rules_with_snapshot(&snapshot, &input.workspace_id, &mut request)?;

    let mut response = match local_response {
        Some(response) => Some(response),
        None => input
            .baseline_response
            .map(response_from_input)
            .transpose()?,
    };
    let mut response_rewrite_traces = Vec::new();
    if let Some(response) = response.as_mut() {
        response_rewrite_traces = apply_response_rewrite_rules_with_snapshot(
            &snapshot,
            &input.workspace_id,
            &request,
            response,
            false,
        )?;
    }

    let (response_status, response_headers, response_body) = match response.as_ref() {
        Some(response) => (
            Some(response.status_code.as_u16()),
            map_headers_to_offline(&response.response_headers),
            response.response_body.clone(),
        ),
        None => (None, Vec::new(), Vec::new()),
    };
    let mut all_rewrite_traces = rewrite_traces;
    all_rewrite_traces.extend(response_rewrite_traces);

    Ok(OfflineEvaluationResult {
        evidence_level: "offline".to_string(),
        final_url: request.url.to_string(),
        request_method: request.method.as_str().to_string(),
        request_headers: entries_to_offline(&request.request_headers),
        request_body_base64: BASE64_STANDARD.encode(&request.body),
        response_status,
        response_headers,
        response_body_base64: BASE64_STANDARD.encode(response_body),
        rewrite_traces: all_rewrite_traces,
        map_traces,
        limitations: vec![
            "Offline evaluation proves rule matching and transformation only; it does not prove that the rule is active in the proxy runtime or reached the network.".to_string(),
            "Offline evaluation does not prove real client rendering or end-to-end TLS behavior.".to_string(),
        ],
    })
}

fn response_from_input(input: OfflineResponseInput) -> Result<UpstreamResponse, String> {
    let status_code = StatusCode::from_u16(input.status)
        .map_err(|error| format!("offline baseline status is invalid: {error}"))?;
    let mut headers = HeaderMap::new();
    for header in input.headers {
        let name = HeaderName::from_bytes(header.name.as_bytes())
            .map_err(|error| format!("offline baseline header name is invalid: {error}"))?;
        let value = HeaderValue::from_str(&header.value)
            .map_err(|error| format!("offline baseline header value is invalid: {error}"))?;
        headers.append(name, value);
    }
    let body = decode_body(input.body_base64.as_deref())?;
    Ok(UpstreamResponse {
        body_truncated: false,
        connect_ms: 0,
        connection_reused: None,
        connection_wait_ms: None,
        dns_ms: 0,
        request_send_ms: None,
        response_body: body.clone(),
        response_body_size_bytes: body.len(),
        response_headers: headers,
        response_read_ms: 0,
        spooled_response_path: None,
        status_code,
        tls_ms: None,
        waiting_ms: 0,
        via_upstream_proxy: None,
    })
}

fn decode_body(encoded: Option<&str>) -> Result<Vec<u8>, String> {
    match encoded {
        Some(value) if !value.is_empty() => BASE64_STANDARD
            .decode(value)
            .map_err(|error| format!("offline body is not valid base64: {error}")),
        _ => Ok(Vec::new()),
    }
}

fn host_header(url: &Url) -> String {
    match url.port() {
        Some(port) => format!("{}:{}", url.host_str().unwrap_or_default(), port),
        None => url.host_str().unwrap_or_default().to_string(),
    }
}

fn entries_to_offline(entries: &[ProxyHeaderEntry]) -> Vec<OfflineHeader> {
    entries
        .iter()
        .filter(|entry| !entry.name.starts_with(':'))
        .map(|entry| OfflineHeader {
            name: entry.name.clone(),
            value: entry.value.clone(),
        })
        .collect()
}

fn map_headers_to_offline(headers: &HeaderMap) -> Vec<OfflineHeader> {
    headers
        .iter()
        .filter_map(|(name, value)| {
            value.to_str().ok().map(|value| OfflineHeader {
                name: name.as_str().to_string(),
                value: value.to_string(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{MapRule, RewriteRule, RewriteRuleMatch};
    use serde_json::json;

    #[test]
    fn request_rewrite_and_local_map_flow_through_the_runtime_functions() {
        let rewrites = Arc::new(RewriteManager::new());
        rewrites.set_rules(vec![RewriteRule {
            actions: Some(vec![json!({
                "rewriteType": "header",
                "payload": {
                    "headerName": "x-preview",
                    "operation": "set",
                    "target": "request",
                    "value": "yes"
                }
            })]),
            enabled: true,
            id: "rewrite-1".to_string(),
            name: "preview".to_string(),
            note: None,
            payload: serde_json::Value::Null,
            priority: 10,
            r#match: RewriteRuleMatch {
                match_type: Some("wildcard".to_string()),
                methods: vec!["GET".to_string()],
                stage: "request".to_string(),
                url_pattern: "https://api.example.com/*".to_string(),
            },
            rewrite_type: "header".to_string(),
            workspace_id: "default".to_string(),
        }]);
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("mock.json");
        std::fs::write(&target, br#"{"ok":true}"#).unwrap();
        let maps = Arc::new(MapManager::new());
        maps.set_rules(vec![MapRule {
            enabled: true,
            id: "map-1".to_string(),
            match_type: Some("contains".to_string()),
            mode: "local".to_string(),
            name: "mock".to_string(),
            note: None,
            preserve_path: false,
            preserve_query: false,
            priority: 10,
            source_pattern: "https://api.example.com/v1/items".to_string(),
            target_value: target.display().to_string(),
            workspace_id: "default".to_string(),
        }]);

        let result = evaluate_offline(
            OfflineEvaluationInput {
                workspace_id: "default".to_string(),
                request: OfflineRequestInput {
                    method: "GET".to_string(),
                    url: "https://api.example.com/v1/items".to_string(),
                    headers: Vec::new(),
                    body_base64: None,
                },
                baseline_response: None,
            },
            rewrites,
            maps,
        )
        .unwrap();

        assert_eq!(result.response_status, Some(200));
        assert_eq!(result.map_traces.len(), 1);
        assert_eq!(result.map_traces[0].outcome, "success");
        assert_eq!(result.rewrite_traces[0].outcome, "success");
        assert!(result
            .request_headers
            .iter()
            .any(|header| header.name.eq_ignore_ascii_case("x-preview") && header.value == "yes"));
        assert_eq!(
            BASE64_STANDARD
                .decode(&result.response_body_base64)
                .unwrap(),
            br#"{"ok":true}"#
        );
    }
}

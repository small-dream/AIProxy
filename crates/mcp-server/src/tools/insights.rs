use aiproxy_db::insights::{compute_insights, InsightsFilter};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use crate::context::AppContext;
use crate::protocol::{ToolError, ToolMeta};
use crate::redaction::redact_url;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GetInsightsRequest {
    pub host: Option<String>,
    pub host_contains: Option<String>,
    #[serde(default)]
    pub methods: Vec<String>,
    pub status_min: Option<u16>,
    pub status_max: Option<u16>,
    pub started_after: Option<String>,
    pub started_before: Option<String>,
}

pub async fn get_insights(
    state: &AppContext,
    request: GetInsightsRequest,
) -> Result<(Value, ToolMeta), ToolError> {
    let config = state.config()?;
    if !config.permissions.read_sessions {
        return Err(ToolError::permission_denied(
            "Session reading is disabled in Agent Access.",
        ));
    }

    let has_scope = request
        .host
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
        || request
            .host_contains
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        || !request.methods.is_empty()
        || request.status_min.is_some()
        || request.status_max.is_some()
        || request
            .started_after
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        || request
            .started_before
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty());
    if !has_scope {
        return Err(ToolError::invalid(
            "get_insights requires at least one host, time, method, or status filter.",
        ));
    }

    let filter = InsightsFilter {
        host_exact: request.host,
        host_keyword: request.host_contains,
        methods: request.methods,
        status_min: request.status_min,
        status_max: request.status_max,
        started_after: request.started_after,
        started_before: request.started_before,
        ..InsightsFilter::default()
    };
    let result = state
        .with_db(move |connection| compute_insights(connection, &filter))
        .await?;
    let truncated = result.by_host.len() >= 50
        || result.slow_requests.len() >= 20
        || result.largest_requests.len() >= 20;
    let mut data = serde_json::to_value(result)
        .map_err(|error| ToolError::new("INTERNAL_ERROR", error.to_string()))?;
    for key in ["slowRequests", "largestRequests"] {
        if let Some(items) = data.get_mut(key).and_then(Value::as_array_mut) {
            for item in items {
                if let Some(url) = item.get("url").and_then(Value::as_str) {
                    let redacted = redact_url(url);
                    item["url"] = Value::String(redacted);
                }
            }
        }
    }
    Ok((data, ToolMeta::new(truncated, true, None)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_json_shape_is_camel_case() {
        let request: GetInsightsRequest = serde_json::from_value(json!({
            "host": "api.example.com",
            "statusMin": 400
        }))
        .unwrap();
        assert_eq!(request.status_min, Some(400));
    }
}

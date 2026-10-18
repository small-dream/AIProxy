use std::collections::BTreeMap;

use aiproxy_db::insights::{compute_insights, InsightGroupBy, InsightsFilter};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use crate::context::AppContext;
use crate::protocol::{ToolError, ToolMeta};
use crate::redaction::Redactor;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum GroupBy {
    #[default]
    None,
    Host,
    Path,
    QueryParam,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GetInsightsRequest {
    pub host: Option<String>,
    pub host_contains: Option<String>,
    pub path_contains: Option<String>,
    #[serde(default)]
    pub query_params: BTreeMap<String, String>,
    #[serde(default)]
    pub methods: Vec<String>,
    pub status_min: Option<u16>,
    pub status_max: Option<u16>,
    pub started_after: Option<String>,
    pub started_before: Option<String>,
    pub since: Option<String>,
    #[serde(default)]
    pub group_by: GroupBy,
    pub group_query_param: Option<String>,
}

pub async fn get_insights(
    state: &AppContext,
    request: GetInsightsRequest,
) -> Result<(Value, ToolMeta), ToolError> {
    let config = state.config()?;
    if !config.permissions.read_sessions {
        return Err(ToolError::permission_denied(
            "Session reading is disabled. Enable readSessions in AIProxy Settings > Agent Access.",
        ));
    }
    let redactor = Redactor::from_config(&config, &state.paths.data_dir)
        .map_err(|message| ToolError::new("INVALID_REDACTION_CONFIG", message))?;

    if request.since.is_some() && request.started_after.is_some() {
        return Err(ToolError::invalid(
            "Use either since or startedAfter, not both.",
        ));
    }
    let started_after = match request.since.as_deref() {
        Some(value) => Some(super::sessions::parse_since(value)?),
        None => request.started_after,
    };

    let has_scope = request
        .host
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
        || request
            .host_contains
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        || request
            .path_contains
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        || !request.query_params.is_empty()
        || !request.methods.is_empty()
        || request.status_min.is_some()
        || request.status_max.is_some()
        || started_after
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
    if request.group_by == GroupBy::QueryParam
        && request
            .group_query_param
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
    {
        return Err(ToolError::invalid(
            "groupQueryParam is required when groupBy=queryParam.",
        ));
    }

    let group_name = match request.group_by {
        GroupBy::QueryParam => request
            .group_query_param
            .clone()
            .unwrap_or_else(|| "queryParam".to_string()),
        GroupBy::Host => "host".to_string(),
        GroupBy::Path => "path".to_string(),
        GroupBy::None => String::new(),
    };
    let filter = InsightsFilter {
        host_exact: request.host,
        host_keyword: request.host_contains,
        path_keyword: request.path_contains,
        query_params: request.query_params.into_iter().collect(),
        methods: request.methods,
        status_min: request.status_min,
        status_max: request.status_max,
        started_after,
        started_before: request.started_before,
        group_by: request.group_by.into(),
        group_query_param: request.group_query_param,
        ..InsightsFilter::default()
    };
    let result = state
        .with_db(move |connection| compute_insights(connection, &filter))
        .await?;
    let truncated = result.by_host.len() >= 50
        || result.groups.len() >= 50
        || result.slow_requests.len() >= 20
        || result.largest_requests.len() >= 20;
    let mut data = serde_json::to_value(result)
        .map_err(|error| ToolError::new("INTERNAL_ERROR", error.to_string()))?;
    for key in ["slowRequests", "largestRequests"] {
        if let Some(items) = data.get_mut(key).and_then(Value::as_array_mut) {
            for item in items {
                if let Some(url) = item.get("url").and_then(Value::as_str) {
                    let redacted = redactor.redact_url(url);
                    item["url"] = Value::String(redacted);
                }
            }
        }
    }
    if let Some(groups) = data.get_mut("groups").and_then(Value::as_array_mut) {
        if !group_name.is_empty() {
            for group in groups {
                if let Some(key) = group.get("key").and_then(Value::as_str) {
                    let redacted = redactor.redact_named_value(&group_name, key);
                    group["key"] = Value::String(redacted.value);
                }
            }
        }
    }
    Ok((data, ToolMeta::new(truncated, true, None)))
}

impl From<GroupBy> for InsightGroupBy {
    fn from(value: GroupBy) -> Self {
        match value {
            GroupBy::None => Self::None,
            GroupBy::Host => Self::Host,
            GroupBy::Path => Self::Path,
            GroupBy::QueryParam => Self::QueryParam,
        }
    }
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

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
    /// Do not compute grouped rows.
    #[default]
    None,
    /// Group by normalized host.
    Host,
    /// Group by URL path.
    Path,
    /// Group by the value of groupQueryParam.
    QueryParam,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum InsightSection {
    /// Overview totals, error rate, and latency percentiles.
    Summary,
    /// Host distribution.
    ByHost,
    /// Method distribution.
    ByMethod,
    /// Status-code distribution.
    ByStatusCode,
    /// Failure-kind distribution for sessions with structured failure metadata.
    ByFailureKind,
    /// Optional grouped aggregation selected by groupBy.
    Groups,
    /// Slowest requests.
    SlowRequests,
    /// Largest requests by response size.
    LargestRequests,
}

fn default_sections() -> Vec<InsightSection> {
    vec![
        InsightSection::Summary,
        InsightSection::Groups,
        InsightSection::SlowRequests,
    ]
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GetInsightsRequest {
    /// Exact host match, case-insensitive. Do not include a scheme or path.
    pub host: Option<String>,
    /// Case-insensitive host substring match.
    pub host_contains: Option<String>,
    /// Case-insensitive URL path substring match.
    pub path_contains: Option<String>,
    /// Query parameters that must all exist with these exact, case-sensitive values.
    #[serde(default)]
    pub query_params: BTreeMap<String, String>,
    /// HTTP methods to include; matching is case-insensitive.
    #[serde(default)]
    pub methods: Vec<String>,
    /// Inclusive minimum HTTP status code (0-65535).
    pub status_min: Option<u16>,
    /// Inclusive maximum HTTP status code (0-65535).
    pub status_max: Option<u16>,
    /// Inclusive RFC 3339 UTC lower bound on startedAt.
    pub started_after: Option<String>,
    /// Inclusive RFC 3339 UTC upper bound on startedAt.
    pub started_before: Option<String>,
    /// Relative lookback such as 30m, 2h, or 7d. Use instead of startedAfter.
    pub since: Option<String>,
    /// Optional grouping dimension. Defaults to none.
    #[serde(default)]
    pub group_by: GroupBy,
    /// Query parameter name used when groupBy=queryParam.
    pub group_query_param: Option<String>,
    /// Sections to return. Defaults to summary, groups, and slowRequests.
    #[serde(default = "default_sections")]
    pub sections: Vec<InsightSection>,
    /// Maximum rows per leaderboard, 1-20; default 10.
    #[schemars(range(min = 1, max = 20))]
    pub top_n: Option<usize>,
    /// Maximum grouped rows, 1-50; default 20.
    #[schemars(range(min = 1, max = 50))]
    pub max_groups: Option<usize>,
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

    let sections = if request.sections.is_empty() {
        default_sections()
    } else {
        request.sections.clone()
    };
    let top_n = request.top_n.unwrap_or(10).clamp(1, 20);
    let max_groups = request.max_groups.unwrap_or(20).clamp(1, 50);
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
        top_n: Some(top_n + 1),
        max_groups: Some(max_groups + 1),
        max_hosts: Some(top_n + 1),
        ..InsightsFilter::default()
    };
    let result = state
        .with_db(move |connection| compute_insights(connection, &filter))
        .await?;
    let mut data = serde_json::to_value(result)
        .map_err(|error| ToolError::new("INTERNAL_ERROR", error.to_string()))?;
    let mut notes = Vec::new();
    let mut truncated_reasons = Vec::new();

    for (key, label, section) in [
        ("slowRequests", "slowRequests", InsightSection::SlowRequests),
        (
            "largestRequests",
            "largestRequests",
            InsightSection::LargestRequests,
        ),
    ] {
        if !sections.contains(&section) {
            continue;
        }
        if let Some(items) = data.get_mut(key).and_then(Value::as_array_mut) {
            if items.len() > top_n {
                items.truncate(top_n);
                truncated_reasons.push(format!("{label} limited to topN={top_n}"));
            }
            for item in items {
                compact_request_item(item);
            }
        }
    }
    if sections.contains(&InsightSection::Groups) {
        if let Some(groups) = data.get_mut("groups").and_then(Value::as_array_mut) {
            if groups.len() > max_groups {
                groups.truncate(max_groups);
                truncated_reasons.push(format!("groups limited to maxGroups={max_groups}"));
            }
        }
    }
    if sections.contains(&InsightSection::ByHost) {
        if let Some(hosts) = data.get_mut("byHost").and_then(Value::as_array_mut) {
            if hosts.len() > top_n {
                hosts.truncate(top_n);
                truncated_reasons.push(format!("byHost limited to topN={top_n}"));
            }
        }
    }
    if sections.contains(&InsightSection::ByFailureKind) {
        if let Some(kinds) = data.get_mut("byFailureKind").and_then(Value::as_array_mut) {
            if kinds.len() > top_n {
                kinds.truncate(top_n);
                truncated_reasons.push(format!("byFailureKind limited to topN={top_n}"));
            }
        }
    }
    if request.group_by == GroupBy::Host
        && sections.contains(&InsightSection::ByHost)
        && sections.contains(&InsightSection::Groups)
    {
        notes.push("byHost omitted because groups already covers hosts.".to_string());
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

    let keep = |name: &str| match name {
        "totalRequests" | "totalErrors" | "errorRate" | "avgDurationMs" | "p50DurationMs"
        | "p95DurationMs" | "p99DurationMs" | "totalBytes" => {
            sections.contains(&InsightSection::Summary)
        }
        "byHost" => {
            sections.contains(&InsightSection::ByHost)
                && !(request.group_by == GroupBy::Host
                    && sections.contains(&InsightSection::Groups))
        }
        "byMethod" => sections.contains(&InsightSection::ByMethod),
        "byStatusCode" => sections.contains(&InsightSection::ByStatusCode),
        "byFailureKind" => sections.contains(&InsightSection::ByFailureKind),
        "groups" => sections.contains(&InsightSection::Groups),
        "slowRequests" => sections.contains(&InsightSection::SlowRequests),
        "largestRequests" => sections.contains(&InsightSection::LargestRequests),
        _ => true,
    };
    if let Some(object) = data.as_object_mut() {
        object.retain(|key, _| keep(key));
        if !notes.is_empty() {
            object.insert("notes".to_string(), serde_json::json!(notes));
        }
    }
    let truncated_reason = (!truncated_reasons.is_empty()).then(|| truncated_reasons.join("; "));
    let truncated = truncated_reason.is_some();
    let mut meta = ToolMeta::new(truncated, true, None);
    if let Some(reason) = truncated_reason {
        meta = meta.with_truncated_reason(reason);
    }
    Ok((data, meta))
}

fn compact_request_item(item: &mut Value) {
    if let Some(object) = item.as_object_mut() {
        let url = object
            .remove("url")
            .and_then(|value| value.as_str().map(str::to_string));
        let (host, path) = url
            .as_deref()
            .and_then(|value| url::Url::parse(value).ok())
            .map(|url| {
                (
                    url.host_str().unwrap_or_default().to_string(),
                    url.path().to_string(),
                )
            })
            .unwrap_or_default();
        object.insert("host".to_string(), Value::String(host));
        object.insert("path".to_string(), Value::String(path));
    }
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

use super::*;
use regex::Regex;

pub(crate) fn pattern_matches(pattern: &str, candidate: &str, match_type: Option<&str>) -> bool {
    let normalized = pattern.trim();

    match match_type.unwrap_or("contains") {
        "exact" => candidate == normalized,
        "regex" => Regex::new(normalized).is_ok_and(|re| re.is_match(candidate)),
        "wildcard" => wildcard_matches(normalized, candidate),
        _ => contains_matches(normalized, candidate),
    }
}

/// Like `pattern_matches`, but uses a pre-compiled regex when available.
/// Falls back to `pattern_matches` for non-regex match types.
#[allow(dead_code)]
pub(crate) fn pattern_matches_compiled(
    compiled: Option<&Regex>,
    candidate: &str,
    match_type: Option<&str>,
) -> bool {
    match match_type.unwrap_or("contains") {
        "regex" => match compiled {
            Some(re) => re.is_match(candidate),
            None => false, // Invalid regex was warned at load time; skip silently.
        },
        _ => {
            // For non-regex types, delegate to pattern_matches with a dummy pattern
            // (the caller already has the original pattern in the DTO).
            // This branch should not be reached in the compiled path for rewrite rules,
            // since only rewrite rules use match_type and they always have the compiled regex.
            // However, as a safety net, return false if compiled was expected but absent.
            compiled.is_some() || match_type.is_none()
        }
    }
}

/// Compile a regex from match_type and url_pattern. Returns None if match_type
/// is not "regex" or if compilation fails (logs a warning).
pub(crate) fn compile_match_regex(match_type: &Option<String>, url_pattern: &str) -> Option<Regex> {
    if match_type.as_deref() != Some("regex") {
        return None;
    }
    let normalized = url_pattern.trim();
    match Regex::new(normalized) {
        Ok(re) => Some(re),
        Err(e) => {
            emit_log("WARN", "rules.regex_compile_failed", &[("pattern", normalized.to_string()), ("error", e.to_string())]);
            None
        }
    }
}

pub(crate) fn wildcard_matches(normalized: &str, candidate: &str) -> bool {
    if normalized.is_empty() || normalized == "*" {
        return true;
    }

    let parts: Vec<&str> = normalized
        .split('*')
        .filter(|part| !part.is_empty())
        .collect();

    if parts.is_empty() {
        return true;
    }

    let mut search_start = 0_usize;

    for (index, part) in parts.iter().enumerate() {
        if let Some(relative_index) = candidate[search_start..].find(part) {
            let absolute_index = search_start + relative_index;

            if index == 0 && !normalized.starts_with('*') && absolute_index != 0 {
                return false;
            }

            search_start = absolute_index + part.len();
        } else {
            return false;
        }
    }

    if normalized.ends_with('*') {
        return true;
    }

    if let Some(last) = parts.last() {
        return candidate.ends_with(last);
    }

    true
}

pub(crate) fn contains_matches(normalized: &str, candidate: &str) -> bool {
    if normalized.is_empty() || normalized == "*" {
        return true;
    }
    candidate.contains(normalized)
}

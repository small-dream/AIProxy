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
            tracing::warn!(
                event = "rules.regex_compile_failed",
                pattern = normalized,
                error = %e,
                "regex compile failed"
            );
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

    // No trailing '*': the last part must end exactly at the candidate's end.
    // After the loop, search_start points just past the last matched part, so
    // it equals candidate.len() only when that part consumed the candidate to
    // its end. The previous `candidate.ends_with(last)` check was insufficient
    // — it let a part match anywhere as long as the candidate ended with it,
    // so "_" wrongly matched "__" (any string ending in the part).
    search_start == candidate.len()
}

pub(crate) fn contains_matches(normalized: &str, candidate: &str) -> bool {
    if normalized.is_empty() || normalized == "*" {
        return true;
    }
    candidate.contains(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    // P1-1: Empty pattern / "*" matches everything
    proptest! {
        #[test]
        fn empty_pattern_matches_any_candidate(candidate in ".*") {
            prop_assert!(wildcard_matches("", &candidate));
        }

        #[test]
        fn star_pattern_matches_any_candidate(candidate in ".*") {
            prop_assert!(wildcard_matches("*", &candidate));
        }
    }

    // P1-2: No wildcard = exact match
    proptest! {
        #[test]
        fn no_wildcard_is_exact_match(
            s in "[a-zA-Z0-9/._-]{1,50}",
            candidate in "[a-zA-Z0-9/._-]{1,50}"
        ) {
            prop_assert_eq!(wildcard_matches(&s, &candidate), candidate == s);
        }
    }

    // P1-3: Prefix anchored `foo*`
    proptest! {
        #[test]
        fn prefix_anchored_matches(candidate in "foo.*") {
            prop_assert!(wildcard_matches("foo*", &candidate));
        }

        #[test]
        fn prefix_anchored_rejects_non_prefix(candidate in "bar[a-zA-Z0-9]*") {
            prop_assert!(!wildcard_matches("foo*", &candidate));
        }
    }

    // P1-4: Suffix anchored `*foo`
    proptest! {
        #[test]
        fn suffix_anchored_matches(candidate in ".*foo") {
            prop_assert!(wildcard_matches("*foo", &candidate));
        }

        #[test]
        fn suffix_anchored_rejects_non_suffix(candidate in "[a-zA-Z0-9]*bar") {
            prop_assert!(!wildcard_matches("*foo", &candidate));
        }
    }

    // P1-5: Multi-segment `*foo*bar*`
    proptest! {
        #[test]
        fn multi_segment_matches_ordered(candidate in ".*foo.*bar.*") {
            prop_assert!(wildcard_matches("*foo*bar*", &candidate));
        }

        #[test]
        fn multi_segment_rejects_wrong_order(candidate in ".*bar.*foo.*") {
            // "bar...foo" does not have "foo" before "bar"
            let has_foo_before_bar = candidate.find("foo").map_or(false, |fi| {
                candidate[fi + 3..].contains("bar")
            });
            if has_foo_before_bar {
                // This candidate accidentally satisfies the order, skip it
                return Ok(());
            }
            prop_assert!(!wildcard_matches("*foo*bar*", &candidate));
        }
    }

    // P1-6: No panic on arbitrary UTF-8
    proptest! {
        #[test]
        fn no_panic_on_arbitrary_input(pattern in "\\PC*", candidate in "\\PC*") {
            let _ = wildcard_matches(&pattern, &candidate);
        }
    }
}

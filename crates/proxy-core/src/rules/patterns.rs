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

    let leading_wildcard = normalized.starts_with('*');
    let trailing_wildcard = normalized.ends_with('*');
    let parts: Vec<&str> = normalized
        .split('*')
        .filter(|part| !part.is_empty())
        .collect();

    if parts.is_empty() {
        return true;
    }

    // Single segment: the anchors decide everything, no scanning needed.
    if parts.len() == 1 {
        let part = parts[0];
        return match (leading_wildcard, trailing_wildcard) {
            (false, false) => candidate == part,
            (true, false) => candidate.ends_with(part),
            (false, true) => candidate.starts_with(part),
            (true, true) => candidate.contains(part),
        };
    }

    // P1-7: the previous single-pass greedy scan advanced each part by its
    // FIRST occurrence and finally demanded that the scan land exactly on the
    // candidate's end. That misses valid alignments whenever an early part's
    // first occurrence steals positions a later part needs — e.g. `foo*bar`
    // vs `foobarXbar`, or even a lone middle part as in `*b*b` vs `bab`.
    //
    // The fix pins the anchor segments (first when unanchored-left, last when
    // unanchored-right) and backtracks over every occurrence of the middle
    // parts until an assignment fits the window between the anchors.
    let head = if leading_wildcard {
        None
    } else {
        Some(parts[0])
    };
    let tail = if trailing_wildcard {
        None
    } else {
        Some(parts[parts.len() - 1])
    };
    let middle_start = usize::from(head.is_some());
    let middle_end = parts.len() - usize::from(tail.is_some());
    let middles = &parts[middle_start..middle_end];

    // Window the candidate between the pinned head/tail segments. Byte offsets
    // stay on char boundaries because `starts_with`/`ends_with` matched these
    // exact segments inside `candidate`.
    let mut window_start = 0_usize;
    let mut window_end = candidate.len();

    if let Some(head_part) = head {
        if !candidate.starts_with(head_part) {
            return false;
        }
        window_start = head_part.len();
    }
    if let Some(tail_part) = tail {
        if candidate.len() - window_start < tail_part.len()
            || !candidate[window_start..].ends_with(tail_part)
        {
            return false;
        }
        window_end -= tail_part.len();
    }
    if window_start > window_end {
        // Head and tail would overlap — e.g. `aba*bab` vs `abab`.
        return false;
    }

    match_middles(middles, candidate, window_start, window_end)
}

/// Match `middles` (each separated by an implicit `*`) inside
/// `candidate[window_start..window_end]`, trying every occurrence of each
/// segment before giving up (backtracking).
fn match_middles(middles: &[&str], candidate: &str, window_start: usize, window_end: usize) -> bool {
    let Some((first, rest)) = middles.split_first() else {
        return true;
    };

    let mut occurrence_start = window_start;
    loop {
        let Some(relative) = candidate[occurrence_start..window_end].find(first) else {
            return false;
        };
        let end = occurrence_start + relative + first.len();
        if rest.is_empty() || match_middles(rest, candidate, end, window_end) {
            return true;
        }
        // Retry from the next character boundary after this occurrence so
        // overlapping occurrences are considered (multibyte-safe).
        match candidate[end..window_end].chars().next() {
            Some(c) => occurrence_start = end + c.len_utf8(),
            None => return false,
        }
    }
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

    // P1-7 regression: first-occurrence alignment must not steal positions a
    // later segment needs.
    #[test]
    fn greedy_first_occurrence_false_negatives() {
        // First segment's only occurrence is at 0; last segment must align at
        // the end — the old scan matched "bar" too early and failed.
        assert!(wildcard_matches("foo*bar", "foobarXbar"));
        // `*.log` style suffix patterns against repeated extensions.
        assert!(wildcard_matches("*.log", "a.log.b.log"));
        // A middle segment alone can need backtracking past its first
        // occurrence (`*b*b` vs "bab": first b@0, second b@2).
        assert!(wildcard_matches("*b*b", "bab"));
        assert!(wildcard_matches("*b*c", "abcbc"));

        // Anchored semantics are unchanged (the "_" vs "__" regression).
        assert!(!wildcard_matches("_", "__"));
        assert!(!wildcard_matches("aba*bab", "abab")); // pinned segments overlap
    }

    /// Build the regex equivalent of a wildcard pattern so the proptest below
    /// can cross-check `wildcard_matches` against a reference implementation.
    fn wildcard_as_regex(normalized: &str) -> String {
        let leading_wildcard = normalized.starts_with('*');
        let trailing_wildcard = normalized.ends_with('*');
        let parts: Vec<String> = normalized
            .split('*')
            .filter(|part| !part.is_empty())
            .map(regex::escape)
            .collect();

        let mut re = String::from("^");
        if leading_wildcard {
            re.push_str(".*");
        }
        re.push_str(&parts.join(".*"));
        if trailing_wildcard {
            re.push_str(".*");
        }
        re.push('$');
        re
    }

    // P1-7: `wildcard_matches` must agree with an equivalent regex on every
    // pattern/candidate pair — this is what proves no false negatives remain
    // in the backtracking matcher.
    proptest! {
        #[test]
        fn agrees_with_equivalent_regex(
            pattern in "[abc_]{0,6}(\\*[abc_]{0,4}){0,3}",
            candidate in "[abc_]{0,12}",
        ) {
            let normalized = pattern.trim();
            // Match-all shortcuts bypass the segment matcher entirely.
            if normalized.is_empty() || normalized == "*" {
                prop_assert!(wildcard_matches(normalized, &candidate));
                return Ok(());
            }
            let expected = Regex::new(&wildcard_as_regex(normalized))
                .expect("constructed regex must compile")
                .is_match(candidate.as_str());
            prop_assert_eq!(wildcard_matches(normalized, &candidate), expected);
        }
    }

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
            let has_foo_before_bar =
                candidate.find("foo").is_some_and(|fi| candidate[fi + 3..].contains("bar"));
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

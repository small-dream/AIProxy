use std::cell::RefCell;
use std::fmt;
use std::io::{Cursor, Read};
use std::rc::Rc;

use aiproxy_db::body_store::BodyStore;
use regex::{Regex, RegexBuilder};
use serde::de::{DeserializeSeed, Error as DeError, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};

use crate::protocol::ToolError;
use crate::redaction::{RedactionRecord, Redactor, REDACTED_VALUE};

use super::body::{decode_inline_reference, sha256_hex, StoredBodyReference};
use super::body_stream::append_key_path;

pub(crate) const MAX_TEXT_QUERY_HITS: usize = 20;
pub(crate) const MAX_TEXT_QUERY_SCAN_BYTES: usize = 16 * 1024 * 1024;
const MAX_JSON_DEPTH: usize = 128;
const SEARCH_WINDOW_BYTES: usize = 8 * 1024;
const MATCH_SLACK_BYTES: usize = 8 * 1024;
const SCAN_BATCH_BYTES: usize = 8 * 1024;

#[derive(Debug)]
pub(crate) struct TextSearchOutcome {
    pub matches: Vec<Value>,
    pub limited: bool,
    pub structure_parsed: bool,
    pub redacted_fields: Vec<String>,
    pub hash: Option<String>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn search_text(
    store: &BodyStore,
    reference: &StoredBodyReference,
    decoded_size_bytes: u64,
    query: &str,
    context_bytes: usize,
    raw: bool,
    redactor: &Redactor,
    scan_limit_bytes: usize,
) -> Result<TextSearchOutcome, ToolError> {
    if decoded_size_bytes > scan_limit_bytes as u64 {
        return Err(text_query_scan_limit_error(
            decoded_size_bytes,
            scan_limit_bytes,
        ));
    }

    let source = BodySource::new(store, reference)?;
    if raw {
        let bytes = source.read_all(scan_limit_bytes)?;
        let text = std::str::from_utf8(&bytes).map_err(|_| not_text_error())?;
        let (matches, limited) = text_matches(text, query, context_bytes);
        return Ok(TextSearchOutcome {
            matches,
            limited,
            structure_parsed: is_valid_json_document(text),
            redacted_fields: Vec::new(),
            hash: Some(sha256_hex(&bytes)),
        });
    }

    let sink = Rc::new(RefCell::new(MatchSink::new(query, context_bytes)?));
    let records = Rc::new(RefCell::new(Vec::new()));
    let context = Rc::new(RedactContext {
        redactor,
        sink: Rc::clone(&sink),
        records: Rc::clone(&records),
    });
    let parsed = try_stream_redacted_json(source.open()?, context)?;
    if parsed {
        sink.borrow_mut().finish();
        let sink = sink.borrow();
        let mut redacted_fields = collect_redacted_fields(&records.borrow());
        redacted_fields.sort();
        redacted_fields.dedup();
        return Ok(TextSearchOutcome {
            matches: sink.matches.clone(),
            limited: sink.limited,
            structure_parsed: true,
            redacted_fields,
            hash: None,
        });
    }

    // Non-JSON bodies (SSE, NDJSON, plain text) still need the line-oriented
    // redaction view. The bound keeps this fallback from materializing a JSON
    // value tree; only the decoded text and its redacted copy are held.
    let bytes = source.read_all(scan_limit_bytes)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| not_text_error())?;
    let redacted = redactor.redact_non_json_text(text);
    let (matches, limited) = text_matches(&redacted.value, query, context_bytes);
    Ok(TextSearchOutcome {
        matches,
        limited,
        structure_parsed: false,
        redacted_fields: redacted.fields,
        hash: None,
    })
}

pub(crate) fn text_query_scan_limit_error(
    decoded_size_bytes: u64,
    scan_limit_bytes: usize,
) -> ToolError {
    ToolError::new(
        "BODY_TOO_LARGE",
        format!(
            "textQuery is limited to {scan_limit_bytes} decoded bytes, but this body is {decoded_size_bytes} bytes. Use get_session_body with jsonPaths to read the specific fields you need instead of searching the whole body."
        ),
    )
    .with_details(json!({
        "reason": "scanLimit",
        "decodedSizeBytes": decoded_size_bytes,
        "scanLimitBytes": scan_limit_bytes,
        "textQuery": true,
        "recommendedAction": "useJsonPaths",
        "recommendedTool": "get_session_body",
    }))
}

fn not_text_error() -> ToolError {
    ToolError::new("BODY_NOT_TEXT", "textQuery requires a UTF-8 text body.")
        .with_details(json!({ "reason": "notText" }))
}

enum BodySource<'a> {
    File { store: &'a BodyStore, path: &'a str },
    Inline(Vec<u8>),
}

impl<'a> BodySource<'a> {
    fn new(store: &'a BodyStore, reference: &'a StoredBodyReference) -> Result<Self, ToolError> {
        match reference.file_path.as_deref() {
            Some(path) => Ok(Self::File { store, path }),
            None => Ok(Self::Inline(decode_inline_reference(reference)?)),
        }
    }

    fn open(&self) -> Result<Box<dyn Read + '_>, ToolError> {
        match self {
            Self::File { store, path } => store
                .open_body_reader(path)
                .map(|reader| Box::new(reader) as Box<dyn Read + '_>)
                .map_err(|error| {
                    ToolError::new(
                        "BODY_NOT_FOUND",
                        format!("The stored body file is unavailable: {error}"),
                    )
                    .with_details(json!({ "reason": "fileMissing" }))
                }),
            Self::Inline(bytes) => Ok(Box::new(Cursor::new(bytes.as_slice()))),
        }
    }

    fn read_all(&self, scan_limit_bytes: usize) -> Result<Vec<u8>, ToolError> {
        match self {
            Self::File { .. } => {
                let reader = self.open()?;
                let mut bytes = Vec::new();
                reader
                    .take(scan_limit_bytes as u64 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|error| {
                        ToolError::new(
                            "BODY_NOT_FOUND",
                            format!("Unable to read the stored body file: {error}"),
                        )
                        .with_details(json!({ "reason": "fileReadFailed" }))
                    })?;
                if bytes.len() > scan_limit_bytes {
                    return Err(text_query_scan_limit_error(
                        bytes.len() as u64,
                        scan_limit_bytes,
                    ));
                }
                Ok(bytes)
            }
            Self::Inline(bytes) => {
                if bytes.len() > scan_limit_bytes {
                    return Err(text_query_scan_limit_error(
                        bytes.len() as u64,
                        scan_limit_bytes,
                    ));
                }
                Ok(bytes.clone())
            }
        }
    }
}

fn collect_redacted_fields(records: &[RedactionRecord]) -> Vec<String> {
    let mut fields = records
        .iter()
        .map(|record| record.rule.clone())
        .collect::<Vec<_>>();
    fields.sort();
    fields.dedup();
    fields
}

fn text_matches(text: &str, query: &str, context_bytes: usize) -> (Vec<Value>, bool) {
    let Ok(regex) = RegexBuilder::new(&regex::escape(query))
        .case_insensitive(true)
        .build()
    else {
        return (Vec::new(), false);
    };
    let mut matches = Vec::new();
    let mut limited = false;
    for found in regex.find_iter(text) {
        if matches.len() >= MAX_TEXT_QUERY_HITS {
            limited = true;
            break;
        }
        let mut start = found.start().saturating_sub(context_bytes);
        while start > 0 && !text.is_char_boundary(start) {
            start -= 1;
        }
        let mut end = found.end().saturating_add(context_bytes).min(text.len());
        while end < text.len() && !text.is_char_boundary(end) {
            end += 1;
        }
        matches.push(json!({
            "offsetBytes": found.start(),
            "snippet": &text[start..end],
            "match": found.as_str(),
        }));
    }
    (matches, limited)
}

fn is_valid_json_document(text: &str) -> bool {
    let mut deserializer = serde_json::Deserializer::from_str(text);
    if IgnoredAny::deserialize(&mut deserializer).is_err() {
        return false;
    }
    deserializer.end().is_ok()
}

struct MatchSink {
    matcher: Regex,
    context_bytes: usize,
    max_match_bytes: usize,
    buffer: String,
    buffer_start: usize,
    next_search_from: usize,
    total_len: usize,
    matches: Vec<Value>,
    limited: bool,
}

impl MatchSink {
    fn new(query: &str, context_bytes: usize) -> Result<Self, ToolError> {
        let matcher = RegexBuilder::new(&regex::escape(query))
            .case_insensitive(true)
            .build()
            .map_err(|error| ToolError::invalid(format!("Invalid textQuery: {error}")))?;
        Ok(Self {
            matcher,
            context_bytes,
            max_match_bytes: query.len().saturating_mul(4).saturating_add(64),
            buffer: String::new(),
            buffer_start: 0,
            next_search_from: 0,
            total_len: 0,
            matches: Vec::new(),
            limited: false,
        })
    }

    fn write_str(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        self.total_len = self.total_len.saturating_add(text.len());
        if self.limited {
            self.release_buffer();
            return;
        }
        self.buffer.push_str(text);
        if self
            .total_len
            .saturating_sub(self.retention())
            .saturating_sub(self.next_search_from)
            >= SCAN_BATCH_BYTES
        {
            self.scan(false);
        }
    }

    fn finish(&mut self) {
        self.scan(true);
    }

    fn release_buffer(&mut self) {
        self.buffer.clear();
        self.buffer_start = self.total_len;
        self.next_search_from = self.total_len;
    }

    fn retention(&self) -> usize {
        SEARCH_WINDOW_BYTES.max(self.context_bytes.saturating_add(MATCH_SLACK_BYTES))
    }

    fn scan(&mut self, flush: bool) {
        if self.limited {
            self.release_buffer();
            return;
        }
        let retention = self.retention();
        let safe_end = if flush {
            self.total_len
        } else {
            self.total_len.saturating_sub(retention)
        };
        let safe_end = self.floor_boundary(safe_end);
        if safe_end <= self.next_search_from {
            return;
        }
        let search_from = self.next_search_from.max(self.buffer_start);
        if search_from >= safe_end {
            return;
        }

        let base = search_from - self.buffer_start;
        let search_end = self.ceil_boundary(
            safe_end
                .saturating_add(self.max_match_bytes)
                .min(self.total_len),
        );
        let search_end = search_end
            .saturating_sub(self.buffer_start)
            .min(self.buffer.len());
        if base >= search_end {
            return;
        }
        let mut advance_to = search_from;
        let mut pending = false;
        for found in self.matcher.find_iter(&self.buffer[base..search_end]) {
            let abs_start = search_from + found.start();
            let abs_end = search_from + found.end();
            if abs_start >= safe_end {
                pending = true;
                break;
            }
            if !flush && abs_end.saturating_add(self.context_bytes) > safe_end {
                pending = true;
                break;
            }
            if self.matches.len() >= MAX_TEXT_QUERY_HITS {
                self.limited = true;
                break;
            }
            let snippet_start = self.floor_boundary(abs_start.saturating_sub(self.context_bytes));
            let snippet_end = self.ceil_boundary(
                abs_end
                    .saturating_add(self.context_bytes)
                    .min(self.total_len),
            );
            let snippet_rel_start = snippet_start.saturating_sub(self.buffer_start);
            let snippet_rel_end = snippet_end.saturating_sub(self.buffer_start);
            if snippet_rel_end > self.buffer.len() {
                pending = true;
                break;
            }
            self.matches.push(json!({
                "offsetBytes": abs_start,
                "snippet": &self.buffer[snippet_rel_start..snippet_rel_end],
                "match": found.as_str(),
            }));
            advance_to = abs_end;
        }

        if self.limited {
            self.release_buffer();
            return;
        }
        if pending {
            self.next_search_from = self.next_search_from.max(advance_to);
        } else {
            self.next_search_from = self.next_search_from.max(safe_end);
        }
        self.trim();
    }

    fn trim(&mut self) {
        let keep = self
            .next_search_from
            .saturating_sub(self.context_bytes.saturating_add(MATCH_SLACK_BYTES));
        let keep = self.floor_boundary(keep);
        if keep > self.buffer_start {
            let drain_to = keep - self.buffer_start;
            self.buffer.drain(..drain_to);
            self.buffer_start = keep;
        }
    }

    fn floor_boundary(&self, absolute: usize) -> usize {
        let absolute = absolute.min(self.total_len);
        let mut relative = absolute.saturating_sub(self.buffer_start);
        while relative > 0 && !self.buffer.is_char_boundary(relative) {
            relative -= 1;
        }
        self.buffer_start + relative
    }

    fn ceil_boundary(&self, absolute: usize) -> usize {
        let absolute = absolute.min(self.total_len);
        let mut relative = absolute.saturating_sub(self.buffer_start);
        while relative < self.buffer.len() && !self.buffer.is_char_boundary(relative) {
            relative += 1;
        }
        self.buffer_start + relative
    }
}

struct RedactContext<'a> {
    redactor: &'a Redactor,
    sink: Rc<RefCell<MatchSink>>,
    records: Rc<RefCell<Vec<RedactionRecord>>>,
}

fn try_stream_redacted_json<R: Read>(
    reader: R,
    context: Rc<RedactContext<'_>>,
) -> Result<bool, ToolError> {
    let mut deserializer = serde_json::Deserializer::from_reader(reader);
    let seed = RedactSeed {
        context,
        path: "$".to_string(),
        depth: 0,
        prefix: false,
    };
    let result = seed
        .deserialize(&mut deserializer)
        .and_then(|()| deserializer.end());
    match result {
        Ok(()) => Ok(true),
        Err(error) if error.is_io() => Err(ToolError::new(
            "BODY_NOT_FOUND",
            format!("Unable to read the stored body file: {error}"),
        )
        .with_details(json!({ "reason": "fileReadFailed" }))),
        Err(_) => Ok(false),
    }
}

struct RedactSeed<'a> {
    context: Rc<RedactContext<'a>>,
    path: String,
    depth: usize,
    prefix: bool,
}

impl<'de, 'a> DeserializeSeed<'de> for RedactSeed<'a> {
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        if self.prefix {
            self.context.sink.borrow_mut().write_str(",");
        }
        deserializer.deserialize_any(RedactVisitor {
            context: self.context,
            path: self.path,
            depth: self.depth,
        })
    }
}

struct RedactVisitor<'a> {
    context: Rc<RedactContext<'a>>,
    path: String,
    depth: usize,
}

impl<'a> RedactVisitor<'a> {
    fn write(&self, text: &str) {
        self.context.sink.borrow_mut().write_str(text);
    }

    fn write_json_string<E: DeError>(&self, value: &str) -> Result<(), E> {
        let encoded = serde_json::to_string(value).map_err(E::custom)?;
        self.write(&encoded);
        Ok(())
    }

    fn write_serialized<E: DeError, T: serde::Serialize>(&self, value: &T) -> Result<(), E> {
        let encoded = serde_json::to_string(value).map_err(E::custom)?;
        self.write(&encoded);
        Ok(())
    }
}

impl<'de, 'a> Visitor<'de> for RedactVisitor<'a> {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_unit<E: DeError>(self) -> Result<Self::Value, E> {
        self.write("null");
        Ok(())
    }

    fn visit_none<E: DeError>(self) -> Result<Self::Value, E> {
        self.write("null");
        Ok(())
    }

    fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(self)
    }

    fn visit_bool<E: DeError>(self, value: bool) -> Result<Self::Value, E> {
        self.write_serialized(&value)
    }

    fn visit_i64<E: DeError>(self, value: i64) -> Result<Self::Value, E> {
        self.write_serialized(&value)
    }

    fn visit_u64<E: DeError>(self, value: u64) -> Result<Self::Value, E> {
        self.write_serialized(&value)
    }

    fn visit_f64<E: DeError>(self, value: f64) -> Result<Self::Value, E> {
        self.write_serialized(&value)
    }

    fn visit_str<E: DeError>(self, value: &str) -> Result<Self::Value, E> {
        let redacted = {
            let mut records = self.context.records.borrow_mut();
            self.context
                .redactor
                .redact_text_value(value, &self.path, &mut records)
        };
        self.write_json_string(&redacted)
    }

    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        ensure_json_depth::<A::Error>(self.depth)?;
        self.write("[");
        let mut index = 0usize;
        while seq
            .next_element_seed(RedactSeed {
                context: Rc::clone(&self.context),
                path: format!("{}[{index}]", self.path),
                depth: self.depth + 1,
                prefix: index > 0,
            })?
            .is_some()
        {
            index += 1;
        }
        self.write("]");
        Ok(())
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        ensure_json_depth::<A::Error>(self.depth)?;
        self.write("{");
        let mut first = true;
        while let Some(key) = map.next_key::<String>()? {
            if !first {
                self.write(",");
            }
            first = false;
            self.write_json_string(&key)?;
            self.write(":");
            let child_path = append_key_path(&self.path, &key);
            if self.context.redactor.is_sensitive_name(&key) {
                let rendered = map.next_value_seed(SensitiveSeed {
                    context: Rc::clone(&self.context),
                    key,
                    path: child_path,
                })?;
                self.write_json_string(&rendered)?;
            } else {
                map.next_value_seed(RedactSeed {
                    context: Rc::clone(&self.context),
                    path: child_path,
                    depth: self.depth + 1,
                    prefix: false,
                })?;
            }
        }
        self.write("}");
        Ok(())
    }
}

fn ensure_json_depth<E: DeError>(depth: usize) -> Result<(), E> {
    if depth >= MAX_JSON_DEPTH {
        return Err(E::custom("recursion limit exceeded"));
    }
    Ok(())
}

struct SensitiveSeed<'a> {
    context: Rc<RedactContext<'a>>,
    key: String,
    path: String,
}

impl<'de, 'a> DeserializeSeed<'de> for SensitiveSeed<'a> {
    type Value = String;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(SensitiveVisitor {
            context: self.context,
            key: self.key,
            path: self.path,
        })
    }
}

struct SensitiveVisitor<'a> {
    context: Rc<RedactContext<'a>>,
    key: String,
    path: String,
}

impl<'a> SensitiveVisitor<'a> {
    fn scalar(&self, value: &str) -> String {
        let mut records = self.context.records.borrow_mut();
        self.context
            .redactor
            .redact_named_scalar(&self.key, value, &self.path, &mut records)
    }

    fn container(&self) -> String {
        let mut records = self.context.records.borrow_mut();
        self.context
            .redactor
            .redact_named_container(&self.key, &self.path, &mut records)
    }
}

impl<'de, 'a> Visitor<'de> for SensitiveVisitor<'a> {
    type Value = String;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a sensitive JSON value")
    }

    fn visit_unit<E: DeError>(self) -> Result<Self::Value, E> {
        Ok(REDACTED_VALUE.to_string())
    }

    fn visit_none<E: DeError>(self) -> Result<Self::Value, E> {
        Ok(REDACTED_VALUE.to_string())
    }

    fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(self)
    }

    fn visit_bool<E: DeError>(self, value: bool) -> Result<Self::Value, E> {
        Ok(self.scalar(&value.to_string()))
    }

    fn visit_i64<E: DeError>(self, value: i64) -> Result<Self::Value, E> {
        Ok(self.scalar(&value.to_string()))
    }

    fn visit_u64<E: DeError>(self, value: u64) -> Result<Self::Value, E> {
        Ok(self.scalar(&value.to_string()))
    }

    fn visit_f64<E: DeError>(self, value: f64) -> Result<Self::Value, E> {
        Ok(self.scalar(&value.to_string()))
    }

    fn visit_str<E: DeError>(self, value: &str) -> Result<Self::Value, E> {
        Ok(self.scalar(value))
    }

    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        while seq.next_element::<IgnoredAny>()?.is_some() {}
        Ok(self.container())
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
        Ok(self.container())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AgentAccessConfig;
    use tempfile::TempDir;

    struct Fixture {
        _directory: TempDir,
        store: BodyStore,
        redactor: Redactor,
    }

    fn fixture() -> Fixture {
        let directory = tempfile::tempdir().unwrap();
        let store = BodyStore::new(directory.path().join("bodies"));
        store.ensure_dir().unwrap();
        let redactor = Redactor::from_config(
            &AgentAccessConfig::default(),
            &directory.path().join("agent"),
        )
        .unwrap();
        Fixture {
            _directory: directory,
            store,
            redactor,
        }
    }

    fn inline(text: &str) -> StoredBodyReference {
        StoredBodyReference {
            file_path: None,
            inline_text: Some(text.to_string()),
            base64_text: None,
            mime_type: Some("application/json".to_string()),
            encoding: None,
            size_bytes: text.len() as u64,
            truncated: false,
        }
    }

    fn run(
        fixture: &Fixture,
        text: &str,
        query: &str,
        raw: bool,
        limit: usize,
    ) -> Result<TextSearchOutcome, ToolError> {
        search_text(
            &fixture.store,
            &inline(text),
            text.len() as u64,
            query,
            32,
            raw,
            &fixture.redactor,
            limit,
        )
    }

    #[test]
    fn redacted_json_search_does_not_expose_secret_values() {
        let fixture = fixture();
        let body = r#"{"hello":"world","token":"abc123","user":{"email":"user@example.com"}}"#;

        let outcome = run(&fixture, body, "world", false, MAX_TEXT_QUERY_SCAN_BYTES).unwrap();
        assert_eq!(outcome.matches.len(), 1);
        assert_eq!(outcome.matches[0]["match"], "world");
        assert!(outcome.structure_parsed);

        let secret = run(&fixture, body, "abc123", false, MAX_TEXT_QUERY_SCAN_BYTES).unwrap();
        assert!(secret.matches.is_empty());

        let email = run(
            &fixture,
            body,
            "user@example.com",
            false,
            MAX_TEXT_QUERY_SCAN_BYTES,
        )
        .unwrap();
        assert!(email.matches.is_empty());
    }

    #[test]
    fn text_matches_returns_context() {
        let (matches, limited) = text_matches("alpha beta gamma", "beta", 3);
        assert!(!limited);
        assert_eq!(matches[0]["match"], "beta");
        assert!(matches[0]["snippet"].as_str().unwrap().contains("beta"));
    }

    #[test]
    fn match_sink_finds_matches_across_write_boundaries() {
        let mut sink = MatchSink::new("beta", 3).unwrap();
        sink.write_str("alpha be");
        sink.write_str("ta gamma");
        sink.finish();
        assert_eq!(sink.matches.len(), 1);
        assert_eq!(sink.matches[0]["match"], "beta");
        assert!(!sink.limited);
    }

    #[test]
    fn text_query_limit_only_marks_more_than_twenty_matches() {
        let fixture = fixture();
        let twenty = format!("[{},]", vec!["\"hit\""; 20].join(","));
        let outcome = run(&fixture, &twenty, "hit", false, MAX_TEXT_QUERY_SCAN_BYTES).unwrap();
        assert_eq!(outcome.matches.len(), 20);
        assert!(!outcome.limited);

        let twenty_one = format!("[{}]", vec!["\"hit\""; 21].join(","));
        let outcome = run(
            &fixture,
            &twenty_one,
            "hit",
            false,
            MAX_TEXT_QUERY_SCAN_BYTES,
        )
        .unwrap();
        assert_eq!(outcome.matches.len(), 20);
        assert!(outcome.limited);
    }

    #[test]
    fn redacted_json_search_handles_long_values_and_many_fields() {
        let fixture = fixture();
        let items = (0..2000)
            .map(|index| format!("\"item-{index}\""))
            .collect::<Vec<_>>()
            .join(",");
        let body = format!("{{\"items\":[{items},\"needle\"]}}");
        let outcome = run(&fixture, &body, "needle", false, MAX_TEXT_QUERY_SCAN_BYTES).unwrap();
        assert_eq!(outcome.matches.len(), 1);
        assert_eq!(outcome.matches[0]["match"], "needle");

        let long = format!("{{\"payload\":\"{}needle\"}}", "x".repeat(128 * 1024));
        let outcome = run(&fixture, &long, "needle", false, MAX_TEXT_QUERY_SCAN_BYTES).unwrap();
        assert_eq!(outcome.matches.len(), 1);
        assert!(outcome.structure_parsed);
    }

    #[test]
    fn redacted_json_search_streams_bodies_above_eight_mib() {
        let fixture = fixture();
        let body = format!("{{\"payload\":\"{}needle\"}}", "x".repeat(9 * 1024 * 1024));
        let outcome = run(&fixture, &body, "needle", false, MAX_TEXT_QUERY_SCAN_BYTES).unwrap();
        assert_eq!(outcome.matches.len(), 1);
        assert_eq!(outcome.matches[0]["match"], "needle");
        assert!(outcome.structure_parsed);
    }

    #[test]
    fn redacted_json_search_skips_sensitive_subtrees() {
        let fixture = fixture();
        let body = r#"{"secret":{"nested":"hide-me"},"visible":"keep-me"}"#;
        let outcome = run(&fixture, body, "hide-me", false, MAX_TEXT_QUERY_SCAN_BYTES).unwrap();
        assert!(outcome.matches.is_empty());
        assert!(outcome
            .redacted_fields
            .iter()
            .any(|field| field == "secret"));

        let visible = run(&fixture, body, "keep-me", false, MAX_TEXT_QUERY_SCAN_BYTES).unwrap();
        assert_eq!(visible.matches.len(), 1);
    }

    #[test]
    fn streaming_search_matches_materialized_redaction_view() {
        let fixture = fixture();
        let bodies = [
            r#"{"hello":"world","nested":{"msg":"hello again"},"items":["hello",1,true,null]}"#
                .to_string(),
            r#"{"user":{"email":"user@example.com"},"note":"prefix hello suffix"}"#.to_string(),
            format!(
                r#"{{"text":"{}hello{}"}}"#,
                "中".repeat(100),
                "文".repeat(100)
            ),
        ];
        for body in bodies {
            let redacted = fixture.redactor.redact_text(&body);
            for query in ["hello", "user@example.com", "中"] {
                let expected = text_matches(&redacted.value, query, 32);
                let actual = run(&fixture, &body, query, false, MAX_TEXT_QUERY_SCAN_BYTES).unwrap();
                assert_eq!(expected.0, actual.matches, "body={body} query={query}");
                assert_eq!(expected.1, actual.limited, "body={body} query={query}");
            }
        }
    }

    #[test]
    fn non_json_bodies_fall_back_to_line_redaction() {
        let fixture = fixture();
        let body = "not json hello\n{\"msg\":\"hello world\"}\nlast hello";
        let outcome = run(&fixture, body, "hello", false, MAX_TEXT_QUERY_SCAN_BYTES).unwrap();
        assert_eq!(outcome.matches.len(), 3);
        assert!(!outcome.structure_parsed);
    }

    #[test]
    fn raw_mode_searches_original_text_and_returns_digest() {
        let fixture = fixture();
        let body = r#"{"token":"abc123"}"#;
        let outcome = run(&fixture, body, "abc123", true, MAX_TEXT_QUERY_SCAN_BYTES).unwrap();
        assert_eq!(outcome.matches.len(), 1);
        assert!(outcome.structure_parsed);
        assert!(outcome.hash.is_some());
    }

    #[test]
    fn scan_limit_error_points_callers_to_json_paths() {
        let fixture = fixture();
        let body = format!("{{\"payload\":\"{}\"}}", "x".repeat(512));
        let error = run(&fixture, &body, "x", false, 128).unwrap_err();
        assert_eq!(error.code, "BODY_TOO_LARGE");
        assert!(error.message.contains("jsonPaths"));
        let details = error.details.unwrap();
        assert_eq!(details["recommendedAction"], "useJsonPaths");
        assert_eq!(details["recommendedTool"], "get_session_body");
        assert_eq!(details["scanLimitBytes"], 128);
    }

    #[test]
    fn file_backed_json_uses_streaming_path() {
        let fixture = fixture();
        let body = r#"{"hello":"world"}"#;
        let path = fixture
            .store
            .write_body("session", "response", body.as_bytes())
            .unwrap();
        let reference = StoredBodyReference {
            file_path: Some(path),
            inline_text: None,
            base64_text: None,
            mime_type: Some("application/json".to_string()),
            encoding: None,
            size_bytes: body.len() as u64,
            truncated: false,
        };
        let outcome = search_text(
            &fixture.store,
            &reference,
            body.len() as u64,
            "world",
            32,
            false,
            &fixture.redactor,
            MAX_TEXT_QUERY_SCAN_BYTES,
        )
        .unwrap();
        assert_eq!(outcome.matches.len(), 1);
        assert!(outcome.structure_parsed);
    }

    #[test]
    fn redacted_fields_are_reported_for_custom_patterns() {
        let fixture = fixture();
        let body = r#"{"note":"prefix user@example.com suffix"}"#;
        let outcome = run(&fixture, body, "prefix", false, MAX_TEXT_QUERY_SCAN_BYTES).unwrap();
        assert_eq!(outcome.matches.len(), 1);
        assert!(outcome.redacted_fields.iter().any(|field| field == "email"));
    }
}

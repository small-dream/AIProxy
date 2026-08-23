use super::common::*;

/// Upper bound for an attached multipart file, mirroring MAX_HAR_IMPORT_BYTES
/// (D1): pick and send both canonicalize + enforce the same cap.
pub const MAX_MULTIPART_FILE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MultipartEntry {
    Text {
        name: String,
        value: String,
    },
    File {
        name: String,
        file_name: String,
        file_token: String,
        content_type: Option<String>,
    },
}

/// Escape structural characters in a multipart field name so a crafted name
/// cannot break out of the Content-Disposition header (RFC 2388 / M16, mirror
/// of the retired frontend buildMultipartBody).
fn escape_field_name(name: &str) -> String {
    name.replace('"', "%22").replace(['\r', '\n'], "")
}

/// Renderer-supplied Content-Type is written verbatim into the part header, so
/// unlike field names it cannot be sanitized in place — anything that may
/// break the header framing (CR/LF, other control bytes, non-ASCII) must be
/// rejected outright. Empty values fall back to the octet-stream default.
fn resolve_part_content_type(content_type: Option<&str>) -> Result<String, String> {
    match content_type {
        None => Ok("application/octet-stream".to_string()),
        Some(value) if value.trim().is_empty() => Ok("application/octet-stream".to_string()),
        Some(value) => {
            if value.bytes().all(|byte| (0x20..=0x7E).contains(&byte)) {
                Ok(value.to_string())
            } else {
                // Debug-format the rejected value so CR/LF never reaches logs
                // or the UI as real control bytes.
                Err(format!("invalid Content-Type {value:?} for a file part"))
            }
        }
    }
}

fn read_attachment_bytes(entry: &MultipartEntry) -> Result<Vec<u8>, String> {
    let MultipartEntry::File {
        file_name,
        file_token,
        ..
    } = entry
    else {
        return Ok(Vec::new());
    };

    // The token authorizes only the originally selected location. Re-resolve
    // and re-check it here so a post-pick symlink replacement cannot redirect
    // the read outside the approved media roots.
    let issued_path = super::files::resolve_attachment_token(file_token)
        .map_err(|error| format!("attachment '{file_name}': {error}"))?;
    let canonical = std::fs::canonicalize(&issued_path).map_err(|error| {
        format!("attachment '{file_name}' cannot be resolved at send time: {error}")
    })?;
    super::files::ensure_attachment_path_allowed(&canonical, file_name)?;
    if !canonical.is_file() {
        return Err(format!("attachment '{file_name}' is not a file"));
    }

    let metadata = std::fs::metadata(&canonical)
        .map_err(|error| format!("attachment '{file_name}' cannot be read: {error}"))?;
    if metadata.len() > MAX_MULTIPART_FILE_BYTES as u64 {
        return Err(format!(
            "attachment '{}' exceeds the {} MB limit",
            file_name,
            MAX_MULTIPART_FILE_BYTES / (1024 * 1024)
        ));
    }

    std::fs::read(&canonical)
        .map_err(|error| format!("attachment '{file_name}' cannot be read: {error}"))
}

/// Build the raw multipart/form-data body bytes for a composed request (C3).
/// Returns `None` when there are no entries. File parts are read from disk
/// here — the renderer never sees the bytes (D1).
pub fn build_multipart_body_bytes(
    entries: &[MultipartEntry],
    boundary: &str,
) -> Result<Option<Vec<u8>>, String> {
    if entries.is_empty() {
        return Ok(None);
    }

    let mut parts: Vec<Vec<u8>> = Vec::new();
    for entry in entries {
        let header: String = match entry {
            MultipartEntry::Text { name, .. } => {
                format!(
                    "Content-Disposition: form-data; name=\"{}\"",
                    escape_field_name(name)
                )
            }
            MultipartEntry::File {
                name,
                file_name,
                content_type,
                ..
            } => {
                let content_type = resolve_part_content_type(content_type.as_deref())?;
                format!(
                    "Content-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\nContent-Type: {}",
                    escape_field_name(name),
                    escape_field_name(file_name),
                    content_type,
                )
            }
        };
        let value_bytes = match entry {
            MultipartEntry::Text { value, .. } => value.clone().into_bytes(),
            MultipartEntry::File { .. } => read_attachment_bytes(entry)?,
        };

        let mut part = Vec::new();
        part.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        part.extend_from_slice(format!("{header}\r\n\r\n").as_bytes());
        part.extend_from_slice(&value_bytes);
        parts.push(part);
    }

    let mut body = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            body.extend_from_slice(b"\r\n");
        }
        body.extend_from_slice(part);
    }
    body.extend_from_slice(format!("\r\n--{boundary}--").as_bytes());
    Ok(Some(body))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(name: &str, value: &str) -> MultipartEntry {
        MultipartEntry::Text {
            name: name.to_string(),
            value: value.to_string(),
        }
    }

    #[test]
    fn returns_none_for_empty_entries() {
        assert!(build_multipart_body_bytes(&[], "B").unwrap().is_none());
    }

    #[test]
    fn builds_text_parts_with_boundary_and_escaped_names() {
        let body = build_multipart_body_bytes(&[text("field\"quote", "value")], "BOUNDARY")
            .unwrap()
            .unwrap();
        let rendered = String::from_utf8(body).unwrap();
        assert!(rendered.contains("--BOUNDARY\r\n"));
        assert!(rendered.contains("name=\"field%22quote\""));
        assert!(rendered.contains("\r\n\r\nvalue"));
        assert!(rendered.ends_with("\r\n--BOUNDARY--"));
    }

    /// Scratch directory under the first allowed media root so attachment
    /// reads pass the P0-6 root constraint. Returns `None` in environments
    /// with no resolvable media root (then no path can be read at all).
    fn scratch_dir_under_allowed_root(label: &str) -> Option<std::path::PathBuf> {
        let root = crate::commands::files::allowed_media_save_roots()
            .into_iter()
            .next()?;
        let dir = root.join(format!(
            "aiproxy-multipart-test-{}-{label}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).ok()?;
        Some(dir)
    }

    #[test]
    fn reads_file_parts_from_disk_with_filename() {
        let Some(dir) = scratch_dir_under_allowed_root("read") else {
            // No allowed media root here, so every read is rejected by design;
            // the rejection itself is covered by the outside-root test below.
            return;
        };
        let path = dir.join("a.bin");
        std::fs::write(&path, b"file-bytes").unwrap();
        let token = super::super::files::issue_attachment_token(path.canonicalize().unwrap())
            .map_err(|error| app_error(ERR_INVALID_INPUT, error))
            .unwrap();

        let body = build_multipart_body_bytes(
            &[MultipartEntry::File {
                name: "upload".to_string(),
                file_name: "a.bin".to_string(),
                file_token: token,
                content_type: Some("application/octet-stream".to_string()),
            }],
            "BOUNDARY",
        )
        .unwrap()
        .unwrap();
        let rendered = String::from_utf8(body).unwrap();
        assert!(rendered.contains("name=\"upload\"; filename=\"a.bin\""));
        assert!(rendered.contains("Content-Type: application/octet-stream"));
        assert!(rendered.contains("file-bytes"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_file_failure_includes_file_name() {
        let err = build_multipart_body_bytes(
            &[MultipartEntry::File {
                name: "upload".to_string(),
                file_name: "gone.txt".to_string(),
                file_token: "missing-token".to_string(),
                content_type: None,
            }],
            "BOUNDARY",
        )
        .unwrap_err();
        assert!(err.contains("gone.txt"), "got: {err}");
        assert!(err.contains("expired"), "got: {err}");
    }

    #[test]
    fn rejects_unknown_or_replayed_tokens() {
        let err = build_multipart_body_bytes(
            &[MultipartEntry::File {
                name: "upload".to_string(),
                file_name: "secret.txt".to_string(),
                file_token: "unknown-token".to_string(),
                content_type: None,
            }],
            "BOUNDARY",
        )
        .unwrap_err();
        assert!(err.contains("expired"), "got: {err}");
    }

    #[test]
    fn issued_token_can_be_reused_for_retries() {
        let Some(dir) = scratch_dir_under_allowed_root("reuse") else {
            return;
        };
        let path = dir.join("retry.txt");
        std::fs::write(&path, b"retry-bytes").unwrap();
        let token =
            super::super::files::issue_attachment_token(path.canonicalize().unwrap()).unwrap();
        let entry = MultipartEntry::File {
            name: "upload".to_string(),
            file_name: "retry.txt".to_string(),
            file_token: token,
            content_type: None,
        };
        assert!(build_multipart_body_bytes(std::slice::from_ref(&entry), "B").is_ok());
        assert!(build_multipart_body_bytes(&[entry], "B").is_ok());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn rejects_content_type_with_crlf_injection() {
        let err = build_multipart_body_bytes(
            &[MultipartEntry::File {
                name: "upload".to_string(),
                file_name: "a.bin".to_string(),
                file_token: "/definitely/missing/aiproxy-file.bin".to_string(),
                content_type: Some("text/plain\r\nX-Injected: 1".to_string()),
            }],
            "BOUNDARY",
        )
        .unwrap_err();
        assert!(err.contains("invalid Content-Type"), "got: {err}");
        // The rejected value must not appear with real CR/LF bytes anywhere
        // (header, logs, or UI).
        assert!(!err.contains("\r\n"), "got: {err}");
    }

    #[test]
    fn rejects_content_type_with_other_control_or_non_ascii_bytes() {
        for value in ["a\u{0}b", "text/plain\n", "text/plain\r", "类型/中文"] {
            let err = build_multipart_body_bytes(
                &[MultipartEntry::File {
                    name: "upload".to_string(),
                    file_name: "a.bin".to_string(),
                    file_token: "/definitely/missing/aiproxy-file.bin".to_string(),
                    content_type: Some(value.to_string()),
                }],
                "BOUNDARY",
            )
            .unwrap_err();
            assert!(
                err.contains("invalid Content-Type"),
                "value {value:?}: {err}"
            );
        }
    }

    #[test]
    fn empty_content_type_falls_back_to_octet_stream() {
        let body = build_multipart_body_bytes(
            &[MultipartEntry::File {
                name: "upload".to_string(),
                file_name: "a.bin".to_string(),
                file_token: "/definitely/missing/aiproxy-file.bin".to_string(),
                content_type: Some("  ".to_string()),
            }],
            "BOUNDARY",
        );
        // The blank content type resolves to the default before an invalid
        // attachment token can affect encoding.
        let err = body.unwrap_err();
        assert!(err.contains("expired"), "got: {err}");
    }

    #[test]
    fn accepts_media_type_parameters_in_content_type() {
        let resolved = resolve_part_content_type(Some("application/json; charset=utf-8")).unwrap();
        assert_eq!(resolved, "application/json; charset=utf-8");
    }
}

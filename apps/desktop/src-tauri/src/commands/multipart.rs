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
        file_path: String,
        content_type: Option<String>,
    },
}

/// Escape structural characters in a multipart field name so a crafted name
/// cannot break out of the Content-Disposition header (RFC 2388 / M16, mirror
/// of the retired frontend buildMultipartBody).
fn escape_field_name(name: &str) -> String {
    name.replace('"', "%22").replace(['\r', '\n'], "")
}

fn read_attachment_bytes(entry: &MultipartEntry) -> Result<Vec<u8>, String> {
    let MultipartEntry::File {
        file_name,
        file_path,
        ..
    } = entry
    else {
        return Ok(Vec::new());
    };

    // Canonicalize to resolve symlinks at send time (D1, aligns with the
    // HAR/rules import trust model: the renderer-supplied path is treated like
    // a MapRule local targetValue).
    let canonical = std::fs::canonicalize(file_path).map_err(|error| {
        format!(
            "attachment '{}' ({}) cannot be resolved: {error}",
            file_name, file_path
        )
    })?;
    if !canonical.is_file() {
        return Err(format!(
            "attachment '{}' ({}) is not a file",
            file_name, file_path
        ));
    }

    let metadata = std::fs::metadata(&canonical).map_err(|error| {
        format!(
            "attachment '{}' ({}) cannot be read: {error}",
            file_name, file_path
        )
    })?;
    if metadata.len() > MAX_MULTIPART_FILE_BYTES as u64 {
        return Err(format!(
            "attachment '{}' ({}) exceeds the {} MB limit",
            file_name,
            file_path,
            MAX_MULTIPART_FILE_BYTES / (1024 * 1024)
        ));
    }

    std::fs::read(&canonical).map_err(|error| {
        format!(
            "attachment '{}' ({}) cannot be read: {error}",
            file_name, file_path
        )
    })
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
                let content_type = content_type
                    .as_deref()
                    .unwrap_or("application/octet-stream");
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

    #[test]
    fn reads_file_parts_from_disk_with_filename() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("aiproxy-multipart-{}.bin", std::process::id()));
        std::fs::write(&path, b"file-bytes").unwrap();

        let body = build_multipart_body_bytes(
            &[MultipartEntry::File {
                name: "upload".to_string(),
                file_name: "a.bin".to_string(),
                file_path: path.display().to_string(),
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
    }

    #[test]
    fn missing_file_failure_includes_name_and_path() {
        let err = build_multipart_body_bytes(
            &[MultipartEntry::File {
                name: "upload".to_string(),
                file_name: "gone.txt".to_string(),
                file_path: "/definitely/missing/aiproxy-file.txt".to_string(),
                content_type: None,
            }],
            "BOUNDARY",
        )
        .unwrap_err();
        assert!(err.contains("gone.txt"), "got: {err}");
        assert!(err.contains("missing"), "got: {err}");
    }
}

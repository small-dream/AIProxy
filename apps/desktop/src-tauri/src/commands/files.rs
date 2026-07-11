use super::common::*;
use base64::Engine as _;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTextFileInput {
    pub content: String,
    pub file_name: String,
    pub reveal_in_folder: Option<bool>,
}

/// Input for [`pick_and_read_har_file`]. The renderer supplies only a localized
/// dialog title — never a path — so a compromised renderer cannot inject an
/// arbitrary path (H3, mirroring the H10 fix for `read_script_source_file`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickHarFileInput {
    pub title: String,
}

/// Output of [`pick_and_read_har_file`]: the HAR file contents and the picked
/// file name (for display). `None` is returned when the user cancels the dialog.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarFileOutput {
    pub file_name: String,
    pub contents: String,
}

/// Validate that `name` is a plain file basename safe to join under the
/// Downloads directory. Rejects path separators, `..`/`.` segments, and
/// absolute paths so a hostile/broken caller cannot escape Downloads.
/// Returns the validated name for convenience.
fn validate_export_basename(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("file name must not be empty".to_string());
    }
    if trimmed == "." || trimmed == ".." {
        return Err("file name must not be a dot segment".to_string());
    }
    // Reject anything that Path would interpret as a separator or traversal.
    // We check the raw string (not just std::path::Component) so behavior is
    // identical on every platform: a backslash is rejected on unix too.
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("file name must not contain path separators".to_string());
    }
    let path = std::path::Path::new(trimmed);
    if path.is_absolute() {
        return Err("file name must not be an absolute path".to_string());
    }
    if path.components().any(|c| {
        matches!(
            c,
            std::path::Component::ParentDir
                | std::path::Component::RootDir
                | std::path::Component::Prefix(_)
        )
    }) {
        return Err("file name must be a plain file name".to_string());
    }
    Ok(trimmed)
}

#[tauri::command]
pub fn save_text_file(input: SaveTextFileInput, app: tauri::AppHandle) -> Result<String, String> {
    let safe_name = validate_export_basename(&input.file_name)?;
    let downloads_dir = dirs::download_dir()
        .ok_or_else(|| "Unable to locate the Downloads directory.".to_string())?;
    let target_path = next_available_export_path(&downloads_dir, safe_name);

    std::fs::write(&target_path, input.content.as_bytes())
        .map_err(|error| format!("write exported file: {error}"))?;

    if input.reveal_in_folder.unwrap_or(false) {
        app.opener()
            .reveal_item_in_dir(&target_path)
            .map_err(|error| format!("reveal exported file: {error}"))?;
    }

    Ok(target_path.display().to_string())
}

/// Upper bound on a HAR import. HAR archives can be large, but capping
/// prevents a pathologically-large (or maliciously-crafted) file from consuming
/// unbounded memory through the IPC boundary.
const MAX_HAR_IMPORT_BYTES: usize = 64 * 1024 * 1024;

fn err_invalid_har() -> String {
    app_error(ERR_INVALID_INPUT, "Unsupported HAR file path.")
}

/// Whether `path` has a `.har` extension (case-insensitive). Extracted as a
/// pure helper so it can be unit-tested independently of the dialog-driven
/// `pick_and_read_har_file` command.
fn is_har_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("har"))
        .unwrap_or(false)
}

/// H3 (mirrors the H10 fix for `read_script_source_file`): the backend owns the
/// file dialog. The renderer supplies only a localized dialog title — never a
/// path — and the OS file picker is driven from the Rust side via
/// `tauri-plugin-dialog`. This closes the arbitrary-file-read primitive under
/// the compromised-renderer threat model: a malicious renderer can trigger the
/// dialog but cannot inject a path, because the picker result never crosses the
/// IPC boundary as input. The picked path is canonicalized before read so a
/// swapped symlink target does not redirect the read after selection. Returns
/// `None` when the user cancels.
#[tauri::command]
pub async fn pick_and_read_har_file(
    app: tauri::AppHandle,
    input: PickHarFileInput,
) -> Result<Option<HarFileOutput>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("HAR", &["har"])
        .set_title(input.title)
        .pick_file(move |picked| {
            let _ = tx.send(picked);
        });
    let Some(picked) = rx
        .await
        .map_err(|e| app_error(ERR_INTERNAL, format!("dialog channel closed: {e}")))?
    else {
        return Ok(None);
    };

    let path_buf = match picked.into_path() {
        Ok(p) => p,
        Err(_) => return Err(err_invalid_har()),
    };

    // Canonicalize to resolve any symlink at the picked location, then verify
    // the extension on the canonical target (a symlink `innocent.har` pointing
    // at a non-HAR file must still be rejected).
    let canon = std::fs::canonicalize(&path_buf).map_err(|_| err_invalid_har())?;
    if !is_har_extension(&canon) {
        return Err(err_invalid_har());
    }

    let bytes = run_blocking_command("pick_and_read_har_file_read", move || {
        std::fs::read(&canon).map_err(|_| err_invalid_har())
    })
    .await?;
    if bytes.len() > MAX_HAR_IMPORT_BYTES {
        return Err(app_error(
            ERR_INVALID_INPUT,
            format!(
                "HAR file exceeds the {} MB limit",
                MAX_HAR_IMPORT_BYTES / (1024 * 1024)
            ),
        ));
    }

    let contents = String::from_utf8(bytes).map_err(|_| err_invalid_har())?;
    let file_name = path_buf
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("import.har")
        .to_string();

    Ok(Some(HarFileOutput {
        file_name,
        contents,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveMediaFileInput {
    pub base64_content: String,
    pub path: String,
}

fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    // Use the standard base64 crate instead of a hand-rolled decoder. The old
    // implementation silently skipped illegal bytes and produced corrupted
    // output for malformed input (M4), so saved media could be unopenable with
    // no error reported.
    base64::engine::general_purpose::STANDARD
        .decode(input.trim())
        .map_err(|error| format!("decode base64 content: {error}"))
}

fn allowed_media_save_roots() -> Vec<PathBuf> {
    [
        dirs::download_dir(),
        dirs::picture_dir(),
        dirs::video_dir(),
        dirs::desktop_dir(),
        dirs::document_dir(),
    ]
    .into_iter()
    .flatten()
    .filter_map(|dir| std::fs::canonicalize(dir).ok())
    .collect()
}

fn reject_unsafe_write_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("save path must be absolute".to_string());
    }

    let parent = path
        .parent()
        .ok_or_else(|| "save path has no parent directory".to_string())?;
    let canon_parent =
        std::fs::canonicalize(parent).map_err(|e| format!("cannot resolve save directory: {e}"))?;
    if path.file_name().is_none() {
        return Err("save path has no file name".to_string());
    }

    let allowed_roots = allowed_media_save_roots();
    if allowed_roots
        .iter()
        .any(|root| canon_parent.starts_with(root))
    {
        return Ok(());
    }

    Err("save path must be inside Downloads, Pictures, Videos, Desktop, or Documents".to_string())
}

#[tauri::command]
pub fn save_media_file(input: SaveMediaFileInput) -> Result<String, String> {
    let bytes = decode_base64(&input.base64_content)?;
    let path = Path::new(&input.path);
    reject_unsafe_write_path(path)?;
    std::fs::write(path, &bytes).map_err(|error| format!("write file: {error}"))?;
    Ok(path.display().to_string())
}

fn next_available_export_path(downloads_dir: &Path, file_name: &str) -> PathBuf {
    let requested_path = downloads_dir.join(file_name);

    if !requested_path.exists() {
        return requested_path;
    }

    let stem = requested_path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("export");
    let extension = requested_path.extension().and_then(|value| value.to_str());

    for index in 1..10_000 {
        let candidate_name = match extension {
            Some(extension) => format!("{stem} ({index}).{extension}"),
            None => format!("{stem} ({index})"),
        };
        let candidate_path = downloads_dir.join(candidate_name);

        if !candidate_path.exists() {
            return candidate_path;
        }
    }

    requested_path
}

#[cfg(test)]
mod tests {
    use super::{validate_export_basename, *};

    #[test]
    fn accepts_plain_basename() {
        assert_eq!(
            validate_export_basename("export.har").unwrap(),
            "export.har"
        );
        assert_eq!(
            validate_export_basename("session (1).json").unwrap(),
            "session (1).json"
        );
    }

    #[test]
    fn rejects_empty_and_dot_segments() {
        assert!(validate_export_basename("").is_err());
        assert!(validate_export_basename(".").is_err());
        assert!(validate_export_basename("..").is_err());
        assert!(validate_export_basename(" ").is_err());
    }

    #[test]
    fn rejects_path_traversal() {
        assert!(validate_export_basename("../foo.txt").is_err());
        assert!(validate_export_basename("a/../b.txt").is_err());
        assert!(validate_export_basename("sub/dir/foo.txt").is_err());
        assert!(validate_export_basename("a\\b.txt").is_err());
        assert!(validate_export_basename("\\\\host\\share\\f").is_err());
    }

    #[test]
    fn rejects_absolute_paths() {
        assert!(validate_export_basename("/etc/passwd").is_err());
        assert!(validate_export_basename("C:\\Users\\x").is_err());
    }

    // H3: the HAR extension check is case-insensitive and rejects non-HAR / no
    // extension. The dialog-driven command cannot be unit-tested, but the pure
    // classifier it relies on is.
    #[test]
    fn h3_is_har_extension_classifies_case_insensitively() {
        assert!(is_har_extension(Path::new("capture.har")));
        assert!(is_har_extension(Path::new("capture.HAR")));
        assert!(is_har_extension(Path::new("capture.Har")));
        assert!(is_har_extension(Path::new("/some/dir/capture.har")));
        // Non-HAR extensions and no extension are rejected.
        assert!(!is_har_extension(Path::new("secret.js")));
        assert!(!is_har_extension(Path::new("id_rsa")));
        assert!(!is_har_extension(Path::new("no_extension")));
    }

    // H3: err_invalid_har produces a structured INVALID_INPUT error, so the
    // frontend's coerceAppError can recover the code (consistent with A3).
    #[test]
    fn h3_err_invalid_har_returns_structured_invalid_input_error() {
        let raw = err_invalid_har();
        // app_error produces a JSON string with a "code" field.
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["code"], serde_json::json!("INVALID_INPUT"));
    }
}

use super::common::*;
use base64::Engine as _;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTextFileInput {
    pub content: String,
    pub file_name: String,
    pub reveal_in_folder: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadHarFileInput {
    pub path: String,
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
            std::path::Component::ParentDir | std::path::Component::RootDir | std::path::Component::Prefix(_)
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

#[tauri::command]
pub fn read_har_file(input: ReadHarFileInput) -> Result<String, String> {
    let path = Path::new(&input.path);
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .ok_or_else(|| "HAR file must end with .har".to_string())?;

    if extension != "har" {
        return Err("HAR file must end with .har".to_string());
    }

    std::fs::read_to_string(path).map_err(|error| format!("read HAR file: {error}"))
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
    use super::validate_export_basename;

    #[test]
    fn accepts_plain_basename() {
        assert_eq!(validate_export_basename("export.har").unwrap(), "export.har");
        assert_eq!(validate_export_basename("session (1).json").unwrap(), "session (1).json");
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
}

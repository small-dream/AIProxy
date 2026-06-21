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

#[tauri::command]
pub fn save_text_file(input: SaveTextFileInput, app: tauri::AppHandle) -> Result<String, String> {
    let downloads_dir = dirs::download_dir()
        .ok_or_else(|| "Unable to locate the Downloads directory.".to_string())?;
    let target_path = next_available_export_path(&downloads_dir, &input.file_name);

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

/// Reject paths that target OS-protected locations. The intended caller passes
/// a user-chosen path from the native save dialog (the trust boundary for a
/// local tool), but a direct `invoke` with a crafted path could otherwise write
/// into system directories. This is defense-in-depth, not a full sandbox (M3).
fn reject_unsafe_write_path(path: &Path) -> Result<(), String> {
    let Some(path_str) = path.to_str() else {
        return Err("save path is not valid UTF-8".to_string());
    };
    let normalized = path_str.replace('\\', "/");
    // Block writes into Windows system directories. Drive letters vary, so match
    // on the well-known system folder segments.
    let lowered = normalized.to_ascii_lowercase();
    let blocked_segments = ["/windows/system32", "/windows/syswow64"];
    if blocked_segments.iter().any(|seg| lowered.contains(seg)) {
        return Err("refusing to write into a protected system directory".to_string());
    }
    Ok(())
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

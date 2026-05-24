use super::common::*;

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
    const TABLE: &[u8; 128] = &[
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 62, 0, 62, 0, 63,
        52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 0, 0, 0, 0, 0, 0,
        0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
        15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 0, 0, 0, 0, 63,
        0, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
        41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 0, 0, 0, 0, 0,
    ];

    let trimmed = input.trim_end_matches('=');
    let mut bytes = Vec::with_capacity(trimmed.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits = 0u32;

    for ch in trimmed.bytes() {
        let val = *TABLE.get(ch as usize).unwrap_or(&0);
        if val == 0 && ch != b'A' {
            continue;
        }
        buf = (buf << 6) | val as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((buf >> bits) as u8);
        }
    }

    Ok(bytes)
}

#[tauri::command]
pub fn save_media_file(input: SaveMediaFileInput) -> Result<String, String> {
    let bytes = decode_base64(&input.base64_content)?;
    let path = Path::new(&input.path);
    std::fs::write(path, &bytes)
        .map_err(|error| format!("write file: {error}"))?;
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

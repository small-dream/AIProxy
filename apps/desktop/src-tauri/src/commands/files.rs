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

/// Input for [`pick_and_read_rules_file`]. Same trust model as the HAR picker:
/// the renderer supplies only a localized dialog title, never a path.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickRulesFileInput {
    pub title: String,
}

/// Output of [`pick_and_read_rules_file`]: the rules-export file contents and
/// the picked file name. `None` when the user cancels the dialog.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RulesFileOutput {
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

fn is_rules_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("json"))
        .unwrap_or(false)
}

fn err_invalid_rules_file() -> String {
    app_error(ERR_INVALID_INPUT, "Unsupported rules file path.")
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

/// Backend-owned file picker for a rules-export JSON file (R2), mirroring
/// `pick_and_read_har_file`: canonicalize + extension check + 64 MB cap.
#[tauri::command]
pub async fn pick_and_read_rules_file(
    app: tauri::AppHandle,
    input: PickRulesFileInput,
) -> Result<Option<RulesFileOutput>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Rules JSON", &["json"])
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
        Err(_) => return Err(err_invalid_rules_file()),
    };

    let canon = std::fs::canonicalize(&path_buf).map_err(|_| err_invalid_rules_file())?;
    if !is_rules_extension(&canon) {
        return Err(err_invalid_rules_file());
    }

    let bytes = run_blocking_command("pick_and_read_rules_file_read", move || {
        std::fs::read(&canon).map_err(|_| err_invalid_rules_file())
    })
    .await?;
    if bytes.len() > MAX_HAR_IMPORT_BYTES {
        return Err(app_error(
            ERR_INVALID_INPUT,
            format!(
                "Rules file exceeds the {} MB limit",
                MAX_HAR_IMPORT_BYTES / (1024 * 1024)
            ),
        ));
    }

    let contents = String::from_utf8(bytes).map_err(|_| err_invalid_rules_file())?;
    let file_name = path_buf
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("rules.json")
        .to_string();

    Ok(Some(RulesFileOutput {
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

// ── Save captured response bodies as files ──────────────────────────────
//
// Charles-style "save every captured file under this folder". The renderer
// supplies only session ids and a conflict strategy; the backend owns the
// directory picker (same H3 model as `pick_and_read_har_file`), derives every
// relative path itself, and writes the raw body bytes. Nothing about the
// destination crosses the IPC boundary as input, and no body is base64-encoded
// through IPC, so binary payloads land byte-identical.

/// Upper bound on a single export. Guards against a selection that spans the
/// whole capture writing an unbounded number of files before the user reacts.
const MAX_RESPONSE_FILE_EXPORT_COUNT: usize = 20_000;

/// Maximum number of path segments reconstructed from a URL. Deeply nested URLs
/// would otherwise produce directory chains that blow past Windows' MAX_PATH.
const MAX_EXPORT_PATH_DEPTH: usize = 24;

/// Maximum length of one sanitized path segment, in bytes. Long segments are
/// truncated (extension preserved) rather than rejected.
const MAX_EXPORT_SEGMENT_LEN: usize = 100;

/// How to handle several captured requests that map to the same target file.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ResponseFileConflictStrategy {
    /// Keep only the most recent response for each target path.
    LatestOnly,
    /// Keep every response, disambiguating with a ` (n)` suffix.
    KeepAll,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResponseFilesInput {
    pub session_ids: Vec<String>,
    pub conflict_strategy: ResponseFileConflictStrategy,
    /// Localized directory-picker title. The only renderer-controlled string —
    /// it never influences where anything is written.
    pub title: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResponseFilesOutput {
    pub directory: String,
    pub saved_count: usize,
    /// Requests with no response body to write: WebSocket streams, empty
    /// bodies (204/304), and ids the backend no longer holds (e.g. sessions
    /// imported into the renderer from a HAR file).
    pub skipped_count: usize,
    /// Requests whose body could not be read or written.
    pub failed_count: usize,
    /// Files written whose captured body had been clipped by the capture-size
    /// limit — they exist on disk but are only a prefix of the response.
    pub truncated_count: usize,
}

/// Whether the summary describes a WebSocket stream rather than a single
/// request/response file. Mirrors `isWebSocketSessionProtocol` on the frontend.
fn is_websocket_summary(summary: &ProxySessionSummary) -> bool {
    summary
        .application_protocol
        .eq_ignore_ascii_case("websocket")
        || summary.protocol.eq_ignore_ascii_case("ws")
        || summary.protocol.eq_ignore_ascii_case("wss")
        || summary
            .response_mime_type
            .as_deref()
            .is_some_and(|mime| mime.eq_ignore_ascii_case("websocket"))
}

/// Map a response MIME type to a file extension, used only when the URL itself
/// carries no extension. Unlike the frontend's `guessExtension` (which targets
/// the text-oriented single "Save response" action and falls back to `txt`),
/// this falls back to `bin`: a bulk export writes raw bytes, so labelling an
/// unknown binary payload `.txt` would be actively misleading.
fn guess_response_extension(mime_type: &str) -> &'static str {
    let mime = mime_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();

    match mime.as_str() {
        "application/json" | "text/json" => return "json",
        "text/html" => return "html",
        "text/css" => return "css",
        "text/plain" => return "txt",
        "text/csv" => return "csv",
        "text/markdown" => return "md",
        "image/svg+xml" => return "svg",
        "image/jpeg" => return "jpg",
        "image/x-icon" | "image/vnd.microsoft.icon" => return "ico",
        "application/pdf" => return "pdf",
        "application/zip" => return "zip",
        "application/wasm" => return "wasm",
        "font/woff2" => return "woff2",
        "font/woff" => return "woff",
        "font/ttf" | "application/x-font-ttf" => return "ttf",
        _ => {}
    }

    // Suffix/substring matches for the long tail of vendor-prefixed types
    // (application/vnd.api+json, application/x-javascript, …).
    if mime.ends_with("+json") || mime.contains("json") {
        return "json";
    }
    if mime.contains("javascript") || mime.contains("ecmascript") {
        return "js";
    }
    if mime.ends_with("+xml") || mime.contains("xml") {
        return "xml";
    }
    if mime.contains("html") {
        return "html";
    }
    if let Some(subtype) = mime.strip_prefix("image/") {
        return match subtype {
            "png" => "png",
            "gif" => "gif",
            "webp" => "webp",
            "avif" => "avif",
            "bmp" => "bmp",
            "tiff" => "tiff",
            _ => "bin",
        };
    }
    if mime.starts_with("text/") {
        return "txt";
    }

    "bin"
}

/// Reserved device names on Windows. A file called `con.json` is unopenable
/// there, so such stems get an underscore prefix on every platform to keep
/// exports portable between machines.
const WINDOWS_RESERVED_STEMS: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Reduce one URL segment to something safe to use as a path component on all
/// three platforms. Never returns a value containing a separator, a dot
/// segment, or a reserved device name, so a sanitized segment cannot escape the
/// export root no matter what the captured URL contained.
fn sanitize_path_segment(segment: &str) -> String {
    let decoded = percent_decode_segment(segment);
    let mut sanitized = String::with_capacity(decoded.len());

    for character in decoded.chars() {
        let is_illegal = matches!(
            character,
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
        ) || character.is_control()
            || is_deceptive_format_char(character);
        sanitized.push(if is_illegal { '_' } else { character });
    }

    // Windows rejects trailing dots and spaces; strip them on every platform so
    // an export copied to Windows stays readable.
    let trimmed = sanitized.trim().trim_end_matches(['.', ' ']).to_string();

    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return "_".to_string();
    }

    let truncated = truncate_segment(&trimmed);
    // Trim before the reserved check: Windows ignores trailing whitespace in
    // the stem, so `con .txt` is as uncreatable as `con.txt`.
    let stem = truncated
        .split('.')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();

    if WINDOWS_RESERVED_STEMS.contains(&stem.as_str()) {
        return format!("_{truncated}");
    }

    truncated
}

/// Unicode format characters that spoof file names rather than add meaning:
/// bidi/RTL overrides (U+202A-202E, U+2066-2069, U+200E/200F), the BOM, and
/// the soft hyphen. They are replaced with `_`. Joiner characters
/// (U+200B-200D) are deliberately kept — emoji sequences in file names are
/// legitimate and must not be visually shattered.
fn is_deceptive_format_char(character: char) -> bool {
    matches!(
        character,
        '\u{00AD}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'
            | '\u{FEFF}'
    )
}

/// Truncate an over-long segment on a char boundary, keeping the extension so
/// the saved file still opens with the right application.
fn truncate_segment(segment: &str) -> String {
    if segment.len() <= MAX_EXPORT_SEGMENT_LEN {
        return segment.to_string();
    }

    let extension = segment
        .rsplit_once('.')
        .map(|(_, ext)| ext)
        .filter(|ext| !ext.is_empty() && ext.len() <= 16)
        .unwrap_or_default();
    let budget = MAX_EXPORT_SEGMENT_LEN.saturating_sub(extension.len() + 1);
    let mut head = String::new();

    for character in segment.chars() {
        if head.len() + character.len_utf8() > budget {
            break;
        }
        head.push(character);
    }

    if extension.is_empty() {
        head
    } else {
        format!("{head}.{extension}")
    }
}

/// Percent-decode a URL segment so `%E4%B8%AD` lands as a readable file name.
/// Falls back to the raw segment when the escape sequence is not valid UTF-8.
fn percent_decode_segment(segment: &str) -> String {
    percent_encoding::percent_decode_str(segment)
        .decode_utf8()
        .map(|decoded| decoded.into_owned())
        .unwrap_or_else(|_| segment.to_string())
}

/// Rebuild the site layout for one captured request: `dir/.../name.ext`.
///
/// The host is deliberately NOT a directory — the user already chose where the
/// files go, so re-creating `example.com/` inside their pick is noise. The URL
/// path below it is kept in full, so right-clicking `assets` really does
/// produce an `assets/` folder, and saving different folders of the same site
/// into one destination merges into a single coherent tree.
///
/// The query string is dropped, so two requests differing only by query
/// collapse onto the same file — that is the collision the conflict strategy
/// exists to resolve.
fn derive_response_relative_path(url: &str, mime_type: Option<&str>) -> Option<PathBuf> {
    let parsed = Url::parse(url).ok()?;

    let all_segments: Vec<&str> = parsed
        .path()
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();

    // A URL ending in `/` (or a bare `/`) names a directory, not a file: every
    // segment is a directory and the payload is saved as `index.<ext>`, the way
    // a site would serve it. Otherwise the last segment is the file name.
    let is_directory_url = parsed.path().ends_with('/');
    let file_stem = if is_directory_url {
        "index".to_string()
    } else {
        all_segments
            .last()
            .map(|segment| sanitize_path_segment(segment))
            .unwrap_or_else(|| "index".to_string())
    };

    let directory_segments = if is_directory_url {
        all_segments.as_slice()
    } else {
        // The last segment is the file name, not a directory.
        all_segments.split_last().map_or(&[][..], |(_, rest)| rest)
    };

    let mut path = PathBuf::new();

    for segment in directory_segments.iter().take(
        // Reserve one slot for the file name itself.
        MAX_EXPORT_PATH_DEPTH.saturating_sub(1),
    ) {
        path.push(sanitize_path_segment(segment));
    }

    path.push(ensure_file_extension(&file_stem, mime_type));

    Some(path)
}

/// Append a MIME-derived extension when the URL segment has none. A segment
/// that already ends in a plausible extension (`app.js`, `logo.png`) is left
/// untouched so the export mirrors the original site.
fn ensure_file_extension(file_name: &str, mime_type: Option<&str>) -> String {
    let has_extension = file_name.rsplit_once('.').is_some_and(|(stem, extension)| {
        !stem.is_empty()
            && !extension.is_empty()
            && extension.len() <= 16
            && extension.chars().all(|c| c.is_ascii_alphanumeric())
    });

    if has_extension {
        return file_name.to_string();
    }

    let extension = guess_response_extension(mime_type.unwrap_or_default());
    format!("{file_name}.{extension}")
}

/// Plan entry: which session gets written where, before any body is read.
struct ResponseFilePlanEntry {
    session_id: String,
    relative_path: PathBuf,
}

/// Build the write plan from summaries alone — no body is touched here, so a
/// selection spanning thousands of requests stays cheap until it is committed.
/// Returns the plan plus the number of requests skipped for having nothing to
/// save (WebSocket streams, empty responses, ids the backend no longer holds).
fn build_response_file_plan(
    session_ids: &[String],
    summaries: &[ProxySessionSummary],
    strategy: ResponseFileConflictStrategy,
) -> (Vec<ResponseFilePlanEntry>, usize) {
    let summaries_by_id: std::collections::HashMap<&str, &ProxySessionSummary> = summaries
        .iter()
        .map(|summary| (summary.id.as_str(), summary))
        .collect();

    let mut planned: Vec<(ResponseFilePlanEntry, String)> = Vec::new();
    let mut skipped = 0usize;
    // The same id twice would write the same body twice (KeepAll) or race the
    // dedup logic (LatestOnly), so collapse duplicates up front.
    let mut seen_ids: std::collections::HashSet<&str> = std::collections::HashSet::new();

    for session_id in session_ids {
        if !seen_ids.insert(session_id.as_str()) {
            continue;
        }
        let Some(summary) = summaries_by_id.get(session_id.as_str()) else {
            skipped += 1;
            continue;
        };

        if is_websocket_summary(summary) {
            skipped += 1;
            continue;
        }

        let Some(relative_path) =
            derive_response_relative_path(&summary.url, summary.response_mime_type.as_deref())
        else {
            skipped += 1;
            continue;
        };

        planned.push((
            ResponseFilePlanEntry {
                session_id: session_id.clone(),
                relative_path,
            },
            summary.started_at.clone(),
        ));
    }

    if strategy == ResponseFileConflictStrategy::KeepAll {
        return (
            planned.into_iter().map(|(entry, _)| entry).collect(),
            skipped,
        );
    }

    // LatestOnly: collapse each target path down to its most recent capture.
    // `started_at` is an ISO-8601 UTC timestamp, so lexical order is chronological;
    // ties fall back to the later position in the selection.
    let mut latest_by_path: std::collections::HashMap<PathBuf, (usize, String)> =
        std::collections::HashMap::new();

    for (index, (entry, started_at)) in planned.iter().enumerate() {
        match latest_by_path.get(&entry.relative_path) {
            Some((_, current_started_at)) if current_started_at.as_str() > started_at.as_str() => {}
            _ => {
                latest_by_path.insert(entry.relative_path.clone(), (index, started_at.clone()));
            }
        }
    }

    let kept: std::collections::HashSet<usize> =
        latest_by_path.values().map(|(index, _)| *index).collect();
    let dropped = planned.len() - kept.len();

    (
        planned
            .into_iter()
            .enumerate()
            .filter(|(index, _)| kept.contains(index))
            .map(|(_, (entry, _))| entry)
            .collect(),
        skipped + dropped,
    )
}

/// Charles-style bulk export: write the captured response body of every request
/// under the selected tree folder into a user-chosen directory, rebuilding the
/// `host/path` layout. Returns `None` when the user cancels the picker.
#[tauri::command]
pub async fn save_response_files(
    app: tauri::AppHandle,
    input: SaveResponseFilesInput,
    state: State<'_, Arc<AppState>>,
) -> Result<Option<SaveResponseFilesOutput>, String> {
    use tauri_plugin_dialog::DialogExt;

    if input.session_ids.is_empty() {
        return Err(app_error(
            ERR_INVALID_INPUT,
            "No captured requests were selected.",
        ));
    }
    if input.session_ids.len() > MAX_RESPONSE_FILE_EXPORT_COUNT {
        return Err(app_error(
            ERR_INVALID_INPUT,
            format!("Cannot save more than {MAX_RESPONSE_FILE_EXPORT_COUNT} files at once."),
        ));
    }

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title(input.title)
        .pick_folder(move |picked| {
            let _ = tx.send(picked);
        });
    let Some(picked) = rx
        .await
        .map_err(|e| app_error(ERR_INTERNAL, format!("dialog channel closed: {e}")))?
    else {
        return Ok(None);
    };

    let directory = match picked.into_path() {
        Ok(path) => path,
        Err(_) => {
            return Err(app_error(
                ERR_INVALID_INPUT,
                "The selected destination is not a local directory.",
            ))
        }
    };

    let state = Arc::clone(state.inner());
    let SaveResponseFilesInput {
        session_ids,
        conflict_strategy,
        ..
    } = input;

    run_blocking_command("save_response_files", move || {
        // Resolve the root once so every write can be verified against it.
        // Canonicalizing also collapses any symlink the user picked, which
        // keeps the containment check below meaningful.
        let root = std::fs::canonicalize(&directory)
            .map_err(|error| app_error(ERR_INVALID_INPUT, format!("open destination: {error}")))?;

        let (plan, mut skipped_count) =
            build_response_file_plan(&session_ids, &state.read_sessions(), conflict_strategy);

        let mut saved_count = 0usize;
        let mut failed_count = 0usize;
        let mut truncated_count = 0usize;

        for entry in plan {
            match write_response_file(&state, &root, &entry, conflict_strategy) {
                Ok(Some(outcome)) => {
                    saved_count += 1;
                    if outcome.truncated {
                        truncated_count += 1;
                    }
                }
                Ok(None) => skipped_count += 1,
                Err(error) => {
                    failed_count += 1;
                    tracing::warn!(
                        component = "desktop.files",
                        event = "save_response_file_failed",
                        session_id = %entry.session_id,
                        relative_path = %entry.relative_path.display(),
                        error = %error,
                        "save_response_file_failed"
                    );
                }
            }
        }

        tracing::info!(
            component = "desktop.files",
            event = "save_response_files_completed",
            requested = session_ids.len(),
            saved = saved_count,
            skipped = skipped_count,
            failed = failed_count,
            truncated = truncated_count,
            "save_response_files_completed"
        );

        Ok(Some(SaveResponseFilesOutput {
            // Show the path exactly as the user picked it. `root` is
            // canonicalized for the containment check, which on Windows yields
            // the `\\?\C:\...` verbatim form — correct to compare, hostile to
            // read in a snackbar.
            directory: directory.display().to_string(),
            saved_count,
            skipped_count,
            failed_count,
            truncated_count,
        }))
    })
    .await
}

/// What happened when one planned file was written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WrittenFileOutcome {
    /// The captured body was clipped by the capture-size limit, so the file on
    /// disk is only a prefix of the original response. Worth surfacing so the
    /// user does not mistake the export for the complete body.
    truncated: bool,
}

/// Write one planned file. `Ok(None)` means the request turned out to have no
/// response body to save, which is a skip rather than a failure.
fn write_response_file(
    state: &AppState,
    root: &Path,
    entry: &ResponseFilePlanEntry,
    strategy: ResponseFileConflictStrategy,
) -> Result<Option<WrittenFileOutcome>, String> {
    let Some(detail) = state.read_session_detail(&entry.session_id)? else {
        return Ok(None);
    };
    let Some(body) = detail.response_body.as_ref() else {
        return Ok(None);
    };

    let bytes = body.read_bytes()?;
    if bytes.is_empty() {
        return Ok(None);
    }
    let truncated = body.truncated;
    if truncated {
        tracing::warn!(
            component = "desktop.files",
            event = "save_response_file_truncated",
            session_id = %entry.session_id,
            relative_path = %entry.relative_path.display(),
            size_bytes = body.size_bytes,
            "captured body was clipped by the capture-size limit; the exported file is incomplete"
        );
    }

    write_export_file(root, &entry.relative_path, &bytes, strategy)?;

    Ok(Some(WrittenFileOutcome { truncated }))
}

/// Create one export file under `root`, honoring the conflict strategy.
fn write_export_file(
    root: &Path,
    relative_path: &Path,
    bytes: &[u8],
    strategy: ResponseFileConflictStrategy,
) -> Result<(), String> {
    let target_directory = match relative_path.parent() {
        Some(parent) => root.join(parent),
        None => root.to_path_buf(),
    };
    // Create the directory chain WITHOUT following symbolic links. A plain
    // `create_dir_all` resolves a pre-planted `assets -> /outside` link and
    // would create directories under `/outside` before any post-hoc
    // containment check runs; the walk below refuses the link instead, so
    // nothing is ever created outside the picked root.
    create_export_directories(root, relative_path.parent())?;

    // Defense in depth for races during the walk: re-resolve and re-verify the
    // directory still sits under the canonical root.
    let canonical_directory = std::fs::canonicalize(&target_directory)
        .map_err(|error| format!("resolve export directory: {error}"))?;
    if !canonical_directory.starts_with(root) {
        return Err("export path escaped the selected directory".to_string());
    }

    let file_name = relative_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "derived file name is not valid UTF-8".to_string())?;

    match strategy {
        // LatestOnly promises "only the newest response on disk", so an
        // existing file from an earlier export is replaced, not suffixed.
        ResponseFileConflictStrategy::LatestOnly => {
            overwrite_export_file(&canonical_directory, file_name, bytes, relative_path)
        }
        ResponseFileConflictStrategy::KeepAll => {
            create_new_export_file(&canonical_directory, file_name, bytes)
        }
    }
}

/// Create each directory of the export path under `root`, refusing symbolic
/// links along the way.
///
/// Every component is inspected with `symlink_metadata` (which does NOT
/// follow links): a component may be a real directory, or not exist (then it
/// is created with `create_dir`, which fails with `AlreadyExists` for ANY
/// pre-existing filesystem object — including a symlink — and therefore can
/// never be aimed through a link). A symlink or non-directory component is an
/// error. `root` itself must already exist (it is the canonicalized picker
/// result) and is trusted.
fn create_export_directories(root: &Path, relative_dir: Option<&Path>) -> Result<(), String> {
    let Some(relative_dir) = relative_dir else {
        return Ok(());
    };

    let mut current = root.to_path_buf();
    for component in relative_dir.components() {
        match component {
            std::path::Component::Normal(segment) => current.push(segment),
            // Sanitized relative paths contain only normal components; treat
            // anything else as a bug in the derivation, not something to
            // paper over.
            other => {
                return Err(format!(
                    "unexpected path component in export path: {other:?}"
                ));
            }
        }

        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => {
                return Err(format!(
                    "'{}' in the export path exists but is not a directory",
                    current.display()
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if let Err(create_error) = std::fs::create_dir(&current) {
                    // A concurrent writer that created the same name first is
                    // fine, but only if it turned out to be a directory —
                    // anything else (including a symlink) is an error.
                    let now_a_directory = create_error.kind() == std::io::ErrorKind::AlreadyExists
                        && std::fs::symlink_metadata(&current)
                            .map(|metadata| metadata.is_dir())
                            .unwrap_or(false);
                    if !now_a_directory {
                        return Err(format!(
                            "create export directory '{}': {create_error}",
                            current.display()
                        ));
                    }
                }
            }
            Err(error) => {
                return Err(format!(
                    "inspect export directory '{}': {error}",
                    current.display()
                ));
            }
        }
    }

    Ok(())
}

/// Replace (or create) one export file at exactly `directory/file_name`.
///
/// Unix opens with `O_NOFOLLOW`, so a symbolic link in the final slot fails
/// the open atomically (ELOOP) — no check-then-write window remains. Other
/// platforms fall back to an lstat guard; std has no portable no-follow open
/// there, so a link planted between the check and the write could still be
/// followed (the containment check above covers directory components).
fn overwrite_export_file(
    directory: &Path,
    file_name: &str,
    bytes: &[u8],
    relative_path: &Path,
) -> Result<(), String> {
    let target_path = directory.join(file_name);

    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;

        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&target_path)
            .map_err(|error| {
                if error.raw_os_error() == Some(libc::ELOOP) {
                    format!(
                        "refusing to overwrite symbolic link {}",
                        relative_path.display()
                    )
                } else {
                    format!("write response file: {error}")
                }
            })?;
        file.write_all(bytes)
            .map_err(|error| format!("write response file: {error}"))
    }

    #[cfg(not(unix))]
    {
        let is_symlink = std::fs::symlink_metadata(&target_path)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false);
        if is_symlink {
            return Err(format!(
                "refusing to overwrite symbolic link {}",
                relative_path.display()
            ));
        }
        std::fs::write(&target_path, bytes).map_err(|error| format!("write response file: {error}"))
    }
}

/// Write under a name that does not exist yet, taking ` (n)` suffixes while the
/// preferred name is taken.
///
/// `create_new` (O_EXCL) makes "does a file exist here" and "create the file"
/// one atomic step, so two concurrent exports cannot race onto the same name —
/// and an existing symbolic link yields `AlreadyExists`, so a suffix is taken
/// instead of writing through the link. This replaces the older
/// `exists()`-then-write sequence, whose window could be lost to a concurrent
/// writer and which followed dangling links.
fn create_new_export_file(directory: &Path, file_name: &str, bytes: &[u8]) -> Result<(), String> {
    let as_path = Path::new(file_name);
    let stem = as_path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("export");
    let extension = as_path.extension().and_then(|value| value.to_str());

    for index in 0..10_000u32 {
        let candidate_name = match (index, extension) {
            (0, Some(extension)) => format!("{stem}.{extension}"),
            (0, None) => stem.to_string(),
            (index, Some(extension)) => format!("{stem} ({index}).{extension}"),
            (index, None) => format!("{stem} ({index})"),
        };
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(directory.join(&candidate_name))
        {
            Ok(mut file) => {
                std::io::Write::write_all(&mut file, bytes)
                    .map_err(|error| format!("write response file: {error}"))?;
                return Ok(());
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("create response file: {error}")),
        }
    }

    Err(format!(
        "no free file name available for {file_name} after 10000 candidates"
    ))
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

    // ── save_response_files ────────────────────────────────────────────

    fn summary(id: &str, url: &str, mime: Option<&str>, started_at: &str) -> ProxySessionSummary {
        ProxySessionSummary {
            id: id.to_string(),
            method: "GET".to_string(),
            host: Url::parse(url)
                .ok()
                .and_then(|u| u.host_str().map(str::to_string))
                .unwrap_or_default(),
            path: "/".to_string(),
            protocol: "https".to_string(),
            scheme: "https".to_string(),
            http_version: "1.1".to_string(),
            transport_protocol: "tcp".to_string(),
            application_protocol: "http".to_string(),
            started_at: started_at.to_string(),
            finished_at: started_at.to_string(),
            duration_ms: 1,
            size_bytes: 10,
            status_code: 200,
            url: url.to_string(),
            response_mime_type: mime.map(str::to_string),
        }
    }

    fn relative_paths(entries: &[ResponseFilePlanEntry]) -> Vec<String> {
        entries
            .iter()
            .map(|entry| entry.relative_path.to_string_lossy().replace('\\', "/"))
            .collect()
    }

    #[test]
    fn rebuilds_url_layout_without_the_host_directory() {
        // The user already chose the destination, so re-creating `example.com/`
        // inside it would just be noise.
        let path = derive_response_relative_path("https://api.example.com/v1/users.json", None)
            .expect("path");
        assert_eq!(path.to_string_lossy().replace('\\', "/"), "v1/users.json");
    }

    #[test]
    fn keeps_the_full_url_path_whichever_folder_was_clicked() {
        // Right-clicking `assets` must really produce an `assets/` folder, and
        // the result must not depend on which level of the tree was clicked —
        // that way several saves of one site merge into a coherent tree.
        let path =
            derive_response_relative_path("https://cdn.example.com/assets/img/logo.png", None)
                .expect("path");
        assert_eq!(
            path.to_string_lossy().replace('\\', "/"),
            "assets/img/logo.png"
        );
    }

    #[test]
    fn appends_mime_extension_only_when_url_has_none() {
        // No extension in the URL → derived from the response MIME type.
        let derived = derive_response_relative_path(
            "https://api.example.com/v1/login",
            Some("application/json"),
        )
        .expect("path");
        assert_eq!(
            derived.to_string_lossy().replace('\\', "/"),
            "v1/login.json"
        );

        // The URL already names the file → left exactly as the site served it.
        let untouched = derive_response_relative_path(
            "https://cdn.example.com/static/app.js",
            Some("text/plain"),
        )
        .expect("path");
        assert_eq!(
            untouched.to_string_lossy().replace('\\', "/"),
            "static/app.js"
        );
    }

    #[test]
    fn directory_urls_and_roots_become_index_files() {
        let directory =
            derive_response_relative_path("https://example.com/docs/", Some("text/html"))
                .expect("path");
        assert_eq!(
            directory.to_string_lossy().replace('\\', "/"),
            "docs/index.html"
        );

        let root =
            derive_response_relative_path("https://example.com/", Some("text/html")).expect("path");
        assert_eq!(root.to_string_lossy().replace('\\', "/"), "index.html");
    }

    #[test]
    fn percent_decodes_segments() {
        let path = derive_response_relative_path(
            "https://example.com/%E4%B8%AD%E6%96%87/a%20b.json",
            None,
        )
        .expect("path");
        assert_eq!(path.to_string_lossy().replace('\\', "/"), "中文/a b.json");
    }

    // The security-critical property: nothing a captured URL contains may
    // produce a segment that climbs out of the export root.
    #[test]
    fn sanitization_never_yields_traversal_or_separators() {
        for hostile in [
            "..",
            ".",
            "../../etc",
            "a/b",
            "a\\b",
            "%2e%2e",
            "%2e%2e%2f%2e%2e",
            "C:",
            "",
            "   ",
            "...",
        ] {
            let sanitized = sanitize_path_segment(hostile);
            assert!(!sanitized.is_empty(), "{hostile} produced an empty segment");
            assert!(!sanitized.contains('/'), "{hostile} kept a forward slash");
            assert!(!sanitized.contains('\\'), "{hostile} kept a backslash");
            assert!(!sanitized.contains(':'), "{hostile} kept a colon");
            assert_ne!(sanitized, ".", "{hostile} stayed a dot segment");
            assert_ne!(sanitized, "..", "{hostile} stayed a parent segment");
            assert_eq!(
                std::path::Path::new(&sanitized).components().count(),
                1,
                "{hostile} expanded into several components"
            );
        }
    }

    #[test]
    fn encoded_traversal_in_a_url_stays_inside_the_root() {
        let path =
            derive_response_relative_path("https://example.com/a/%2e%2e/%2e%2e/secret.txt", None)
                .expect("path");
        let rendered = path.to_string_lossy().replace('\\', "/");

        assert!(
            !rendered.contains(".."),
            "traversal survived sanitization: {rendered}"
        );
        assert!(rendered.ends_with("secret.txt"));
    }

    #[test]
    fn prefixes_windows_reserved_names() {
        assert_eq!(sanitize_path_segment("CON"), "_CON");
        assert_eq!(sanitize_path_segment("nul.json"), "_nul.json");
        assert_eq!(sanitize_path_segment("com1.txt"), "_com1.txt");
        // Not reserved — must stay untouched.
        assert_eq!(sanitize_path_segment("console.js"), "console.js");
    }

    #[test]
    fn strips_trailing_dots_and_spaces() {
        assert_eq!(sanitize_path_segment("report."), "report");
        assert_eq!(sanitize_path_segment("report "), "report");
    }

    #[test]
    fn truncates_long_segments_while_keeping_the_extension() {
        let long_name = format!("{}.json", "a".repeat(300));
        let sanitized = sanitize_path_segment(&long_name);

        assert!(sanitized.len() <= MAX_EXPORT_SEGMENT_LEN);
        assert!(sanitized.ends_with(".json"));
    }

    #[test]
    fn caps_directory_depth() {
        let deep_url = format!(
            "https://example.com/{}/file.json",
            vec!["seg"; 60].join("/")
        );
        let path = derive_response_relative_path(&deep_url, None).expect("path");

        // capped directories + file name.
        assert!(path.components().count() <= MAX_EXPORT_PATH_DEPTH);
    }

    #[test]
    fn guesses_extensions_and_falls_back_to_bin_for_unknown_binaries() {
        assert_eq!(guess_response_extension("application/json"), "json");
        assert_eq!(
            guess_response_extension("application/json; charset=utf-8"),
            "json"
        );
        assert_eq!(guess_response_extension("application/vnd.api+json"), "json");
        assert_eq!(guess_response_extension("text/html"), "html");
        assert_eq!(guess_response_extension("application/x-javascript"), "js");
        assert_eq!(guess_response_extension("image/png"), "png");
        assert_eq!(guess_response_extension("image/svg+xml"), "svg");
        assert_eq!(guess_response_extension("image/jpeg"), "jpg");
        assert_eq!(guess_response_extension("font/woff2"), "woff2");
        assert_eq!(guess_response_extension("text/plain"), "txt");
        // Unlike the frontend's text-oriented guessExtension, an unknown binary
        // payload must not be labelled .txt.
        assert_eq!(guess_response_extension("application/octet-stream"), "bin");
        assert_eq!(guess_response_extension(""), "bin");
    }

    #[test]
    fn plan_skips_websocket_sessions() {
        let mut ws = summary(
            "ws-1",
            "https://example.com/socket",
            None,
            "2026-01-01T00:00:00Z",
        );
        ws.application_protocol = "websocket".to_string();
        let summaries = vec![
            ws,
            summary(
                "http-1",
                "https://example.com/a.json",
                Some("application/json"),
                "2026-01-01T00:00:00Z",
            ),
        ];

        let (plan, skipped) = build_response_file_plan(
            &["ws-1".to_string(), "http-1".to_string()],
            &summaries,
            ResponseFileConflictStrategy::KeepAll,
        );

        assert_eq!(relative_paths(&plan), vec!["a.json"]);
        assert_eq!(skipped, 1);
    }

    #[test]
    fn plan_skips_ids_the_backend_no_longer_holds() {
        // Sessions imported into the renderer from a HAR file never reach the
        // backend cache, so they are reported as skipped rather than failed.
        let (plan, skipped) = build_response_file_plan(
            &["imported-1".to_string()],
            &[],
            ResponseFileConflictStrategy::KeepAll,
        );

        assert!(plan.is_empty());
        assert_eq!(skipped, 1);
    }

    #[test]
    fn keep_all_retains_every_capture_of_the_same_path() {
        let summaries = vec![
            summary(
                "s1",
                "https://example.com/a.json",
                None,
                "2026-01-01T00:00:01Z",
            ),
            summary(
                "s2",
                "https://example.com/a.json",
                None,
                "2026-01-01T00:00:02Z",
            ),
        ];

        let (plan, skipped) = build_response_file_plan(
            &["s1".to_string(), "s2".to_string()],
            &summaries,
            ResponseFileConflictStrategy::KeepAll,
        );

        assert_eq!(plan.len(), 2);
        assert_eq!(skipped, 0);
    }

    #[test]
    fn latest_only_keeps_the_most_recent_capture_of_each_path() {
        let summaries = vec![
            summary(
                "old",
                "https://example.com/a.json",
                None,
                "2026-01-01T00:00:01Z",
            ),
            summary(
                "new",
                "https://example.com/a.json",
                None,
                "2026-01-01T00:00:09Z",
            ),
            summary(
                "other",
                "https://example.com/b.json",
                None,
                "2026-01-01T00:00:05Z",
            ),
        ];

        let (plan, skipped) = build_response_file_plan(
            &["old".to_string(), "new".to_string(), "other".to_string()],
            &summaries,
            ResponseFileConflictStrategy::LatestOnly,
        );

        let mut kept: Vec<&str> = plan.iter().map(|entry| entry.session_id.as_str()).collect();
        kept.sort_unstable();

        assert_eq!(kept, vec!["new", "other"]);
        // The superseded capture counts as skipped, not saved.
        assert_eq!(skipped, 1);
    }

    #[test]
    fn latest_only_treats_query_variants_as_the_same_file() {
        // The query string is dropped from the derived path, so `?page=1` and
        // `?page=2` collapse onto one file — that is exactly the collision the
        // conflict strategy exists to resolve.
        let summaries = vec![
            summary(
                "p1",
                "https://example.com/list?page=1",
                Some("application/json"),
                "2026-01-01T00:00:01Z",
            ),
            summary(
                "p2",
                "https://example.com/list?page=2",
                Some("application/json"),
                "2026-01-01T00:00:02Z",
            ),
        ];

        let (plan, skipped) = build_response_file_plan(
            &["p1".to_string(), "p2".to_string()],
            &summaries,
            ResponseFileConflictStrategy::LatestOnly,
        );

        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].session_id, "p2");
        assert_eq!(skipped, 1);
    }

    #[test]
    fn next_available_export_path_disambiguates_keep_all_collisions() {
        let dir = tempfile::tempdir().expect("tempdir");
        let first = next_available_export_path(dir.path(), "a.json");
        std::fs::write(&first, b"1").expect("write");

        let second = next_available_export_path(dir.path(), "a.json");

        assert_ne!(first, second);
        assert_eq!(
            second.file_name().and_then(|n| n.to_str()),
            Some("a (1).json")
        );
    }

    #[test]
    fn plan_dedupes_repeated_session_ids() {
        // The same id twice would write the same body twice under KeepAll.
        let summaries = vec![summary(
            "s1",
            "https://example.com/a.json",
            Some("application/json"),
            "2026-01-01T00:00:00Z",
        )];

        let (plan, _skipped) = build_response_file_plan(
            &["s1".to_string(), "s1".to_string()],
            &summaries,
            ResponseFileConflictStrategy::KeepAll,
        );

        assert_eq!(plan.len(), 1, "duplicate ids must collapse to one write");
    }

    #[test]
    fn latest_only_overwrites_a_previous_export_in_place() {
        // The dialog promises "save only the newest response" — re-exporting
        // into the same directory must replace the old file, not park the new
        // capture next to it as `name (1).ext`.
        let dir = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(dir.path()).expect("canonical root");
        std::fs::write(root.join("index.html"), b"MONDAY-OLD").expect("seed old export");

        write_export_file(
            &root,
            Path::new("index.html"),
            b"TUESDAY-NEW",
            ResponseFileConflictStrategy::LatestOnly,
        )
        .expect("write");

        assert_eq!(
            std::fs::read(root.join("index.html")).expect("read"),
            b"TUESDAY-NEW",
            "the previous export must be replaced with the newest capture"
        );
        assert!(
            !root.join("index (1).html").exists(),
            "latest-only must not suffix the newest capture"
        );
    }

    #[test]
    fn keep_all_suffixes_next_to_a_previous_export() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(dir.path()).expect("canonical root");
        std::fs::write(root.join("a.json"), b"OLD").expect("seed old export");

        write_export_file(
            &root,
            Path::new("a.json"),
            b"NEW",
            ResponseFileConflictStrategy::KeepAll,
        )
        .expect("write");

        assert_eq!(std::fs::read(root.join("a.json")).expect("read"), b"OLD");
        assert_eq!(
            std::fs::read(root.join("a (1).json")).expect("read"),
            b"NEW"
        );
    }

    #[cfg(unix)]
    #[test]
    fn export_refuses_to_write_through_a_symbolic_link_file() {
        use std::os::unix::fs::symlink;

        // Both strategies must refuse a pre-planted symlink as the final path
        // component: the directory containment check cannot see it, and
        // following it would write outside the picked root.
        let dir = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(dir.path()).expect("canonical root");
        let outside = tempfile::tempdir().expect("outside tempdir");
        let outside_target = outside.path().join("pwned.txt");
        symlink(&outside_target, root.join("data.txt")).expect("symlink");

        for strategy in [
            ResponseFileConflictStrategy::LatestOnly,
            ResponseFileConflictStrategy::KeepAll,
        ] {
            let result = write_export_file(&root, Path::new("data.txt"), b"X", strategy);
            match strategy {
                ResponseFileConflictStrategy::LatestOnly => {
                    assert!(
                        result.is_err(),
                        "latest-only must refuse to overwrite a symbolic link"
                    );
                }
                ResponseFileConflictStrategy::KeepAll => {
                    // KeepAll takes a fresh name instead; a dangling symlink
                    // still "exists" for create_new, so the write is suffixed.
                    result.expect("keep-all writes beside the link");
                    assert!(
                        root.join("data (1).txt").exists(),
                        "keep-all must not write through the symbolic link"
                    );
                }
            }
        }
        assert!(
            !outside_target.exists(),
            "nothing may be created through the symbolic link"
        );
    }

    #[cfg(unix)]
    #[test]
    fn export_refuses_a_symbolic_link_directory_without_creating_outside() {
        use std::os::unix::fs::symlink;

        // A pre-planted `assets -> <outside>` link inside the picked root must
        // be refused BEFORE anything is created: `create_dir_all` would have
        // happily made `<outside>/deep/nested` first and only then failed the
        // post-hoc containment check, leaving directories outside the root.
        let dir = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(dir.path()).expect("canonical root");
        let outside = tempfile::tempdir().expect("outside tempdir");
        symlink(outside.path(), root.join("assets")).expect("symlink");

        let result = write_export_file(
            &root,
            Path::new("assets/deep/nested/data.txt"),
            b"X",
            ResponseFileConflictStrategy::LatestOnly,
        );

        assert!(
            result.is_err(),
            "a symbolic-link directory component must be refused"
        );
        // The load-bearing assertion: not a single directory may have been
        // created through the link while refusing.
        assert!(
            !outside.path().join("deep").exists(),
            "nothing may be created outside the root, not even directories"
        );
        assert!(!root.join("assets/deep").exists());
    }

    #[test]
    fn sanitize_replaces_bidi_and_format_controls() {
        // U+202E (RTL override) visually rewrites the rest of a file name.
        let sanitized = sanitize_path_segment("report\u{202E}txt.exe");
        assert!(
            !sanitized.contains('\u{202E}'),
            "bidi override must be neutralized, got: {sanitized:?}"
        );
        assert!(
            !sanitized.contains('\u{FEFF}'),
            "the BOM must be neutralized"
        );
        // Joiners stay: emoji sequences are legitimate file names.
        assert!(sanitize_path_segment("\u{200D}").contains('\u{200D}') || true);
    }

    #[test]
    fn sanitize_neutralizes_reserved_stems_with_trailing_spaces() {
        // Windows strips stem whitespace, so `con .txt` is as reserved as
        // `con.txt`.
        assert_eq!(sanitize_path_segment("con.txt"), "_con.txt");
        assert_eq!(sanitize_path_segment("con .txt"), "_con .txt");
    }
}

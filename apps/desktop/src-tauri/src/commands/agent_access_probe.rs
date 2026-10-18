use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const PROTOCOL_VERSION: &str = "2025-06-18";

#[derive(Debug, Clone)]
pub struct ProbeResult {
    pub tool_count: usize,
    pub session_count: usize,
    pub latest_session_at: Option<String>,
    pub protocol_version: Option<String>,
}

/// Start the sidecar and speak MCP over stdio: initialize, tools/list, and one
/// `search_sessions` call. This proves the same path an Agent client uses,
/// including config permissions and the database read path.
pub fn probe_sidecar(sidecar: &Path, data_dir: &Path) -> Result<ProbeResult, String> {
    let mut command = Command::new(sidecar);
    command
        .arg("--data-dir")
        .arg(data_dir)
        .arg("--log-level")
        .arg("error")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    configure_hidden(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start aiproxy-mcp: {error}"))?;

    let outcome = run_probe(&mut child);
    let _ = child.kill();
    let _ = child.wait();
    outcome
}

#[cfg(windows)]
fn configure_hidden(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn configure_hidden(_command: &mut Command) {}

fn run_probe(child: &mut std::process::Child) -> Result<ProbeResult, String> {
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "aiproxy-mcp stdin was not available".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "aiproxy-mcp stdout was not available".to_string())?;

    let (sender, receiver) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) => {
                    if sender.send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let initialize = request(
        &mut stdin,
        &receiver,
        1,
        "initialize",
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "AIProxy verification", "version": env!("CARGO_PKG_VERSION") },
        }),
    )?;
    let protocol_version = initialize["result"]["protocolVersion"]
        .as_str()
        .map(str::to_string);

    writeln!(
        stdin,
        "{}",
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })
    )
    .map_err(|error| format!("failed to write initialized notification: {error}"))?;

    let tools = request(&mut stdin, &receiver, 2, "tools/list", json!({}))?;
    let tool_count = tools["result"]["tools"]
        .as_array()
        .map(Vec::len)
        .unwrap_or(0);

    let call = request(
        &mut stdin,
        &receiver,
        3,
        "tools/call",
        json!({ "name": "search_sessions", "arguments": { "limit": 1 } }),
    )?;
    let session_count = search_session_count(&call["result"])?;
    let latest_session_at = call["result"]["structuredContent"]["data"]["items"][0]["startedAt"]
        .as_str()
        .map(str::to_string);

    Ok(ProbeResult {
        tool_count,
        session_count,
        latest_session_at,
        protocol_version,
    })
}

fn search_session_count(result: &Value) -> Result<usize, String> {
    if result["isError"].as_bool() == Some(true) {
        return Err(tool_error_message(result));
    }
    if let Some(envelope) = result.get("structuredContent") {
        if envelope["ok"].as_bool() == Some(true) {
            return Ok(envelope["data"]["items"]
                .as_array()
                .map(Vec::len)
                .unwrap_or(0));
        }
        return Err(tool_error_message(envelope));
    }
    if let Some(text) = result["content"][0]["text"].as_str() {
        let envelope: Value = serde_json::from_str(text)
            .map_err(|error| format!("invalid tool response: {error}"))?;
        if envelope["ok"].as_bool() == Some(true) {
            return Ok(envelope["data"]["items"]
                .as_array()
                .map(Vec::len)
                .unwrap_or(0));
        }
        return Err(tool_error_message(&envelope));
    }
    Err("aiproxy-mcp returned an empty search_sessions result".to_string())
}

fn tool_error_message(value: &Value) -> String {
    let code = value["error"]["code"].as_str().unwrap_or("TOOL_ERROR");
    let message = value["error"]["message"]
        .as_str()
        .unwrap_or("unknown error");
    format!("{code}: {message}")
}

fn request(
    stdin: &mut impl Write,
    receiver: &mpsc::Receiver<String>,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    writeln!(
        stdin,
        "{}",
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
    )
    .map_err(|error| format!("failed to write {method}: {error}"))?;

    let deadline = Instant::now() + PROBE_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(format!("{method} timed out"));
        }
        let line = receiver
            .recv_timeout(remaining)
            .map_err(|_| format!("{method} timed out"))?;
        let value: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if value["id"].as_u64() != Some(id) {
            continue;
        }
        if let Some(error) = value.get("error") {
            return Err(format!(
                "{method} failed: {}",
                error["message"].as_str().unwrap_or("unknown error")
            ));
        }
        return Ok(value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiproxy_mcp::config::{write_config, AgentAccessConfig, AppPaths};

    fn staged_sidecar() -> Option<std::path::PathBuf> {
        let binaries = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        let entries = std::fs::read_dir(binaries).ok()?;
        entries.filter_map(Result::ok).find_map(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let executable = if cfg!(windows) {
                name.ends_with(".exe")
            } else {
                !name.contains('.')
            };
            (name.starts_with("aiproxy-mcp") && executable).then(|| entry.path())
        })
    }

    #[test]
    fn probe_completes_handshake_and_tool_call_when_sidecar_is_staged() {
        let Some(sidecar) = staged_sidecar() else {
            return;
        };
        let directory = tempfile::tempdir().unwrap();
        let connection =
            aiproxy_db::rusqlite::Connection::open(directory.path().join("aiproxy.db")).unwrap();
        aiproxy_db::schema::run_migrations(&connection).unwrap();
        drop(connection);

        let paths = AppPaths::resolve(Some(directory.path().to_path_buf()), None).unwrap();
        write_config(
            &paths.config_path,
            &AgentAccessConfig {
                enabled: true,
                ..AgentAccessConfig::default()
            },
        )
        .unwrap();

        let probe = probe_sidecar(&sidecar, directory.path()).unwrap();
        assert_eq!(probe.tool_count, 8);
        assert_eq!(probe.session_count, 0);
        assert!(probe.protocol_version.is_some());
    }
}

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

static API_BASE_URL: OnceLock<String> = OnceLock::new();
static GUI_LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
static BACKEND_CHILD: OnceLock<Mutex<Option<Child>>> = OnceLock::new();

const ENV_API_URL: &str = "WIKI_CRAFT_API_URL";
const GUI_LOG_DIR: &str = "app_gui";

#[tauri::command]
fn get_api_base_url() -> Result<String, String> {
    API_BASE_URL
        .get()
        .cloned()
        .ok_or_else(|| "local API server has not started".to_string())
}

#[tauri::command]
fn log_gui_event(level: String, message: String, context: Option<Value>) -> Result<(), String> {
    let path = GUI_LOG_PATH
        .get()
        .ok_or_else(|| "GUI log path has not been initialized".to_string())?;
    append_gui_log_event(path, &level, &message, context.as_ref()).map_err(|error| {
        eprintln!("warn: failed to append GUI log event: {error}");
        error
    })
}

fn start_backend() -> Result<String, String> {
    let config_path = config_path_from_env();
    if let Some(workspace_dir) = config_path.parent() {
        std::env::set_current_dir(workspace_dir).map_err(|error| {
            format!(
                "failed to set desktop backend working directory to {}: {error}",
                workspace_dir.display()
            )
        })?;
    }
    let gui_log_path = gui_log_path_for_config(&config_path);
    let _ = GUI_LOG_PATH.set(gui_log_path.clone());
    let _ = append_gui_log_event(
        &gui_log_path,
        "info",
        "desktop_backend_starting",
        Some(&json!({ "config_path": config_path.display().to_string(), "service": "app" })),
    );

    if let Ok(url) = std::env::var(ENV_API_URL) {
        let trimmed = url.trim().trim_end_matches('/').to_string();
        if !trimmed.is_empty() {
            return Ok(trimmed);
        }
    }

    let root = workspace_root();
    let server = root.join("backend").join("src").join("server.ts");
    let mut child = Command::new("node")
        .arg(server)
        .arg("--config")
        .arg(&config_path)
        .arg("--port")
        .arg("0")
        .arg("--print-ready")
        .current_dir(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("failed to start TS backend with node: {error}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture TS backend stdout".to_string())?;
    let mut line = String::new();
    BufReader::new(stdout)
        .read_line(&mut line)
        .map_err(|error| format!("failed to read TS backend startup line: {error}"))?;
    let payload: Value = serde_json::from_str(line.trim())
        .map_err(|error| format!("failed to parse TS backend startup line `{}`: {error}", line.trim()))?;
    let api_base_url = payload
        .get("api_base_url")
        .and_then(Value::as_str)
        .ok_or_else(|| "TS backend startup line missing api_base_url".to_string())?
        .trim_end_matches('/')
        .to_string();
    let _ = BACKEND_CHILD.set(Mutex::new(Some(child)));
    Ok(api_base_url)
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn config_path_from_env() -> PathBuf {
    if let Ok(value) = std::env::var("WIKI_CRAFT_CONFIG") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return absolutize(PathBuf::from(trimmed));
        }
    }
    discover_config_path().unwrap_or_else(|| absolutize(PathBuf::from("wiki_craft.toml")))
}

fn discover_config_path() -> Option<PathBuf> {
    let mut dir = std::env::current_dir().ok()?;
    loop {
        let candidate = dir.join("wiki_craft.toml");
        if candidate.is_file() {
            return Some(candidate);
        }
        if !dir.pop() {
            return None;
        }
    }
}

fn absolutize(path: PathBuf) -> PathBuf {
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .map(|current| current.join(&path))
            .unwrap_or(path)
    }
}

fn gui_log_path_for_config(config_path: &Path) -> PathBuf {
    let runtime_root = runtime_root_from_config(config_path).unwrap_or_else(|| {
        config_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(".wiki_craft")
    });
    runtime_root
        .join("runtime")
        .join(GUI_LOG_DIR)
        .join("events.jsonl")
}

fn runtime_root_from_config(config_path: &Path) -> Option<PathBuf> {
    let content = fs::read_to_string(config_path).ok()?;
    let mut in_runtime = false;
    for raw in content.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.starts_with('[') && line.ends_with(']') {
            in_runtime = line == "[runtime]";
            continue;
        }
        if !in_runtime || !line.starts_with("root") {
            continue;
        }
        let (_, value) = line.split_once('=')?;
        let value = value.trim().trim_matches('"').trim_matches('\'');
        if value.is_empty() {
            return None;
        }
        let root = PathBuf::from(value);
        return Some(if root.is_absolute() {
            root
        } else {
            config_path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join(root)
        });
    }
    None
}

fn append_gui_log_event(
    path: &Path,
    level: &str,
    message: &str,
    context: Option<&Value>,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create GUI log dir {}: {error}", parent.display()))?;
    }
    let event = json!({
        "kind": "gui_event",
        "ts_unix_ms": unix_ms(),
        "level": level,
        "message": message,
        "context": context.cloned().unwrap_or(Value::Null),
    });
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("failed to open GUI log {}: {error}", path.display()))?;
    writeln!(file, "{event}").map_err(|error| format!("failed to append GUI log event: {error}"))
}

fn unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|_app| {
            let api_base_url = start_backend().map_err(|error| {
                eprintln!("error: failed to start desktop backend: {error}");
                Box::<dyn std::error::Error>::from(error)
            })?;
            let _ = API_BASE_URL.set(api_base_url);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_api_base_url, log_gui_event])
        .run(tauri::generate_context!())
        .expect("error while running Wiki Craft desktop app");
}

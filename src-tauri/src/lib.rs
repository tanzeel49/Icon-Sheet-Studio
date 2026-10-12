use tauri_plugin_shell::ShellExt;
use tauri::Manager;
use std::net::TcpListener;
use tauri::Url;
use tauri_plugin_dialog::DialogExt;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

fn find_server_js(resource_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    // 1. Check known candidate paths directly
    let candidates = [
        resource_dir.join("_up_").join(".next").join("standalone").join("server.js"),
        resource_dir.join("_up_").join(".next").join("standalone").join("Icon Sheet Studio").join("server.js"),
        resource_dir.join(".next").join("standalone").join("server.js"),
        resource_dir.join(".next").join("standalone").join("Icon Sheet Studio").join("server.js"),
        resource_dir.join("standalone").join("server.js"),
        resource_dir.join("standalone").join("Icon Sheet Studio").join("server.js"),
        resource_dir.join("server.js"),
    ];

    for candidate in &candidates {
        if candidate.is_file() {
            return Some(candidate.clone());
        }
    }

    // 2. Recursive fallback search (up to 5 directory levels deep)
    fn search_dir(dir: &std::path::Path, depth: usize) -> Option<std::path::PathBuf> {
        if depth == 0 {
            return None;
        }
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() && path.file_name().and_then(|s| s.to_str()) == Some("server.js") {
                    return Some(path);
                } else if path.is_dir() {
                    let dir_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
                    if dir_name == "node_modules" {
                        continue;
                    }
                    if let Some(found) = search_dir(&path, depth - 1) {
                        return Some(found);
                    }
                }
            }
        }
        None
    }

    search_dir(resource_dir, 5)
}

fn get_app_data_dir() -> std::path::PathBuf {
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        std::path::PathBuf::from(local_app_data).join("com.iconsheetstudio.desktop")
    } else {
        std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
    }
}

fn atomic_write_file(path: &std::path::Path, data: &[u8]) -> Result<u64, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let tmp_path = path.with_extension(format!("tmp.{}", timestamp));
    std::fs::write(&tmp_path, data).map_err(|e| e.to_string())?;
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    std::fs::rename(&tmp_path, path).map_err(|e| e.to_string())?;
    let len = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    Ok(len)
}

fn rotate_directory_files(dir: &std::path::Path, max_keep: usize) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        let mut files: Vec<(std::path::PathBuf, std::time::SystemTime)> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Ok(meta) = path.metadata() {
                    let mtime = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                    files.push((path, mtime));
                }
            }
        }
        if files.len() > max_keep {
            // Sort oldest first
            files.sort_by(|a, b| a.1.cmp(&b.1));
            let remove_count = files.len() - max_keep;
            for (path, _) in files.iter().take(remove_count) {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

fn kill_all_child_processes() {
    #[cfg(windows)]
    {
        // Suppress window popup when terminating background sidecar
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/IM", "node.exe"])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output();
    }
}

/* ------------------------------------------------------------------ */
/* Core Data Transfer Objects                                         */
/* ------------------------------------------------------------------ */

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct SaveResult {
    pub success: bool,
    pub path: String,
    pub revision: u64,
    pub timestamp: u64,
    pub bytes_written: u64,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct CheckpointInfo {
    pub id: String,
    pub filename: String,
    pub revision: u64,
    pub timestamp: u64,
    pub summary: String,
    pub size: u64,
    pub project_name: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct RecoveryInfo {
    pub has_recovery: bool,
    pub recovery_timestamp: u64,
    pub last_saved_timestamp: u64,
    pub project_name: String,
    pub revision: u64,
    pub sheets_count: usize,
    pub icons_count: usize,
    pub content: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct BackupInfo {
    pub filename: String,
    pub path: String,
    pub timestamp: u64,
    pub size: u64,
    pub is_auto: bool,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct StorageHealth {
    pub is_desktop: bool,
    pub base_dir: String,
    pub project_path: String,
    pub project_size: u64,
    pub backup_count: usize,
    pub total_backup_size: u64,
    pub checkpoint_count: usize,
    pub last_saved: Option<u64>,
    pub has_yesterday_work: bool,
    pub yesterday_sheets_count: usize,
    pub yesterday_icons_count: usize,
}

/* ------------------------------------------------------------------ */
/* Tauri Commands for Authoritative Desktop Storage & Safety          */
/* ------------------------------------------------------------------ */

#[tauri::command]
async fn write_file_native(path: String, data: Vec<u8>) -> Result<u64, String> {
    let file_path = std::path::PathBuf::from(&path);
    if let Some(parent) = file_path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent directory: {}", e))?;
        }
    }
    std::fs::write(&file_path, &data).map_err(|e| format!("Failed to write file to '{}': {}", path, e))?;

    let metadata = std::fs::metadata(&file_path).map_err(|e| format!("Failed to verify '{}': {}", path, e))?;
    let bytes_written = metadata.len();
    if !data.is_empty() && bytes_written == 0 {
        return Err(format!("File verification failed: '{}' is 0 bytes", path));
    }
    Ok(bytes_written)
}

#[tauri::command]
async fn save_project_native(project_json: String, is_checkpoint: bool, summary: Option<String>) -> Result<SaveResult, String> {
    let base_dir = get_app_data_dir();
    let projects_dir = base_dir.join("projects");
    let active_path = projects_dir.join("active_project.json");

    let val: serde_json::Value = serde_json::from_str(&project_json)
        .map_err(|e| format!("Invalid project JSON: {}", e))?;

    let revision = val.get("revision").and_then(|v| v.as_u64()).unwrap_or(1);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let bytes_written = atomic_write_file(&active_path, project_json.as_bytes())?;

    // Create a checkpoint on structural operations or requested checkpoints
    if is_checkpoint {
        let checkpoints_dir = projects_dir.join("checkpoints");
        let _ = std::fs::create_dir_all(&checkpoints_dir);
        let chk_filename = format!("rev_{:06}_{}.json", revision, now);
        let chk_path = checkpoints_dir.join(&chk_filename);
        let mut chk_val = val.clone();
        if let Some(s) = summary {
            chk_val["checkpointSummary"] = serde_json::Value::String(s);
        }
        let chk_bytes = serde_json::to_vec_pretty(&chk_val).unwrap_or_else(|_| project_json.as_bytes().to_vec());
        let _ = atomic_write_file(&chk_path, &chk_bytes);
        rotate_directory_files(&checkpoints_dir, 20);
    }

    // Clear recovery journal once committed to authoritative storage
    let journal_path = base_dir.join("recovery_journal.json");
    if journal_path.exists() {
        let _ = std::fs::remove_file(journal_path);
    }

    Ok(SaveResult {
        success: true,
        path: active_path.to_string_lossy().to_string(),
        revision,
        timestamp: now,
        bytes_written,
    })
}

#[tauri::command]
async fn load_project_native() -> Result<Option<String>, String> {
    let active_path = get_app_data_dir().join("projects").join("active_project.json");
    if active_path.exists() {
        let content = std::fs::read_to_string(&active_path).map_err(|e| e.to_string())?;
        if !content.trim().is_empty() {
            return Ok(Some(content));
        }
    }
    Ok(None)
}

#[tauri::command]
async fn list_checkpoints_native() -> Result<Vec<CheckpointInfo>, String> {
    let checkpoints_dir = get_app_data_dir().join("projects").join("checkpoints");
    if !checkpoints_dir.exists() {
        return Ok(Vec::new());
    }

    let mut list = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&checkpoints_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("json") {
                let filename = path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
                let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
                let size = meta.len();

                let mut revision = 0;
                let mut timestamp = 0;
                let mut project_name = "Untitled Project".to_string();
                let mut summary = "Checkpoint".to_string();

                if let Ok(file_content) = std::fs::read_to_string(&path) {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&file_content) {
                        if let Some(r) = val.get("revision").and_then(|v| v.as_u64()) {
                            revision = r;
                        }
                        if let Some(t) = val.get("updatedAt").and_then(|v| v.as_u64()) {
                            timestamp = t;
                        }
                        if let Some(n) = val.get("name").and_then(|v| v.as_str()) {
                            project_name = n.to_string();
                        }
                        if let Some(s) = val.get("checkpointSummary").and_then(|v| v.as_str()) {
                            summary = s.to_string();
                        }
                    }
                }

                if timestamp == 0 {
                    timestamp = meta.modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);
                }

                list.push(CheckpointInfo {
                    id: filename.clone(),
                    filename,
                    revision,
                    timestamp,
                    summary,
                    size,
                    project_name,
                });
            }
        }
    }

    list.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(list)
}

#[tauri::command]
async fn restore_checkpoint_native(checkpoint_id: String) -> Result<String, String> {
    let base_dir = get_app_data_dir();
    let projects_dir = base_dir.join("projects");
    let chk_path = projects_dir.join("checkpoints").join(&checkpoint_id);
    if !chk_path.exists() {
        return Err(format!("Checkpoint '{}' not found", checkpoint_id));
    }

    let content = std::fs::read_to_string(&chk_path).map_err(|e| e.to_string())?;

    // Create safety snapshot of current active project first
    let active_path = projects_dir.join("active_project.json");
    if active_path.exists() {
        if let Ok(active_content) = std::fs::read_to_string(&active_path) {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            let safety_chk = projects_dir.join("checkpoints").join(format!("pre_restore_safety_{}.json", now));
            let _ = atomic_write_file(&safety_chk, active_content.as_bytes());
        }
    }

    atomic_write_file(&active_path, content.as_bytes())?;
    Ok(content)
}

#[tauri::command]
async fn save_recovery_journal_native(journal_json: String) -> Result<(), String> {
    let journal_path = get_app_data_dir().join("recovery_journal.json");
    atomic_write_file(&journal_path, journal_json.as_bytes())?;
    Ok(())
}

#[tauri::command]
async fn clear_recovery_journal_native() -> Result<(), String> {
    let journal_path = get_app_data_dir().join("recovery_journal.json");
    if journal_path.exists() {
        let _ = std::fs::remove_file(journal_path);
    }
    Ok(())
}

#[tauri::command]
async fn check_recovery_native() -> Result<Option<RecoveryInfo>, String> {
    let base_dir = get_app_data_dir();
    let journal_path = base_dir.join("recovery_journal.json");
    if !journal_path.exists() {
        return Ok(None);
    }

    let journal_content = std::fs::read_to_string(&journal_path).map_err(|e| e.to_string())?;
    if journal_content.trim().is_empty() {
        return Ok(None);
    }

    let val: serde_json::Value = serde_json::from_str(&journal_content).map_err(|e| e.to_string())?;
    let recovery_timestamp = val.get("timestamp").and_then(|v| v.as_u64()).unwrap_or(0);
    let project_name = val.get("projectName").or_else(|| val.get("name")).and_then(|v| v.as_str()).unwrap_or("Untitled Project").to_string();
    let revision = val.get("revision").and_then(|v| v.as_u64()).unwrap_or(0);

    let doc = val.get("document").unwrap_or(&val);
    let sheets_count = doc.get("sheets").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
    let icons_count = doc.get("icons").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);

    let active_path = base_dir.join("projects").join("active_project.json");
    let mut last_saved_timestamp = 0;
    if active_path.exists() {
        if let Ok(meta) = std::fs::metadata(&active_path) {
            last_saved_timestamp = meta.modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
        }
    }

    Ok(Some(RecoveryInfo {
        has_recovery: true,
        recovery_timestamp,
        last_saved_timestamp,
        project_name,
        revision,
        sheets_count,
        icons_count,
        content: doc.to_string(),
    }))
}

#[tauri::command]
async fn create_backup_native(backup_json: Option<String>) -> Result<BackupInfo, String> {
    let base_dir = get_app_data_dir();
    let backups_dir = base_dir.join("backups");
    std::fs::create_dir_all(&backups_dir).map_err(|e| e.to_string())?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let filename = format!("backup_{}.issproj", now);
    let backup_path = backups_dir.join(&filename);

    let content_to_write = match backup_json {
        Some(json) => json,
        None => {
            let active_path = base_dir.join("projects").join("active_project.json");
            if active_path.exists() {
                std::fs::read_to_string(&active_path).map_err(|e| e.to_string())?
            } else {
                return Err("No active project found to backup".to_string());
            }
        }
    };

    let size = atomic_write_file(&backup_path, content_to_write.as_bytes())?;
    rotate_directory_files(&backups_dir, 10);

    Ok(BackupInfo {
        filename,
        path: backup_path.to_string_lossy().to_string(),
        timestamp: now,
        size,
        is_auto: true,
    })
}

#[tauri::command]
async fn list_backups_native() -> Result<Vec<BackupInfo>, String> {
    let backups_dir = get_app_data_dir().join("backups");
    if !backups_dir.exists() {
        return Ok(Vec::new());
    }

    let mut list = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&backups_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                let filename = path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
                if filename.ends_with(".issproj") || filename.ends_with(".json") {
                    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
                    let size = meta.len();
                    let timestamp = meta.modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);

                    list.push(BackupInfo {
                        filename,
                        path: path.to_string_lossy().to_string(),
                        timestamp,
                        size,
                        is_auto: true,
                    });
                }
            }
        }
    }

    list.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(list)
}

#[tauri::command]
async fn restore_backup_native(backup_path: String) -> Result<String, String> {
    let path = std::path::PathBuf::from(&backup_path);
    if !path.exists() {
        return Err(format!("Backup file '{}' does not exist", backup_path));
    }

    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;

    let base_dir = get_app_data_dir();
    let projects_dir = base_dir.join("projects");
    let active_path = projects_dir.join("active_project.json");
    if active_path.exists() {
        if let Ok(active_content) = std::fs::read_to_string(&active_path) {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            let safety_chk = projects_dir.join("checkpoints").join(format!("pre_backup_restore_safety_{}.json", now));
            let _ = atomic_write_file(&safety_chk, active_content.as_bytes());
        }
    }

    atomic_write_file(&active_path, content.as_bytes())?;
    Ok(content)
}

#[tauri::command]
async fn get_storage_health_native() -> Result<StorageHealth, String> {
    let base_dir = get_app_data_dir();
    let active_path = base_dir.join("projects").join("active_project.json");
    let project_size = active_path.metadata().map(|m| m.len()).unwrap_or(0);
    let last_saved = active_path.metadata().ok().and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);

    let backups_dir = base_dir.join("backups");
    let mut backup_count = 0;
    let mut total_backup_size = 0;
    if let Ok(entries) = std::fs::read_dir(&backups_dir) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    backup_count += 1;
                    total_backup_size += meta.len();
                }
            }
        }
    }

    let checkpoints_dir = base_dir.join("projects").join("checkpoints");
    let mut checkpoint_count = 0;
    if let Ok(entries) = std::fs::read_dir(&checkpoints_dir) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    checkpoint_count += 1;
                }
            }
        }
    }

    let yesterday_path = base_dir.join("recovered_project_yesterday.json");
    let has_yesterday_work = yesterday_path.exists();
    let mut yesterday_sheets_count = 0;
    let mut yesterday_icons_count = 0;
    if has_yesterday_work {
        if let Ok(content) = std::fs::read_to_string(&yesterday_path) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                yesterday_sheets_count = val.get("sheets").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
                yesterday_icons_count = val.get("icons").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
            }
        }
    }

    Ok(StorageHealth {
        is_desktop: true,
        base_dir: base_dir.to_string_lossy().to_string(),
        project_path: active_path.to_string_lossy().to_string(),
        project_size,
        backup_count,
        total_backup_size,
        checkpoint_count,
        last_saved,
        has_yesterday_work,
        yesterday_sheets_count,
        yesterday_icons_count,
    })
}

#[tauri::command]
async fn open_folder_native(path: Option<String>) -> Result<(), String> {
    let target = match path {
        Some(p) => std::path::PathBuf::from(p),
        None => get_app_data_dir(),
    };
    if !target.exists() {
        let _ = std::fs::create_dir_all(&target);
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn get_yesterday_recovered_project() -> Result<Option<String>, String> {
    let p = get_app_data_dir().join("recovered_project_yesterday.json");
    if p.exists() {
        let content = std::fs::read_to_string(p).map_err(|e| e.to_string())?;
        return Ok(Some(content));
    }
    Ok(None)
}

fn migrate_indexeddb_to_port(port: u16) {
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let idb_dir = std::path::PathBuf::from(local_app_data)
            .join("com.iconsheetstudio.desktop")
            .join("EBWebView")
            .join("Default")
            .join("IndexedDB");

        if !idb_dir.exists() {
            return;
        }

        let target_dir_name = format!("http_127.0.0.1_{}.indexeddb.leveldb", port);
        let target_dir = idb_dir.join(&target_dir_name);

        let mut best_source: Option<(std::path::PathBuf, u64)> = None;

        if let Ok(entries) = std::fs::read_dir(&idb_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
                    if name.starts_with("http_127.0.0.1_") && name.ends_with(".indexeddb.leveldb") && name != target_dir_name {
                        let mut total_size: u64 = 0;
                        if let Ok(files) = std::fs::read_dir(&path) {
                            for file in files.flatten() {
                                if let Ok(meta) = file.metadata() {
                                    total_size += meta.len();
                                }
                            }
                        }
                        if total_size > 50_000 {
                            if best_source.as_ref().map(|(_, s)| total_size > *s).unwrap_or(true) {
                                best_source = Some((path, total_size));
                            }
                        }
                    }
                }
            }
        }

        if let Some((source_dir, source_size)) = best_source {
            let mut target_size: u64 = 0;
            if target_dir.exists() {
                if let Ok(files) = std::fs::read_dir(&target_dir) {
                    for file in files.flatten() {
                        if let Ok(meta) = file.metadata() {
                            target_size += meta.len();
                        }
                    }
                }
            }

            if target_size < source_size {
                let _ = std::fs::create_dir_all(&target_dir);
                if let Ok(files) = std::fs::read_dir(&source_dir) {
                    for file in files.flatten() {
                        let file_path = file.path();
                        if file_path.is_file() {
                            let file_name = file_path.file_name().unwrap();
                            let dest_file = target_dir.join(file_name);
                            let _ = std::fs::copy(&file_path, &dest_file);
                        }
                    }
                }
                println!("Migrated IndexedDB from {:?} to {:?}", source_dir, target_dir);
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .invoke_handler(tauri::generate_handler![
        write_file_native,
        save_project_native,
        load_project_native,
        list_checkpoints_native,
        restore_checkpoint_native,
        save_recovery_journal_native,
        clear_recovery_journal_native,
        check_recovery_native,
        create_backup_native,
        list_backups_native,
        restore_backup_native,
        get_storage_health_native,
        open_folder_native,
        get_yesterday_recovered_project
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        // In development, Next.js is running on devUrl (localhost:3000)
        return Ok(());
      }

      // In production, use fixed port 14210 so IndexedDB and localStorage origins persist permanently
      const FIXED_PORT: u16 = 14210;
      let port = match TcpListener::bind(format!("127.0.0.1:{}", FIXED_PORT)) {
          Ok(l) => {
              drop(l);
              FIXED_PORT
          }
          Err(_) => {
              // Fallback to dynamic port if 14210 is temporarily busy
              let listener = match TcpListener::bind("127.0.0.1:0") {
                  Ok(l) => l,
                  Err(e) => {
                      app.dialog().message(format!("Failed to bind port: {}", e)).show(|_| {});
                      return Ok(());
                  }
              };
              let p = match listener.local_addr() {
                  Ok(addr) => addr.port(),
                  Err(_) => FIXED_PORT,
              };
              drop(listener);
              p
          }
      };

      migrate_indexeddb_to_port(port);

      let resource_dir = match app.path().resource_dir() {
          Ok(dir) => dir,
          Err(e) => {
              app.dialog().message(format!("Failed to get resource dir: {}", e)).show(|_| {});
              return Ok(());
          }
      };
      
      let server_js_path = match find_server_js(&resource_dir) {
          Some(path) => path,
          None => {
              app.dialog().message(format!("server.js not found in app resource directory: {:?}", resource_dir)).show(|_| {});
              return Ok(());
          }
      };

      let standalone_path = server_js_path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| resource_dir.clone());

      let sidecar_command = match app.shell().sidecar("node") {
          Ok(cmd) => cmd,
          Err(e) => {
              app.dialog().message(format!("Failed to create node sidecar: {}. Make sure Node is packaged correctly.", e)).show(|_| {});
              return Ok(());
          }
      };
      
      let (mut rx, child) = match sidecar_command
        .args([server_js_path.to_str().unwrap()])
        .env("PORT", port.to_string())
        .env("NODE_ENV", "production")
        .env("HOSTNAME", "127.0.0.1")
        .current_dir(&standalone_path)
        .spawn()
      {
          Ok(c) => c,
          Err(e) => {
              app.dialog().message(format!("Failed to spawn node sidecar: {}", e)).show(|_| {});
              return Ok(());
          }
      };

      // Ensure sidecar is killed when parent exits (in addition to WindowEvent fallback)
      let child_arc = std::sync::Arc::new(std::sync::Mutex::new(Some(child)));
      app.manage(child_arc.clone());

      let app_handle_for_rx = app.handle().clone();
      tauri::async_runtime::spawn(async move {
          while let Some(event) = rx.recv().await {
              match event {
                  tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                      println!("Next.js: {}", String::from_utf8_lossy(&line));
                  }
                  tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                      eprintln!("Next.js Error: {}", String::from_utf8_lossy(&line));
                  }
                  tauri_plugin_shell::process::CommandEvent::Error(err) => {
                      eprintln!("Next.js spawned process error: {}", err);
                  }
                  tauri_plugin_shell::process::CommandEvent::Terminated(payload) => {
                      let code = payload.code.unwrap_or(-1);
                      eprintln!("Next.js terminated with code: {}", code);
                      if code != 0 {
                          app_handle_for_rx.dialog().message(format!("Next.js background server crashed with code {}", code)).show(|_| {});
                      }
                  }
                  _ => {}
              }
          }
      });

      let app_handle = app.handle().clone();
      tauri::async_runtime::spawn(async move {
          // Wait for the server to be ready by polling the TCP port
          let mut attempts = 0;
          let max_attempts = 600; // 30 seconds
          
          loop {
            if std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_ok() {
              break;
            }
            if attempts > max_attempts {
              app_handle.dialog().message("Failed to connect to Next.js standalone server after 30 seconds. Check console logs for Next.js errors.").show(|_| {});
              return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            attempts += 1;
          }

          // Update the main window URL
          if let Some(main_window) = app_handle.get_webview_window("main") {
              let url: Url = format!("http://127.0.0.1:{}", port).parse().unwrap();
              if let Err(e) = main_window.navigate(url) {
                  eprintln!("Failed to navigate: {}", e);
              }
          }
      });

      Ok(())
    })
    .on_window_event(|window, event| {
        if let tauri::WindowEvent::Destroyed = event {
            if window.label() == "main" {
                if let Some(state) = window.try_state::<std::sync::Arc<std::sync::Mutex<Option<tauri_plugin_shell::process::CommandChild>>>>() {
                    if let Ok(mut child_lock) = state.lock() {
                        if let Some(child) = child_lock.take() {
                            let _ = child.kill();
                        }
                    }
                }
                kill_all_child_processes();
            }
        }
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}

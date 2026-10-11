use tauri_plugin_shell::ShellExt;
use tauri::Manager;
use std::net::TcpListener;
use tauri::Url;
use tauri_plugin_dialog::DialogExt;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .invoke_handler(tauri::generate_handler![write_file_native])
    .setup(|app| {
      if cfg!(debug_assertions) {
        // In development, Next.js is running on devUrl (localhost:3000)
        return Ok(());
      }

      // In production, start the bundled Next.js standalone server
      let listener = match TcpListener::bind("127.0.0.1:0") {
          Ok(l) => l,
          Err(e) => {
              app.dialog().message(format!("Failed to bind port: {}", e)).show(|_| {});
              return Ok(());
          }
      };
      
      let port = match listener.local_addr() {
          Ok(addr) => addr.port(),
          Err(e) => {
              app.dialog().message(format!("Failed to get local address: {}", e)).show(|_| {});
              return Ok(());
          }
      };
      drop(listener); // Free the port so Next.js can bind to it

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
            }
        }
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}

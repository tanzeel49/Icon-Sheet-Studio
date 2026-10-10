use tauri_plugin_shell::ShellExt;
use tauri::Manager;
use std::net::TcpListener;
use tauri::Url;
use tauri_plugin_dialog::DialogExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
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
      
      let mut standalone_path = resource_dir.clone();
      
      // Tauri maps `../` to `_up_` in the resource directory
      let possible_paths = vec![
          resource_dir.join("_up_").join(".next").join("standalone"),
          resource_dir.join(".next").join("standalone"),
          resource_dir.join("standalone"),
      ];

      for path in possible_paths {
          if path.exists() {
              standalone_path = path;
              break;
          }
      }
      
      // Handle Next.js workspace monorepo structure (if Icon Sheet Studio folder exists)
      let mut project_standalone_path = standalone_path.clone();
      project_standalone_path.push("Icon Sheet Studio");
      if project_standalone_path.exists() {
          standalone_path = project_standalone_path;
      }
      
      let server_js_path = standalone_path.join("server.js");

      if !server_js_path.exists() {
          app.dialog().message(format!("server.js not found at {:?}", server_js_path)).show(|_| {});
          return Ok(());
      }

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

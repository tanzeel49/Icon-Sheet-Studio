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

      // Spawn the node sidecar
      let sidecar_command = match app.shell().sidecar("node") {
          Ok(cmd) => cmd,
          Err(e) => {
              app.dialog().message(format!("Failed to create node sidecar: {}. Make sure Node is packaged correctly.", e)).show(|_| {});
              return Ok(());
          }
      };
      
      if let Err(e) = sidecar_command
        .args([server_js_path.to_str().unwrap()])
        .env("PORT", port.to_string())
        .env("NODE_ENV", "production")
        .env("HOSTNAME", "127.0.0.1")
        .current_dir(standalone_path)
        .spawn()
      {
          app.dialog().message(format!("Failed to spawn node sidecar: {}", e)).show(|_| {});
          return Ok(());
      }

      // Wait for the server to be ready by polling the TCP port
      let mut attempts = 0;
      loop {
        if std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_ok() {
          break;
        }
        if attempts > 100 {
          app.dialog().message("Failed to connect to Next.js standalone server after 5 seconds.").show(|_| {});
          break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
        attempts += 1;
      }

      // Update the main window URL
      if let Some(main_window) = app.get_webview_window("main") {
          let url: Url = format!("http://127.0.0.1:{}", port).parse().unwrap();
          if let Err(e) = main_window.navigate(url) {
              app.dialog().message(format!("Failed to navigate: {}", e)).show(|_| {});
          }
      } else {
          app.dialog().message("No main window found!").show(|_| {});
      }

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}

fn main() {
  tauri_build::try_build(
    tauri_build::Attributes::new()
      .app_manifest(
        tauri_build::AppManifest::new()
          .commands(&[
            "write_file_native",
            "save_project_native",
            "load_project_native",
            "list_checkpoints_native",
            "restore_checkpoint_native",
            "save_recovery_journal_native",
            "clear_recovery_journal_native",
            "check_recovery_native",
            "create_backup_native",
            "list_backups_native",
            "restore_backup_native",
            "get_storage_health_native",
            "open_folder_native",
            "get_yesterday_recovered_project",
            "terminate_background_server",
          ])
      ),
  )
  .unwrap();
}


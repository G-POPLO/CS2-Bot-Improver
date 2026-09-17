//! The Panel's Rust backend.
//!
//! Split into a library target so the command implementations can be unit
//! tested (`cargo test --lib`) — a `windows_subsystem = "windows"` binary has no
//! console for a test harness to report through.

pub mod backend;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        // The three plugins the frontend imports from @tauri-apps/*.
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Loading the config needs the app handle (it decides where the
            // per-user config file lives), so the state is built here rather
            // than inline in the builder chain.
            app.manage(backend::PanelState::new(app.handle()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backend::get_config,
            backend::save_config,
            backend::detect_directories,
            backend::select_directory,
            backend::cleanup_backups,
            backend::validate_files,
            backend::get_difficulty,
            backend::set_difficulty,
            backend::get_mode,
            backend::set_mode,
            backend::reconcile_launch_options,
            backend::launch_cs2,
            backend::reconcile_core_json,
            backend::get_bot_items,
            backend::set_bot_item,
            backend::get_presets,
            backend::set_aim,
            backend::set_nades,
            backend::get_drop_knives,
            backend::set_drop_knives
        ])
        .run(tauri::generate_context!())
        .expect("error while running the CS2 Bot Improver Panel");
}

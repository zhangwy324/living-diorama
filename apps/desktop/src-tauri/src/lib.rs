mod event_counts;
mod placement;
mod platform;
mod settings;
mod shell;
mod tray;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| shell::setup(app))
        .invoke_handler(tauri::generate_handler![
            shell::set_strip_height,
            shell::commands::set_paused,
            shell::commands::set_expanded,
            shell::commands::hide,
            shell::commands::quit_ready,
            event_counts::record_event_counts,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                shell::release_space(app);
            }
        });
}

mod diagnostics;
mod event_counts;
mod library;
mod placement;
mod platform;
mod settings;
mod shell;
mod studio;
mod tray;

pub fn run() {
    tauri::Builder::default()
        .plugin(diagnostics::plugin())
        .setup(|app| shell::setup(app))
        .invoke_handler(tauri::generate_handler![
            shell::set_strip_height,
            shell::commands::set_paused,
            shell::commands::set_expanded,
            shell::commands::set_full_screen,
            shell::commands::hide,
            shell::commands::quit_ready,
            studio::commands::open_studio,
            event_counts::record_event_counts,
            library::commands::list_library,
            library::commands::load_library_drawing,
            library::commands::load_library_image,
            library::commands::save_library_entry,
            library::commands::delete_library_entry,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                shell::release_space(app);
            }
        });
}

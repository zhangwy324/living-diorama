mod placement;
mod platform;
mod settings;
mod shell;
mod tray;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| shell::setup(app))
        .invoke_handler(tauri::generate_handler![shell::set_strip_height])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

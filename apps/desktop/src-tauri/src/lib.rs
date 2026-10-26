mod placement;
mod platform;
mod strip;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| strip::setup(app))
        .invoke_handler(tauri::generate_handler![strip::set_strip_height])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

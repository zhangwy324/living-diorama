//! The Creation Studio's window (ADR 0015 §1): a normal, focusable window, created when the
//! controls overlay or the tray asks for it, one at a time. Closing it destroys it.

use std::sync::Mutex;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const LABEL: &str = "studio";

/// Held while opening, so two quick requests open one window.
static OPENING: Mutex<()> = Mutex::new(());

/// Opens the Studio, or shows and focuses it if it is open. Creating a window waits for the event
/// loop, so it happens off the main thread: the tray's handlers and synchronous commands run on
/// it, and building there deadlocks.
pub fn open(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _opening = OPENING.lock().unwrap();
        if let Err(error) = open_now(&app) {
            log::warn!("Could not open the Studio: {error}");
        }
    });
}

fn open_now(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(LABEL) {
        return bring_forward(&window);
    }
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("studio.html".into()))
        .title("Creation Studio")
        .inner_size(960.0, 720.0)
        .min_inner_size(640.0, 520.0)
        .center()
        .focused(true)
        .build()?
        // Being created focused isn't always enough to come to the front; asking again is.
        .set_focus()
}

fn bring_forward(window: &WebviewWindow) -> tauri::Result<()> {
    window.unminimize()?;
    window.show()?;
    window.set_focus()
}

pub mod commands {
    use tauri::AppHandle;

    #[tauri::command]
    pub fn open_studio(app: AppHandle) {
        super::open(&app);
    }
}

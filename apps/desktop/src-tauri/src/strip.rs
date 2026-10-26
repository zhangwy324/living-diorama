//! The compact strip: the one app window, placed from `placement` and re-placed whenever the
//! displays or the requested height change (ADR 0008 §2–§6).

use std::sync::Mutex;

use tauri::{Manager, Monitor, PhysicalPosition, PhysicalSize, State, WebviewWindow};

use crate::placement::{
    DEFAULT_STRIP_HEIGHT, MonitorInfo, Rect, choose_monitor, clamp_strip_height, strip_rect,
};
use crate::platform;

/// What the strip's placement depends on besides the displays. PR B persists it.
#[derive(Clone, Debug)]
pub struct Strip {
    /// Device name of the chosen monitor; `None` means the primary.
    pub monitor: Option<String>,
    /// Compact height in logical pixels, always within the limits.
    pub height: f64,
}

impl Default for Strip {
    fn default() -> Self {
        Self {
            monitor: None,
            height: DEFAULT_STRIP_HEIGHT,
        }
    }
}

pub type StripState = Mutex<Strip>;

/// Turns the `main` window into the strip and shows it, without activating it, once it is in
/// place.
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let window = app
        .get_webview_window("main")
        .ok_or("the main window is missing")?;
    app.manage(StripState::default());
    let platform = platform::current();
    platform.prepare_strip(&window)?;
    place(&window);
    let watched = window.clone();
    platform.watch_displays(&window, Box::new(move || place(&watched)))?;
    window.show()?;
    Ok(())
}

/// Moves the window to where the strip belongs on the current displays. Errors are logged, not
/// returned: the window just stays where it was until the next change.
pub fn place(window: &WebviewWindow) {
    if let Err(error) = try_place(window) {
        eprintln!("Could not place the strip: {error}");
    }
}

fn try_place(window: &WebviewWindow) -> tauri::Result<()> {
    let strip = window.state::<StripState>().lock().unwrap().clone();
    let primary = window.primary_monitor()?;
    let monitors: Vec<MonitorInfo> = window
        .available_monitors()?
        .iter()
        .map(|m| monitor_info(m, primary.as_ref()))
        .collect();
    let Some(monitor) = choose_monitor(&monitors, strip.monitor.as_deref()) else {
        return Ok(());
    };
    let rect = strip_rect(monitor.work_area, monitor.scale_factor, strip.height);
    window.set_size(PhysicalSize::new(rect.width, rect.height))?;
    window.set_position(PhysicalPosition::new(rect.x, rect.y))?;
    Ok(())
}

fn monitor_info(monitor: &Monitor, primary: Option<&Monitor>) -> MonitorInfo {
    let area = monitor.work_area();
    MonitorInfo {
        name: monitor.name().cloned(),
        work_area: Rect {
            x: area.position.x,
            y: area.position.y,
            width: area.size.width,
            height: area.size.height,
        },
        scale_factor: monitor.scale_factor(),
        primary: primary.is_some_and(|p| p.name() == monitor.name()),
    }
}

/// Sets the compact height in logical pixels; it is clamped to the limits.
#[tauri::command]
pub fn set_strip_height(window: WebviewWindow, strip: State<StripState>, height: f64) {
    strip.lock().unwrap().height = clamp_strip_height(height);
    place(&window);
}

//! The shell's state and the actions on it, shared by the tray and the frontend's commands: the one
//! app window, placed as the compact strip or expanded (ADR 0008 §2–§10), and the settings it
//! persists.

use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::Duration;

use tauri::{
    AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, State, WebviewWindow,
};

use crate::diagnostics;
use crate::placement::{
    MonitorInfo, Rect, choose_monitor, clamp_strip_height, expanded_rect, strip_rect,
};
use crate::platform::{self, DisplayEvent, Platform};
use crate::settings::{self, Settings};
use crate::tray;

/// Event telling the frontend to pause or resume the simulation; the payload is the new state.
const PAUSED_CHANGED: &str = "paused-changed";
/// Event telling the frontend the window was expanded or collapsed; the payload is the new state.
const EXPANDED_CHANGED: &str = "expanded-changed";
/// Event asking the frontend to shut down; it answers with the `quit_ready` command.
const QUIT_REQUESTED: &str = "quit-requested";
/// How long quitting waits for the frontend to shut down before exiting anyway (ADR 0008 §14).
const QUIT_TIMEOUT: Duration = Duration::from_secs(1);
/// How long the height must stay put before it is saved and its space reserved, so a handle drag
/// is one write and one change of other windows' work area.
const HEIGHT_SETTLE_DELAY: Duration = Duration::from_millis(500);

#[derive(Clone, Debug, Default)]
pub struct Shell {
    pub settings: Settings,
    /// Expanded mode is not persisted: the app always starts as the strip.
    pub expanded: bool,
    /// Rust owns the flag so the tray and the controls overlay agree; the frontend applies it.
    pub paused: bool,
    /// Set once Quit has asked the frontend to shut down, so a second Quit doesn't ask again.
    pub quitting: bool,
    /// A full-screen app is open while the strip reserves space; always-on-top steps aside.
    pub full_screen: bool,
    /// Counts height changes, so a delayed reservation can tell whether the height has settled.
    pub height_changes: u64,
}

pub type ShellState = Mutex<Shell>;

/// The OS hooks, shared so placement can reserve space.
struct PlatformState(Box<dyn Platform>);

/// Where the settings are saved. The path's lock also serializes writes, and the generation lets
/// a newer save cancel a pending delayed one.
struct SettingsFile {
    path: Mutex<Option<PathBuf>>,
    generation: AtomicU64,
}

/// Loads the settings, turns the `main` window into the strip, creates the tray and shows the
/// window, without activating it, once it is in place.
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let window = app
        .get_webview_window("main")
        .ok_or("the main window is missing")?;
    let path = match app.path().app_config_dir() {
        Ok(dir) => Some(dir.join("settings.json")),
        Err(error) => {
            log::warn!("No config directory, settings will not be saved: {error}");
            None
        }
    };
    let settings = path.as_deref().map(settings::load).unwrap_or_default();
    window.set_always_on_top(settings.always_on_top)?;
    app.manage(ShellState::new(Shell {
        settings,
        ..Shell::default()
    }));
    app.manage(SettingsFile {
        path: Mutex::new(path),
        generation: AtomicU64::new(0),
    });

    app.manage(PlatformState(platform::current()));

    diagnostics::log_startup(&window);
    let platform = &app.state::<PlatformState>().0;
    platform.prepare_strip(&window)?;
    place(&window);
    tray::create(app)?;
    let watched = window.clone();
    platform.watch_displays(
        &window,
        Box::new(move |event| match event {
            DisplayEvent::Changed => {
                place(&watched);
                tray::refresh(watched.app_handle());
            }
            DisplayEvent::FullScreen(open) => {
                watched
                    .app_handle()
                    .state::<ShellState>()
                    .lock()
                    .unwrap()
                    .full_screen = open;
                apply_always_on_top(&watched);
            }
        }),
    )?;
    show(&window)?;
    // After showing, so the menu offers Hide.
    tray::refresh(app.handle());
    Ok(())
}

/// Shows the window and its page, then places it, which reserves its space now that it is visible.
fn show(window: &WebviewWindow) -> tauri::Result<()> {
    window.show()?;
    platform_of(window).set_webview_visible(window, true)?;
    place(window);
    Ok(())
}

/// Hides the window and its page, so the page stops rendering, then places it, which gives its
/// reserved space back.
fn hide_window(window: &WebviewWindow) -> tauri::Result<()> {
    platform_of(window).set_webview_visible(window, false)?;
    window.hide()?;
    place(window);
    Ok(())
}

/// Gives the reserved space back as the app exits. The window's destruction does too, but the
/// space must not outlive the app even if the window is never destroyed.
pub fn release_space(app: &AppHandle) {
    let (Some(window), Some(platform)) = (main_window(app), app.try_state::<PlatformState>())
    else {
        return;
    };
    if let Err(error) = platform.0.release(&window) {
        log::warn!("Could not give the reserved space back: {error}");
    }
}

pub fn platform_of(window: &WebviewWindow) -> &dyn Platform {
    window
        .app_handle()
        .state::<PlatformState>()
        .inner()
        .0
        .as_ref()
}

pub fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

fn state(app: &AppHandle) -> Shell {
    app.state::<ShellState>().lock().unwrap().clone()
}

/// The connected monitors, in the shape placement works with.
pub fn monitors(window: &WebviewWindow) -> tauri::Result<Vec<MonitorInfo>> {
    let primary = window.primary_monitor()?;
    Ok(window
        .available_monitors()?
        .iter()
        .map(|m| monitor_info(m, primary.as_ref()))
        .collect())
}

fn monitor_info(monitor: &Monitor, primary: Option<&Monitor>) -> MonitorInfo {
    let area = monitor.work_area();
    MonitorInfo {
        name: monitor.name().cloned(),
        bounds: Rect {
            x: monitor.position().x,
            y: monitor.position().y,
            width: monitor.size().width,
            height: monitor.size().height,
        },
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

/// Moves the window to where it belongs on the current displays, as the strip or expanded, and
/// reserves the strip's space while it is visible and the setting is on (ADR 0008 §10).
/// Errors are logged, not returned: the window just stays where it was until the next change.
pub fn place(window: &WebviewWindow) {
    place_with(window, Reservation::Update);
}

/// Whether placing the window also updates its reserved space.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Reservation {
    Update,
    /// Leave it as it is: every change makes Windows resize all maximized windows, which flickers
    /// if done on every step of a handle drag.
    Keep,
}

fn place_with(window: &WebviewWindow, reservation: Reservation) {
    if let Err(error) = try_place(window, reservation) {
        log::warn!("Could not place the window: {error}");
    }
}

fn try_place(window: &WebviewWindow, reservation: Reservation) -> tauri::Result<()> {
    let app = window.app_handle();
    let platform = &app.state::<PlatformState>().0;
    let shell = state(app);
    let monitors = monitors(window)?;
    let Some(monitor) = choose_monitor(&monitors, shell.settings.monitor.as_deref()) else {
        return Ok(());
    };
    let height = shell.settings.height;
    let area = if shell.settings.reserve_space && window.is_visible()? {
        platform
            .reservable_area(window, monitor.bounds, monitor.work_area)
            .unwrap_or_else(|error| {
                log::warn!("Could not reserve space for the strip: {error}");
                None
            })
    } else {
        None
    };
    // Expanded mode keeps the compact strip's reservation, so other windows don't move.
    let strip = match area {
        Some(area) => {
            let strip = strip_rect(area, monitor.scale_factor, height);
            match reservation {
                Reservation::Update => platform.reserve(window, strip)?,
                Reservation::Keep => strip,
            }
        }
        None => {
            platform.release(window)?;
            if shell.full_screen {
                // No more full-screen notices once released; don't leave always-on-top off.
                app.state::<ShellState>().lock().unwrap().full_screen = false;
                apply_always_on_top(window);
            }
            strip_rect(monitor.work_area, monitor.scale_factor, height)
        }
    };
    let rect = if shell.expanded {
        expanded_rect(monitor.work_area)
    } else {
        strip
    };
    window.set_size(PhysicalSize::new(rect.width, rect.height))?;
    window.set_position(PhysicalPosition::new(rect.x, rect.y))?;
    Ok(())
}

/// Shows the window if it is hidden and hides it otherwise. Hiding does not pause (ADR 0008 §12).
pub fn toggle_visible(app: &AppHandle) {
    let Some(window) = main_window(app) else {
        return;
    };
    let result = if window.is_visible().unwrap_or(false) {
        hide_window(&window)
    } else {
        show(&window)
    };
    if let Err(error) = result {
        log::warn!("Could not show or hide the window: {error}");
    }
    tray::refresh(app);
}

/// Hides the window. Hiding does not pause (ADR 0008 §12).
pub fn hide(app: &AppHandle) {
    let Some(window) = main_window(app) else {
        return;
    };
    if let Err(error) = hide_window(&window) {
        log::warn!("Could not hide the window: {error}");
    }
    tray::refresh(app);
}

pub fn toggle_expanded(app: &AppHandle) {
    let expanded = state(app).expanded;
    set_expanded(app, !expanded);
}

/// Switches between the strip and expanded mode, showing the window if it was hidden.
pub fn set_expanded(app: &AppHandle, expanded: bool) {
    let Some(window) = main_window(app) else {
        return;
    };
    app.state::<ShellState>().lock().unwrap().expanded = expanded;
    place(&window);
    if let Err(error) = show(&window) {
        log::warn!("Could not show the window: {error}");
    }
    emit(app, EXPANDED_CHANGED, expanded);
    tray::refresh(app);
}

pub fn toggle_paused(app: &AppHandle) {
    let paused = state(app).paused;
    set_paused(app, !paused);
}

pub fn set_paused(app: &AppHandle, paused: bool) {
    app.state::<ShellState>().lock().unwrap().paused = paused;
    emit(app, PAUSED_CHANGED, paused);
    tray::refresh(app);
}

/// Tells the frontend about a change; it applies the new state.
fn emit(app: &AppHandle, event: &str, payload: bool) {
    if let Err(error) = app.emit(event, payload) {
        log::warn!("Could not send {event} to the frontend: {error}");
    }
}

pub fn toggle_always_on_top(app: &AppHandle) {
    let Some(window) = main_window(app) else {
        return;
    };
    {
        let state = app.state::<ShellState>();
        let mut shell = state.lock().unwrap();
        shell.settings.always_on_top = !shell.settings.always_on_top;
    }
    apply_always_on_top(&window);
    save_now(app);
    tray::refresh(app);
}

/// Puts the window on top if the setting says so and no full-screen app is open.
fn apply_always_on_top(window: &WebviewWindow) {
    let shell = state(window.app_handle());
    let on_top = shell.settings.always_on_top && !shell.full_screen;
    if let Err(error) = window.set_always_on_top(on_top) {
        log::warn!("Could not change always-on-top: {error}");
    }
}

pub fn toggle_reserve_space(app: &AppHandle) {
    let Some(window) = main_window(app) else {
        return;
    };
    {
        let state = app.state::<ShellState>();
        let mut shell = state.lock().unwrap();
        shell.settings.reserve_space = !shell.settings.reserve_space;
    }
    place(&window);
    save_now(app);
    tray::refresh(app);
}

/// Moves the window to the monitor with this device name and remembers it.
pub fn use_monitor(app: &AppHandle, name: &str) {
    let Some(window) = main_window(app) else {
        return;
    };
    app.state::<ShellState>().lock().unwrap().settings.monitor = Some(name.to_owned());
    place(&window);
    save_now(app);
    tray::refresh(app);
}

/// Saves the settings and asks the frontend to shut down, exiting when it answers with
/// `quit_ready` or after `QUIT_TIMEOUT`, whichever comes first (ADR 0008 §14).
pub fn quit(app: &AppHandle) {
    {
        let state = app.state::<ShellState>();
        let mut shell = state.lock().unwrap();
        if shell.quitting {
            return;
        }
        shell.quitting = true;
    }
    save_now(app);
    if let Err(error) = app.emit(QUIT_REQUESTED, ()) {
        log::warn!("Could not ask the frontend to shut down: {error}");
        app.exit(0);
        return;
    }
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(QUIT_TIMEOUT);
        log::warn!("The frontend did not shut down in time, exiting anyway");
        app.exit(0);
    });
}

/// The frontend's commands that share a name with an action above; a command is named after its
/// function.
pub mod commands {
    use tauri::AppHandle;

    #[tauri::command]
    pub fn set_paused(app: AppHandle, paused: bool) {
        super::set_paused(&app, paused);
    }

    #[tauri::command]
    pub fn set_expanded(app: AppHandle, expanded: bool) {
        super::set_expanded(&app, expanded);
    }

    #[tauri::command]
    pub fn hide(app: AppHandle) {
        super::hide(&app);
    }

    /// The frontend's answer to `quit-requested`: it has shut down, so the app exits.
    #[tauri::command]
    pub fn quit_ready(app: AppHandle) {
        app.exit(0);
    }
}

/// Sets the compact height in logical pixels; it is clamped to the limits. Ignored while expanded,
/// so the handle can't change the strip's height from a window of another size. The window
/// follows at once; the reserved space and the settings file once the height has settled.
#[tauri::command]
pub fn set_strip_height(
    app: AppHandle,
    window: WebviewWindow,
    shell: State<ShellState>,
    height: f64,
) {
    let change = {
        let mut shell = shell.lock().unwrap();
        let height = clamp_strip_height(height);
        if shell.expanded || shell.settings.height == height {
            return;
        }
        shell.settings.height = height;
        shell.height_changes += 1;
        shell.height_changes
    };
    place_with(&window, Reservation::Keep);
    save_later(&app);
    thread::spawn(move || {
        thread::sleep(HEIGHT_SETTLE_DELAY);
        if state(&app).height_changes == change {
            let result = app.run_on_main_thread(move || place(&window));
            if let Err(error) = result {
                log::warn!("Could not reserve the strip's new height: {error}");
            }
        }
    });
}

fn save_now(app: &AppHandle) {
    let file = app.state::<SettingsFile>();
    file.generation.fetch_add(1, Ordering::SeqCst);
    write_settings(app, &file);
}

/// Saves after `HEIGHT_SETTLE_DELAY`, unless another save comes first.
fn save_later(app: &AppHandle) {
    let generation = app
        .state::<SettingsFile>()
        .generation
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(HEIGHT_SETTLE_DELAY);
        let file = app.state::<SettingsFile>();
        if file.generation.load(Ordering::SeqCst) == generation {
            write_settings(&app, &file);
        }
    });
}

fn write_settings(app: &AppHandle, file: &SettingsFile) {
    let path = file.path.lock().unwrap();
    let Some(path) = path.as_deref() else { return };
    let settings = state(app).settings;
    if let Err(error) = settings::save(path, &settings) {
        log::warn!("Could not save {}: {error}", path.display());
    }
}

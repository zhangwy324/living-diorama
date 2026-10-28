//! The shell's state and the actions on it, shared by the tray and the frontend's commands: the one
//! app window, in the strip's shape or the normal window's (ADR 0008 §2–§10, ADR 0016 §1–§8), and
//! the settings it persists.

use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::Duration;

use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, Monitor, PhysicalPosition, PhysicalSize, Size, State,
    WebviewWindow, WindowEvent,
};

use crate::diagnostics;
use crate::placement::{
    Band, MonitorInfo, Move, NormalWindow, Rect, Shape, Situation, Trigger, choose_monitor,
    clamp_strip_height, decide, monitor_of, normal_window, strip_rect,
};
use crate::platform::{self, DisplayEvent, Platform};
use crate::settings::{self, Settings};
use crate::tray;

/// The strip's window label. Shell events go to it only, so the Studio never hears them
/// (ADR 0015 §6).
pub const MAIN: &str = "main";

/// Event telling the frontend to pause or resume the simulation; the payload is the new state.
const PAUSED_CHANGED: &str = "paused-changed";
/// Event telling the frontend the window was expanded or collapsed; the payload is the new state.
const EXPANDED_CHANGED: &str = "expanded-changed";
/// Event telling the frontend the normal window entered or left full screen.
const FULL_SCREEN_CHANGED: &str = "full-screen-changed";
/// Event asking the frontend to shut down; it answers with the `quit_ready` command.
const QUIT_REQUESTED: &str = "quit-requested";
/// How long quitting waits for the frontend to shut down before exiting anyway (ADR 0008 §14).
const QUIT_TIMEOUT: Duration = Duration::from_secs(1);
/// How long the height must stay put before it is saved and its space reserved, so a handle drag
/// is one write and one change of other windows' work area.
const HEIGHT_SETTLE_DELAY: Duration = Duration::from_millis(500);
/// How long a maximize waits for the work area to change once the band is given back, before it
/// maximizes anyway.
const MAXIMIZE_FALLBACK_DELAY: Duration = Duration::from_millis(500);
/// How long a switch of shape stays hidden after its last step, for the page to draw at the new
/// size. The page redraws on resize; WebView2 shows it within about 80 ms (ADR 0016 §8).
const REVEAL_DELAY: Duration = Duration::from_millis(150);
/// The normal window's smallest inner size, in logical pixels.
const NORMAL_MIN_SIZE: LogicalSize<f64> = LogicalSize::new(480.0, 270.0);

#[derive(Clone, Debug, Default)]
pub struct Shell {
    pub settings: Settings,
    /// Not persisted: the app always starts as the strip (ADR 0016 §5).
    pub shape: Shape,
    /// Rust owns the flag so the tray and the controls overlay agree; the frontend applies it.
    pub paused: bool,
    /// Set once Quit has asked the frontend to shut down, so a second Quit doesn't ask again.
    pub quitting: bool,
    /// A full-screen app is open while the strip reserves space; always-on-top steps aside.
    pub full_screen_app: bool,
    /// Counts height changes, so a delayed reservation can tell whether the height has settled.
    pub height_changes: u64,
    /// The band the strip has reserved, if any.
    pub band: Option<Rect>,
    /// The normal window's geometry while it has that shape, its restore rectangle kept up to
    /// date as the user moves and resizes it.
    pub normal: Option<NormalWindow>,
    /// The normal window maximizes once the band it just gave back has left the work area.
    pub maximize_pending: bool,
    /// Set while the window switches shape. Its own move and resize events arrive during the
    /// switch, before it is in place, and are not the user's.
    pub switching: bool,
    /// Counts switches hidden from view, so a delayed reveal can tell whether a newer one started.
    pub hidden_switches: u64,
    /// Whether the normal window was minimized when last looked at, so the tray's Show/Hide
    /// follows minimizing.
    pub minimized: bool,
}

impl Shell {
    pub fn expanded(&self) -> bool {
        self.shape == Shape::Normal
    }
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
        .get_webview_window(MAIN)
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
    platform.set_window_animations(&window, false)?;
    place(&window);
    tray::create(app)?;
    let watched = window.clone();
    platform.watch_displays(
        &window,
        Box::new(move |event| match event {
            DisplayEvent::Changed => {
                place_with(&watched, Trigger::DisplaysChanged);
                tray::refresh(watched.app_handle());
            }
            DisplayEvent::FullScreen(open) => {
                watched
                    .app_handle()
                    .state::<ShellState>()
                    .lock()
                    .unwrap()
                    .full_screen_app = open;
                apply_always_on_top(&watched);
            }
        }),
    )?;
    let watched = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => note_normal_window(&watched),
        // Closing the normal window turns it back into the strip (ADR 0016 §3).
        WindowEvent::CloseRequested { api, .. } if state(watched.app_handle()).expanded() => {
            api.prevent_close();
            let app = watched.app_handle().clone();
            let result = watched
                .app_handle()
                .run_on_main_thread(move || set_expanded(&app, false));
            if let Err(error) = result {
                log::warn!("Could not collapse the window: {error}");
            }
        }
        _ => {}
    });
    show(&window)?;
    // After showing, so the menu offers Hide.
    tray::refresh(app.handle());
    Ok(())
}

/// Shows the window and its page, then places it, which reserves the strip's space now that it is
/// visible. The normal window also comes to the front, restored if it was minimized.
fn show(window: &WebviewWindow) -> tauri::Result<()> {
    window.show()?;
    platform_of(window).set_webview_visible(window, true)?;
    place(window);
    if state(window.app_handle()).expanded() {
        window.unminimize()?;
        window.set_focus()?;
    }
    Ok(())
}

/// Hides the window and its page, so the page stops rendering, then places it, which gives the
/// strip's reserved space back.
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
    app.get_webview_window(MAIN)
}

pub fn state(app: &AppHandle) -> Shell {
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

/// Places the window after a change of state (shown, hidden, a setting, a monitor).
pub fn place(window: &WebviewWindow) {
    place_with(window, Trigger::StateChanged);
}

/// Does what `placement::decide` says for this trigger: reserves or gives back the strip's band
/// (ADR 0008 §10) and moves the window. Errors are logged, not returned: the window just stays
/// where it was until the next change.
fn place_with(window: &WebviewWindow, trigger: Trigger) {
    if let Err(error) = try_place(window, trigger) {
        log::warn!("Could not place the window: {error}");
    }
}

fn try_place(window: &WebviewWindow, trigger: Trigger) -> tauri::Result<()> {
    let app = window.app_handle();
    let platform = &app.state::<PlatformState>().0;
    let shell = state(app);
    let placement = decide(Situation {
        shape: shell.shape,
        trigger,
        visible: window.is_visible()?,
        reserve_space: shell.settings.reserve_space,
        maximize_pending: shell.maximize_pending,
    });
    let monitors = monitors(window)?;
    let Some(monitor) = choose_monitor(&monitors, shell.settings.monitor.as_deref()) else {
        return Ok(());
    };
    let area = match placement.band {
        Band::Release => None,
        Band::Reserve | Band::Keep => platform
            .reservable_area(window, monitor.bounds, monitor.work_area)
            .unwrap_or_else(|error| {
                log::warn!("Could not reserve space for the strip: {error}");
                None
            }),
    };
    if area.is_none() {
        release_band(window)?;
    }
    match placement.window {
        Move::Strip => {
            let rect = match area {
                Some(area) => {
                    let strip = strip_rect(area, monitor.scale_factor, shell.settings.height);
                    if placement.band == Band::Reserve {
                        let granted = platform.reserve(window, strip)?;
                        app.state::<ShellState>().lock().unwrap().band = Some(granted);
                        granted
                    } else {
                        strip
                    }
                }
                None => strip_rect(
                    monitor.work_area,
                    monitor.scale_factor,
                    shell.settings.height,
                ),
            };
            window.set_size(PhysicalSize::new(rect.width, rect.height))?;
            window.set_position(PhysicalPosition::new(rect.x, rect.y))?;
        }
        Move::Restore => {
            if let Some(normal) = shell.normal {
                // Position first: moving onto a monitor with another scale makes Windows rescale
                // the window, which would undo a size set before the move (ADR 0016 §8).
                window.set_position(PhysicalPosition::new(normal.x, normal.y))?;
                window.set_size(PhysicalSize::new(normal.width, normal.height))?;
            }
        }
        Move::Maximize => {
            app.state::<ShellState>().lock().unwrap().maximize_pending = false;
            window.maximize()?;
            reveal_later(window);
        }
        Move::Leave => {}
    }
    Ok(())
}

/// Gives the strip's band back, if it holds one.
fn release_band(window: &WebviewWindow) -> tauri::Result<()> {
    let app = window.app_handle();
    platform_of(window).release(window)?;
    let full_screen_app = {
        let state = app.state::<ShellState>();
        let mut shell = state.lock().unwrap();
        shell.band = None;
        std::mem::take(&mut shell.full_screen_app)
    };
    if full_screen_app {
        // No more full-screen notices once released; don't leave always-on-top off.
        apply_always_on_top(window);
    }
    Ok(())
}

/// Keeps the normal window's restore rectangle up to date as the user moves and resizes it, and
/// the tray's Show/Hide in step with minimizing. Maximized, full-screen and minimized sizes are
/// not restore rectangles; nor is anything once it is the strip again.
fn note_normal_window(window: &WebviewWindow) {
    let app = window.app_handle();
    let shell = state(app);
    if !shell.expanded() || shell.switching {
        return;
    }
    let minimized = window.is_minimized().unwrap_or(false);
    let minimized_changed = {
        let state = app.state::<ShellState>();
        let mut shell = state.lock().unwrap();
        std::mem::replace(&mut shell.minimized, minimized) != minimized
    };
    if minimized_changed {
        tray::refresh(app);
    }
    let resting = !minimized
        && !window.is_maximized().unwrap_or(true)
        && !window.is_fullscreen().unwrap_or(true);
    let (true, Ok(position), Ok(size)) = (resting, window.outer_position(), window.inner_size())
    else {
        return;
    };
    let state = app.state::<ShellState>();
    let mut shell = state.lock().unwrap();
    if let (Shape::Normal, Some(normal)) = (shell.shape, shell.normal.as_mut()) {
        normal.x = position.x;
        normal.y = position.y;
        normal.width = size.width;
        normal.height = size.height;
    }
}

/// Saves the normal window's current geometry in the settings (ADR 0016 §5): its restore
/// rectangle, the monitor under it and whether it is maximized or full screen.
fn remember_normal_window(window: &WebviewWindow) {
    let app = window.app_handle();
    let monitors = monitors(window).unwrap_or_default();
    let maximized = window.is_maximized().unwrap_or(false);
    let full_screen = window.is_fullscreen().unwrap_or(false);
    let state = app.state::<ShellState>();
    let mut shell = state.lock().unwrap();
    let Some(normal) = shell.normal.clone() else {
        return;
    };
    let monitor = monitor_of(&monitors, normal.rect());
    shell.settings.expanded = Some(NormalWindow {
        monitor: monitor
            .and_then(|m| m.name.clone())
            .or(normal.monitor.clone()),
        scale_factor: monitor.map_or(normal.scale_factor, |m| m.scale_factor),
        maximized: maximized || shell.maximize_pending,
        full_screen,
        ..normal
    });
}

/// Shows the window if it is hidden and hides it otherwise; the normal window instead comes to
/// the front, restored if minimized (ADR 0016 §3). Hiding does not pause (ADR 0008 §12).
pub fn toggle_visible(app: &AppHandle) {
    let Some(window) = main_window(app) else {
        return;
    };
    let result = if state(app).expanded() || !window.is_visible().unwrap_or(false) {
        show(&window)
    } else {
        hide_window(&window)
    };
    if let Err(error) = result {
        log::warn!("Could not show or hide the window: {error}");
    }
    tray::refresh(app);
}

/// The tray's Show/Hide: it shows a hidden or minimized window, in its shape, and hides one in
/// view.
pub fn show_or_hide(app: &AppHandle) {
    let Some(window) = main_window(app) else {
        return;
    };
    let result = if offers_show(&window) {
        show(&window)
    } else {
        hide_window(&window)
    };
    if let Err(error) = result {
        log::warn!("Could not show or hide the window: {error}");
    }
    tray::refresh(app);
}

/// Whether the tray offers Show rather than Hide: the window is hidden, or minimized.
pub fn offers_show(window: &WebviewWindow) -> bool {
    !window.is_visible().unwrap_or(false)
        || (state(window.app_handle()).expanded() && window.is_minimized().unwrap_or(false))
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
    let expanded = state(app).expanded();
    set_expanded(app, !expanded);
}

/// Switches between the strip and the normal window (ADR 0016 §1), showing the window if it was
/// hidden. Asked for the shape it has, it shows the window, the normal one in front.
pub fn set_expanded(app: &AppHandle, expanded: bool) {
    let Some(window) = main_window(app) else {
        return;
    };
    app.state::<ShellState>().lock().unwrap().switching = true;
    let result = match (state(app).expanded(), expanded) {
        (false, true) => expand(&window),
        (true, false) => collapse(&window),
        _ => show(&window),
    };
    app.state::<ShellState>().lock().unwrap().switching = false;
    if let Err(error) = result {
        log::warn!("Could not switch the window's shape: {error}");
        // Never leave it hidden from view.
        if let Err(error) = platform_of(&window).set_cloaked(&window, false) {
            log::warn!("Could not show the window: {error}");
        }
    }
    emit(app, EXPANDED_CHANGED, expanded);
    emit(
        app,
        FULL_SCREEN_CHANGED,
        window.is_fullscreen().unwrap_or(false),
    );
    tray::refresh(app);
}

/// Turns the strip into the normal window: framed, resizable, focusable, in the taskbar and
/// Alt+Tab, at its saved geometry or maximized on the strip's monitor (ADR 0016 §1, §5). The band
/// is given back first, and maximizing waits for it to leave the work area (§8).
fn expand(window: &WebviewWindow) -> tauri::Result<()> {
    let app = window.app_handle();
    let shell = state(app);
    let monitors = monitors(window)?;
    let Some(strip_monitor) = choose_monitor(&monitors, shell.settings.monitor.as_deref()) else {
        return Ok(());
    };
    let normal = normal_window(
        shell.settings.expanded.as_ref(),
        &monitors,
        strip_monitor,
        shell.band,
    );
    let band_held = shell.band.is_some();
    let maximize_pending = normal.maximized && !normal.full_screen && band_held;
    {
        let state = app.state::<ShellState>();
        let mut shell = state.lock().unwrap();
        shell.shape = Shape::Normal;
        shell.normal = Some(normal.clone());
        shell.maximize_pending = maximize_pending;
        shell.minimized = false;
    }
    hide_switch(window)?;
    platform_of(window).set_normal_window(window, true)?;
    apply_always_on_top(window);
    window.set_decorations(true)?;
    window.set_shadow(true)?;
    window.set_resizable(true)?;
    window.set_min_size(Some(Size::Logical(NORMAL_MIN_SIZE)))?;
    window.set_skip_taskbar(false)?;
    window.set_focusable(true)?;
    place_with(window, Trigger::Switched);
    window.show()?;
    platform_of(window).set_webview_visible(window, true)?;
    if normal.full_screen {
        window.set_fullscreen(true)?;
    } else if normal.maximized && !band_held {
        window.maximize()?;
    } else if maximize_pending {
        maximize_later(window);
    }
    if !maximize_pending {
        reveal_later(window);
    }
    platform_of(window).set_window_animations(window, true)?;
    window.set_focus()
}

/// Hides the window from view for a switch of shape; `reveal_later` shows it again.
fn hide_switch(window: &WebviewWindow) -> tauri::Result<()> {
    window
        .app_handle()
        .state::<ShellState>()
        .lock()
        .unwrap()
        .hidden_switches += 1;
    platform_of(window).set_cloaked(window, true)
}

/// Shows the window again `REVEAL_DELAY` after a switch's last step, unless another switch has
/// started since.
fn reveal_later(window: &WebviewWindow) {
    let switch = state(window.app_handle()).hidden_switches;
    let window = window.clone();
    thread::spawn(move || {
        thread::sleep(REVEAL_DELAY);
        let app = window.app_handle().clone();
        let result = app.run_on_main_thread(move || {
            if state(window.app_handle()).hidden_switches == switch
                && let Err(error) = platform_of(&window).set_cloaked(&window, false)
            {
                log::warn!("Could not show the window after switching: {error}");
            }
        });
        if let Err(error) = result {
            log::warn!("Could not show the window after switching: {error}");
        }
    });
}

/// Maximizes the normal window after `MAXIMIZE_FALLBACK_DELAY` if the work-area change it waits
/// for hasn't come.
fn maximize_later(window: &WebviewWindow) {
    let window = window.clone();
    thread::spawn(move || {
        thread::sleep(MAXIMIZE_FALLBACK_DELAY);
        let app = window.app_handle().clone();
        let result = app.run_on_main_thread(move || {
            if state(window.app_handle()).maximize_pending {
                log::info!("The work area did not change in time; maximizing anyway");
                place_with(&window, Trigger::DisplaysChanged);
            }
        });
        if let Err(error) = result {
            log::warn!("Could not maximize the window: {error}");
        }
    });
}

/// Turns the normal window back into the strip, saving its geometry, then takes the band again
/// (ADR 0016 §1, §5). The strip never stays active, so activation goes back to the app the user
/// was in.
fn collapse(window: &WebviewWindow) -> tauri::Result<()> {
    let app = window.app_handle();
    hide_switch(window)?;
    // Un-maximizing would animate over the strip's place.
    platform_of(window).set_window_animations(window, false)?;
    remember_normal_window(window);
    {
        let state = app.state::<ShellState>();
        let mut shell = state.lock().unwrap();
        shell.shape = Shape::Strip;
        shell.normal = None;
        shell.maximize_pending = false;
    }
    if window.is_fullscreen()? {
        window.set_fullscreen(false)?;
    }
    if window.is_minimized()? {
        window.unminimize()?;
    }
    if window.is_maximized()? {
        window.unmaximize()?;
    }
    window.set_min_size(None::<Size>)?;
    window.set_focusable(false)?;
    window.set_skip_taskbar(true)?;
    window.set_resizable(false)?;
    window.set_shadow(false)?;
    window.set_decorations(false)?;
    platform_of(window).set_normal_window(window, false)?;
    apply_always_on_top(window);
    place_with(window, Trigger::Switched);
    reveal_later(window);
    save_now(app);
    if window.is_visible()? {
        Ok(())
    } else {
        show(window)
    }
}

/// Enters or leaves full screen in the normal shape (ADR 0016 §2); the strip has none.
pub fn set_full_screen(app: &AppHandle, full_screen: bool) {
    let Some(window) = main_window(app) else {
        return;
    };
    if state(app).expanded()
        && let Err(error) = window.set_fullscreen(full_screen)
    {
        log::warn!("Could not change full screen: {error}");
    }
    emit(
        app,
        FULL_SCREEN_CHANGED,
        window.is_fullscreen().unwrap_or(false),
    );
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

/// Tells the strip about a change; it applies the new state.
fn emit(app: &AppHandle, event: &str, payload: bool) {
    if let Err(error) = app.emit_to(MAIN, event, payload) {
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

/// Puts the strip on top if the setting says so and no full-screen app is open. The normal
/// window is an ordinary one, never on top.
fn apply_always_on_top(window: &WebviewWindow) {
    let shell = state(window.app_handle());
    let on_top = shell.settings.always_on_top && !shell.full_screen_app && !shell.expanded();
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

/// Moves the strip to the monitor with this device name and remembers it. The normal window stays
/// where it is; the strip comes back there.
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
    if let Some(window) = main_window(app)
        && state(app).expanded()
    {
        remember_normal_window(&window);
    }
    save_now(app);
    if let Err(error) = app.emit_to(MAIN, QUIT_REQUESTED, ()) {
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
    use tauri::{AppHandle, WebviewWindow};

    #[tauri::command]
    pub fn set_paused(app: AppHandle, paused: bool) {
        super::set_paused(&app, paused);
    }

    #[tauri::command]
    pub fn set_expanded(app: AppHandle, expanded: bool) {
        super::set_expanded(&app, expanded);
    }

    #[tauri::command]
    pub fn set_full_screen(app: AppHandle, full_screen: bool) {
        super::set_full_screen(&app, full_screen);
    }

    #[tauri::command]
    pub fn hide(app: AppHandle) {
        super::hide(&app);
    }

    /// The strip's answer to `quit-requested`: it has shut down, so the app exits.
    #[tauri::command]
    pub fn quit_ready(app: AppHandle, window: WebviewWindow) {
        if super::accepts_quit_ready(window.label()) {
            app.exit(0);
        } else {
            log::warn!("Ignored quit_ready from the {} window", window.label());
        }
    }
}

/// Sets the compact height in logical pixels; it is clamped to the limits. Ignored in the normal
/// shape, so the handle can't change the strip's height from a window of another size. The window
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
        if shell.expanded() || shell.settings.height == height {
            return;
        }
        shell.settings.height = height;
        shell.height_changes += 1;
        shell.height_changes
    };
    place_with(&window, Trigger::HeightDragged);
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

/// Whether a `quit_ready` call comes from the strip. App commands can be called from every window,
/// so another window's answer must not end the strip's shutdown early (ADR 0015 §6).
fn accepts_quit_ready(label: &str) -> bool {
    label == MAIN
}

#[cfg(test)]
mod tests {
    use super::accepts_quit_ready;

    #[test]
    fn only_the_strip_answers_quit() {
        assert!(accepts_quit_ready("main"));
        assert!(!accepts_quit_ready("studio"));
    }
}

//! The tray icon and its menu (ADR 0008 §7, plus the Creation Studio of ADR 0015 §1 and the normal
//! window of ADR 0016 §3). Left-click toggles the strip, and brings the normal window to the front;
//! the menu's labels and checks are refreshed from the shell state after every change.

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::diagnostics;
use crate::placement::choose_monitor;
use crate::shell::{self, ShellState};
use crate::studio;

const STUDIO: &str = "studio";
const SHOW_HIDE: &str = "show-hide";
const EXPAND: &str = "expand";
const PAUSE: &str = "pause";
const ALWAYS_ON_TOP: &str = "always-on-top";
const RESERVE_SPACE: &str = "reserve-space";
const OPEN_LOG_FOLDER: &str = "open-log-folder";
const QUIT: &str = "quit";
/// Monitor entries' ids are this prefix plus the monitor's device name.
const MONITOR_PREFIX: &str = "monitor:";

/// The menu items whose labels or checks follow the shell state.
struct Tray {
    show_hide: MenuItem<tauri::Wry>,
    expand: MenuItem<tauri::Wry>,
    pause: MenuItem<tauri::Wry>,
    always_on_top: CheckMenuItem<tauri::Wry>,
    reserve_space: CheckMenuItem<tauri::Wry>,
    monitors: Submenu<tauri::Wry>,
}

pub fn create(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let tray = Tray {
        show_hide: MenuItem::with_id(app, SHOW_HIDE, "Hide", true, None::<&str>)?,
        expand: MenuItem::with_id(app, EXPAND, "Expand", true, None::<&str>)?,
        pause: MenuItem::with_id(app, PAUSE, "Pause", true, None::<&str>)?,
        always_on_top: CheckMenuItem::with_id(
            app,
            ALWAYS_ON_TOP,
            "Always on top",
            true,
            false,
            None::<&str>,
        )?,
        reserve_space: CheckMenuItem::with_id(
            app,
            RESERVE_SPACE,
            "Reserve screen space",
            true,
            true,
            None::<&str>,
        )?,
        monitors: Submenu::new(app, "Monitor", true)?,
    };
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, STUDIO, "Creation Studio", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &tray.show_hide,
            &tray.expand,
            &tray.pause,
            &tray.always_on_top,
            &tray.reserve_space,
            &tray.monitors,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, OPEN_LOG_FOLDER, "Open log folder", true, None::<&str>)?,
            &MenuItem::with_id(app, QUIT, "Quit", true, None::<&str>)?,
        ],
    )?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("the app has no icon for the tray")?;
    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("Living Diorama")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                shell::toggle_visible(tray.app_handle());
            }
        })
        .build(app)?;
    app.manage(tray);
    Ok(())
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        STUDIO => studio::open(app),
        SHOW_HIDE => shell::show_or_hide(app),
        EXPAND => shell::toggle_expanded(app),
        PAUSE => shell::toggle_paused(app),
        ALWAYS_ON_TOP => shell::toggle_always_on_top(app),
        RESERVE_SPACE => shell::toggle_reserve_space(app),
        OPEN_LOG_FOLDER => diagnostics::open_log_folder(app),
        QUIT => shell::quit(app),
        _ => {
            if let Some(name) = id.strip_prefix(MONITOR_PREFIX) {
                shell::use_monitor(app, name);
            }
        }
    }
}

/// Brings the menu in line with the shell state and the connected monitors.
pub fn refresh(app: &AppHandle) {
    if let Err(error) = try_refresh(app) {
        log::warn!("Could not update the tray menu: {error}");
    }
}

fn try_refresh(app: &AppHandle) -> tauri::Result<()> {
    let (Some(tray), Some(window)) = (app.try_state::<Tray>(), shell::main_window(app)) else {
        return Ok(());
    };
    let shell = app.state::<ShellState>().lock().unwrap().clone();
    let offers_show = shell::offers_show(&window);
    tray.show_hide
        .set_text(if offers_show { "Show" } else { "Hide" })?;
    tray.expand.set_text(if shell.expanded() {
        "Collapse"
    } else {
        "Expand"
    })?;
    tray.pause
        .set_text(if shell.paused { "Resume" } else { "Pause" })?;
    tray.always_on_top
        .set_checked(shell.settings.always_on_top)?;
    tray.reserve_space
        .set_checked(shell.settings.reserve_space)?;

    for item in tray.monitors.items()? {
        tray.monitors.remove(&item)?;
    }
    let monitors = shell::monitors(&window)?;
    let current =
        choose_monitor(&monitors, shell.settings.monitor.as_deref()).and_then(|m| m.name.clone());
    for monitor in &monitors {
        let Some(name) = &monitor.name else { continue };
        tray.monitors.append(&CheckMenuItem::with_id(
            app,
            format!("{MONITOR_PREFIX}{name}"),
            monitor_label(name, monitor.primary),
            true,
            current.as_ref() == Some(name),
            None::<&str>,
        )?)?;
    }
    Ok(())
}

/// A readable menu label for a monitor: `\\.\DISPLAY2` becomes "Display 2".
fn monitor_label(name: &str, primary: bool) -> String {
    let base = match name.strip_prefix(r"\\.\DISPLAY") {
        Some(number) if number.parse::<u32>().is_ok() => format!("Display {number}"),
        _ => name.to_owned(),
    };
    if primary {
        format!("{base} (primary)")
    } else {
        base
    }
}

#[cfg(test)]
mod tests {
    use super::monitor_label;

    #[test]
    fn labels_windows_device_names() {
        assert_eq!(monitor_label(r"\\.\DISPLAY2", false), "Display 2");
        assert_eq!(monitor_label(r"\\.\DISPLAY1", true), "Display 1 (primary)");
        assert_eq!(monitor_label("HDMI-1", false), "HDMI-1");
    }
}

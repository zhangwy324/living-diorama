//! The diagnostics log (ADR 0009 §13–15). `tauri-plugin-log` writes it to the app's log directory
//! and rotates it; the shell logs through the `log` macros and the frontend through the plugin's
//! JavaScript binding.

use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Manager, WebviewWindow, Wry};
use tauri_plugin_log::{RotationStrategy, TimezoneStrategy, WEBVIEW_TARGET};
use time::macros::format_description;

use crate::shell;

/// Each file rotates at this size, and the newest `KEEP_FILES` are kept.
const MAX_FILE_BYTES: u128 = 1_000_000;
const KEEP_FILES: usize = 5;

pub fn plugin() -> TauriPlugin<Wry> {
    let timestamp = format_description!("[year]-[month]-[day] [hour]:[minute]:[second]");
    tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        .max_file_size(MAX_FILE_BYTES)
        .rotation_strategy(RotationStrategy::KeepSome(KEEP_FILES))
        // Local time, since a person reads it. Rotated file names stay UTC, the plugin's default.
        .format(move |out, message, record| {
            let now = TimezoneStrategy::UseLocal.get_now();
            out.finish(format_args!(
                "[{}][{}][{}] {message}",
                now.format(&timestamp).unwrap_or_default(),
                record.level(),
                short_target(record.target()),
            ))
        })
        .build()
}

/// The plugin adds the JavaScript caller's location to the webview target, which is always the
/// console forwarder in `desktop-integration`, so it is dropped.
fn short_target(target: &str) -> &str {
    if target.starts_with(WEBVIEW_TARGET) {
        WEBVIEW_TARGET
    } else {
        target
    }
}

/// Logs what a bug report needs to know about the machine: app version, OS build and monitors.
pub fn log_startup(window: &WebviewWindow) {
    let app = window.app_handle();
    log::info!(
        "Living Diorama {} on {}",
        app.package_info().version,
        shell::platform_of(window).os_version()
    );
    match shell::monitors(window) {
        Ok(monitors) => {
            for monitor in monitors {
                log::info!("Monitor {monitor:?}");
            }
        }
        Err(error) => log::warn!("Could not list the monitors: {error}"),
    }
}

pub fn open_log_folder(app: &AppHandle) {
    let (Ok(dir), Some(window)) = (app.path().app_log_dir(), shell::main_window(app)) else {
        log::warn!("No log directory to open");
        return;
    };
    if let Err(error) = shell::platform_of(&window).open_folder(&dir) {
        log::warn!("Could not open {}: {error}", dir.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_the_javascript_callers_location() {
        assert_eq!(
            short_target("webview::console.warn@http://localhost/log.ts:17:3"),
            "webview"
        );
        assert_eq!(
            short_target("living_diorama_lib::shell"),
            "living_diorama_lib::shell"
        );
    }
}

//! OS-specific window behavior behind one trait (ADR 0008 §1). Everything else in the shell is
//! written against Tauri's cross-platform API and this trait, so another OS adds an implementation
//! here and nothing else changes.

use std::path::Path;

use tauri::WebviewWindow;

use crate::placement::Rect;

#[cfg(windows)]
mod windows;

/// What `Platform::watch_displays` reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DisplayEvent {
    /// Displays, scale factors, work areas or other apps' reserved space changed.
    Changed,
    /// A full-screen app opened (`true`) or the last one closed (`false`). Reported only while the
    /// strip reserves space.
    FullScreen(bool),
}

pub trait Platform: Send + Sync {
    /// Applies the strip's OS window style before it is first shown: no taskbar button and no
    /// task-switcher entry. Focus policy itself is Tauri's `focusable: false`.
    fn prepare_strip(&self, window: &WebviewWindow) -> tauri::Result<()>;

    /// Switches the OS window style between the strip's and the normal window's (ADR 0016 §8):
    /// the normal window has a taskbar and task-switcher entry and may stay active, so the strip's
    /// style and activation hooks stand aside. Back in the strip's style, activation goes back to
    /// the app the user was in. Focusability, the frame and the taskbar tab are Tauri's calls.
    fn set_normal_window(&self, window: &WebviewWindow, normal: bool) -> tauri::Result<()>;

    /// Turns the OS's animations of minimizing, maximizing and restoring the window on or off.
    /// Off while the window switches shape, or un-maximizing on the way back to the strip animates
    /// for about 120 ms over the strip's place (ADR 0016 §8).
    fn set_window_animations(&self, window: &WebviewWindow, on: bool) -> tauri::Result<()>;

    /// Hides the window from view while it keeps being laid out and drawn, or shows it again. A
    /// switch of shape happens hidden so, and the window is shown once the page has drawn at its
    /// new size, rather than showing the steps and one stale frame (ADR 0016 §8).
    fn set_cloaked(&self, window: &WebviewWindow, cloaked: bool) -> tauri::Result<()>;

    /// Calls `on_event` on the main thread, outside any window message handling. Bursts of
    /// `Changed` may be coalesced into one call.
    fn watch_displays(
        &self,
        window: &WebviewWindow,
        on_event: Box<dyn Fn(DisplayEvent) + 'static>,
    ) -> tauri::Result<()>;

    /// The area along the bottom of a monitor that the strip may reserve, left by the taskbar and
    /// other apps' reservations but not counting the strip's own (ADR 0008 §10). `bounds` is the
    /// whole monitor and `work_area` its current work area. Registers the window for reserving
    /// space if needed. `None` when the platform can't reserve space.
    fn reservable_area(
        &self,
        window: &WebviewWindow,
        bounds: Rect,
        work_area: Rect,
    ) -> tauri::Result<Option<Rect>>;

    /// Reserves `rect`, which lies at the bottom of `reservable_area`, so that other windows'
    /// work area excludes it, and returns the rectangle actually granted.
    fn reserve(&self, window: &WebviewWindow, rect: Rect) -> tauri::Result<Rect>;

    /// Gives any reserved space back. Does nothing when nothing is reserved.
    fn release(&self, window: &WebviewWindow) -> tauri::Result<()>;

    /// Tells the web view whether it can be seen. Hiding the window alone leaves the page visible
    /// to itself, so it would keep rendering (ADR 0009 §7).
    fn set_webview_visible(&self, window: &WebviewWindow, visible: bool) -> tauri::Result<()>;

    /// The OS name and build, for the diagnostics log (ADR 0009 §14).
    fn os_version(&self) -> String;

    /// Opens `path` in the file manager (ADR 0009 §15).
    fn open_folder(&self, path: &Path) -> std::io::Result<()>;
}

/// The platform this build runs on.
pub fn current() -> Box<dyn Platform> {
    #[cfg(windows)]
    return Box::new(windows::Windows::default());
    #[cfg(not(windows))]
    return Box::new(Unsupported);
}

/// Lets the app compile elsewhere; v1 targets Windows only (roadmap risk R3).
#[cfg(not(windows))]
struct Unsupported;

#[cfg(not(windows))]
impl Platform for Unsupported {
    fn prepare_strip(&self, _window: &WebviewWindow) -> tauri::Result<()> {
        Ok(())
    }

    fn set_normal_window(&self, _window: &WebviewWindow, _normal: bool) -> tauri::Result<()> {
        Ok(())
    }

    fn set_window_animations(&self, _window: &WebviewWindow, _on: bool) -> tauri::Result<()> {
        Ok(())
    }

    fn set_cloaked(&self, _window: &WebviewWindow, _cloaked: bool) -> tauri::Result<()> {
        Ok(())
    }

    fn watch_displays(
        &self,
        _window: &WebviewWindow,
        _on_event: Box<dyn Fn(DisplayEvent) + 'static>,
    ) -> tauri::Result<()> {
        Ok(())
    }

    fn reservable_area(
        &self,
        _window: &WebviewWindow,
        _bounds: Rect,
        _work_area: Rect,
    ) -> tauri::Result<Option<Rect>> {
        Ok(None)
    }

    fn reserve(&self, _window: &WebviewWindow, rect: Rect) -> tauri::Result<Rect> {
        Ok(rect)
    }

    fn release(&self, _window: &WebviewWindow) -> tauri::Result<()> {
        Ok(())
    }

    fn set_webview_visible(&self, _window: &WebviewWindow, _visible: bool) -> tauri::Result<()> {
        Ok(())
    }

    fn os_version(&self) -> String {
        std::env::consts::OS.to_string()
    }

    fn open_folder(&self, _path: &Path) -> std::io::Result<()> {
        Err(std::io::ErrorKind::Unsupported.into())
    }
}

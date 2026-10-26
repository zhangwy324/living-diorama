//! OS-specific window behavior behind one trait (ADR 0008 §1). Everything else in the shell is
//! written against Tauri's cross-platform API and this trait, so another OS adds an implementation
//! here and nothing else changes.

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
}

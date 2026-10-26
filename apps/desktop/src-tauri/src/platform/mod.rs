//! OS-specific window behavior behind one trait (ADR 0008 §1). Everything else in the shell is
//! written against Tauri's cross-platform API and this trait, so another OS adds an implementation
//! here and nothing else changes.

use tauri::WebviewWindow;

#[cfg(windows)]
mod windows;

pub trait Platform {
    /// Applies the strip's OS window style before it is first shown: no taskbar button and no
    /// task-switcher entry. Focus policy itself is Tauri's `focusable: false`.
    fn prepare_strip(&self, window: &WebviewWindow) -> tauri::Result<()>;

    /// Calls `on_change` on the main thread, outside any window message handling, after displays,
    /// scale factors or work areas changed. Bursts of changes may be coalesced into one call.
    fn watch_displays(
        &self,
        window: &WebviewWindow,
        on_change: Box<dyn Fn() + 'static>,
    ) -> tauri::Result<()>;
}

/// The platform this build runs on.
pub fn current() -> Box<dyn Platform> {
    #[cfg(windows)]
    return Box::new(windows::Windows);
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
        _on_change: Box<dyn Fn() + 'static>,
    ) -> tauri::Result<()> {
        Ok(())
    }
}

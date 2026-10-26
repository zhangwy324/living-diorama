//! Windows implementation. Both hooks are window subclasses on the strip's top-level window:
//! Tauri's own window procedure still runs for every message, the subclasses only look first.

use std::cell::Cell;

use tauri::WebviewWindow;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    GWL_EXSTYLE, GetWindowLongPtrW, PostMessageW, SPI_SETWORKAREA, STYLESTRUCT, SetWindowLongPtrW,
    WM_APP, WM_DISPLAYCHANGE, WM_DPICHANGED, WM_NCDESTROY, WM_SETTINGCHANGE, WM_STYLECHANGING,
    WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
};

use super::Platform;

pub struct Windows;

const STRIP_STYLE_SUBCLASS: usize = 1;
const DISPLAY_SUBCLASS: usize = 2;
/// Posted to ourselves so `on_change` runs from the message loop, not inside the handling of
/// the message that triggered it (Tauri runs window calls synchronously on the main thread).
const WM_DISPLAYS_CHANGED: u32 = WM_APP + 1;

impl Platform for Windows {
    fn prepare_strip(&self, window: &WebviewWindow) -> tauri::Result<()> {
        let hwnd = hwnd(window)?;
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, strip_ex_style(style) as isize);
            // Tauri rewrites the extended style when some window flags change; keep ours.
            subclass(hwnd, Some(strip_style_proc), STRIP_STYLE_SUBCLASS, 0)
        }
    }

    fn watch_displays(
        &self,
        window: &WebviewWindow,
        on_change: Box<dyn Fn() + 'static>,
    ) -> tauri::Result<()> {
        let hwnd = hwnd(window)?;
        let watcher = Box::into_raw(Box::new(DisplayWatcher {
            on_change,
            pending: Cell::new(false),
        }));
        let result =
            unsafe { subclass(hwnd, Some(display_proc), DISPLAY_SUBCLASS, watcher as usize) };
        if result.is_err() {
            drop(unsafe { Box::from_raw(watcher) });
        }
        result
    }
}

/// A tool window has no taskbar button and no Alt+Tab entry; `WS_EX_APPWINDOW` would force both.
fn strip_ex_style(style: u32) -> u32 {
    (style | WS_EX_TOOLWINDOW.0) & !WS_EX_APPWINDOW.0
}

struct DisplayWatcher {
    on_change: Box<dyn Fn()>,
    pending: Cell<bool>,
}

fn hwnd(window: &WebviewWindow) -> tauri::Result<HWND> {
    Ok(HWND(window.hwnd()?.0))
}

unsafe fn subclass(
    hwnd: HWND,
    proc: windows::Win32::UI::Shell::SUBCLASSPROC,
    id: usize,
    data: usize,
) -> tauri::Result<()> {
    if unsafe { SetWindowSubclass(hwnd, proc, id, data) }.as_bool() {
        Ok(())
    } else {
        Err(tauri::Error::Io(std::io::Error::last_os_error()))
    }
}

unsafe extern "system" fn strip_style_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    id: usize,
    _data: usize,
) -> LRESULT {
    match msg {
        WM_STYLECHANGING if wparam.0 as i32 == GWL_EXSTYLE.0 => {
            let change = unsafe { &mut *(lparam.0 as *mut STYLESTRUCT) };
            change.styleNew = strip_ex_style(change.styleNew);
        }
        WM_NCDESTROY => unsafe {
            let _ = RemoveWindowSubclass(hwnd, Some(strip_style_proc), id);
        },
        _ => {}
    }
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

unsafe extern "system" fn display_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    id: usize,
    data: usize,
) -> LRESULT {
    let watcher = unsafe { &*(data as *const DisplayWatcher) };
    match msg {
        WM_DISPLAYCHANGE | WM_DPICHANGED => request(hwnd, watcher),
        WM_SETTINGCHANGE if wparam.0 as u32 == SPI_SETWORKAREA.0 => request(hwnd, watcher),
        WM_DISPLAYS_CHANGED => {
            watcher.pending.set(false);
            (watcher.on_change)();
            return LRESULT(0);
        }
        WM_NCDESTROY => unsafe {
            let _ = RemoveWindowSubclass(hwnd, Some(display_proc), id);
            let result = DefSubclassProc(hwnd, msg, wparam, lparam);
            drop(Box::from_raw(data as *mut DisplayWatcher));
            return result;
        },
        _ => {}
    }
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

/// Posts one `WM_DISPLAYS_CHANGED` per burst: a display change usually brings several messages.
fn request(hwnd: HWND, watcher: &DisplayWatcher) {
    if !watcher.pending.replace(true)
        && unsafe { PostMessageW(Some(hwnd), WM_DISPLAYS_CHANGED, WPARAM(0), LPARAM(0)) }.is_err()
    {
        watcher.pending.set(false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_style_is_a_tool_window_without_app_window() {
        let style = strip_ex_style(WS_EX_APPWINDOW.0 | 0x0800_0000);
        assert_eq!(style, WS_EX_TOOLWINDOW.0 | 0x0800_0000);
    }
}

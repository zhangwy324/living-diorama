//! Windows implementation. Both hooks are window subclasses on the strip's top-level window:
//! Tauri's own window procedure still runs for every message, the subclasses only look first.
//! Reserving space registers the strip as an AppBar (`SHAppBarMessage`), the mechanism the taskbar
//! itself uses, so the shell shrinks other windows' work area.

use std::cell::Cell;
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;

use tauri::WebviewWindow;
use windows::Wdk::System::SystemServices::RtlGetVersion;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
use windows::Win32::System::SystemInformation::OSVERSIONINFOW;
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::Shell::{
    ABE_BOTTOM, ABM_ACTIVATE, ABM_GETAUTOHIDEBAREX, ABM_NEW, ABM_QUERYPOS, ABM_REMOVE, ABM_SETPOS,
    ABM_WINDOWPOSCHANGED, ABN_FULLSCREENAPP, ABN_POSCHANGED, APPBARDATA, DefSubclassProc,
    RemoveWindowSubclass, SHAppBarMessage, SetWindowSubclass,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GWL_EXSTYLE, GetForegroundWindow, GetWindowLongPtrW, GetWindowThreadProcessId,
    IsIconic, IsWindow, IsWindowVisible, PostMessageW, SPI_SETWORKAREA, STYLESTRUCT,
    SetForegroundWindow, SetWindowLongPtrW, WA_INACTIVE, WM_ACTIVATE, WM_APP, WM_DISPLAYCHANGE,
    WM_DPICHANGED, WM_NCDESTROY, WM_SETTINGCHANGE, WM_STYLECHANGING, WM_WINDOWPOSCHANGED,
    WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

use super::{DisplayEvent, Platform};
use crate::placement::Rect;

#[derive(Default)]
pub struct Windows {
    appbar: Mutex<AppBar>,
}

/// The strip's AppBar registration. Every call runs on the main thread; the lock only makes the
/// platform shareable as app state.
#[derive(Default)]
struct AppBar {
    registered: bool,
    /// The last rectangle passed to `ABM_SETPOS`. Setting the same one again is skipped, so the
    /// work-area change our own reservation causes doesn't start another round.
    reserved: Option<Rect>,
}

const STRIP_STYLE_SUBCLASS: usize = 1;
const DISPLAY_SUBCLASS: usize = 2;
/// Posted to ourselves so `on_event` runs from the message loop, not inside the handling of
/// the message that triggered it (Tauri runs window calls synchronously on the main thread).
const WM_DISPLAYS_CHANGED: u32 = WM_APP + 1;
/// The shell's AppBar notifications (`ABN_*` in `wParam`).
const WM_APPBAR: u32 = WM_APP + 2;
/// Posted to ourselves for `ABN_FULLSCREENAPP`, for the same reason; `wParam` is the new state.
const WM_FULL_SCREEN: u32 = WM_APP + 3;
/// Posted to ourselves when the strip is activated, to hand activation on once that is done;
/// `lParam` is the window that lost it.
const WM_HAND_BACK: u32 = WM_APP + 4;
/// Physical pixels left uncovered at the bottom when an auto-hide taskbar shares the strip's edge,
/// so the pointer can still reach the hidden taskbar's sliver and reveal it.
const AUTO_HIDE_MARGIN: i32 = 2;

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
        on_event: Box<dyn Fn(DisplayEvent) + 'static>,
    ) -> tauri::Result<()> {
        let hwnd = hwnd(window)?;
        let watcher = Box::into_raw(Box::new(DisplayWatcher {
            on_event,
            pending: Cell::new(false),
        }));
        let result =
            unsafe { subclass(hwnd, Some(display_proc), DISPLAY_SUBCLASS, watcher as usize) };
        if result.is_err() {
            drop(unsafe { Box::from_raw(watcher) });
        }
        result
    }

    fn reservable_area(
        &self,
        window: &WebviewWindow,
        bounds: Rect,
        work_area: Rect,
    ) -> tauri::Result<Option<Rect>> {
        let hwnd = hwnd(window)?;
        let mut appbar = self.appbar.lock().unwrap();
        if !appbar.registered {
            let mut data = appbar_data(hwnd);
            data.uCallbackMessage = WM_APPBAR;
            if unsafe { SHAppBarMessage(ABM_NEW, &mut data) } == 0 {
                return Err(tauri::Error::Io(std::io::Error::other(
                    "the shell refused to register the strip as an AppBar",
                )));
            }
            *appbar = AppBar {
                registered: true,
                reserved: None,
            };
        }
        // The shell trims the query to leave room for the taskbar and other AppBars, but not for
        // this one. Left and right come from the work area, which our reservation never narrows.
        let mut data = appbar_data(hwnd);
        data.rc = to_win_rect(Rect {
            x: work_area.x,
            y: bounds.y,
            width: work_area.width,
            height: bounds.height,
        });
        unsafe { SHAppBarMessage(ABM_QUERYPOS, &mut data) };
        let mut auto_hide = appbar_data(HWND::default());
        auto_hide.rc = to_win_rect(bounds);
        if unsafe { SHAppBarMessage(ABM_GETAUTOHIDEBAREX, &mut auto_hide) } != 0 {
            data.rc.bottom = data.rc.bottom.min(auto_hide.rc.bottom - AUTO_HIDE_MARGIN);
        }
        Ok(from_win_rect(data.rc))
    }

    fn reserve(&self, window: &WebviewWindow, rect: Rect) -> tauri::Result<Rect> {
        let hwnd = hwnd(window)?;
        let mut appbar = self.appbar.lock().unwrap();
        if !appbar.registered || appbar.reserved == Some(rect) {
            return Ok(rect);
        }
        let mut data = appbar_data(hwnd);
        data.rc = to_win_rect(rect);
        unsafe { SHAppBarMessage(ABM_SETPOS, &mut data) };
        appbar.reserved = Some(rect);
        Ok(from_win_rect(data.rc).unwrap_or(rect))
    }

    fn release(&self, window: &WebviewWindow) -> tauri::Result<()> {
        let mut appbar = self.appbar.lock().unwrap();
        if appbar.registered {
            remove_appbar(hwnd(window)?);
            *appbar = AppBar::default();
        }
        Ok(())
    }

    /// WebView2's `IsVisible`: while false the page is hidden (`document.hidden`), so the renderer
    /// stops, and Chromium throttles it. The closure runs later on the main thread.
    fn set_webview_visible(&self, window: &WebviewWindow, visible: bool) -> tauri::Result<()> {
        window.with_webview(move |webview| {
            if let Err(error) = unsafe { webview.controller().SetIsVisible(visible) } {
                log::warn!("Could not change the web view's visibility: {error}");
            }
        })
    }

    fn os_version(&self) -> String {
        // `GetVersionEx` reports the version the app's manifest claims to support, so ask ntdll.
        let mut info = OSVERSIONINFOW {
            dwOSVersionInfoSize: size_of::<OSVERSIONINFOW>() as u32,
            ..Default::default()
        };
        if unsafe { RtlGetVersion(&mut info) }.is_err() {
            return "Windows (unknown version)".to_string();
        }
        format!(
            "Windows {}.{}.{}",
            info.dwMajorVersion, info.dwMinorVersion, info.dwBuildNumber
        )
    }

    fn open_folder(&self, path: &Path) -> std::io::Result<()> {
        Command::new("explorer").arg(path).spawn().map(drop)
    }
}

/// A tool window has no taskbar button and no Alt+Tab entry; `WS_EX_APPWINDOW` would force both.
fn strip_ex_style(style: u32) -> u32 {
    (style | WS_EX_TOOLWINDOW.0) & !WS_EX_APPWINDOW.0
}

/// An `APPBARDATA` for the strip's window on the bottom edge.
fn appbar_data(hwnd: HWND) -> APPBARDATA {
    APPBARDATA {
        cbSize: size_of::<APPBARDATA>() as u32,
        hWnd: hwnd,
        uEdge: ABE_BOTTOM,
        ..Default::default()
    }
}

/// Unregisters the window as an AppBar; harmless when it isn't one.
fn remove_appbar(hwnd: HWND) {
    unsafe { SHAppBarMessage(ABM_REMOVE, &mut appbar_data(hwnd)) };
}

fn to_win_rect(rect: Rect) -> RECT {
    RECT {
        left: rect.x,
        top: rect.y,
        right: rect.x + rect.width as i32,
        bottom: rect.y + rect.height as i32,
    }
}

/// `None` for an empty or inverted rectangle.
fn from_win_rect(rect: RECT) -> Option<Rect> {
    (rect.right > rect.left && rect.bottom > rect.top).then(|| Rect {
        x: rect.left,
        y: rect.top,
        width: (rect.right - rect.left) as u32,
        height: (rect.bottom - rect.top) as u32,
    })
}

struct DisplayWatcher {
    on_event: Box<dyn Fn(DisplayEvent)>,
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
        // `WS_EX_NOACTIVATE` keeps clicks from activating the strip over other apps, but not over
        // the Studio: its webview, in the same input queue, activates the strip when clicked. The
        // strip never stays active: it hands activation back (ADR 0015 §1).
        WM_ACTIVATE if wparam.0 & 0xFFFF != WA_INACTIVE as usize => unsafe {
            let _ = PostMessageW(Some(hwnd), WM_HAND_BACK, WPARAM(0), lparam);
        },
        WM_HAND_BACK => {
            unsafe { hand_back(hwnd, HWND(lparam.0 as _)) };
            return LRESULT(0);
        }
        WM_NCDESTROY => unsafe {
            let _ = RemoveWindowSubclass(hwnd, Some(strip_style_proc), id);
        },
        _ => {}
    }
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

/// Activates the window the strip took activation from, or, if that is gone (the Studio just
/// closed), the topmost window that could have been active instead. Does nothing if the strip is
/// no longer the foreground window.
unsafe fn hand_back(strip: HWND, previous: HWND) {
    unsafe {
        if GetForegroundWindow() != strip {
            return;
        }
        let target = if !previous.is_invalid() && IsWindow(Some(previous)).as_bool() {
            Some(previous)
        } else {
            topmost_activatable()
        };
        if let Some(target) = target {
            let _ = SetForegroundWindow(target);
        }
    }
}

/// What decides whether a window can take activation from the strip.
struct Candidate {
    own_process: bool,
    visible: bool,
    minimized: bool,
    cloaked: bool,
    ex_style: u32,
}

/// A window of another app the user could have been using: shown, not minimized, not on another
/// virtual desktop, not a tool window and not one that refuses activation.
fn can_take_activation(window: &Candidate) -> bool {
    !window.own_process
        && window.visible
        && !window.minimized
        && !window.cloaked
        && window.ex_style & (WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0) == 0
}

/// The first window, in z-order from the top, that can take activation.
fn topmost_activatable() -> Option<HWND> {
    unsafe extern "system" fn visit(hwnd: HWND, found: LPARAM) -> windows::core::BOOL {
        let mut pid = 0;
        let mut cloaked = 0u32;
        let candidate = unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let _ = DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                (&raw mut cloaked).cast(),
                size_of::<u32>() as u32,
            );
            Candidate {
                own_process: pid == GetCurrentProcessId(),
                visible: IsWindowVisible(hwnd).as_bool(),
                minimized: IsIconic(hwnd).as_bool(),
                cloaked: cloaked != 0,
                ex_style: GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32,
            }
        };
        if can_take_activation(&candidate) {
            unsafe { *(found.0 as *mut Option<HWND>) = Some(hwnd) };
            return false.into();
        }
        true.into()
    }
    let mut found: Option<HWND> = None;
    // Stopping early reports an error; `found` says whether a window was found.
    let _ = unsafe { EnumWindows(Some(visit), LPARAM((&raw mut found) as isize)) };
    found
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
            (watcher.on_event)(DisplayEvent::Changed);
            return LRESULT(0);
        }
        WM_APPBAR => {
            match wparam.0 as u32 {
                // Another AppBar or the taskbar moved; ours may have to as well.
                ABN_POSCHANGED => request(hwnd, watcher),
                ABN_FULLSCREENAPP => unsafe {
                    let opened = WPARAM(usize::from(lparam.0 != 0));
                    let _ = PostMessageW(Some(hwnd), WM_FULL_SCREEN, opened, LPARAM(0));
                },
                _ => {}
            }
            return LRESULT(0);
        }
        WM_FULL_SCREEN => {
            (watcher.on_event)(DisplayEvent::FullScreen(wparam.0 != 0));
            return LRESULT(0);
        }
        // The shell asks AppBars to forward these; it ignores windows that aren't registered.
        WM_ACTIVATE => unsafe {
            SHAppBarMessage(ABM_ACTIVATE, &mut appbar_data(hwnd));
        },
        WM_WINDOWPOSCHANGED => unsafe {
            SHAppBarMessage(ABM_WINDOWPOSCHANGED, &mut appbar_data(hwnd));
        },
        WM_NCDESTROY => unsafe {
            // Whatever the exit path, the reservation goes with the window.
            remove_appbar(hwnd);
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

    #[test]
    fn hands_activation_only_to_other_apps_ordinary_windows() {
        let window = || Candidate {
            own_process: false,
            visible: true,
            minimized: false,
            cloaked: false,
            ex_style: 0,
        };
        assert!(can_take_activation(&window()));
        for other in [
            Candidate {
                own_process: true,
                ..window()
            },
            Candidate {
                visible: false,
                ..window()
            },
            Candidate {
                minimized: true,
                ..window()
            },
            Candidate {
                cloaked: true,
                ..window()
            },
            Candidate {
                ex_style: WS_EX_TOOLWINDOW.0,
                ..window()
            },
            Candidate {
                ex_style: WS_EX_NOACTIVATE.0,
                ..window()
            },
        ] {
            assert!(!can_take_activation(&other));
        }
    }

    #[test]
    fn converts_rectangles_both_ways() {
        let rect = Rect {
            x: -1920,
            y: 812,
            width: 1920,
            height: 220,
        };
        assert_eq!(from_win_rect(to_win_rect(rect)), Some(rect));
        let empty = RECT {
            left: 0,
            top: 10,
            right: 100,
            bottom: 10,
        };
        assert_eq!(from_win_rect(empty), None);
    }
}

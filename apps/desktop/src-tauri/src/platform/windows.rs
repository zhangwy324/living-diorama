//! Windows implementation. The hooks are window subclasses: Tauri's own window procedure still
//! runs for every message, the subclasses only look first. Two are on the strip's top-level window,
//! the session-end one on tao's hidden event-loop window. Reserving space registers the strip as an
//! AppBar (`SHAppBarMessage`), the mechanism the taskbar itself uses, so the shell shrinks other
//! windows' work area.

use std::cell::Cell;
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::WebviewWindow;
use windows::Wdk::System::SystemServices::RtlGetVersion;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{
    DWMWA_CLOAK, DWMWA_CLOAKED, DWMWA_TRANSITIONS_FORCEDISABLED, DwmGetWindowAttribute,
    DwmSetWindowAttribute,
};
use windows::Win32::System::Shutdown::{ShutdownBlockReasonCreate, ShutdownBlockReasonDestroy};
use windows::Win32::System::SystemInformation::OSVERSIONINFOW;
use windows::Win32::System::Threading::{GetCurrentProcessId, GetCurrentThreadId};
use windows::Win32::UI::Shell::{
    ABE_BOTTOM, ABM_ACTIVATE, ABM_GETAUTOHIDEBAREX, ABM_NEW, ABM_QUERYPOS, ABM_REMOVE, ABM_SETPOS,
    ABM_WINDOWPOSCHANGED, ABN_FULLSCREENAPP, ABN_POSCHANGED, APPBARDATA, DefSubclassProc,
    RemoveWindowSubclass, SHAppBarMessage, SetWindowSubclass,
};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, EnumThreadWindows, EnumWindows, GWL_EXSTYLE, GetClassNameW,
    GetForegroundWindow, GetWindowLongPtrW, GetWindowThreadProcessId, IsIconic, IsWindow,
    IsWindowVisible, MSG, MWMO_INPUTAVAILABLE, MsgWaitForMultipleObjectsEx, PM_REMOVE,
    PeekMessageW, PostMessageW, PostQuitMessage, QS_ALLINPUT, ReplyMessage, SPI_SETWORKAREA,
    STYLESTRUCT, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
    SetForegroundWindow, SetWindowLongPtrW, SetWindowPos, TranslateMessage, WA_INACTIVE,
    WM_ACTIVATE, WM_APP, WM_DISPLAYCHANGE, WM_DPICHANGED, WM_ENDSESSION, WM_NCDESTROY,
    WM_QUERYENDSESSION, WM_QUIT, WM_SETTINGCHANGE, WM_STYLECHANGING, WM_WINDOWPOSCHANGED,
    WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};
use windows::core::w;

use super::{DisplayEvent, Platform, SessionEvent};
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

/// Whether the window has the normal shape, so the strip's style subclass stands aside. There is
/// one strip window, and the subclass procedure is a plain function, so the flag is global.
static NORMAL_SHAPE: AtomicBool = AtomicBool::new(false);

const STRIP_STYLE_SUBCLASS: usize = 1;
const DISPLAY_SUBCLASS: usize = 2;
/// On tao's event-loop window, not the strip, but kept apart from the strip's IDs all the same.
const SESSION_END_SUBCLASS: usize = 3;
/// The class of the hidden window tao's event loop runs on. It is the window that exits the
/// process on `WM_ENDSESSION` (tao 0.37), so the session end is held back there. Re-check both on
/// every tao upgrade (see development.md): a renamed class only logs a warning at startup, and a tao
/// that handles the session end itself makes this hook unnecessary.
const TAO_EVENT_TARGET_CLASS: &str = "Tao Thread Event Target";
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

    /// Tauri has no call for `WS_EX_TOOLWINDOW` (ADR 0016 §8), so it is set here, with
    /// `SWP_FRAMECHANGED` for the frame to follow.
    fn set_normal_window(&self, window: &WebviewWindow, normal: bool) -> tauri::Result<()> {
        let hwnd = hwnd(window)?;
        unsafe {
            // Before the style changes, so the strip's subclass lets the change through.
            NORMAL_SHAPE.store(normal, Ordering::SeqCst);
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            let style = if normal {
                normal_ex_style(style)
            } else {
                strip_ex_style(style)
            };
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style as isize);
            SetWindowPos(
                hwnd,
                None,
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            )
            .map_err(|error| tauri::Error::Io(error.into()))?;
            if !normal {
                // The normal window was active; the strip never stays so.
                hand_back(hwnd, HWND::default());
            }
        }
        Ok(())
    }

    fn set_window_animations(&self, window: &WebviewWindow, on: bool) -> tauri::Result<()> {
        set_dwm_flag(window, DWMWA_TRANSITIONS_FORCEDISABLED, !on)
    }

    fn set_cloaked(&self, window: &WebviewWindow, cloaked: bool) -> tauri::Result<()> {
        set_dwm_flag(window, DWMWA_CLOAK, cloaked)
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

    fn watch_session_end(
        &self,
        window: &WebviewWindow,
        timeout: Duration,
        on_event: Box<dyn Fn(SessionEvent) + 'static>,
        finished: Box<dyn Fn() -> bool + 'static>,
    ) -> tauri::Result<()> {
        let strip = hwnd(window)?;
        let target = event_target_window().ok_or_else(|| {
            tauri::Error::Io(std::io::Error::other(format!(
                "no {TAO_EVENT_TARGET_CLASS:?} window on the main thread"
            )))
        })?;
        let watcher = Box::into_raw(Box::new(SessionWatcher {
            strip,
            timeout,
            on_event,
            finished,
            started: Cell::new(None),
            waiting: Cell::new(false),
        }));
        let result = unsafe {
            subclass(
                target,
                Some(session_end_proc),
                SESSION_END_SUBCLASS,
                watcher as usize,
            )
        };
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

/// Sets a window attribute that DWM takes as a `BOOL`.
fn set_dwm_flag(
    window: &WebviewWindow,
    attribute: windows::Win32::Graphics::Dwm::DWMWINDOWATTRIBUTE,
    value: bool,
) -> tauri::Result<()> {
    let value = windows::core::BOOL::from(value);
    unsafe {
        DwmSetWindowAttribute(
            hwnd(window)?,
            attribute,
            (&raw const value).cast(),
            size_of::<windows::core::BOOL>() as u32,
        )
    }
    .map_err(|error| tauri::Error::Io(error.into()))
}

/// A tool window has no taskbar button and no Alt+Tab entry; `WS_EX_APPWINDOW` would force both.
fn strip_ex_style(style: u32) -> u32 {
    (style | WS_EX_TOOLWINDOW.0) & !WS_EX_APPWINDOW.0
}

/// The normal window has both.
fn normal_ex_style(style: u32) -> u32 {
    (style | WS_EX_APPWINDOW.0) & !WS_EX_TOOLWINDOW.0
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
    // The normal window keeps its own style and may stay active (ADR 0016 §8).
    if NORMAL_SHAPE.load(Ordering::SeqCst) && msg != WM_NCDESTROY {
        return unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
    }
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

/// The session-end hook's state, in its window procedure's data on the main thread.
struct SessionWatcher {
    /// The strip: the window Windows names when it shows why the session end waits.
    strip: HWND,
    timeout: Duration,
    on_event: Box<dyn Fn(SessionEvent)>,
    finished: Box<dyn Fn() -> bool>,
    /// When the session started to end, while it is ending.
    started: Cell<Option<Instant>>,
    /// Set while `WM_ENDSESSION` waits. The wait runs the thread's messages, so the window
    /// procedure is entered again meanwhile.
    waiting: Cell<bool>,
}

impl SessionWatcher {
    /// Reports `Ending`, the first time only.
    fn begin(&self) {
        if self.started.get().is_some() {
            return;
        }
        // Before reporting, so a session-end message arriving while `on_event` runs sees it.
        self.started.set(Some(Instant::now()));
        if let Err(error) = unsafe { ShutdownBlockReasonCreate(self.strip, w!("Saving the world")) }
        {
            log::warn!("Could not tell Windows why the session end waits: {error}");
        }
        log::info!("The Windows session is ending; saving the world");
        (self.on_event)(SessionEvent::Ending);
    }

    /// Forgets the session end, if one started.
    fn end(&self) {
        if self.started.take().is_some() {
            let _ = unsafe { ShutdownBlockReasonDestroy(self.strip) };
        }
    }
}

/// What the session-end hook does with a message.
#[derive(Debug, PartialEq, Eq)]
enum SessionStep {
    /// `WM_QUERYENDSESSION`: agree at once, then start the save.
    Begin,
    /// `WM_ENDSESSION`, ending: wait for the save, at most until the timeout, then let tao exit.
    Wait,
    /// `WM_ENDSESSION` again during that wait, ending or cancelled: answered here, so neither tao's
    /// exit nor the shell's `app.exit` on cancel runs inside the wait.
    Swallow,
    /// `WM_ENDSESSION`, cancelled, after the session started to end.
    Cancel,
    /// Everything else goes on to tao.
    Pass,
}

fn session_step(msg: u32, ending: bool, started: bool, waiting: bool) -> SessionStep {
    match msg {
        WM_QUERYENDSESSION => SessionStep::Begin,
        WM_ENDSESSION if waiting => SessionStep::Swallow,
        WM_ENDSESSION if ending => SessionStep::Wait,
        WM_ENDSESSION if started => SessionStep::Cancel,
        _ => SessionStep::Pass,
    }
}

/// On tao's event-loop window. Windows asks with `WM_QUERYENDSESSION`, then ends the session with
/// `WM_ENDSESSION`, after which tao exits the process at once. Answering the query first lets the
/// save start outside Windows' sent message; the end then waits for it, running the thread's
/// messages as a modal loop does, so the web view and Tauri's commands keep working.
unsafe extern "system" fn session_end_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    id: usize,
    data: usize,
) -> LRESULT {
    if msg == WM_NCDESTROY {
        unsafe {
            let _ = RemoveWindowSubclass(hwnd, Some(session_end_proc), id);
            let result = DefSubclassProc(hwnd, msg, wparam, lparam);
            drop(Box::from_raw(data as *mut SessionWatcher));
            return result;
        }
    }
    let watcher = unsafe { &*(data as *const SessionWatcher) };
    let step = session_step(
        msg,
        wparam.0 != 0,
        watcher.started.get().is_some(),
        watcher.waiting.get(),
    );
    match step {
        SessionStep::Begin => {
            let _ = unsafe { ReplyMessage(LRESULT(1)) };
            watcher.begin();
            return LRESULT(1);
        }
        SessionStep::Wait => {
            // Without a query first, as with a forced sign-out, the end is the first word.
            watcher.begin();
            watcher.waiting.set(true);
            let started = watcher.started.get().unwrap_or_else(Instant::now);
            if !pump_until(started + watcher.timeout, &*watcher.finished) {
                log::warn!("The world was not saved in time; letting the session end");
            }
            watcher.waiting.set(false);
            watcher.end();
            // tao exits the process now.
        }
        SessionStep::Swallow => return LRESULT(0),
        SessionStep::Cancel => {
            watcher.end();
            log::info!("The Windows session end was cancelled");
            (watcher.on_event)(SessionEvent::Cancelled);
        }
        SessionStep::Pass => {}
    }
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

/// Runs the thread's messages until `done` returns true or `deadline` passes; returns whether
/// `done` did. A `WM_QUIT` is put back for the outer loop and ends the wait.
///
/// Unlike tao's own loop, this skips tao's `msg_hook` (menu accelerators and the like) and its
/// check for a panic in an event handler. That is acceptable for a wait of at most a few seconds
/// right before the process exits.
fn pump_until(deadline: Instant, done: &dyn Fn() -> bool) -> bool {
    loop {
        if done() {
            return true;
        }
        let Some(left) = remaining(deadline, Instant::now()) else {
            return false;
        };
        unsafe {
            MsgWaitForMultipleObjectsEx(None, wait_millis(left), QS_ALLINPUT, MWMO_INPUTAVAILABLE)
        };
        let mut msg = MSG::default();
        while remaining(deadline, Instant::now()).is_some()
            && unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE) }.as_bool()
        {
            if msg.message == WM_QUIT {
                unsafe { PostQuitMessage(msg.wParam.0 as i32) };
                return done();
            }
            unsafe {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            if done() {
                return true;
            }
        }
    }
}

/// The time left until `deadline`, or `None` once it has come.
fn remaining(deadline: Instant, now: Instant) -> Option<Duration> {
    deadline
        .checked_duration_since(now)
        .filter(|left| !left.is_zero())
}

/// A wait in whole milliseconds that doesn't end before `left` does, never 0 (a busy loop) nor
/// `INFINITE`.
fn wait_millis(left: Duration) -> u32 {
    left.as_nanos()
        .div_ceil(1_000_000)
        .clamp(1, u128::from(u32::MAX - 1)) as u32
}

/// tao's event-loop window on this thread, if there is one.
fn event_target_window() -> Option<HWND> {
    unsafe extern "system" fn visit(hwnd: HWND, found: LPARAM) -> windows::core::BOOL {
        let mut name = [0u16; 64];
        let length = unsafe { GetClassNameW(hwnd, &mut name) }.max(0) as usize;
        if is_event_target_class(&name[..length]) {
            unsafe { *(found.0 as *mut Option<HWND>) = Some(hwnd) };
            return false.into();
        }
        true.into()
    }
    let mut found: Option<HWND> = None;
    // Stopping early reports an error; `found` says whether the window was found.
    let _ = unsafe {
        EnumThreadWindows(
            GetCurrentThreadId(),
            Some(visit),
            LPARAM((&raw mut found) as isize),
        )
    };
    found
}

fn is_event_target_class(name: &[u16]) -> bool {
    String::from_utf16_lossy(name) == TAO_EVENT_TARGET_CLASS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_end_waits_once_and_cancels_only_what_started() {
        use SessionStep::*;
        assert_eq!(session_step(WM_QUERYENDSESSION, false, false, false), Begin);
        assert_eq!(session_step(WM_QUERYENDSESSION, false, true, true), Begin);
        assert_eq!(session_step(WM_ENDSESSION, true, true, false), Wait);
        // A forced end comes without a query.
        assert_eq!(session_step(WM_ENDSESSION, true, false, false), Wait);
        assert_eq!(session_step(WM_ENDSESSION, true, true, true), Swallow);
        assert_eq!(session_step(WM_ENDSESSION, false, true, true), Swallow);
        assert_eq!(session_step(WM_ENDSESSION, false, true, false), Cancel);
        assert_eq!(session_step(WM_ENDSESSION, false, false, false), Pass);
        assert_eq!(session_step(WM_ACTIVATE, true, true, false), Pass);
    }

    #[test]
    fn the_wait_ends_at_the_deadline() {
        let now = Instant::now();
        let deadline = now + Duration::from_millis(3000);
        assert_eq!(remaining(deadline, now), Some(Duration::from_millis(3000)));
        assert_eq!(remaining(deadline, deadline), None);
        assert_eq!(
            remaining(deadline, deadline + Duration::from_millis(1)),
            None
        );
    }

    #[test]
    fn waits_whole_milliseconds_rounded_up() {
        assert_eq!(wait_millis(Duration::from_nanos(1)), 1);
        assert_eq!(wait_millis(Duration::from_micros(1500)), 2);
        assert_eq!(wait_millis(Duration::from_secs(3)), 3000);
        assert_eq!(wait_millis(Duration::from_secs(u64::MAX)), u32::MAX - 1);
    }

    #[test]
    fn a_wait_that_never_finishes_stops_at_the_deadline() {
        let start = Instant::now();
        assert!(!pump_until(start + Duration::from_millis(50), &|| false));
        assert!(start.elapsed() >= Duration::from_millis(50));
        assert!(pump_until(start + Duration::from_secs(10), &|| true));
    }

    #[test]
    fn strip_style_is_a_tool_window_without_app_window() {
        let style = strip_ex_style(WS_EX_APPWINDOW.0 | 0x0800_0000);
        assert_eq!(style, WS_EX_TOOLWINDOW.0 | 0x0800_0000);
    }

    #[test]
    fn normal_style_is_an_app_window_and_switches_back() {
        let strip = WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0;
        let normal = normal_ex_style(strip);
        assert_eq!(normal, WS_EX_APPWINDOW.0 | WS_EX_NOACTIVATE.0);
        assert_eq!(strip_ex_style(normal), strip);
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

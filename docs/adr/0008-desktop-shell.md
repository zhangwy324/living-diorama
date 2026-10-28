# ADR 0008: Desktop shell

- **Status:** Accepted
- **Date:** 2026-10-25
- **Context:** Roadmap M5 (desktop shell, Windows). The app has so far run in a default Tauri window. M5 makes it a well-mannered companion strip: placed above the taskbar, never taking focus, controlled from a tray icon, with an expanded inspection mode, a small controls overlay, persisted window settings and a clean lifecycle. It ships as three PRs: **A** window placement, monitors, DPI and focus; **B** tray, always-on-top, settings and expanded mode; **C** the controls overlay, the `desktop-integration` frontend API and lifecycle. Decisions for all three are recorded here so the PRs share one design; each PR updates this ADR if it has to deviate.

## Decisions

### Where the OS code lives

1. **Rust owns the OS, `desktop-integration` is a thin TypeScript API.** Placement, monitor and display-change handling, the tray, focus policy and the settings file live in the Tauri app's Rust code, behind a `Platform` trait with one Windows implementation, so macOS and Linux add an implementation rather than touch callers (roadmap M5 task 8). Rust places the window before it is shown, so there is no flash at a default size, and it receives display-change messages the webview never sees.

   `@living-diorama/desktop-integration` is the only frontend code that imports `@tauri-apps/api`. It exposes an OS-neutral `DesktopShell` interface (commands such as `setExpanded`, `hide`, and events such as `quitRequested`) with two implementations: Tauri, and a no-op one for tests. The React app depends on the interface only. Running the frontend in a plain browser is not supported: it still loads there with the no-op shell, so the shell's controls do nothing, which is enough for using browser dev tools against `pnpm dev`.

### Window and placement (PR A)

2. **One window, two modes.** _Revised by [ADR 0016](0016-integration-and-v0.2-build.md) §1: still one window, but expanding also changes its style, to a normal window._ Compact and expanded are sizes of the same window, so there is one WebGL context and one simulation worker. Collapsing returns to the strip's placement.

3. **Strip placement.** Borderless, no taskbar button, spanning the full work-area width of its monitor, bottom edge on the work area's bottom edge (above the taskbar wherever it is). Height defaults to 220 px and is limited to 180–260 px in compact mode. These are logical pixels, so the strip is the same apparent size at every scale factor.

4. **Height resize** uses a thin handle along the top edge of the page. Dragging it calls the shell's `setStripHeight` with the height the pointer asks for, and Rust clamps it and places the window, so the bottom edge stays where it is. Native resizing is off. PR A tried Tauri's native top-edge resize first: it works on a non-activating window, but a drag past the maximum height moved the whole window up the screen, and the native frame's invisible shadow insets would have to be accounted for at every scale factor.

5. **Monitors.** The strip lives on one monitor: the primary by default. A monitor is remembered by its device name (e.g. `\\.\DISPLAY2`); if that monitor is gone at launch or disconnects, the strip moves to the primary. The choice is kept, so the strip goes back when that monitor returns. Device names can be renumbered by Windows after hardware changes; then the strip falls back to the primary and the user picks again. The window is re-placed on DPI change, display change (resolution, monitors added or removed) and work-area change (taskbar moved, resized or auto-hide toggled). On Windows a window subclass watches `WM_DPICHANGED`, `WM_DISPLAYCHANGE` and `WM_SETTINGCHANGE` with `SPI_SETWORKAREA`, and posts itself one message per burst, so placement runs from the message loop rather than inside the handling of those messages (Tauri runs window calls made on the main thread synchronously).

6. **Focus: the strip never activates.** The window is created non-focusable (Tauri's `focusable: false`, which sets `WS_EX_NOACTIVATE` on Windows) and shown without activation. Clicks, drags and the wheel reach the webview, so the camera works, but keyboard focus stays in the user's foreground app. Consequently the strip has no keyboard shortcuts; PR C's controls overlay replaces the M4 `D` key, which is removed. Expanded mode is non-focusable too. _Superseded by [ADR 0016](0016-integration-and-v0.2-build.md) §1: the expanded window is a normal, focusable window._ See _Experiment_ below.

   The window is also a tool window (`WS_EX_TOOLWINDOW`, without `WS_EX_APPWINDOW`), which keeps it out of the taskbar and Alt+Tab; Tauri's `skipTaskbar` only removes the taskbar tab (`ITaskbarList::DeleteTab`) and says nothing about Alt+Tab. A second subclass keeps that style if Tauri rewrites the extended style later.

### Tray, settings and expanded mode (PR B)

7. **Tray icon.** Left-click toggles show/hide. The menu: Show/Hide, Expand/Collapse, Pause/Resume, Always on top (checkbox), Reserve screen space (checkbox, §10), Monitor ▸ (one entry per monitor), Quit. Always-on-top defaults to off. Rust owns the paused flag, so the tray and the controls overlay agree, and tells the frontend with a `paused-changed` event, which `DesktopShell.onPausedChanged` forwards to the simulation worker. This event arrived in PR B, ahead of the rest of the event API in PR C, so the tray Pause works from the start. Quit goes through the clean shutdown (§14).

8. **Expanded mode** _Superseded by [ADR 0016](0016-integration-and-v0.2-build.md) §1–9._ It is about 70% of the work area in each dimension, centred on the strip's monitor. The camera keeps its state across the switch (roadmap §1.9 Q1). The resize handle is hidden while expanded, and Rust ignores height changes in that mode anyway. Expanded mode is not persisted: the app always starts as the strip.

9. **Settings file.** `settings.json` in the app config directory, read and written by Rust with serde (no store plugin). It holds the monitor name, compact height, always-on-top and (since §10) reserve-space, plus a `version` field. Writes go to a temporary file then rename, so a crash never leaves a torn file. A missing or unreadable file, or one with another `version`, means defaults, and an unreadable one is logged, not fatal. Monitor and always-on-top changes are saved at once; height changes once the height has been still for 500 ms, so a handle drag is one write. This is window settings only; worlds are not saved in v1 (roadmap §1.9 Q5).

10. **Screen-space reservation.** PR A–C shipped the strip as a plain window, so with always-on-top off a maximized window covered it, and with it on the strip covered the bottom of maximized windows. The strip now reserves its band the way the taskbar does, behind the `Platform` trait: on Windows it registers as an AppBar on the bottom edge (`SHAppBarMessage`), which shrinks the work area other windows see. A "Reserve screen space" tray checkbox, saved as `reserveSpace` and on by default, turns it off.
    - **Its own reservation doesn't count.** The strip's rectangle comes from `ABM_QUERYPOS` on the monitor, which leaves room for the taskbar and other AppBars but not for the strip itself, rather than from the work area, which already excludes the strip. Setting the same rectangle again is skipped, so the work-area change the strip causes settles after one re-place. While the height handle is dragged only the window moves; the reservation follows once the height has been still for 500 ms, like the settings save (§9), because every reservation change makes Windows resize all maximized windows, which flickers on every drag step. This matches the two-step `ABM_QUERYPOS`/`ABM_SETPOS` design, which expects an AppBar to commit its position after a drag, not during it.
    - **Visible only.** Hiding gives the space back and showing takes it again. _The rest of this bullet is superseded by [ADR 0016](0016-integration-and-v0.2-build.md) §3: expanding gives the band back._ Expanded mode keeps the compact band reserved, so other windows don't move when expanding or collapsing; the expanded window is centred in the work area above it.
    - **Re-placed** on everything in §5 plus `ABN_POSCHANGED` (the taskbar or another AppBar moved). With an auto-hide taskbar on the bottom edge the strip stops 2 physical pixels short of the monitor's bottom, so the pointer can still reveal the taskbar.
    - **Full-screen apps.** On `ABN_FULLSCREENAPP` always-on-top steps aside until the full-screen app closes. Full-screen apps ignore the work area, so the reservation itself needs nothing.
    - **Release.** `ABM_REMOVE` runs when the setting is turned off, on hide, on app exit and when the window is destroyed. A crash that skips all of these leaves the reservation to the shell's own clean-up of AppBars whose window is gone; see the manual checklist.

### Controls overlay and lifecycle (PR C)

11. **Controls overlay.** A small row of icon buttons in the top-right corner that fades in while the pointer is over the strip: pause/resume, expand/collapse, reset camera, debug overlays, hide. Icons are inline SVG; no icon library. Double-click-to-reset stays.

    Rust owns paused and expanded, so the overlay asks rather than toggles: `DesktopShell.setPaused` and `setExpanded` set the state in Rust, which answers with `paused-changed` or `expanded-changed`, and the overlay shows what those events say. A tray action and an overlay click can't disagree, since both end in the same event. The debug overlays are frontend-only state. The frontend assumes the shell starts unpaused and collapsed, which a reload of the webview during development can break until the next change.

12. **Hide is not pause.** Hiding (tray or overlay) keeps the simulation running and stops rendering, which the renderer already does while the page is hidden; the world stays alive in the background. Pause stops the simulation clock and leaves rendering on.

13. **Sleep and resume.** The simulation clock already drops time beyond 10 ticks of catch-up per advance (ADR 0006), so a long sleep costs at most one second of simulated time. The renderer treats a wait of over a second between snapshots as a break: it draws the next snapshot as it is instead of interpolating across the gap, and leaves the wait out of its estimate of the snapshot interval, which a long gap would otherwise push to its maximum and make creatures trail behind for a second or so. A pause is a break too (a hidden window is not: the worker keeps sending snapshots); resuming after a pause snaps by one tick's movement, too small to see. The real Windows sleep is in the manual checklist, since browsers may throttle or batch worker timers around it.

14. **Clean shutdown.** Quit from the tray goes through Rust, which saves the settings and emits `quit-requested`; the frontend sends `shutdown` to the worker, disposes the view and answers with the `quit_ready` command. Rust exits on that answer or after one second, whichever comes first. A second Quit while waiting is ignored.

### Testing

15. **What is automated and what is manual.** Placement maths (work area, scale factor and height to a window rectangle; monitor fallback; height clamping) and settings parsing are pure Rust functions with unit tests. `desktop-integration` and the overlay are tested against the no-op shell. The exit criteria (100%, 150% and 200% scaling; one and two monitors; sleep/resume; focus never stolen) are checked by hand against a checklist in `docs/development.md`, because they need real display configurations.

## Experiment: does a non-activating WebView2 window still take input?

Before committing to §6, a throwaway build (a local branch, not pushed) set `focusable: false` and `focus: false` on a borderless window and mirrored pointer, wheel, key and focus event counts into the window title. A PowerShell probe opened a small WinForms window and made it the foreground window, launched the app, then clicked, dragged, scrolled and pressed a key over the strip with synthetic input, reading the foreground window after each step.

| Step              | Non-focusable (`WS_EX_NOACTIVATE` set)           | Control (default, focusable)            |
| ----------------- | ------------------------------------------------ | --------------------------------------- |
| Launch            | Foreground stays in the other app                | Strip takes the foreground              |
| Click             | Webview gets `pointerdown`; foreground unchanged | Webview gets it; strip stays foreground |
| Drag (20 moves)   | All 20 `pointermove` with buttons held arrive    | Same                                    |
| Wheel (3 notches) | All 3 `wheel` events arrive                      | Same                                    |
| Key press         | Goes to the foreground app, not the strip        | Strip receives it                       |

So the camera works with no activation, and the control shows the probe does detect a stolen focus. Two side notes: the webview still fires a DOM `focus` event on the first click without the OS window activating, so DOM focus and blur are not a usable signal for "the strip is active"; and Tauri's `focusable: false` is enough, no raw Win32 style call is needed.

The same probe, run against PR A's release build on a two-monitor setup at 100%, found the strip at the full width of the primary's work area and 220 px tall, directly above the taskbar; foreground focus unchanged through launch, click, orbit and three handle drags; and the height clamped to 260 and 180 with the bottom edge fixed.

A third probe, against PR B's release build, drove the tray icon in the notification-area overflow. Dragging the handle wrote `settings.json` once, after the debounce; a left-click hid the strip; Expand gave 1792×974 centred on the 2560×1392 work area and 1344×722 on the 1920×1032 second monitor; Collapse restored the strip; Always on top set `WS_EX_TOPMOST` and saved it; Monitor ▸ Display 2 moved the strip and saved `\.DISPLAY2`, which a relaunch restored; Quit exited. The menu is owner-drawn, so UI Automation cannot see its items, and synthetic keyboard navigation of it dropped keys; Pause/Resume and long sequences of menu actions are left to the manual checklist. The probe did catch the menu reading "Show" at launch because it was refreshed before the window was shown.

Not covered by the probes: real (not synthetic) mouse and touchpad input, and other scale factors and display changes, which the manual checklist in `docs/development.md` covers.

## Consequences

- The strip has no keyboard input at all. Anything that needs typing (a later Creation Studio, search) belongs in a separate, normal window.
- `apps/desktop` gains Rust code for the first time. Its tests run with `pnpm test:rust`, in CI after the Windows build; `pnpm check` stays Rust-free so it remains fast.
- A boundary rule makes `desktop-integration` the only workspace package that imports `@tauri-apps/api`.
- The Tauri capability file grows to exactly the commands and events the shell uses.

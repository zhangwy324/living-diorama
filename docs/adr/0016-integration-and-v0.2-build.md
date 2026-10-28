# ADR 0016: Integration and the v0.2 build

- **Status:** Accepted
- **Date:** 2026-10-27
- **Context:** Roadmap M12 (integration and the v0.2 build). M11 gave the app a second window, the Creation Studio (ADR 0015). M12 reworks expanded mode (issue #30), polishes the sides of drawn bodies (issue #40), measures and soaks a release build with 20 creatures, and ships v0.2.0. The user settled the M12 decisions on 2026-10-27 (roadmap M12, "Settled with the user"), then settled the shape of expanded mode after the two experiments below and the details that shape left open (§2, §3, §5, §7). This ADR records the decisions for the code. It ships as six PRs, in the order of §18; each PR updates this ADR if it has to deviate.

## Decisions

### Expanded mode: one window that changes shape (PR 2)

1. **The strip's window becomes a normal window.** Expanded mode is still the one `main` window (ADR 0008 §2 stands: one window, one simulation worker, one WebGL context), but expanding now changes the window's style as well as its size. In the strip shape it is as ADR 0008 describes: borderless, non-focusable, no taskbar or Alt+Tab entry, its band reserved. In the normal shape it is framed, resizable, movable and focusable, with a taskbar and an Alt+Tab entry. This replaces ADR 0008 §8 (expanded mode) and the expanded bullet of §10. A separate expanded window was measured too and is the documented fallback (_Experiment 1_ below).

2. **Full screen and keys.** F11 or a button in the overlay toggles full screen in the normal shape. Esc leaves full screen; outside full screen it does nothing, and it never collapses the window. Home resets the camera. The normal shape takes focus, so unlike the strip it can have keyboard shortcuts, but it has only these three: F11, Esc and Home.

3. **No strip while expanded.** Switching to the normal shape gives the band back (ADR 0008 §10), so other windows grow; they shrink again when the strip returns. Closing the normal window (its frame's X, the overlay's Collapse button, or the tray) turns it back into the strip rather than quitting. Minimizing is an ordinary minimize: the window stays in its normal shape.
   - **The tray** (ADR 0008 §7) follows the shape. Expand/Collapse reads "Collapse" in the normal shape and turns the window back into the strip. Left-click and Show bring the normal window to the front, restoring it if it is minimized, rather than hiding it. Hide hides the window in whichever shape it has, and Show brings it back in that shape. Monitor ▸ chooses the strip's monitor only: the normal window stays where the user put it, and the strip comes back on the chosen monitor. Always on top applies to the strip only; the normal window is an ordinary one (settled with the user in PR 2).
   - **The error screen's Details** (ADR 0009 §3) keeps working as it did: it switches to the normal shape, which lists every diagnostic, now in a framed, focusable window the user can resize and close.

4. **No forwarding.** The world, the worker and the species library stay in the one page, as today. The Studio's window channel (ADR 0015 §5) is unchanged.

5. **Persistence.** The normal shape's size, position, monitor and whether it is maximized or full screen are saved in `settings.json` (ADR 0008 §9) and restored the next time the window expands, maximized or not. The app always launches as the strip. The first time it expands, with nothing saved, the window opens maximized on the strip's monitor; its restore size (what un-maximizing gives) is about 70% of that monitor's work area without the band, centred.
   - **Settled in PR 2.** The geometry is an optional `expanded` field, so the file stays at version 1: 0.1.0 ignores the field and 0.2 reads 0.1.0's files, and a malformed `expanded` is dropped alone. Physical pixels, the outer position and inner size of the restore rectangle, with the monitor's name and scale. Saved geometry that no longer fits (its monitor gone, its scale changed, larger than the monitor or its title bar off it) counts as a first open. It is saved on collapsing and on quitting while expanded. The normal window's smallest size is 480×270 logical pixels.

6. **Its own camera.** The normal shape has its own camera, separate from the strip's: it starts at the default view and keeps its position while the app runs, also across collapsing and expanding again. It is not saved across launches. The view keeps one camera state per shape and swaps them on each switch.

7. **The overlay in the normal shape** (ADR 0008 §11) has Pause/Resume, Reset camera, debug overlays, Full screen, Open Studio and Collapse. It has no Hide: minimizing does that. Open Studio opens or focuses the Studio as the strip's pencil button does (ADR 0015 §1); editing the world in place comes in a later release.

### Known pitfalls for the build (PR 2)

8. **What the experiment found, and how each is guarded.** Each of these went wrong in the throwaway build of _Experiment 2_ or was needed to make it work.
   - **The normal shape never reserves the band.** The experiment's placement reserved the band, then released it for the normal shape. Each change of the work area made the shell place the window again (ADR 0008 §5), so it reserved and released at 10–25 Hz and every maximized window flickered. Unit test.
   - **No re-placing when the window's own scale changes.** Dragging the normal window from the 150% monitor to the 100% one sends it `WM_DPICHANGED`, which the shell treats as a display change (ADR 0008 §5). Placing it there moved it back to its saved rectangle on the first monitor, which changed its scale again: a placement loop. In the normal shape, display changes leave the window where the user put it, and Windows rescales it. Pull the placement decision (which shape, which event, what to do) into a pure function with unit tests, as `placement.rs` already does for the rectangles.
   - **Restore the position before the size.** Setting the saved size while the window is still on another monitor, then moving it, makes Windows rescale it: restored onto the 100% monitor from the 150% one, it came back at two thirds of its size. Moving first, then sizing, restored it exactly. This is Windows behaviour, so it is a manual check, not a unit test.
   - **The first-open geometry comes from the work area without the band.** Computed from the work area with the strip's band reserved, the experiment's default normal window at 200% was 577 px tall. The first open is maximized (§5), so this now sets the restore size, which must come from the monitor's work area as it is without the band. Maximizing likewise waits until the band is given back, or the maximized window stops short of the space the strip just freed.
   - **One stale frame going back to the strip.** For about 80 ms the strip shows the page still at the normal window's size, then redraws. A small glitch; PR 2 tries to hide it (for example by drawing once at the new size before the switch shows), and accepts it if that fails. **Hidden in PR 2:** with the first open maximized, collapsing also showed about 120 ms of the un-maximize animation over the strip's place. Now each switch is cloaked (`DWMWA_CLOAK`, through a `Platform` call): the window is laid out and drawn unseen and shown 150 ms after the switch's last step (the deferred maximize, for an expand), with DWM's window transitions off while it switches. Screenshots every 10–30 ms showed no stale, blank or intermediate frame; what is behind the band shows for about 200–270 ms instead, then the new shape appears fully drawn.
   - **The window's own events during a switch are not the user's** (found in PR 2). tao reports moves and resizes synchronously while the style changes, so the strip's rectangle was taken for the normal window's restore rectangle, and un-maximizing gave a framed strip. The shell ignores them while it switches.
   - **The tool-window style needs one raw Win32 call, and the focus hooks stand aside.** Tauri switches focusable (`set_focusable`), decorations, resizing, shadow and the taskbar tab at runtime, but has no call for `WS_EX_TOOLWINDOW`, which keeps a window out of the taskbar and Alt+Tab. The `Platform` trait gains a method that sets or clears it (`SetWindowLongPtrW`, then `SetWindowPos` with `SWP_FRAMECHANGED`). The strip's style subclass, which forces the tool-window style back, and its activation hand-back (ADR 0015 §1) are skipped in the normal shape, or the normal window could never stay active.
   - **The renderer follows the pixel density.** The diorama view and the Studio preview set the renderer's pixel ratio once, when they are created. On a 100% monitor after starting on a 200% one, the canvas drew at 2× (3840×2160 in full screen). Issue [#55](https://github.com/zhangwy324/living-diorama/issues/55), fixed in PR 2.

9. **Manual checks PR 2 adds to `docs/development.md`,** at 100%, 150% and 200% with two monitors:
   - switching to the normal shape and back several times: the band goes and comes back once per switch, the strip returns to the same place and still never takes focus;
   - the first expand opens maximized on the strip's monitor, filling the space the band gave back, and un-maximizing gives a centred window;
   - F11, Esc and Home in the normal shape, and Esc outside full screen doing nothing;
   - the tray in each shape: Collapse, left-click and Show on a minimized normal window, Hide and Show keeping the shape;
   - the overlay's buttons in the normal shape, and the error screen's Details;
   - full screen on each monitor, and back;
   - moving the normal window between monitors with different scales, then collapsing and expanding again: it comes back at the same place and size, and the canvas stays sharp (#55);
   - minimizing, and the saved geometry after a relaunch.

### Measuring a release build (PR 4)

10. **`VITE_CREATURE_COUNT` in any build.** The build-time override of the starting creature count (ADR 0009 §4) is honoured whenever it is set at build time, in release builds too, so performance can be measured on a release build with 20 creatures. The release workflow never sets it, so the published installers are unchanged.
    - **Settled in PR 4.** `0` is honoured too and starts with no built-in creatures, for the state with 20 drawn species; only an unset or empty variable means no override, and anything but a whole number is ignored with a warning. A build with an override logs `Starting count overridden: N`. `tools/development/check-no-creature-count.sh` fails if the variable is set in the environment or in `apps/desktop/.env*`; the release workflow runs it before building the installer, and CI's Windows build runs it on every PR.

11. **A seeding hook for 20 drawn species.** A development hook generates 20 varied drawn species into a species library folder. For the measurements that folder is copied into the release app's data folder (ADR 0014 §1), and creatures are added from My creatures in the Studio, so the measured app goes through the same library, schemas and registries as a player's drawings.
    - **Settled in PR 4.** The hook is `livingDiorama.library.saveSamples()` in the dev app's console. It saves 20 species built from strokes from eight body plans, varied in colour, outline and size class (four tiny, six small, six medium, four large); three have separate shapes. Creatures are added by hand, once per species, in My creatures: the user chose that over a build-time option spawning one of each library species. `docs/development.md` has the procedure.

### Side colours (PR 3)

12. **Fixtures drawn in the Studio (issue #40).** The user draws about six cases in the Studio: with and without an outline, details near the edge, thin limbs. Their `drawing.json` files become test fixtures for how body sides take their colours. The mossling's hairs come back in the same PR. The PR waits for the drawings.

### Soak, release and smoke test (PR 6 and the release-candidate round)

13. **The soak mix.** 8 hours at the creature cap: 3 mosslings and 17 different drawn species, 20 creatures in all, the strip shown with the cursor off it. The pass criteria are v0.1's (ADR 0009 §6): memory flat after warm-up and every stuck event recovered.

14. **One release-notes file per version.** `docs/release-notes/0.2.0.md`. The release workflow publishes the file for the tag's version with `gh release create --notes-file`, replacing the text hard-coded for v0.1.

15. **Installer smoke tests, in Windows Sandbox** (ADR 0009 §9): a clean install, and 0.2.0 installed over 0.1.0.

16. **Screenshots** are stored in `docs/screenshots/` and shown in the README.

### Scope and order

17. **Out of v0.2:** generated creature names (issue #48), a suggested size (#49) and polishing the release moment (#51). Timing a first-time user moves to a later milestone.

18. **PRs, in order:**
    1. the two experiments and this ADR;
    2. expanded mode as one window that changes shape, the fix for #55, and the manual checks of §9;
    3. side colours and the mossling's hairs, once the drawings exist;
    4. measurement tooling: the build-time count and the seeding hook;
    5. docs;
    6. version 0.2.0, the release-notes file and the workflow change.

    Then a release-candidate tag, the manual round on its build (the checklist, screenshots, performance, soak and smoke tests), a PR with the results, and the `v0.2.0` tag.

## Experiment 1: forwarding the world to a second window

The first design kept the strip's hidden window as the world's home and forwarded it to a separate expanded window. A throwaway release build (a local branch, not pushed) ran 20 mosslings. Three seconds after launch the strip opened a second window, a bare page with no WebGL in the Studio's place, and hid itself the way the tray does (window and WebView2 hidden, AppBar released). On every worker snapshot `main` sent `{ seq, sentAt, snapshot, events }` to the second window. The second window recorded the one-way latency (both clocks are `performance.timeOrigin + performance.now()` on the same machine), the arrival interval, lost sequence numbers and the JSON size, and echoed every tenth message back for the round trip. A control build forwarded nothing. Once `emitTo` missed the CPU criterion, two variants located the cost: `emitTo` with the snapshot left out (76 bytes), and the full message over a `BroadcastChannel`, the browser's messaging between same-origin pages, which doesn't go through Rust. A last run kept the strip shown, to compare arrival intervals. Each run was 8 minutes with `main` hidden (5 for the 76-byte one, 3 for the visible one), past Chromium's 5-minute threshold for intensive throttling, with `pnpm measure` sampling the process tree once a second on the reference machine (`docs/performance.md`).

Hypothesis, written before running: messages of 4–6 KB (pass: under 16 KB); latency p50 under 5 ms and p95 under 20 ms; 10 Hz held for the whole hidden run; forwarding adding under 0.1 percentage points of CPU against the control.

CPU is a share of all 16 logical processors, as in `docs/performance.md`, where the idle strip is 0.58%.

| Run (`main` hidden)               | CPU %      | Private MB | Message, p50 | Latency p50 / p95 / max | Rate, lost    |
| --------------------------------- | ---------- | ---------- | ------------ | ----------------------- | ------------- |
| Control: nothing forwarded        | 0.02       | 312        | –            | –                       | –             |
| `emitTo`, full message (two runs) | 0.24, 0.26 | 347, 352   | 5.5 KB       | 1.0–1.2 / 1.3–1.6 / 2.4 | 10.0 Hz, none |
| `emitTo`, 76 bytes                | 0.23       | 327        | 76 B         | 0.9–1.0 / 1.2 / 2.2     | 10.0 Hz, none |
| `BroadcastChannel`, full message  | 0.04       | 322        | 5.5 KB       | 0.1 / 0.2 / 0.9         | 10.0 Hz, none |

- **Size and latency passed.** The largest message was 6.1 KB; drawn species' longer IDs would add about 0.5 KB. Every minute of every run held 10.0 Hz.
- **`emitTo` failed on CPU:** about 0.22 points, the same with 76 bytes as with 5.5 KB, so the cost is per event. A `BroadcastChannel` cost about 0.02.
- **A hidden `main` changes the tick cadence.** With the strip shown, snapshots arrive every 100.4 ms (p50). Hidden, the worker's 100 ms timer fires about every 111 ms and the fixed clock (ADR 0006) catches up with two ticks about once a second, so 1 snapshot in 10 arrives as a pair, which would show as a small hitch in a separate window. One window that changes shape never hides `main` while expanded, so it avoids this.
- The world description such a window needs once is about 190 KB for the scene and 1.5 MB for the navigation debug overlays.

**The fallback.** If one window that changes shape fails in the build, the fallback is a separate expanded window fed over a `BroadcastChannel`, wrapped as a `WindowTransport` (ADR 0015 §5) in `desktop-integration`. It also needs:

- the world sent once when the window opens;
- drawn species' images loaded by the expanded window itself;
- a second renderer and WebGL context;
- the tick-cadence fix: schedule each tick for when it is due.

## Experiment 2: one window that changes shape

A second throwaway build (a local branch, not pushed) switched the live `main` window between the strip and a normal window at runtime. Rust read commands from a file (normal, strip, full screen, move to a monitor, quit) and logged every placement and AppBar call. A PowerShell probe:

- read the window's styles and rectangles with Win32 calls;
- kept a maximized test window in front, standing in for the user's app;
- drove the app with synthetic clicks, a title-bar drag and keys (Home, F11, Esc, and an Alt+Tab with screenshots);
- took screenshots every 30–40 ms through a switch.

The page logged the keys it received, its canvas size and the camera. The reference machine has a 2560×1440 primary monitor and a 1920×1080 second one at 100%. The primary ran at 100%, 150% and 200% in turn, with the user changing the scale. The pass criteria were written before running.

| Check                                                       | 100%                   | 150%                      | 200% |
| ----------------------------------------------------------- | ---------------------- | ------------------------- | ---- |
| Every property flips both ways                              | Pass                   | Pass                      | Pass |
| Keys in the normal shape; the strip still never takes focus | Pass                   | Pass                      | Pass |
| Band given back and taken again                             | Pass                   | Pass                      | Pass |
| Exact geometry, strip and normal                            | Pass                   | Pass                      | Pass |
| No blank frame; canvas and camera                           | Pass (one stale frame) | Pass                      | Pass |
| Full screen and back                                        | Pass                   | Pass                      | Pass |
| Normal window on the second monitor                         | Not exercised          | Two bugs found, then pass | Pass |

- **Properties.** In the strip shape: `WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`, no taskbar button, not in Alt+Tab. In the normal shape: caption, thick frame, minimize and maximize boxes, a taskbar button and an Alt+Tab entry (both seen on screenshots).
- **Focus.** A click focuses the normal window, and Home, F11 and Esc reached the page every time. Back in the strip, a click on it, a click on the overlay's Reset camera and a typed key all left the test window in front, on both monitors.
- **Band.** The maximized test window went 1148 ↔ 1408 px tall at 100% on every switch, with no stale space. After the fix in §8, each switch made one AppBar change and settled in 54–204 ms.
- **Geometry.** The strip came back to the same pixels on every switch: 2560×260 at 100%, 2560×390 at 150%, 2560×520 at 200% (260 logical), and 1920×260 on the second monitor. The normal window came back exactly after a title-bar drag (window, DWM frame and client rectangles). That held although the invisible frame insets grow with the scale (7, 9 and 11 px), because the build saves the outer position and the inner size and restores both the same way.
- **Visual.** No white or blank frame. One captured frame going back to the strip showed the page still at the old size (§8). The camera kept its position through every switch, and the canvas always matched the client size (at the starting pixel ratio, #55).
- **Full screen.** F11 covered the whole monitor, taskbar included (2560×1440 on the primary, 1920×1080 on the second), and Esc returned to the exact saved rectangle.
- **The two bugs** were the placement loops of §8. The first, reserving then releasing the band, flickered maximized windows at 10–25 Hz until fixed. The second appeared when the normal window was dragged between monitors with different scales: no display setting changed; the move itself changed the window's scale. With both fixes, the 200% run passed everything, including a drag onto the 100% monitor with no placement during the drag.

## Consequences

- ADR 0008 §2's single window stands, so there is still one page, one worker and one WebGL context; nothing is forwarded between windows.
- The shell's placement becomes shape-aware, and its decisions move into a pure function with unit tests, since getting them wrong loops (§8).
- The `Platform` trait gains a call for the tool-window style, and the strip's style and activation hooks become conditional on the shape.
- The release workflow reads its notes from a file, so each version's notes are reviewed in a PR like any other change.

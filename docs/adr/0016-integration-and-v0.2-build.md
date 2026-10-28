# ADR 0016: Integration and the v0.2 build

- **Status:** Proposed. The open questions at the end are for the user to settle; the PR that settles them makes this Accepted.
- **Date:** 2026-10-27
- **Context:** Roadmap M12 (integration and the v0.2 build). M11 gave the app a second window, the Creation Studio (ADR 0015). M12 reworks expanded mode (issue #30), polishes the sides of drawn bodies (issue #40), measures and soaks a release build with 20 creatures, and ships v0.2.0. The user settled the M12 decisions on 2026-10-27 (roadmap M12, "Settled with the user"); this ADR records them for the code and the results of the IPC experiment they asked for first. It ships as six PRs, in the order of §16; each PR updates this ADR if it has to deviate.

## Decisions

### The expanded window (PR 2)

1. **A separate, normal window.** Expanded mode stops being a size of the strip's window. It becomes its own window: framed, resizable, movable, focusable, with a taskbar entry, like the Studio (ADR 0015 §1). It is a place to give the diorama full attention: look at it, move the camera, and start edits. This replaces ADR 0008 §2 (one window, two modes), §8 (expanded mode) and the expanded bullet of §10. The strip keeps every other ADR 0008 behaviour, non-focusable included. ADR 0015 §1's activation hand-back, which keeps the strip from staying active after a click while the Studio is open, applies to the expanded window in the same way.

2. **Full screen.** F11 or a button in the expanded window's overlay toggles full screen. Esc leaves full screen and never closes the window. Home resets the camera. The window takes focus, so unlike the strip it can have keyboard shortcuts.

3. **The strip hides while expanded is open.** Opening the expanded window hides the strip, which gives its reserved band back (ADR 0008 §10, "Visible only"), so other windows grow; they shrink again when the strip returns. Closing the expanded window (its frame's X, the overlay's Collapse button, or the tray) brings the strip back. Minimizing it is an ordinary minimize: the strip stays hidden.

4. **The world stays in the strip's window.** The simulation worker, the registries and the species library stay in `main`, which is hidden but keeps ticking (ADR 0008 §12). `main` forwards the worker's snapshots and events to the expanded window over targeted events (`emitTo`), and the expanded window's commands come back to `main`, as the Studio's do (ADR 0015 §4–6). The experiment below measured it: 5.5 KB per message with 20 creatures, delivered in about 1 ms at a steady 10 Hz while `main` is hidden, but at about 0.2 percentage points of CPU, which is more than the pass criterion. So the transport is open question 1. Hiding `main` also makes the tick cadence uneven (open question 2). What the messages carry is open question 3.

5. **Persistence.** The expanded window's size, position, monitor and whether it is maximized or full screen are saved in `settings.json` (ADR 0008 §9) and restored the next time it opens. The app always launches as the strip, never expanded.

6. **Its own camera.** The expanded window has a camera of its own, separate from the strip's. It starts at the default view and keeps its position for as long as the app runs, also across closing and reopening the window. It is not saved across launches.

7. **Edits start from the Studio.** The expanded window's overlay has an "Open Studio" button, which opens or focuses the Studio as the strip's pencil button does (ADR 0015 §1). Editing the world in place comes in a later release.

### Measuring a release build (PR 4)

8. **`VITE_CREATURE_COUNT` in any build.** The build-time override of the starting creature count (ADR 0009 §4) is honoured whenever it is set at build time, in release builds too, so performance can be measured on a release build with 20 creatures. The release workflow never sets it, so the published installers are unchanged.

9. **A seeding hook for 20 drawn species.** A development hook generates 20 varied drawn species into a species library folder. For the measurements that folder is copied into the release app's data folder (ADR 0014 §1), and creatures are added from My creatures in the Studio, so the measured app goes through the same library, schemas and registries as a player's drawings.

### Side colours (PR 3)

10. **Fixtures drawn in the Studio (issue #40).** The user draws about six cases in the Studio: with and without an outline, details near the edge, thin limbs. Their `drawing.json` files become test fixtures for how body sides take their colours. The mossling's hairs come back in the same PR. The PR waits for the drawings.

### Soak, release and smoke test (PR 6 and the release-candidate round)

11. **The soak mix.** 8 hours at the creature cap: 3 mosslings and 17 different drawn species, 20 creatures in all, the strip shown with the cursor off it. The pass criteria are v0.1's (ADR 0009 §6): memory flat after warm-up and every stuck event recovered.

12. **One release-notes file per version.** `docs/release-notes/0.2.0.md`. The release workflow publishes the file for the tag's version with `gh release create --notes-file`, replacing the text hard-coded for v0.1.

13. **Installer smoke tests, in Windows Sandbox** (ADR 0009 §9): a clean install, and 0.2.0 installed over 0.1.0.

14. **Screenshots** are stored in `docs/screenshots/` and shown in the README.

### Scope and order

15. **Out of v0.2:** generated creature names (issue #48), a suggested size (#49) and polishing the release moment (#51). Timing a first-time user moves to a later milestone.

16. **PRs, in order:**
    1. the IPC experiment and this ADR;
    2. the expanded window, with the manual checks in `docs/development.md` updated;
    3. side colours and the mossling's hairs, once the drawings exist;
    4. measurement tooling: the build-time count and the seeding hook;
    5. docs;
    6. version 0.2.0, the release-notes file and the workflow change.

    Then a release-candidate tag, the manual round on its build (the checklist, screenshots, performance, soak and smoke tests), a PR with the results, and the `v0.2.0` tag.

## Experiment: forwarding the world to a second window

Before committing to §4, a throwaway release build (a local branch, not pushed) ran 20 mosslings. Three seconds after launch the strip opened a second window, a bare page with no WebGL in the Studio's place, and hid itself the way the tray does (window and WebView2 hidden, AppBar released). On every worker snapshot `main` called `emitTo` with `{ seq, sentAt, snapshot, events }`; the second window recorded the one-way latency (both clocks are `performance.timeOrigin + performance.now()` on the same machine), the arrival interval, lost sequence numbers and the JSON size, and echoed every tenth message back so `main` could check the round trip. A control build was the same without the `emitTo`. Once forwarding missed the CPU criterion, two variants were added to find where the cost is: the same `emitTo` with the snapshot left out (76 bytes), and the full message over a `BroadcastChannel`, a browser API that same-origin pages use to message each other without going through Rust. A last run kept the strip shown, to compare the arrival intervals with a visible `main`. Each run was 8 minutes hidden (5 for the 76-byte one, 3 for the visible one), past Chromium's 5-minute threshold for intensive throttling of hidden pages, with `pnpm measure` sampling the process tree once a second on the reference machine (`docs/performance.md`).

Hypothesis, written before running: messages of 4–6 KB (pass: under 16 KB); latency p50 under 5 ms and p95 under 20 ms, well inside one 100 ms tick; 10 Hz held for the whole hidden run, after 5 minutes too; forwarding adding under 0.1 percentage points of CPU against the control.

CPU is a share of all 16 logical processors, as in `docs/performance.md`, where the idle strip is 0.58%. Latency is one way, from `main` receiving the worker's message to the handler in the second window.

| Run (`main` hidden)               | CPU %      | Private MB | Message, p50 | Latency p50 / p95 / max | Rate, lost    |
| --------------------------------- | ---------- | ---------- | ------------ | ----------------------- | ------------- |
| Control: nothing forwarded        | 0.02       | 312        | –            | –                       | –             |
| `emitTo`, full message (two runs) | 0.24, 0.26 | 347, 352   | 5.5 KB       | 1.0–1.2 / 1.3–1.6 / 2.4 | 10.0 Hz, none |
| `emitTo`, 76 bytes                | 0.23       | 327        | 76 B         | 0.9–1.0 / 1.2 / 2.2     | 10.0 Hz, none |
| `BroadcastChannel`, full message  | 0.04       | 322        | 5.5 KB       | 0.1 / 0.2 / 0.9         | 10.0 Hz, none |

The largest message was 6.1 KB. Drawn species' IDs (`user:<uuid>`) are 26 characters longer than `hollow:mossling`, about 0.5 KB more per message with 20 of them. One message in the first minute of the first run took 45 ms; none after it took over 2.4 ms. The `emitTo` round trip (the echo) was 1.7–2.1 ms at p50. Every minute of every run held 10.0 Hz, minutes 6 to 8 included.

What it shows:

- **Size and latency pass by a wide margin.** 5.5 KB per message and about 1 ms, against 16 KB and 20 ms. The world description the expanded window needs once is much larger: about 190 KB for the scene and 1.5 MB for the navigation debug overlays (open question 3).
- **CPU fails.** `emitTo` adds about 0.22 percentage points, twice the 0.1 allowed and about a third of the idle strip's whole cost. The 76-byte run costs the same as the 5.5 KB one, so the cost is per event, not per byte: a smaller payload doesn't help, only fewer events or another transport. A `BroadcastChannel` costs about 0.02, at a tenth of the latency (open question 1). Private memory was about 35 MB higher with `emitTo` too, against 10 MB with the `BroadcastChannel`; 8 minutes is too short to tell growth from a larger steady state.
- **A hidden `main` changes the tick cadence, not the rate.** With the strip shown, snapshots arrive every 100.4 ms (p50; p95 about 102). With `main` hidden, the worker's 100 ms timer fires about every 111 ms, and the fixed clock (ADR 0006) catches up with two ticks about once a second, so about 1 snapshot in 10 arrives right behind the one before. The pattern is the same through both transports and with the 76-byte payload, and from the first minute, so it comes from hiding the page, not from forwarding or Chromium's 5-minute throttling. The renderer blends from the previous snapshot to the newest one (ADR 0007 §8), so a pair skips one tick's movement: probably a small hitch about once a second in the expanded window (open question 2).

## Open questions

The roadmap doesn't settle these. They are for the user; each has a recommendation.

1. **The transport for the world.** The settled design uses `emitTo`, which missed the CPU criterion.
   - **A. `emitTo` as settled,** accepting about 0.2 percentage points while the expanded window is open. That window renders anyway (about 0.5% idle, `docs/performance.md`), so the total stays under 1%.
   - **B. A `BroadcastChannel` for the expanded window** (recommended). About 0.02 points and 0.1 ms. It fits the channel's existing `WindowTransport` interface in `desktop-integration`, so the rest of the code is unchanged. Trade-offs: Tauri's capability files don't scope it (any page of the app's origin can listen, and the app loads no other pages), and it relies on all windows sharing one WebView2 profile, which is Tauri's default. The Studio keeps `emitTo`: it sends a message now and then.
   - **C. `emitTo` every second or third tick.** It cuts the cost in proportion but adds 100–200 ms of delay and makes the cadence uneven.
2. **The tick cadence while `main` is hidden.** About 1 snapshot in 10 arrives as a pair.
   - **A. Schedule each tick for when it is due** (recommended). The host's loop waits `tickMs` after each run today; waiting until the next tick is due instead should keep it to one tick per timer firing. A small change in `simulation`'s host, checked in PR 2 by measuring arrival intervals with `main` hidden.
   - **B. Let the renderer place snapshots by simulation time** (`timeMs`) instead of arrival time, with a short buffer. More work in the renderer, and the strip doesn't need it.
   - **C. Accept it,** and check by eye in PR 2 whether the hitch shows.
3. **What the expanded window receives** (the payload shape).
   - **Recommended:** on opening, the expanded window asks `main` for the world (the scene, the assets and species registered so far, and the navigation overlays) and the shell state, as the Studio asks for a library snapshot (ADR 0015 §5). Then `main` pushes every worker snapshot with its events, and each species registered or removed. Drawn species' images are `blob:` URLs of the strip's page, so the expanded window loads them itself with `load_library_image`, as the Studio does. Commands go back through Rust where Rust owns the state (pause, open Studio) and through the channel otherwise (the debug overlays).
   - **Alternative:** leave the navigation overlays out (1.5 MB) and send them only when the debug overlays are turned on. Opening is lighter, at the cost of one more request.
4. **The expanded window's overlay and keys.** Recommended: Pause/Resume, Reset camera, debug overlays, Full screen, Open Studio and Collapse; no Hide, since minimizing does that. Keys: F11, Esc and Home only. The debug overlays are one setting shared by both windows, since the worker adds routes to every snapshot or to none.
5. **Esc outside full screen.** The roadmap says Esc leaves full screen and doesn't close the window. Recommended: outside full screen, Esc does nothing.
6. **The tray while the expanded window is open.** Recommended: Expand/Collapse reads "Collapse" and closes it. Left-click and Show/Hide bring the expanded window to the front, restoring it if minimized, rather than toggling the hidden strip. Expanding from the tray while the strip is hidden opens the expanded window, and collapsing then shows the strip, as §3 says. The alternative is to disable Show/Hide while the expanded window is open.
7. **Closing the window, and the camera.** §6 keeps the camera across closing and reopening while the app runs. Recommended: closing destroys the window, which frees its WebGL context as the Studio does (expanded mode used about 40 MB more GPU memory than the strip, `docs/performance.md`), and the shell keeps the camera's position and target in memory, sent by the window when it closes. The alternative is to hide the window instead of destroying it, which keeps the camera without any of that but holds the GPU memory while it is closed.
8. **The error screen's Details.** ADR 0009 §3 shows the details by expanding the strip, which §1 removes. Recommended: Details opens the expanded window, which shows the full error screen; `main` answers its world request with the failure instead. The alternative is to drop Details from the strip and point at the log ("Open log folder" in the tray).
9. **Where it first opens.** Before any geometry is saved (§5). Recommended: as ADR 0008 §8 did, about 70% of the work area, centred on the strip's monitor.

## Consequences

- The app has a third page and window. `desktop-integration` grows the expanded window's end of the channel and stays the only package that imports `@tauri-apps/api`.
- The expanded window gets a capability file of its own, like the Studio's. Any shell event it shows, such as `paused-changed`, goes to it as well as to `main` (ADR 0015 §6 sends shell events to `main` only).
- While the expanded window is open the strip's WebGL context stays alive but draws nothing, so there are two contexts, and three with the Studio open too.
- The release workflow reads its notes from a file, so each version's notes are reviewed in a PR like any other change.

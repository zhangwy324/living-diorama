# ADR 0009: Integration, hardening and the v1 build

- **Status:** Accepted
- **Date:** 2026-10-26
- **Context:** Roadmap M6 (integration, hardening and v1 build). The composition root already loads the built-in content through the registries, validates it and starts the simulation worker and the renderer (M2–M4), and the app spawns 3 creatures (M4). M6 makes failures visible, measures the app over long runs, builds an installer and documents the result. It ships as four PRs: **A** error screen and many-creature checks; **B** soak and performance tooling, the measured baseline and any throttling fixes; **C** installer, version, release workflow and docs (split into C1, the installer, workflow and README, and C2, the two other docs); **D** a diagnostics log file and an app icon. Decisions for all four are recorded here; each PR updates this ADR if it has to deviate.

## Decisions

### Order of work

1. **The M5 manual checklist runs during M6.** The desktop-shell checks in `docs/development.md` (scaling, monitors, sleep, focus) and the installer smoke test both need hands-on sessions on a release build, so they run together. M6 is not done until both have passed.

   **Outcome.** Both ran on the published v0.1.0 installer: the smoke test in Windows Sandbox and the desktop-shell checks on the developer's machine. They found two problems, neither blocking v0.1.0, which are filed for later: a creature's shadow is partly hidden where two surfaces meet (#29), and expanded mode can't be resized and keeps the strip's reserved space, which calls for rethinking what it is for (#30).

### Failures (PR A)

2. **Every startup or runtime failure reaches the error screen.** Before M6 only content validation did; a simulation `error` message went to the console, and a worker crash or a WebGL failure left a blank strip. Now three more sources feed the same screen:
   - an `error` message from the simulation worker. The app only sends commands it knows are valid, so any rejection is a bug and is treated as fatal;
   - the worker failing to load or throwing (`error` and `messageerror` on the `Worker`);
   - the renderer failing to start (for example no WebGL context).

   On a failure the app stops the worker and disposes the view, so nothing keeps running behind the screen.

3. **The error screen fits the strip.** At 180–260 px there is room for a one-line summary, not a list of diagnostics. The compact screen shows the summary and a **Details** button that expands the window (ADR 0008 §2) and lists every diagnostic. In expanded mode the details show at once. Hiding and quitting stay in the tray.

### Creature count (PR A)

4. **The shipped app keeps a fixed count of 3.** Roadmap §1.9 Q3 asked for a configurable count; no user-facing need for it exists yet, so it is not a setting. Instead:
   - a headless test runs 20 creatures through the invariant checks, so nothing in the simulation assumes one creature;
   - in development builds only, `VITE_CREATURE_COUNT` overrides the count, to check the renderer and frame rate with about 20 creatures in the real app. Production builds ignore it. _Superseded by [ADR 0016](0016-integration-and-v0.2-build.md) §10: any build honours it when it is set at build time._

### Soak test and performance baseline (PR B)

5. **One sampling script for both.** A PowerShell script in `tools/development` samples the app's process tree (the Rust host and its WebView2 child processes) at a fixed interval and writes a CSV of working set, private bytes, CPU and GPU use. The frontend counts `creature_stuck` and `path_failed` events, and the count is written where the script can read it at the end of a run: the frontend sends the totals to the shell on each change, and the shell writes them to `event-counts.json` in the app's local data directory. A stuck event counts as recovered once the creature has moved 0.5 m from where it got stuck. The file is written in release builds too, since the soak runs on one; it stays alongside the diagnostics log (§14).

6. **Soak pass criteria.** An 8-hour run with the default 3 creatures, on the developer's machine. Memory is flat after warm-up (less than 10% growth from hour 1 to hour 8) and every stuck event is recovered (the creature moves again).

7. **Performance baseline.** The same script, about 5 minutes in each of four states: strip idle, strip hovered, expanded, hidden. The numbers and the reference machine (CPU, GPU, displays) are recorded in `docs/performance.md` as the starting budget. Only obviously wasteful costs are fixed in M6; the first candidate is the idle render rate (about 30 fps, ADR 0007), which could drop when only creatures move.

   **Outcome (PR B).** The idle rate stays at 30 fps: it costs about a tenth of one core and under 1% GPU. The measurement found one waste instead: a hidden window kept rendering, because hiding a Tauri window does not hide its WebView2. The shell now sets the WebView2's visibility with the window's, so the page's existing `visibilitychange` handling stops the render loop; the simulation worker keeps ticking.

### Installer and release (PR C)

8. **NSIS only, per user.** No admin rights are needed, and MSI would add WiX and per-machine installs without a v1 benefit. WebView2 uses the download bootstrapper, since Windows 11 already includes it. The installer is unsigned (signing is post-MVP).

9. **Smoke test in Windows Sandbox.** It starts clean every time and ships with Windows 11 Pro, so it is a clean VM for this purpose.

10. **Version `0.1.0` and a GitHub pre-release.** v1 is a proof of concept, not 1.0. A tag push builds the NSIS bundle in CI and attaches it to a GitHub Release marked as a pre-release, with a note that it is unsigned and SmartScreen will warn.

    The workflow uses plain steps (`pnpm tauri build`, then `gh release create`) rather than a third-party release action, and fails unless the tag matches the version in `tauri.conf.json`, `Cargo.toml` and `package.json`; a release candidate tag such as `v0.1.0-rc.1` matches `0.1.0`. The `v0.1.0` tag waits for PR D, so the first public installer has the real icon; PR C tests the workflow with a release candidate tag that is deleted afterwards.

### Docs (PR C)

11. **Three public docs.**
    - The README gains instructions for people who only run the app: download the installer, get past SmartScreen and use the tray.
    - `docs/architecture.md` gives an overview of packages, runtime topology, the message protocol and the boundary rules, written from the code and these ADRs.
    - `docs/adding-content.md` walks through registering a prop, a species and a world through `extension-api`.

### Roadmap assumptions

12. **No world persistence, an opaque window and a 10 Hz tick** (roadmap §1.9 Q5–Q7) match the code and are confirmed for v1.

    _Amended by [ADR 0019](0019-world-saving.md) (M15 PR 6):_ the world is now saved and restored across launches. The window and the tick are unchanged.

### Diagnostics log and icon (PR D)

13. **A log file through `tauri-plugin-log`.** The official plugin gives the shell the `log` macros, a JavaScript binding and rotation, so none of that is written by hand. Only `desktop-integration` imports the binding. The file lives in the app's log directory (`%LOCALAPPDATA%\com.livingdiorama.desktop\logs`), stays on the machine and is never uploaded. It rotates at 1 MB and keeps the 5 newest files, so the log never exceeds about 6 MB. Timestamps use local time, since a person reads them, and lines from the frontend are tagged `webview` without the plugin's caller location, which would always be the forwarder.

14. **What is logged, at info level and up.**
    - At startup: the app version, the Windows build and the connected monitors.
    - Every shell problem that went to stderr before, now at warn or error.
    - Every failure the error screen shows, with its details, and the frontend's `console.warn` and `console.error` calls (for example a missing asset). `desktop-integration` forwards them, so engine packages stay unaware of the log.
    - The event totals each time they change. `event-counts.json` stays: the measuring script reads it as structured data and should not depend on the log's format or rotation.

    Nothing is logged per tick or per frame.

15. **"Open log folder" in the tray.** It sits above Quit and opens the log directory in the file manager, through a `Platform` method so the rest of the shell stays OS-neutral.

16. **An original app icon.** A raised square of ground in isometric view, with a tree and a small creature, on a dark rounded square. One SVG in `apps/desktop/src-tauri/icons/` is the source, and `pnpm tauri icon` generates every size from it. The 16 and 32 px output is checked by eye; a simpler drawing for those sizes is added only if the detailed one does not read.

## Consequences

- A bug that rejects a command now stops the app with a visible error instead of running with missing creatures. That is deliberate for a proof of concept: a silent partial failure is harder to report.
- WebGL context loss after a successful start is not handled beyond what three.js does; it is rare on desktop and would show as a frozen view, not a blank one.
- The creature count is still a constant; making it a setting later only touches the app.

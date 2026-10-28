# Development environment (Windows)

Development happens natively on Windows (resolves roadmap §1.8 R1). WSL2 is not used: Tauri must build and run with the Windows toolchain, and window placement/focus behavior must be tested on real Windows.

## Toolchain

| Tool                                                                                | Version (at setup)       | Install                                                                                                                                                            |
| ----------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Git for Windows                                                                     | 2.56                     | pre-installed                                                                                                                                                      |
| Visual Studio 2022 Build Tools, "Desktop development with C++" (MSVC + Windows SDK) | 17.x                     | `winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --quiet --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` |
| WebView2 Runtime                                                                    | evergreen                | ships with Windows 11                                                                                                                                              |
| Rust (`stable-x86_64-pc-windows-msvc`)                                              | 1.99                     | `winget install Rustlang.Rustup`, then `rustup default stable`                                                                                                     |
| Node.js LTS                                                                         | 24 (see `.node-version`) | `winget install OpenJS.NodeJS.LTS`                                                                                                                                 |
| pnpm                                                                                | 12                       | `npm install -g pnpm --allow-scripts=pnpm`                                                                                                                         |
| GitHub CLI                                                                          | —                        | `winget install GitHub.cli`                                                                                                                                        |

Open a new terminal after installing so `PATH` picks up the new tools.

Maintainers with access can clone the private design docs (spec, roadmap, blueprint) into the gitignored `docs/design/` folder:

```bash
gh repo clone zhangwy324/living-diorama-design docs/design
```

## Conventions

- Line endings are LF in the repo and working tree (`.gitattributes`); only `.bat`/`.cmd`/`.ps1` use CRLF.
- Keep the repo on a local NTFS path (not a network or WSL path) for fast file watching and Rust builds.
- Rust build output (`target/`) can grow to several GB; exclude it from antivirus real-time scanning if builds are slow.
- To run `pnpm dev` with more creatures than the default 3, put `VITE_CREATURE_COUNT=20` in `apps/desktop/.env.development.local` (gitignored). Production builds ignore it (ADR 0009 §4).
- `pnpm measure` samples the running app's CPU, GPU and memory into a CSV under `tools/development/out/measurements/` (ADR 0009 §5–7). Start a release build first (`pnpm tauri build --no-bundle`, then `apps\desktop\src-tauri\target\release\living-diorama.exe`). With no arguments it measures the four baseline states, 5 minutes each, and says how to put the app in each one. For the soak test run `pnpm measure -States soak -Minutes 480 -IntervalSeconds 10`; it ends with the stuck and path-failed counts the app writes to `%LOCALAPPDATA%\com.livingdiorama.desktop\event-counts.json`. Results go in [performance.md](performance.md).

## Troubleshooting

**`listen EACCES: permission denied` on the dev server port.** Windows (Hyper-V, WSL, Docker) reserves blocks of ports inside the TCP dynamic port range, and the reservations can move after a reboot. The dev server uses port 17420 to stay clear of them. If it still fails, compare against:

```bash
netsh interface ipv4 show excludedportrange protocol=tcp
```

```bash
netsh int ipv4 show dynamicport tcp
```

The Windows default dynamic range is 49152–65535; some installs move it to start at 1024, which puts most common dev ports at risk.

## Verify

```bash
node --version && pnpm --version && cargo --version
```

A throwaway `create-tauri-app` project builds with `pnpm tauri build --debug --no-bundle`, confirming MSVC, the Windows SDK and WebView2 are wired up.

## Desktop shell checks (manual)

The strip's window behavior depends on real displays, so it is checked by hand (ADR 0008 §15) before a release and after changing `apps/desktop/src-tauri`. Run `pnpm tauri build --no-bundle` and launch `apps/desktop/src-tauri/target/release/living-diorama.exe`; debug builds open a console window that takes focus at launch.

Repeat at 100%, 150% and 200% scaling (Settings → System → Display → Scale), with one monitor and with two.

- [ ] Launched while another app is in front, the strip appears without taking focus: the other app's title bar stays active and typing still goes to it.
- [ ] The strip spans the full width of its monitor's work area, its bottom edge on the taskbar's top edge, with no gap and no overlap.
- [ ] It has no taskbar button and no Alt+Tab entry.
- [ ] Clicking, orbiting, panning and zooming in the strip work and never take focus from the other app.
- [ ] Dragging the top edge resizes the strip between 180 and 260 logical pixels; the bottom edge stays put.
- [ ] Moving or resizing the taskbar, or toggling auto-hide, re-places the strip.
- [ ] Changing the scale or the resolution of the strip's monitor re-places it at the same logical height.
- [ ] Two monitors: disconnecting the strip's monitor moves the strip to the primary.

Tray, expanded mode and settings (once, at any scale):

- [ ] The tray menu reads Creation Studio, Hide, Expand, Pause, Always on top, Reserve screen space, Monitor ▸, Open log folder, Quit right after launch, and its labels and checks follow every change (Show/Hide, Expand/Collapse, Pause/Resume, the always-on-top and reserve-space checks, the current monitor's check).
- [ ] Left-clicking the tray icon several times in a row hides and shows the strip each time.
- [ ] Pause freezes the creatures and Resume restarts them; hiding and showing does not pause.
- [ ] Several menu actions in a row each take effect (e.g. Expand, Collapse, Always on top on and off, Monitor ▸ Display 2 and back).
- [ ] Expand covers about 70% of the strip's monitor, centred; the camera keeps its view; Collapse returns the strip to where it was. Expanded mode has no resize handle along the top edge.
- [ ] With Always on top on, a maximized window does not cover the strip; with it off, it does (Reserve screen space off).
- [ ] After Quit and relaunch, the height, monitor, always-on-top and reserve-space choices are as they were. Deleting or corrupting `%APPDATA%\com.livingdiorama.desktop\settings.json` starts with the defaults.

Reserved screen space (once, at any scale; two monitors where noted):

- [ ] With Reserve screen space on, a maximized window stops at the strip's top edge, and the strip sits directly above the taskbar, not above its own reserved band.
- [ ] Dragging the height handle neither flickers nor blanks the strip. Half a second after letting go, the maximized window's bottom edge meets the strip's new top edge; the strip doesn't creep up the screen.
- [ ] Hiding the strip lets the maximized window grow to the taskbar; showing it shrinks the window again.
- [ ] Expand and Collapse don't move or resize the maximized window.
- [ ] Turning Reserve screen space off gives the space back at once; turning it on takes it again.
- [ ] Two monitors: Monitor ▸ Display 2 moves the reservation with the strip; the first monitor's maximized windows grow back.
- [ ] Moving the taskbar to the left or top edge keeps the strip at the bottom, spanning the work area's width.
- [ ] With an auto-hide taskbar, moving the pointer to the very bottom of the screen still reveals the taskbar.
- [ ] With Always on top on, a full-screen video (F11 in a browser, or a game) covers the strip; leaving full screen puts the strip back on top.
- [ ] After Quit, the space is given back. After ending the process in Task Manager, note whether maximized windows regain the space and how long it takes.

Controls overlay and lifecycle (once, at any scale):

- [ ] Moving the pointer over the strip fades in the buttons in the top-right corner; moving it away fades them out. Clicking them never takes focus from the other app.
- [ ] Pause/Resume, Expand/Collapse, Reset camera, debug overlays and Hide each work, and the overlay and the tray menu always agree (e.g. pause from the tray, resume from the overlay).
- [ ] Hide from the overlay hides the strip; the tray icon brings it back with the creatures having moved on.
- [ ] Quit from the tray exits within a second; with `pnpm dev`, the console shows no "did not shut down in time" line.
- [ ] Sleep the PC for a few minutes with the strip showing. After waking, the creatures carry on from where they were, without sliding across the world or stuttering.

Creation Studio window (once at 100% and once at 150% or 200%, with two monitors; ADR 0015). M11 checked the overlay, single instance, focus and the close dialog in the dev app with synthetic input; the tray item, quitting with the Studio open, real pen and mouse pressure, other scale factors and two-monitor sharpness are run in M12:

- [ ] The pencil button in the controls overlay and the tray's Creation Studio each open the Studio in front, focused, with a taskbar button and an Alt+Tab entry.
- [ ] Opening it again, from either, focuses the open Studio instead of opening a second one; a minimized Studio is restored.
- [ ] With the Studio open, clicking, orbiting and zooming in the strip still works. Launched while another app is in front, and with the Studio closed, the strip still never takes focus.
- [ ] With the Studio in front, clicking or dragging in the strip and using its overlay buttons works and keeps the Studio active: Ctrl+Z still undoes in the Studio afterwards. Closing the Studio gives the focus back to the app that was in front before, not to the strip.
- [ ] Pen, eraser, colours, brush sizes, Undo, Redo and Clear work from the toolbar; Ctrl+Z undoes, Ctrl+Y and Ctrl+Shift+Z redo, and Clear can be undone. With a pen, pressing harder draws wider; with a mouse, quick flicks taper.
- [ ] The drawing stays sharp when the window is resized and when it is moved to a monitor with another scale. The guide line is never part of the drawing.
- [ ] Beside the canvas, the 3D preview shows the drawing as a body turning slowly, rebuilt a moment after each stroke, undo, redo or clear, and drawing stays smooth meanwhile. Changing the size makes the body bigger or smaller against the grid; a wide drawing still stays in view while it turns. Closing the Studio frees the preview's WebGL context (Task Manager's GPU memory for the app drops back).
- [ ] The name starts as "Creature N", N one more than the species in the library, and the size as Small.
- [ ] Hints under the preview: an empty canvas says nothing is drawn yet; a body with a whisker drawn with the smallest brush says a part is very thin and tints it orange in the preview; two separate blobs say parts aren't joined and tint the smaller one blue; a single line on its own is not called thin. Choosing Large says it is too big to cross the wooden bridge (Woodland Hollow); Medium has no size hints. Switching sizes back and forth updates the hints at once.
- [ ] Closing an empty Studio closes it at once. Closing it with something drawn asks: Cancel (or Escape) keeps the drawing, Save draft is disabled, Discard closes it.
- [ ] Quit from the tray with the Studio open closes both within a second, with no "did not shut down in time" line.

## Releasing

1. On a branch, set the new version in `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml` (then build once to update `Cargo.lock`) and `apps/desktop/package.json`, and merge it.
2. Tag the merge commit on `main` and push the tag:

   ```bash
   git tag v0.1.0 && git push origin v0.1.0
   ```

3. The `Release` workflow checks that the tag matches all three versions, builds the NSIS installer and publishes it as a GitHub pre-release (ADR 0009 §10).
4. Run the installer smoke test below on the published installer, along with the desktop shell checks above.

### Installer smoke test (manual)

Run in [Windows Sandbox](https://learn.microsoft.com/windows/security/application-security/application-isolation/windows-sandbox/) (ADR 0009 §9), which starts clean every time. Copy the installer in, then:

- [ ] SmartScreen warns about an unknown publisher; **More info → Run anyway** starts the installer.
- [ ] The installer asks for no admin rights and installs under `%LOCALAPPDATA%\Living Diorama`.
- [ ] Start menu → **Living Diorama** shows the strip at the bottom of the screen with creatures moving, and a tray icon.
- [ ] Tray → Open log folder opens `%LOCALAPPDATA%\com.livingdiorama.desktop\logs` in Explorer, and `Living Diorama.log` starts with the version, the Windows build and the monitors.
- [ ] The tray icon, Start menu entry and installer show the diorama icon, not the Tauri logo.
- [ ] Tray → Quit exits; no `living-diorama.exe` process is left in Task Manager.
- [ ] **Settings → Apps → Installed apps** lists Living Diorama with the right version, and uninstalling removes it and its Start menu entry.

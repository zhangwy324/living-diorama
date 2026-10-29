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
- To run `pnpm dev` with another number of mosslings than the default 3, put `VITE_CREATURE_COUNT=20` in `apps/desktop/.env.development.local` (gitignored). `0` starts with none. Release builds honour it too when it is set at build time (ADR 0016 §10); the release workflow fails if it is set. While it is set, the app neither loads nor writes the saved world (ADR 0019 §11): every launch starts fresh with that count, and the player's `world.json` is left as it was.
- To keep `pnpm dev` away from your own drawn creatures and your saved world, set `LIVING_DIORAMA_DEV_DATA_DIR` to a folder before starting it (PowerShell: `$env:LIVING_DIORAMA_DEV_DATA_DIR = "$env:TEMP\diorama-dev"; pnpm dev`). The species library then lives in `library/` under that folder, and the saved world in `world.json` and `world.prev.json` beside it, instead of `%APPDATA%\com.livingdiorama.desktop`. Release builds ignore it; settings and logs stay where they are.
- In development builds, the dev tools console has two world hooks (ADR 0019 §9): `await livingDiorama.world.reset()` takes every creature out, spawns the three mosslings and saves; `await livingDiorama.world.save()` saves now. The reset keeps the world's seed, tick and creature ID counter, so it is not a wholly fresh world; for that, quit and delete `world.json` and `world.prev.json`. There is no reset for players.
- `pnpm sim --save <file>` writes the world as a headless run leaves it, in the app's save format, and `pnpm sim --load <file>` carries on from such a save instead of a fresh world: `--gap <minutes>` says how much wall-clock time passed since it was made (default 0, an exact resume; 2 minutes or more is caught up as in the app). Both run at the app's 10 Hz only and refuse another `--hz`, because a save doesn't record its tick rate. A save from `pnpm sim` can be copied into a dev data folder as `world.json`, and the app's `world.json` can be loaded with `--load`. `pnpm soak` saves and restores every run several times and checks each restore (`tools/development/README.md`).
- `pnpm measure` samples the running app's CPU, GPU and memory into a CSV under `tools/development/out/measurements/` (ADR 0009 §5–7). Start a release build first (`pnpm tauri build --no-bundle`, then `apps\desktop\src-tauri\target\release\living-diorama.exe`). With no arguments it measures the four baseline states, 5 minutes each, and says how to put the app in each one. For the soak test run `pnpm measure -States soak -Minutes 480 -IntervalSeconds 10`; it ends with the stuck and path-failed counts the app writes to `%LOCALAPPDATA%\com.livingdiorama.desktop\event-counts.json`. Results go in [performance.md](performance.md).

## Measuring with many creatures

v0.2 measures a release build with 20 creatures, some of them drawn (ADR 0016 §10–13). A build with `VITE_CREATURE_COUNT` set neither loads nor saves the world (ADR 0019 §11), so measuring never touches a saved world. The drawn species come from a library of 20 sample species generated in the dev app, copied to where the release app keeps its library. All commands are PowerShell, from the repository root.

1. **Generate the 20 species** in a library folder of their own:

   ```powershell
   $env:LIVING_DIORAMA_DEV_DATA_DIR = "$env:TEMP\diorama-measure"; pnpm dev
   ```

   Expand the strip, press Ctrl+Shift+I to open the dev tools (the strip itself takes neither right-click nor shortcuts) and run `await livingDiorama.library.saveSamples()` in the console. It saves Bramble, Pip, … Hazel through the library, as the Studio saves a drawing, and resolves with the species it could not save: `[]` when all 20 were saved. Quit the app. `$env:TEMP\diorama-measure\library` now holds 20 folders.

2. **Move your own creatures and world aside.** The release build reads its library only from `%APPDATA%\com.livingdiorama.desktop\library`, and builds without the count override load and save the world in `world.json` beside it:

   ```powershell
   $data = "$env:APPDATA\com.livingdiorama.desktop"
   if (Test-Path "$data\library") { Rename-Item "$data\library" library.mine }
   foreach ($f in "world", "world.prev") { if (Test-Path "$data\$f.json") { Rename-Item "$data\$f.json" "$f.mine.json" } }
   ```

3. **Measure the built-in species** with the library empty, as it was for the M6 baseline. Build once per count; the diagnostics log says `Starting count overridden: N` when the build has one.
   - **3 mosslings:** the shipped build, without the variable: `pnpm tauri build --no-bundle`, start `apps\desktop\src-tauri\target\release\living-diorama.exe`, then `pnpm measure`.
   - **20 mosslings:**

     ```powershell
     $env:VITE_CREATURE_COUNT = "20"; pnpm tauri build --no-bundle; Remove-Item Env:VITE_CREATURE_COUNT
     ```

     Start the exe, then `pnpm measure`.

4. **Copy the 20 species** into the release app's data folder:

   ```powershell
   Copy-Item -Recurse "$env:TEMP\diorama-measure\library" "$data\library"
   ```

5. **20 creatures of different drawn species:** build with no mosslings:

   ```powershell
   $env:VITE_CREATURE_COUNT = "0"; pnpm tauri build --no-bundle; Remove-Item Env:VITE_CREATURE_COUNT
   ```

   Start the exe, open the Creation Studio, and in My creatures click Add once on each of the 20 species. Close the Studio, then `pnpm measure`.

6. **The soak mix: 3 mosslings and 17 different drawn species.** Build without the variable, as for 3 mosslings. Delete `$data\world.json` and `$data\world.prev.json` left by the 3-mossling run, so the world starts fresh. Start the exe, click Add once on every species in My creatures except the last three (Burdock, Tansy and Hazel), close the Studio and show the strip with the cursor off it. Then `pnpm measure -States soak -Minutes 480 -IntervalSeconds 10`.

7. **Afterwards** put your own library back, and build once more without the variable before using the release exe for anything else:

   ```powershell
   Remove-Item -Recurse "$data\library"
   if (Test-Path "$data\library.mine") { Rename-Item "$data\library.mine" library }
   foreach ($f in "world", "world.prev") {
     Remove-Item -ErrorAction SilentlyContinue "$data\$f.json"
     if (Test-Path "$data\$f.mine.json") { Rename-Item "$data\$f.mine.json" "$f.json" }
   }
   ```

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

Tray and settings (once, at any scale):

- [ ] The tray menu reads Creation Studio, Hide, Expand, Pause, Always on top, Reserve screen space, Monitor ▸, Open log folder, Quit right after launch, and its labels and checks follow every change (Show/Hide, Expand/Collapse, Pause/Resume, the always-on-top and reserve-space checks, the current monitor's check).
- [ ] Left-clicking the tray icon several times in a row hides and shows the strip each time.
- [ ] Pause freezes the creatures and Resume restarts them; hiding and showing does not pause.
- [ ] Several menu actions in a row each take effect (e.g. Expand, Collapse, Always on top on and off, Monitor ▸ Display 2 and back).
- [ ] With Always on top on, a maximized window does not cover the strip; with it off, it does (Reserve screen space off).
- [ ] After Quit and relaunch, the height, monitor, always-on-top and reserve-space choices are as they were. Deleting or corrupting `%APPDATA%\com.livingdiorama.desktop\settings.json` starts with the defaults.

Reserved screen space (once, at any scale; two monitors where noted):

- [ ] With Reserve screen space on, a maximized window stops at the strip's top edge, and the strip sits directly above the taskbar, not above its own reserved band.
- [ ] Dragging the height handle neither flickers nor blanks the strip. Half a second after letting go, the maximized window's bottom edge meets the strip's new top edge; the strip doesn't creep up the screen.
- [ ] Hiding the strip lets the maximized window grow to the taskbar; showing it shrinks the window again.
- [ ] Expand gives the band back, so the maximized window grows to the taskbar; Collapse takes it again and the window shrinks back, once per switch, with no flicker.
- [ ] Turning Reserve screen space off gives the space back at once; turning it on takes it again.
- [ ] Two monitors: Monitor ▸ Display 2 moves the reservation with the strip; the first monitor's maximized windows grow back.
- [ ] Moving the taskbar to the left or top edge keeps the strip at the bottom, spanning the work area's width.
- [ ] With an auto-hide taskbar, moving the pointer to the very bottom of the screen still reveals the taskbar.
- [ ] With Always on top on, a full-screen video (F11 in a browser, or a game) covers the strip; leaving full screen puts the strip back on top.
- [ ] After Quit, the space is given back. After ending the process in Task Manager, note whether maximized windows regain the space and how long it takes.

Controls overlay and lifecycle (once, at any scale):

- [ ] Moving the pointer over the strip fades in the buttons in the top-right corner; moving it away fades them out. Clicking them never takes focus from the other app.
- [ ] Pause/Resume, Expand/Collapse, Reset camera, debug overlays and Hide each work in the strip, and the overlay and the tray menu always agree (e.g. pause from the tray, resume from the overlay).
- [ ] Hide from the overlay hides the strip; the tray icon brings it back with the creatures having moved on.
- [ ] Quit from the tray exits within a second; with `pnpm dev`, the console shows no "did not shut down in time" line.
- [ ] Sleep the PC for a few minutes with the strip showing. After waking, the creatures carry on from where they were, without sliding across the world or stuttering.

Expanded window (at 100%, 150% and 200%, with two monitors; ADR 0016 §9). Expanding turns the strip's own window into a normal window. Before the first check, delete `expanded` from `settings.json`, or the whole file:

- [ ] The first Expand opens maximized on the strip's monitor, filling the space the band gave back down to the taskbar. Un-maximizing gives a window of about 70% of the monitor, centred.
- [ ] The normal window has a frame, resizes, moves, has a taskbar button and an Alt+Tab entry, and takes focus when clicked. It has no resize handle along the top edge.
- [ ] Expand and Collapse several times in a row: the band goes and comes back once per switch, the strip returns to the same place and height, and it still never takes focus (click it, orbit, use its overlay: the other app stays active and typing goes to it). After Collapse, typing goes to the app that was in front before Expand, not to the strip.
- [ ] Each shape has its own camera: orbit in the strip, expand (the default view), orbit there, collapse (the strip's view is back), expand again (the normal window's view is back). A relaunch starts both at the default view.
- [ ] F11 enters and leaves full screen, covering the whole monitor including the taskbar; Esc leaves it; Esc outside full screen does nothing and never collapses. Home resets the camera, in and out of full screen.
- [ ] The overlay offers Creation Studio, Pause/Resume, Collapse, Reset camera, debug overlays and Full screen (no Hide), and each works. Creation Studio opens or focuses the Studio.
- [ ] The frame's X, the overlay's Collapse and the tray's Collapse each turn the window back into the strip; the app keeps running.
- [ ] Minimizing is an ordinary minimize. On a minimized normal window the tray reads Show; Show and a left-click on the tray icon restore it in front. Left-clicking the tray icon on a normal window in view brings it to the front rather than hiding it.
- [ ] Tray Hide hides the window in either shape and Show brings it back in the same shape. Always on top applies to the strip only. Monitor ▸ moves the strip, not the normal window: collapsing then puts the strip on the chosen monitor.
- [ ] Full screen on each monitor, and back.
- [ ] Drag the normal window onto a monitor with another scale (it neither jumps back nor flickers), collapse, expand: it comes back at the same place and size. The canvas stays sharp on each monitor (issue #55): in the dev tools console `document.querySelector("canvas").width / innerWidth` equals `devicePixelRatio` (capped at 2). The Studio's preview stays sharp when moved too.
- [ ] Maximized, full screen and plain normal windows each come back that way after Collapse and Expand, and after Quit and relaunch (the app itself always starts as the strip). With the saved monitor unplugged, or its scale changed, Expand opens maximized on the strip's monitor instead.
- [ ] Quit while expanded, then relaunch: the strip appears, without taking focus; Expand restores the saved geometry.
- [ ] With a content error (e.g. a broken pack in development), the strip's Details opens the normal window listing every problem; it can be resized and closed back to the strip.

Creation Studio window (once at 100% and once at 150% or 200%, with two monitors; ADR 0015). M11 checked the overlay, single instance, focus, the close dialog, release, My creatures and the cap in the dev app with synthetic input; the tray item, quitting with the Studio open, real pen and mouse pressure, other scale factors and two-monitor sharpness are run in M12:

- [ ] The pencil button in the controls overlay and the tray's Creation Studio each open the Studio in front, focused, with a taskbar button and an Alt+Tab entry.
- [ ] Opening it again, from either, focuses the open Studio instead of opening a second one; a minimized Studio is restored.
- [ ] With the Studio open, clicking, orbiting and zooming in the strip still works. Launched while another app is in front, and with the Studio closed, the strip still never takes focus.
- [ ] With the Studio in front, clicking or dragging in the strip and using its overlay buttons works and keeps the Studio active: Ctrl+Z still undoes in the Studio afterwards. Closing the Studio gives the focus back to the app that was in front before, not to the strip.
- [ ] Pen, eraser, fill, colours, brush sizes, Undo, Redo and Clear work from the toolbar; Ctrl+Z undoes, Ctrl+Y and Ctrl+Shift+Z redo, and Clear can be undone. With a pen, pressing harder draws wider; a mouse draws at the brush's full width however fast it moves, with no spikes on the edges at any brush size, and a stroke doesn't visibly change when the button is released. A long pen stroke with a wobbling pressure stays smooth while it is drawn.
- [ ] Fill (the bucket button, not to be confused with the eraser; the cursor becomes a bucket over the canvas): clicking inside a drawn ring fills it in the current colour right up to the line, with no pale fringe along the line's soft inside edge. Clicking outside a shape that doesn't enclose anything (an L, say) fills the whole open background up to the canvas edge. Clicking a coloured area recolours it, leaving a thin seam of the old colour where it met its outline. Clicking an area already of the current colour does nothing and adds no undo step. Picking another colour keeps the fill tool selected, and the brush sizes are greyed out while it is.
- [ ] Watch for fills that land on a stroke's soft edge instead of the empty area beside it (likeliest with a thin line or a click right next to one): that recolours the few edge pixels of the same exact colour, opaque, instead of filling the area. This is the designed behaviour, but note how often it happens in practice and whether it confuses.
- [ ] Undo and redo take a fill back and bring it again, as one step each. The 3D preview rebuilds after a fill: filling a ring's inside turns the ring into a solid disc, and undoing makes it a ring again.
- [ ] Release a creature with a filled ring and a recoloured area, quit and relaunch: in the strip and in My creatures it looks as it did in the Studio, fill and recolour included.
- [ ] The drawing is the 256 px image, scaled up smoothly: slightly soft, never blocky, at every window size and on a monitor with another scale. The guide line is never part of the drawing.
- [ ] Undo and redo bring back exactly what was shown before, including after an eraser stroke and after Clear; drawing after an undo drops what was undone. After many strokes (a hundred or more), undo still goes back step by step.
- [ ] Beside the canvas, the 3D preview shows the drawing as a body turning slowly, rebuilt a moment after each stroke, fill, undo, redo or clear, and drawing stays smooth meanwhile. Changing the size makes the body bigger or smaller against the grid; a wide drawing still stays in view while it turns. Closing the Studio frees the preview's WebGL context (Task Manager's GPU memory for the app drops back).
- [ ] The name starts as a playful two-part suggestion (such as "Mossy Pebble") that isn't already a name in the library, and the size as Medium. The die beside the name (tooltip "Suggest another name") replaces the name, typed or suggested, with a different suggestion; deleting a species in My creatures doesn't change the suggestion.
- [ ] The Thickness slider under the sizes starts at 40% and runs from 10% to 80% in steps of 5, with the arrow keys too. Moving it makes the preview thinner or thicker at once, with no wait and no stutter; at 10% a body is a thin card, at 80% a deep block. A creature released at 10% or 80% is that thin or thick in the strip, still after a relaunch, and the slider is back at 40% for the next drawing.
- [ ] Hints under the preview: an empty canvas says nothing is drawn yet; a body with a whisker drawn with the smallest brush says a part is very thin and tints it orange in the preview; two separate blobs say parts aren't joined and tint the smaller one blue; a single line on its own is not called thin. Choosing Large says it is too big to cross the wooden bridge (Woodland Hollow); Medium has no size hints. Switching sizes back and forth updates the hints at once.
- [ ] Release is disabled while nothing is drawn, after everything drawn has been erased, and while the name is empty (or only spaces). Closing a Studio whose drawing was all erased closes without asking. Releasing shows "Releasing…", then a short "<name> is off into the world!" and the creature appears in the strip within a few seconds. The canvas is empty with nothing to undo, the name is a new suggestion and the size Medium.
- [ ] My creatures, beside the preview, folds away and back. It lists each released species with its picture, name and count in the world, and the world's total of 20. + adds one, − takes one out (disabled at 0), and the counts follow.
- [ ] Delete asks first, saying how many leave the world; Cancel (or Escape) keeps it, Delete removes it from the list and its creatures from the strip.
- [ ] With 20 creatures in the world, + says the world is full instead of adding one, and Release says the same and keeps the drawing. Taking one out makes room again.
- [ ] After quitting and relaunching, released species are listed again with their pictures and can be added back.
- [ ] Closing an empty Studio closes it at once. Closing it with something drawn asks: Cancel (or Escape) keeps the drawing, Save draft is disabled, Discard closes it.
- [ ] Quit from the tray with the Studio open closes both within a second, with no "did not shut down in time" line.

Living behavior (once, in the dev app at any scale; ADR 0018). Creatures eat, sleep at night and keep a home. Run `pnpm dev`, since the time hook exists only in development builds, then expand the strip and press Ctrl+Shift+I to open the dev tools (the strip itself takes neither right-click nor shortcuts). In the console, `livingDiorama.time.set("21:30")` fixes the time of day, `.follow()` goes back to the real clock, and `.speed(10)` runs simulation time ten times as fast (`.speed(1)` is normal; `.speed(60)` turns a real minute into a simulated hour, and 100 is the most). The time of day stays where it is set, or with the real clock, at any speed. Turn the debug overlays on from the controls overlay to read each creature's needs. Before the first check, start from a fresh world: quit and relaunch.

- [ ] By day, each mossling now and then walks to a mushroom or a bush, stops beside it, turns smoothly in place to face it (half a turn takes about a second) and eats with a small peck (a bob with the front dipping). That happens about every half hour to an hour of real time per creature, or every 3–6 minutes at `.speed(10)`. While walking it shows no eating cue. A creature whose hunger reaches 0.8 shows a speech bubble with a mushroom above it until it eats. By day, with food all around, that is rare. It is likeliest at dawn, after a long night.
- [ ] `livingDiorama.time.set(...)` stepped through `"17:00"`, `"18:00"`, `"18:30"`, `"19:00"`, `"19:30"`, `"20:00"` and `"20:30"` warms the light, then fades it to a moonlit blue-grey in small steps, never a sudden change. The creatures stay readable at night and still cast soft shadows. The same steps from `"04:30"` to `"08:00"` bring the day back. With `.follow()` the light is the real time of day's.
- [ ] At night (`set("23:00")`), the Creation Studio's preview is still lit as by day.
- [ ] `set("19:00")`: the creatures stay up through dusk unless the overlay shows tiredness of 0.9 or more. `set("20:00")`: within about 30 s, each at its own moment, they walk to a round tree (the round, leafy ones, not the pines), turn smoothly in place and lie down beside it, each facing its own random direction (not the tree), and a different one each night. The body lowers a little and breathes slowly, and z's rise from it. Several may share a tree, each at its own side. The overlay shows each creature's home (a pink line to its tree) once it has fallen asleep.
- [ ] `set("06:00")`: within a few seconds the creatures wake, if they have slept enough (tiredness below 0.1 in the overlay; otherwise they sleep on until it is, which can take up to about 40 minutes at `.speed(10)` if the app had been running for hours before bedtime), and go about their day, usually eating first. Set `"20:00"` again: each goes back to its own home, not to whichever tree is nearest.
- [ ] The debug overlay's label above each creature shows its action, its home, its hunger and tiredness, how many food and shelter places it knows and its recent cells, with cyan lines to the places it knows and faint squares for its recent cells.
- [ ] At night (`set("21:30")`, speed 1), release a new drawing from the Studio. It wanders and eats like the others but doesn't lie down in its first 10 minutes. Within a minute or so after that, it goes to a round tree, sleeps and takes it as its home.
- [ ] `.follow()` and `.speed(1)` put the strip back on the real clock. Overnight on the real clock (or from 20:00 to 06:00 with the app running), the creatures go to bed around 20:00 and wake around 06:00, rarely waking in between.

World saving (once, in the dev app at any scale; ADR 0019). The world is saved on quit, every 60 seconds (hidden or not), when the strip is hidden and after a creature is added, taken out or released, and restored at launch. Use a data folder of its own, so the checks never touch your world: `$env:LIVING_DIORAMA_DEV_DATA_DIR = "$env:TEMP\diorama-world"; pnpm dev`, with `VITE_CREATURE_COUNT` unset (the count override skips saving). The save is `world.json` in that folder, and the save before it `world.prev.json`. Turn the debug overlays on to read each creature's needs and home. Before the first check, start from a fresh world: quit, delete `world.json` and `world.prev.json` from the folder, and relaunch. Some checks edit `world.json` with the app closed; the long-gap checks move `savedAt` (milliseconds since the epoch) back, which the app reads as time away (8 hours is 28800000).

- [ ] Release a drawn creature from the Studio, add another species from My creatures, and let the world run until every mossling has a home (a pink line in the overlay; `livingDiorama.time.set("20:00")` speeds this up, then `.follow()`). Note each creature's place, needs and home. Quit from the tray and relaunch within a minute: the same creatures are back, the drawn ones included, each where it was with the same needs and home, and no extra mosslings have joined. Quitting takes no longer than about 3 seconds, and with `pnpm dev` the console shows no "did not shut down in time" line.
- [ ] A short gap resumes exactly: quit while creatures walk, eat or sleep, and relaunch within 2 minutes. Each carries on with what it was doing from where it stood, with no jump. Only the time of day has moved on.
- [ ] Add a creature and quit straight away: it is there after relaunch.
- [ ] Hide the strip from the tray: `world.json`'s modified time changes at once. Leave it hidden for 10 minutes and watch the modified time (`Get-Item "$env:TEMPdiorama-worldworld.json" | Select LastWriteTime`): it never falls more than about a minute behind. Then Tray → Quit and relaunch: the world comes back as it was at quit (the save on quit still runs with the strip hidden).
- [ ] A long gap by day: quit, move `savedAt` back by 8 hours (or relaunch the next morning), and relaunch between 08:00 and 18:00. The creatures are awake, each near its home, with hunger below 0.4. If the gap covered the end of a night they are rested (tiredness near 0). Nothing happens all at once: they don't all eat, wake or walk off on the first tick, and they start doing things one by one over the first 30 seconds or so.
- [ ] A long gap at night: quit, move `savedAt` back by 3 hours or more, and relaunch after 20:30 (or before 05:00). Every mossling is already asleep beside its home tree at launch, with z's, and none walks to bed or wakes.
- [ ] A corrupt save falls back to the backup: quit, cut `world.json` in half (so it is no longer valid JSON) and relaunch. The world comes back as of the save before last (`world.prev.json`), and the app log (Tray → Open log folder) has a warning about `world.json`. After the next save, `world.json` is valid again and the backup is still the old good save.
- [ ] A save that is valid JSON but doesn't fit starts fresh: quit, change `"schemaVersion": 1` to `2` in `world.json` (or the world's `version`), and relaunch. The world starts fresh with 3 mosslings, the log has a warning, and the backup is not used. Do the same with both `world.json` and `world.prev.json` deleted: a fresh world, no warning needed.
- [ ] A save that can't be read for now is left alone: with the app closed, lock `world.json` from another program (PowerShell, kept open: `$f = [IO.File]::Open("$env:TEMP\diorama-world\world.json", 'Open', 'Read', 'None')`), then launch. The world starts fresh, with a warning in the log. Quit, then `$f.Close()`: `world.json` is untouched (same modified time and content), and the next launch brings that world back.
- [ ] A creature whose drawn species is gone is dropped: quit, move that species' folder out of `library/`, and relaunch. Every other creature is back, and the log lists the dropped one. Put the folder back afterwards.
- [ ] `await livingDiorama.world.reset()` takes every creature out and puts the 3 starting mosslings in, and that is what comes back after a relaunch. `await livingDiorama.world.save()` saves at once (`world.json`'s modified time changes).
- [ ] With `VITE_CREATURE_COUNT=5` in `apps/desktop/.env.development.local`, the app starts with 5 mosslings and leaves `world.json` as it was (its modified time doesn't change after several minutes and a quit). Remove the line afterwards; the saved world comes back.
- [ ] In none of the checks above does the app crash or show an error instead of the world.

## Releasing

1. On a branch, set the new version in `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml` (then build once to update `Cargo.lock`) and `apps/desktop/package.json`. Add the player-facing notes as `docs/release-notes/<version>.md` (for example `0.2.0.md`), and merge it. Every version needs its notes file before it is tagged: the workflow publishes it and fails without it. A release candidate tag such as `v0.2.0-rc.1` publishes `0.2.0.md`.
2. Tag the merge commit on `main` and push the tag:

   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```

3. The `Release` workflow checks that the tag matches all three versions and that the notes file exists, builds the NSIS installer and publishes it as a GitHub pre-release (ADR 0009 §10).
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
- [ ] Uninstalling offers **Delete the application data**, unticked. Left unticked, `%APPDATA%\com.livingdiorama.desktop` (settings and the creature library) stays.

Installing over the previous version (install it first, change a few settings, release a creature):

- [ ] The installer offers **Uninstall before installing** (the default) or **Do not uninstall**. With the default, the uninstall page's **Delete the application data** is unticked.
- [ ] The new version starts with the same settings, and My creatures lists the creatures released before.

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
- When upgrading Tauri or tao, re-check the session-end hook (ADR 0019 §4, `platform/windows.rs`): it relies on tao's hidden window class being "Tao Thread Event Target" and on tao exiting the process on `WM_ENDSESSION`. If tao gains a session-end event, use that instead. Then run the Windows restart check in the manual checklist.
- Rust build output (`target/`) can grow to several GB; exclude it from antivirus real-time scanning if builds are slow.
- To run `pnpm dev` with another number of mosslings than the default 3, put `VITE_CREATURE_COUNT=20` in `apps/desktop/.env.development.local` (gitignored). `0` starts with none. Release builds honour it too when it is set at build time (ADR 0016 §10); the release workflow fails if it is set. While it is set, the app neither loads nor writes the saved world (ADR 0019 §11): every launch starts fresh with that count, and the player's `world.json` is left as it was.
- To keep `pnpm dev` away from your own creatures, parts and saved world, set `LIVING_DIORAMA_DEV_DATA_DIR` to a folder before starting it (PowerShell: `$env:LIVING_DIORAMA_DEV_DATA_DIR = "$env:TEMP\diorama-dev"; pnpm dev`). The species library then lives in `library/` under that folder, the parts you draw in `parts/`, and the saved world in `world.json` and `world.prev.json` beside them, instead of `%APPDATA%\com.livingdiorama.desktop`. Release builds ignore it; settings and logs stay where they are.
- In development builds, the dev tools console has two world hooks (ADR 0019 §9): `await livingDiorama.world.reset()` takes every creature out, spawns the three mosslings and saves; `await livingDiorama.world.save()` saves now. The reset keeps the world's seed, tick, creature ID counter and any edits to its props (ADR 0021), so it is not a wholly fresh world; for that, quit and delete `world.json` and `world.prev.json`. There is no reset for players.
- Development builds also edit the world's props from the console (ADR 0021 §12), through the same undo history as the prop editor: `await livingDiorama.world.edit({ ops: [{ op: "prop.add", prop: "hollow:rock", position: { x: 0, z: 0 } }] })` applies an edit and resolves with the result (the edit as applied, its inverse, footprints, warnings and moved creatures) or the rejection; `await livingDiorama.world.validate(edit)` says what an edit would do without doing it; `await livingDiorama.world.undo()` and `.redo()` undo and redo the last edit, made here or in the editor, and resolve undefined when there is nothing to undo or redo. The ops are `prop.add` (`prop`, `position: { x, z }`, optional `rotationY`, `scale` and `id`), `prop.remove` (`id`), `prop.move` (`id` with `position`, `rotationY` or both) and `prop.scale` (`id`, `scale`); the built-in placements' IDs are in `packages/built-in-content/src/woodland-hollow/world.json`, and an added one comes back in the edit's result. A restore or `world.reset()` forgets the undo history.
- `pnpm sim --save <file>` writes the world as a headless run leaves it, in the app's save format, and `pnpm sim --load <file>` carries on from such a save instead of a fresh world: `--gap <minutes>` says how much wall-clock time passed since it was made (default 0, an exact resume; 2 minutes or more is caught up as in the app). Both run at the app's 10 Hz only and refuse another `--hz`, because a save doesn't record its tick rate. A save from `pnpm sim` can be copied into a dev data folder as `world.json`, and the app's `world.json` can be loaded with `--load`. `pnpm soak` saves and restores every run several times and checks each restore (`tools/development/README.md`).
- `pnpm sim --species voxel-walk,voxel-hop,voxel-swim,voxel-land+swim` runs voxel creatures headless (ADR 0022): the sample voxel creature of `built-in-content` (`sampleVoxelAssembly()`, the one the dev console's `livingDiorama.library.saveVoxelSample(plan)` saves) as a species of each body plan, its size class measured from its cubes (`measureAssembly`). The fixture (`tools/development/src/fixtures/voxel-creatures.ts`) registers them as the app registers library species, with `registerSpecies(species, url, "voxel")` while the world runs and again before a save is restored, so `--save` and `--load` keep their creatures. The worker gets the assembly's URL only and never reads it.
- Voxel parts are made in [MagicaVoxel](https://ephtracy.github.io/) (ADR 0022). Each part is a `<name>.vox` in `packages/built-in-content/src/woodland-hollow/voxel-parts/vox/` with a sidecar `<name>.json` beside it (`id`, `version`, `name`, part `type`, cube `step` in metres, `attach` point and `sockets`, in the part's cubes). Keep one model per file, unrotated, at most 32 cubes along each axis; materials are ignored. MagicaVoxel's z is up: the importer takes part X = vox x, Y = vox z and Z = size.y − 1 − vox y, so the creature faces +x and its right is −y in MagicaVoxel. After saving, run `pnpm parts` and commit the `.vox`, the sidecar and the generated `voxel-parts/parts/<name>.json`; a test fails while the committed definitions don't match their sources. The mossling species is drawn from a frozen copy of its parts (`woodland-hollow/assets/voxels/mossling.json`): after changing a part it uses (its torso, head and foot, the round eye or the smile), commit the asset too, which `pnpm parts` (with no options) writes again after the parts; a test fails while it differs. Never edit the generated files by hand. The starter parts' first-pass files were written by `pnpm parts:bootstrap` from recipes in code (`tools/development/src/voxel-parts/starter-parts.ts`); since then the `.vox` files and sidecars are their sources, so refine them in MagicaVoxel and by hand, not in the recipes. `pnpm parts:bootstrap` only writes files that are missing. `pnpm parts:bootstrap --force round-eye` makes the named parts again from their recipes; **`--force` with no part named overwrites every starter part, losing every refinement made since**, so name the parts.
- `pnpm sim --edits <file>` applies world edits during a headless run (ADR 0021): a JSON array of `{ "tick": n, "edit": { "ops": [...] } }` (the edit as the app's worker takes it) or `{ "tick": n, "undo": true }`, where `tick` counts steps from the run's start and the edit applies before that step. It prints each result (ops as applied, relocated creatures, warnings, or why it was refused, and the time it took) and writes it to the NDJSON. For example, `[{ "tick": 50, "edit": { "ops": [{ "op": "prop.add", "prop": "hollow:round-tree", "position": { "x": 13, "z": 6 }, "scale": 2 }] } }, { "tick": 150, "undo": true }]` drops a tree on the `meadow` spawn point, moving whoever stands there, and takes it away again. `pnpm soak` also makes 24 random prop edits per run (`--edits`, 0 for none), about one in five an undo, and reports their counts and `applyEdit` times. `pnpm rebuild-time` times a full rebuild and `validateEdit` and `applyEdit` in a running world of 20 creatures.
- Two soaks run the long-run, living-behavior and save/restore checks at the app's 10 Hz; CI runs neither. `pnpm soak:quick` (3 seeds × one simulated day from noon, so a full night of sleep and waking, with 12 restores, and two amphibians (one that keeps to the water), one water-only swimmer, and two voxel creatures, an amphibian and a hopper, beside 2 mosslings; about 40 s) goes before opening any PR that touches `packages/simulation`, navigation, world content (`packages/built-in-content`, worldgen) or save/restore. The full `pnpm soak` (32 seeds × one day; about 3 min on 16 logical cores) is for PRs that change simulation, navigation or save logic substantially (new movement or navigation rules, new behaviours, save format changes); run it once before the PR is ready, not on every fix round. Renderer, Studio, docs and app-only PRs need neither.
- Both soaks run `--jobs` seeds at a time, each in a worker thread, by default one per logical core; `--jobs 1` runs them one after another. A seed takes about 32 s alone but 55–85 s with every core busy, so more jobs pay off only up to the number of logical cores: on a Ryzen 7 9700X (8 cores, 16 threads) the full soak took about 17 min with 1 job, 162 s with 16, and 193 s with 15 (a tail of 2 seeds after two rounds of 15). On a smaller machine expect the full soak to take longer in proportion. Each worker uses about 275 MB, so 16 jobs peaked at about 4.4 GB on a full 24 h run; on a machine with less RAM, pass a smaller `--jobs`.
- `pnpm measure` samples the running app's CPU, GPU and memory into a CSV under `tools/development/out/measurements/` (ADR 0009 §5–7). Start a release build first (`pnpm tauri build --no-bundle`, then `apps\desktop\src-tauri\target\release\living-diorama.exe`). With no arguments it measures the four baseline states, 5 minutes each, and says how to put the app in each one. For the soak test run `pnpm measure -States soak -Minutes 480 -IntervalSeconds 10`; it ends with the stuck and path-failed counts the app writes to `%LOCALAPPDATA%\com.livingdiorama.desktop\event-counts.json`. Results go in [performance.md](performance.md).

## Measuring with many creatures

v0.2 measures a release build with 20 creatures, many of them of different species (ADR 0016 §10–13, ADR 0025 §12). A build with `VITE_CREATURE_COUNT` set neither loads nor saves the world (ADR 0019 §11), so measuring never touches a saved world. The species come from a library of 20 sample voxel species generated in the dev app, copied to where the release app keeps its library. All commands are PowerShell, from the repository root.

1. **Generate the 20 species** in a library folder of their own:

   ```powershell
   $env:LIVING_DIORAMA_DEV_DATA_DIR = "$env:TEMP\diorama-measure"; pnpm dev
   ```

   Expand the strip, press Ctrl+Shift+I to open the dev tools (the strip itself takes neither right-click nor shortcuts) and run `await livingDiorama.library.saveVoxelSamples()` in the console. It assembles Bramble, Pip, … Hazel from the starter parts with fixed seeds (`VOXEL_SAMPLES` in `apps/desktop/src/dev-library.ts`: all four torsos, small, medium and large, walkers, hoppers, two swimmers and two that walk and swim), saves them through the library as the Studio releases a creature, without adding any to the world, and resolves with the species it could not save: `[]` when all 20 were saved. Quit the app. `$env:TEMP\diorama-measure\library` now holds 20 folders.

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

5. **20 creatures of different voxel species:** build with no mosslings:

   ```powershell
   $env:VITE_CREATURE_COUNT = "0"; pnpm tauri build --no-bundle; Remove-Item Env:VITE_CREATURE_COUNT
   ```

   Start the exe, open the Creation Studio, unfold My creatures & parts and click Add once on each of the 20 species. The two swimmers (Dewdrop and Sorrel) appear in the river. Close the Studio, then `pnpm measure`.

6. **The soak mix: 3 mosslings and 17 different sample species.** Build without the variable, as for 3 mosslings. Delete `$data\world.json` and `$data\world.prev.json` left by the 3-mossling run, so the world starts fresh. Start the exe, click Add once on every species in My creatures except the last three (Burdock, Tansy and Hazel), close the Studio and show the strip with the cursor off it. Then `pnpm measure -States soak -Minutes 480 -IntervalSeconds 10`.

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
- [ ] Sleep the PC for under 2 minutes with the strip showing. After waking, the creatures carry on from where they were, without sliding across the world or stuttering. (A longer sleep is caught up: see World saving.)

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

Creation Studio window (once at 100% and once at 150% or 200%, with two monitors; ADR 0015). These check the window itself, My creatures & parts and closing; Build mode and Draw mode have their own entries, "Building a creature" and "Drawing a part", below:

- [ ] The pencil button in the controls overlay and the tray's Creation Studio each open the Studio in front, focused, with a taskbar button and an Alt+Tab entry.
- [ ] Opening it again, from either, focuses the open Studio instead of opening a second one; a minimized Studio is restored.
- [ ] With the Studio open, clicking, orbiting and zooming in the strip still works. Launched while another app is in front, and with the Studio closed, the strip still never takes focus.
- [ ] With the Studio in front, clicking or dragging in the strip and using its overlay buttons works and keeps the Studio active: Ctrl+Z still undoes in the Studio afterwards. Closing the Studio gives the focus back to the app that was in front before, not to the strip.
- [ ] The 3D views (Build mode's assembly view, Draw mode's part preview) are sharp at every window size and on a monitor with another scale. Closing the Studio frees their WebGL contexts (Task Manager's GPU memory for the app drops back).
- [ ] The name starts as a playful two-part suggestion (such as "Mossy Pebble") that isn't already a name in the library. The die beside the name (tooltip "Suggest another name") replaces the name, typed or suggested, with a different suggestion; deleting a species in My creatures doesn't change the suggestion.
- [ ] My creatures & parts, beside the 3D view, folds away and back, in both modes. Under its "My creatures" heading it lists each released species with its picture, name and count in the world, and the world's total of 20. + adds one, − takes one out (disabled at 0), and the counts follow. "My parts" below it lists the parts you have drawn.
- [ ] Delete asks first, saying how many leave the world; Cancel (or Escape) keeps it, Delete removes it from the list and its creatures from the strip.
- [ ] With 20 creatures in the world, + says the world is full instead of adding one, and Release says the same and keeps the creature. Taking one out makes room again.
- [ ] After quitting and relaunching, released species are listed again with their pictures and can be added back.
- [ ] Closing an untouched Studio closes it at once. Closing it with a creature in Build that wasn't released asks "Close the Studio?": Cancel (or Escape) keeps it, Save draft is disabled, Discard closes it. With an unsaved part in Draw mode it says the part would be lost, and with both, both.
- [ ] Quit from the tray with the Studio open closes both within a second, with no "did not shut down in time" line.

Living behavior (once, in the dev app at any scale; ADR 0018). Creatures eat, sleep at night and keep a home. Run `pnpm dev`, since the time hook exists only in development builds, then expand the strip and press Ctrl+Shift+I to open the dev tools (the strip itself takes neither right-click nor shortcuts). In the console, `livingDiorama.time.set("21:30")` fixes the time of day, `.follow()` goes back to the real clock, and `.speed(10)` runs simulation time ten times as fast (`.speed(1)` is normal; `.speed(60)` turns a real minute into a simulated hour, and 100 is the most). The time of day stays where it is set, or with the real clock, at any speed. Turn the debug overlays on from the controls overlay to read each creature's needs. Before the first check, start from a fresh world: quit and relaunch.

- [ ] By day, each mossling now and then walks to a mushroom or a bush, stops beside it, turns smoothly in place to face it (half a turn takes about a second) and eats with a small peck (a bob with the front dipping). That happens about every half hour to an hour of real time per creature, or every 3–6 minutes at `.speed(10)`. While walking it shows no eating cue. A creature whose hunger reaches 0.8 shows a speech bubble with a red fruit above it until it eats. By day, with food all around, that is rare. It is likeliest at dawn, after a long night.
- [ ] `livingDiorama.time.set(...)` stepped through `"17:00"`, `"18:00"`, `"18:30"`, `"19:00"`, `"19:30"`, `"20:00"` and `"20:30"` warms the light, then fades it to a moonlit blue-grey in small steps, never a sudden change. The creatures stay readable at night and still cast soft shadows. The same steps from `"04:30"` to `"08:00"` bring the day back. With `.follow()` the light is the real time of day's.
- [ ] At night (`set("23:00")`), the Creation Studio's preview is still lit as by day.
- [ ] `set("19:00")`: the creatures stay up through dusk unless the overlay shows tiredness of 0.9 or more. `set("20:30")`: within about 30 s, each at its own moment, they walk to a round tree (the round, leafy ones, not the pines), turn smoothly in place and lie down beside it, each facing its own random direction (not the tree), and a different one each night. The body lowers a little and breathes slowly, and z's rise from it. Several may share a tree, each at its own side. The overlay shows each creature's home (a pink line to its tree) once it has fallen asleep. Each creature's own night starts up to half an hour either side of 20:00, a different time each night ([#85](https://github.com/zhangwy324/living-diorama/issues/85)), so at `set("20:00")` some go to bed at once and others only up to 30 minutes later.
- [ ] `set("06:30")`: within a few seconds the creatures wake (each one's own dawn falls between 05:30 and 06:30), if they have slept enough (tiredness below 0.1 in the overlay; otherwise they sleep on until it is, which can take up to about 40 minutes at `.speed(10)` if the app had been running for hours before bedtime), and go about their day, usually eating first. Set `"20:30"` again: each goes back to its own home, not to whichever tree is nearest.
- [ ] The debug overlay's label above each creature shows its action, its home, its hunger and tiredness, how many food and shelter places it knows and its recent cells, with cyan lines to the places it knows and faint squares for its recent cells.
- [ ] At night (`set("21:30")`, speed 1), release a new creature from the Studio. It wanders and eats like the others but doesn't lie down in its first 10 minutes. Within a minute or so after that, it goes to a round tree, sleeps and takes it as its home.
- [ ] `.follow()` and `.speed(1)` put the strip back on the real clock. Overnight on the real clock (or from 20:00 to 06:00 with the app running), the creatures go to bed between about 19:30 and 20:30 and wake between about 05:30 and 06:30, each at a different time each night, rarely waking in between.

World saving (once, in the dev app at any scale; ADR 0019). The world is saved on quit, every 60 seconds (hidden or not), when the strip is hidden, after a creature is added, taken out or released and after a world edit, and restored at launch. An edited world is saved whole (ADR 0021 §4). Use a data folder of its own, so the checks never touch your world: `$env:LIVING_DIORAMA_DEV_DATA_DIR = "$env:TEMP\diorama-world"; pnpm dev`, with `VITE_CREATURE_COUNT` unset (the count override skips saving). The save is `world.json` in that folder, and the save before it `world.prev.json`. Turn the debug overlays on to read each creature's needs and home. Before the first check, start from a fresh world: quit, delete `world.json` and `world.prev.json` from the folder, and relaunch. Some checks edit `world.json` with the app closed; the long-gap checks move `savedAt` (milliseconds since the epoch) back, which the app reads as time away (8 hours is 28800000).

- [ ] Release a creature from the Studio, add another species from My creatures, and let the world run until every mossling has a home (a pink line in the overlay; `livingDiorama.time.set("20:00")` speeds this up, then `.follow()`). Note each creature's place, needs and home. Quit from the tray and relaunch within a minute: the same creatures are back, the released ones included, each where it was with the same needs and home, and no extra mosslings have joined. Quitting takes no longer than about 3 seconds, and with `pnpm dev` the console shows no "did not shut down in time" line.
- [ ] A short gap resumes exactly: quit while creatures walk, eat or sleep, and relaunch within 2 minutes. Each carries on with what it was doing from where it stood, with no jump. Only the time of day has moved on.
- [ ] Add a creature and quit straight away: it is there after relaunch.
- [ ] Hide the strip from the tray: `world.json`'s modified time changes at once. Leave it hidden for 10 minutes and watch the modified time (`Get-Item "$env:TEMP\diorama-world\world.json" | Select LastWriteTime`): it never falls more than about a minute behind. Then Tray → Quit and relaunch: the world comes back as it was at quit (the save on quit still runs with the strip hidden).
- [ ] Windows restart saves the world (ADR 0019 §4): add a creature, then within a minute (before the next autosave) restart Windows from Start → Power → Restart. Watch for Windows' "This app is preventing restart" screen: Living Diorama must not hold the restart up, or shows there only briefly with "Saving the world" (at most about 3 seconds). After signing in, launch the app: the new creature is there. The previous run's log has "The Windows session is ending; saving the world" and no "not saved in time" line. Repeat with Sign out, once with the strip hidden from the tray and once with the Studio open.
- [ ] A cancelled restart quits cleanly: with Notepad holding unsaved text, start a restart and press Cancel on Windows' blocking screen. Living Diorama has quit with the world saved, and no `living-diorama.exe` is left in Task Manager.
- [ ] A long gap by day: quit, move `savedAt` back by 8 hours (or relaunch the next morning), and relaunch between 08:00 and 18:00. The creatures are awake, each near its home, with hunger below 0.4. If the gap covered the end of a night they are rested (tiredness near 0). Nothing happens all at once: they don't all eat, wake or walk off on the first tick, and they start doing things one by one over the first 30 seconds or so.
- [ ] A long gap at night: quit, move `savedAt` back by 3 hours or more, and relaunch after 20:30 (or before 05:00). Every mossling is already asleep beside its home tree at launch, with z's, and none walks to bed or wakes.
- [ ] An OS sleep with the app open is caught up as a relaunch would be ([#113](https://github.com/zhangwy324/living-diorama/issues/113)): with the creatures awake by day, sleep the PC (Start → Power → Sleep) for over 2 minutes, ideally overnight, and wake it. Within a second the creatures are where a relaunch after the same gap would put them, without sliding or a burst of fast movement: by morning, rested, fed and near home; at night, asleep at home. With `pnpm dev`, the console has "Caught up N min the world lost", with N about the time asleep (12 hours at most). Repeat with the world paused from the overlay: after waking and resuming, nothing is caught up and the creatures carry on from where they were.
- [ ] A corrupt save falls back to the backup: quit, cut `world.json` in half (so it is no longer valid JSON) and relaunch. The world comes back as of the save before last (`world.prev.json`), and the app log (Tray → Open log folder) has a warning about `world.json`. After the next save, `world.json` is valid again and the backup is still the old good save.
- [ ] A save that is valid JSON but doesn't fit starts fresh: quit, change `"schemaVersion": 4` to `3` in `world.json` (or the world's `version`), and relaunch. The world starts fresh with 3 mosslings, the log has a warning, and the backup is not used. Do the same with both `world.json` and `world.prev.json` deleted: a fresh world, no warning needed.
- [ ] A save that can't be read for now is left alone: with the app closed, lock `world.json` from another program (PowerShell, kept open: `$f = [IO.File]::Open("$env:TEMP\diorama-world\world.json", 'Open', 'Read', 'None')`), then launch. The world starts fresh, with a warning in the log. Quit, then `$f.Close()`: `world.json` is untouched (same modified time and content), and the next launch brings that world back.
- [ ] A creature whose species is gone from the library is dropped: quit, move that species' folder out of `library/`, and relaunch. Every other creature is back, and the log lists the dropped one. Put the folder back afterwards.
- [ ] `await livingDiorama.world.reset()` takes every creature out and puts the 3 starting mosslings in, and that is what comes back after a relaunch. `await livingDiorama.world.save()` saves at once (`world.json`'s modified time changes).
- [ ] With `VITE_CREATURE_COUNT=5` in `apps/desktop/.env.development.local`, the app starts with 5 mosslings and leaves `world.json` as it was (its modified time doesn't change after several minutes and a quit). Remove the line afterwards; the saved world comes back.
- [ ] In none of the checks above does the app crash or show an error instead of the world.

Swimming, hopping and animation (once, in the dev app at any scale; ADR 0020, M16). Creatures move on land, in water or both, and on land they walk or hop; each way of moving has its own whole-body animation. `pnpm sim --species mossling,amphibian,swimmer,hopper` runs the same mix headless first, if you want to see where they go. In the app, build one creature of each kind below in the Studio's Build mode and release it, choosing its ways of moving in the confirm step (Next: how it moves →, checked under "Building a creature"; the checks here look closer at how they move). The river's spawn point is in the water about 13 m downstream of the bridge, near the default camera.

- [ ] A water-only swimmer appears in the river and never leaves it: not onto a bank, not onto the bridge. It sits about half its height down in the water, sways from side to side as it swims, with the tail sweeping wider than the head, and keeps a gentle bob when it stops. It eats only if it finds the one bush whose feeding spot is in the water (on the west bank near the river's north end, reached under the bridge); otherwise it shows the hungry cue in time, which is accepted until water food arrives. At night it sleeps where it is.
- [ ] An amphibious walker (land and swimming) walks on land and, now and then, jumps into the river from a bank in a short leaping arc, sinking smoothly to its swimming depth over the jump, swims with the sway, and climbs out on either bank the same way, rising as it leaves. It may use the bridge too. By the bridge, no jump starts or lands under the deck or against its side, and none passes through it, at any size. Nothing ever floats above the water, sinks below the surface past half its height or stands in the bank.
- [ ] An amphibious hopper does the same but hops on land and swims in water.
- [ ] A land-only hopper hops everywhere: it squashes as it lands, gathers low, then leaves in an arc, stretching, nose up then nose down. It crosses the bridge hopping and never goes into the water.
- [ ] The mosslings walk with a small bob and side-to-side waddle in step with their speed, still never enter the water and still find the bridge.
- [ ] Creatures standing still, eating or sleeping don't walk, hop or sway in place (only a swimmer's bob keeps going), and a faster creature steps faster. Pause holds every creature in its pose mid-stride or mid-hop; Resume carries on from there.
- [ ] Setting off never snaps: a creature turns towards where it is going at its usual turn rate, standing while it faces far away and walking on while it finishes the turn (#121).
- [ ] Quit with the swimmer and an amphibian in the water, and relaunch within a minute: both are back in the water, at the same depth, and carry on swimming.

Prop editing (once, in the dev app at any scale; ADR 0021, M17). Edit mode edits the world's props while the creatures carry on. It is in the normal window only (Expand first), so its keys work. Use a data folder of its own, as for World saving (`$env:LIVING_DIORAMA_DEV_DATA_DIR = "$env:TEMP\diorama-edit"; pnpm dev`), and start from a fresh world. Every key also has a toolbar button. Turn the debug overlays on where a check needs walkability.

- [ ] The strip's overlay has no Edit props button. In the normal window, the move button (four arrows) turns Edit mode on: it shows pressed, a toolbar appears in the top-left corner with the drawer's toggle (shown pressed), Turn left, Turn right, Delete, Undo and Redo, and a line under it saying what a click does, and the prop drawer slides in from the right. The drawer pushes the world view narrower instead of covering it: the whole world is still in view, smaller, and the overlay's buttons move left to stay on the world. Neither covers the other, also with the window made small. The world keeps running: the creatures keep moving and the clock doesn't pause. Pressing the button again leaves Edit mode: the toolbar and the drawer go, the world view takes the whole window again, and any selection goes too.
- [ ] The drawer has a tab per category, in order: Trees (Pine, Round tree), Rocks (Rock), Plants (Bush) and Mushrooms (Mushroom), and no Other tab, since every built-in prop has a category. Each tile shows a picture of the prop and its name; a tab's pictures appear when it is first shown. Tab moves to the tabs, and the arrow keys, Home and End move between them. The close button (×) and the toolbar's toggle close the drawer and keep Edit mode and the selection; the toggle opens it again on the tab last shown. Leaving and entering Edit mode opens it again.
- [ ] Collapse to the strip while editing: Edit mode ends. A turn or scale made just before is kept (it is there after expanding again, and Undo takes it back); a drag or a placement under way is dropped, leaving no see-through copy and no hidden prop. Expanding again doesn't turn Edit mode back on.
- [ ] Clicking a prop selects it: a yellow ring at its foot, and the line says "Drag it to move, scroll to scale". Clicking another prop selects that one; clicking the ground, or Esc, deselects. A small prop partly hidden behind a tree or the cliff can't be clicked through it.
- [ ] Dragging anywhere but on the selected prop still orbits the camera, the wheel still zooms when nothing is selected, and right-drag still pans. A double click doesn't reset the camera while editing (the overlay's Reset camera still does).
- [ ] Dragging the selected prop shows a see-through copy following the pointer on the ground, with the prop itself hidden; the creatures keep moving. On release the prop is there, standing on the ground, after at most a short pause (the world is rebuilt once, about 10–50 ms), and the ring has followed it. It never jumps back to where it was for a frame. Dragging off the world's edge leaves it where the pointer last met the ground.
- [ ] With a prop selected, the wheel scales it (up grows, down shrinks), shown see-through while scrolling, and is committed once, about a third of a second after the last notch: one undo step however many notches. The camera doesn't zoom meanwhile. Shrinking by many notches never makes it vanish or refuse as zero.
- [ ] Turn left and Turn right (R and Shift+R) turn the selected prop by 15° a press, shown see-through and committed shortly after the last press. A turn followed by a scroll is one undo step.
- [ ] Delete (Delete or Backspace) removes the selected prop. A mossling that had it as its home, or was walking to eat it, carries on with something else.
- [ ] Dragging a tile into the world shows a see-through copy following the pointer over the ground, with the line saying "Release over the ground to place …"; R and Shift+R turn it at once. Releasing over the ground places it there, selects it, and the copy never vanishes before the prop is drawn; the camera doesn't move during the drag. Releasing over the drawer, over the toolbar, or past the world's edge places nothing and ends placing; so do Esc during the drag, and collapsing to the strip.
- [ ] Clicking a tile (it shows pressed) also places: a see-through copy follows the pointer over the ground and goes while the pointer is over the drawer; Turn left and Turn right turn it. A click on the ground places it there and selects it; a drag still orbits and places nothing. Esc, clicking the pressed tile again, or closing the drawer stops placing.
- [ ] Undo and Redo (Ctrl+Z, and Ctrl+Y or Ctrl+Shift+Z) take back and bring back each edit, one at a time, in order: a move, a delete (the prop comes back), an add (it goes again), a scale and a turn. Undo and Redo are greyed out when there is nothing to undo or redo, and a new edit after an undo drops what was undone. The console's `livingDiorama.world.undo()` shares the same history.
- [ ] Refused edits say why in red for a few seconds and change nothing, the prop staying where it was: drag a prop or scale one so that it reaches past the world's edge ("would reach outside the world"). Accepted edits that need saying, in amber: scale a rock over a mossling ("Moved 1 creature out of the way", and it stands beside the rock), and over the woods' glade spawn point (the spawn point warning). With an amphibian released from the Studio, a rock scaled over a river bank names the blocked way out of the water.
- [ ] Edit, then quit from the tray and relaunch: the edits are there, and Undo is greyed out (the history isn't saved). Edit, then `await livingDiorama.world.reset()`: the edits stay, the selection and the undo history go.
- [ ] Move a round tree a mossling sleeps by at night (`livingDiorama.time.set("21:00")`): it gets up and walks to its home where it now stands, or picks another. Delete it: the mossling picks a new home. No creature is ever left inside a prop or stuck.

Voxel creatures (once, in the dev app at any scale; ADR 0022, M19). These checks use a sample creature added from the console, so they don't depend on the Studio's Build mode (checked under Building a creature below): a fox-coloured creature of 5 cm boxes about 72 cm long (size class `medium`). Use a data folder of its own, as for World saving (`$env:LIVING_DIORAMA_DEV_DATA_DIR = "$env:TEMP\diorama-voxel"; pnpm dev`), then expand the strip and press Ctrl+Shift+I for the dev tools. `await livingDiorama.library.saveVoxelSample("walk")` saves the sample as a new species and adds one of its creatures; the plan is `"walk"`, `"hop"`, `"swim"` or `"land+swim"`, and a name may follow it. The answer is `{ ok: true, value: { species, creatureId } }`, or `ok: false` with the reasons.

- [ ] Add a walker, a hopper, a swimmer and a land-and-swim one. Each appears as a body of blocks (a torso, four legs, a head with two small dark eyes, a tail), standing on the ground with its feet, not sunk into it or floating, and facing the way it goes.
- [ ] The walker walks with the whole-body bob and waddle of the mosslings, and the hopper hops with the squash and stretch; both cross the bridge and keep out of the water.
- [ ] The swimmer appears in the river and stays there, half under the surface, swaying from near its head so the tail sweeps. The land-and-swim one walks, jumps into the river from a bank now and then, swims and climbs out.
- [ ] Its colours sit with the world's: shaded like the props and terrain, not glowing or flat. The joins between parts don't flicker as the camera turns, and its shadow meets its feet.
- [ ] By night (`livingDiorama.time.set("22:00")`) the voxel creatures are lit like the others and still readable, and they sleep like them. `livingDiorama.time.follow()` afterwards.
- [ ] Open the Creation Studio and unfold My creatures & parts: it lists each voxel species with a picture of its blocks (a placeholder block until its picture is ready, a moment after the panel opens), its name and its count. + and − add and take out creatures of it, and Delete removes the species and its creatures.
- [ ] Quit from the tray and relaunch: the voxel species are listed again, and every voxel creature is back where it was, moving its own way. The app log has no warning about the library.

Starter creatures (in the dev app; ADR 0022, M20). The console builds random creatures from the starter parts, with no Studio. `livingDiorama.library.starterParts()` lists the registered parts (`id`, `name`, `type`) as a table. `await livingDiorama.library.saveStarterCreature({ root, seed, plan, name })` assembles a creature from them with the assembler (`assembleParts`), saves it to My creatures and adds one of it to the world, as `saveVoxelSample` does; every option may be left out. `root` is the ID of the part to build on; by default the seed picks one of the parts no other part has a socket for (the torsos). `seed` is a whole number from 0 to 2³² − 1, random by default; `plan` is as for `saveVoxelSample` (default `"walk"`) and the name defaults to `Starter <seed>`. It logs and returns the species, the creature's ID, the root and the seed: the same root, seed and parts build the same creature again. With no parts registered it answers `no_root`.

- [ ] Add a few starter creatures with random seeds: each stands on the ground with its parts joined, pairs alike on both sides, and moves its plan's way. Adding one again with a logged seed gives the same creature.

The voxel mossling (in the dev app; ADR 0022, M20). The built-in mossling is made of voxels: its own round green body, head and feet with the starter round eyes and smile, from its frozen assembly (`packages/built-in-content/src/woodland-hollow/assets/voxels/mossling.json`). Use a data folder of its own, as for World saving, so the three mosslings start fresh.

- [ ] The three mosslings appear as round green voxel critters about half a metre tall, with two dark eyes, a smile, pink cheeks and two feet, standing on the ground with their feet, not sunk or floating, and facing the way they go. No flat or extruded drawing of a mossling shows anywhere, and the app log has no warning about loading it.
- [ ] They walk with the whole-body bob and waddle as before, eat at mushrooms and bushes, cross the bridge and keep out of the water. At night (`livingDiorama.time.set("22:00")`) they go to the round trees and sleep, lit like the props and still readable; `livingDiorama.time.follow()` afterwards.
- [ ] Close up, the joins between the body, the feet and the face don't flicker as the camera turns, and the shadow meets the feet.
- [ ] Quit from the tray and relaunch: the three mosslings are back where they were, as voxels.

Building a creature (once, in the dev app at any scale; ADR 0023, M21). The Studio opens in Build mode, which assembles a voxel creature from the registered parts, yours among them; Draw mode draws parts ("Drawing a part", below). How it fits together: the Studio asks the strip for the parts with the `parts` channel request (answered from the latest `ready`, so it retries until the world runs); `AssemblyEditor.tsx` keeps the creature as immutable assembly snapshots (`assembly-state.ts` over content-schema's `voxel-edit.ts` operations, which only ever return valid assemblies) and shows it in the renderer's assembly view; Release sends `releaseVoxel`, which saves it with `SpeciesLibrary.saveVoxel`. My creatures asks for a voxel species' assembly with the `assembly` request and draws its picture with `VoxelThumbnails` (`voxel-thumbnails.ts`); Edit a copy loads that assembly into Build mode. Use a data folder of its own, as for World saving (`$env:LIVING_DIORAMA_DEV_DATA_DIR = "$env:TEMP\diorama-build"; pnpm dev`).

- [ ] Open the Studio: it opens in Build mode, with the parts tray by part type (torsos first), each part with its picture, and the default four-legged torso in the 3D view. Drag orbits the view and the wheel zooms. Build and Draw switch modes, and each keeps its work: the creature in Build, the part in Draw.
- [ ] Click a tray part: the free sockets it fits are marked, and hovering one shows a see-through copy of the part there. Click a socket to place it; with Mirror on (the default) the other side gets one too. A part that fits only one place is placed at once. Click a placed part to select it; Delete removes it with what hangs from it, and Escape drops the pick and the selection. Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z undo and redo each edit.
- [ ] Drag a tray part onto a marked socket: it is placed as a click would. Select a part: its colour slots show as swatches; pick a slot and a suggested colour, then Any colour…: the part and its mirror image change, and the other legs of a shared copy don't. Moving the picker recolours live and is one undo step. Turn part (R) turns it a quarter turn. Smaller part (−) and Bigger part (+ or =) step it, and Smaller creature and Bigger creature step the whole creature: the size readout follows, a stepped part stays joined to its socket (snapped to the finer grid, never refused for it), only a step that would leave a joint too shallow is refused with a reason, and parts of very different cube sizes give the step-spread hint. Randomize builds a new creature; Fill empty puts parts on the free sockets and keeps those placed; Reset goes back to the default torso and is greyed out when there is nothing to reset.
- [ ] Next: how it moves → shows the confirm step; the view walks the creature in place (it hops, swims or both as ticked). ← Back keeps the creature. Release shows "Releasing…", then "<name> is off into the world!"; the creature appears in the strip within a few seconds, standing on its feet and moving its chosen way, and Build starts over from the default torso.
- [ ] Unfold My creatures & parts: the new species is listed with a picture of its blocks, its name and its count. + and − add and take out creatures of it.
- [ ] Place a part in Build without releasing, then press Edit a copy (the pencil) on a voxel species: it asks "Discard your creature?"; Cancel (or Escape) keeps the creature, Discard loads the copy. With nothing changed in Build, Edit a copy loads at once without asking.
- [ ] Press Edit a copy on the released species: the Studio switches to Build mode and shows that creature named "<name> copy", ready to edit, with nothing to undo and Reset greyed out. Closing the Studio without changing it closes at once; after one edit it asks first, and Reset goes back to the loaded creature, not the default torso. Change it and release it: it is listed as a second species beside the first, which is unchanged in the list and in the world. Edit a copy pressed while a release is on its way loads once the release is done.
- [ ] Quit from the tray and relaunch: both species are listed again with their pictures, and their creatures are back in the world.

Per-part motion (once, in the dev app at any scale; ADR 0024, M22). Voxel creatures move their parts: the part's type picks the motion (`swing`, `wag`, `bob`, `flop`, `blink`, `paddle`), its size scales it and the gait sets one rhythm per creature. Add a few starter creatures from the console (`await livingDiorama.library.saveStarterCreature({ seed: 1 })`, then seeds 3 and 5) and expand the strip.

- [ ] Walking, each starter creature's legs visibly step, about twice a second at its usual walk: four legs in diagonal pairs, two legs alternating. An upright creature's arms swing against its legs, less than the legs. The body bobs once per step, its feet neither sink into the ground nor float above it, and it doesn't lift as it leans into the walk.
- [ ] Seeds 1 and 5 (the same torso on stout legs and on mossling feet) keep the same rhythm, as every starter leg does, but their feet trace different paths: compare the size and shape of each foot's arc side by side close up.
- [ ] Standing still, a creature's legs don't move, but it blinks every few seconds, now and then twitches an ear (never during a blink) and flicks its tail. Neighbours don't blink together. Mouths and noses never move.
- [ ] Eating, the head dips with each peck, without a big nod. Asleep (`livingDiorama.time.set("22:00")`), the head droops a little, the ears drop, the eyes stay shut and the tail curls. `livingDiorama.time.follow()` afterwards.
- [ ] A hopper tucks its legs in the air and stretches them at take-off and landing; a swimmer paddles its legs slowly and sculls its fins. Pause holds every part where it is.
- [ ] In the Studio, Build mode stands at rest, and the confirm step's test walk steps the legs as in the strip, seen from the default angle. With no way of moving ticked, the preview stands and still blinks.

Drawing a part (once, in the dev app at any scale; ADR 0025, M23). Draw mode draws one part on a 32 × 32 grid, one cell a cube, and turns it into cubes as you draw: `PartDrawMode.tsx` keeps the grid as immutable snapshots (`grid-editor.ts`), content-schema's `voxelizeDrawing` (`voxel-draw.ts`) gives the drawing its depth by the chosen rule, and `fitDrawnPart` carries the base part's attach point and sockets over to it. Save writes the part, with its drawing, to the player's parts store (`connectPartsStore`: `parts/<uuid>.json` in the data folder), and Build mode's tray and My parts read it from there (`player-parts.ts`). Use a data folder of its own (`$env:LIVING_DIORAMA_DEV_DATA_DIR = "$env:TEMP\diorama-draw"; pnpm dev`).

- [ ] Switch the Studio to Draw: an empty grid with a centimetre ruler along its top and left, the base part's dashed outline on it, and a panel with Name, Part type (Torso first), Base part, Cube size, Drawn from and Depth. Pen (P), Eraser (E) and Fill (F) work, a fast pen stroke fills every cell it crosses, and Fill floods the cells joined to the one clicked. Undo, Redo, Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z take back and bring back each stroke, fill and Clear, one at a time.
- [ ] Each part type starts drawn from its view with its rule: Torso and Head from the side, Puffy; Leg, Arm and Tail from the side, Tube; Ear, Eye, Nose and Mouth from the front, Flat; Fin from the top, Flat; Tail fin from the side, Flat. The 3D preview shows the part a moment after each stroke.
- [ ] Puffy: a torso drawn as a blob is rounded, deepest in its middle and thin at its edges; Chubby makes it fatter or slimmer. Tube: a leg drawn as a long stroke is round across its own width, about as deep as it is wide all along, and a wider band of cells makes a thicker limb. Flat: a part one cube deep, and Thickness 2 cubes makes it two. Switching the rule on a drawing re-shapes it at once and isn't an undo step. From the front, the canvas's right is the creature's left.
- [ ] The base part's outline is shaded under the cells and dashed over them, so it stays visible while you draw over it; another base part changes the outline and the cube size. The size readout gives the part's size in centimetres and "About N× its base part", and a part over twice its base part's size says a creature built with it may be too big to release. A smaller cube size makes the part smaller, and the ruler and readout follow.
- [ ] On a torso, the attach point shows as a diamond and the sockets as dots, filled for deep enough, half filled for smaller parts only, empty for too shallow. Drag a socket: it lands where it is dropped, snapped into the drawing, and a mirror pair moves together. Drag one onto a thin edge or a one-cube-thin stroke: it gets a red ring and the panel says a socket sits less deep than on the base part; Save still works. Escape during a drag puts the point back; Undo takes a drop back; "Put the points back where the base part has them" resets them all.
- [ ] Save is disabled until something is drawn and the part has a name ("Draw your part first.", "Give your part a name."). Save shows "Saving…", then "Saved" until the next change. The part appears under My parts in My creatures & parts, newest first, with its picture, name and type, and a `<uuid>.json` appears in the data folder's `parts/`.
- [ ] Use in Build → saves if needed, switches to Build and picks the part: its tile in its type's section of the tray (after the pack parts, marked "Mine") is pressed and the free sockets it fits are marked. Place it, with Mirror on too. Randomize and Fill empty never use it, and Fill empty keeps it where it was placed. Release the creature: it lives in the strip with the drawn part, joined where the part's attach point is.
- [ ] Every tray section ends with a "Draw your own" tile, which opens Draw mode on a new part of that type, drawn against its default base part (a root type's starter part, else the first part of the type in the tray).
- [ ] My parts: Rename (the text-cursor icon) edits the name in place; Enter or Save keeps it, Escape or Cancel drops it, and a blank name can't be saved. The part keeps its place in the tray. Edit (the pencil) opens the part's drawing as it was saved, its type locked and its points where you left them; change it and Save: the tray and My parts show the new picture, a creature being built keeps the copy it has until the part is placed again, and creatures already released don't change. Delete asks "Delete <name>?", saying released creatures keep theirs; Cancel (or Escape) keeps it, Delete removes it from My parts and the tray, and creatures released with it stay as they are in the strip.
- [ ] With a drawing not saved, New part, a "Draw your own" tile and My parts' Edit each ask "Discard your part?": Cancel (or Escape) keeps the drawing, Discard opens the new one. With the drawing saved and unchanged they open at once. Closing the Studio with an unsaved part asks first (see "Creation Studio window").
- [ ] Quit from the tray and relaunch: My parts and the tray list your parts again, with their pictures, and a deleted part stays gone. Creatures released with drawn parts are back in the world, moving their own way.
- [ ] If you have a species library from before M23, copy a drawn species' folder (one with `drawing.json`) into the data folder's `library/` and relaunch: it isn't listed in My creatures, and the app log has a warning about it.

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

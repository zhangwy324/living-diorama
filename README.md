# Living Diorama

A desktop companion strip with a small living 3D diorama. Developer docs live in [`docs/`](docs/), including the [architecture overview](docs/architecture.md), [adding content](docs/adding-content.md), the [world coordinate spec](docs/world-coordinates.md) and [architecture decision records](docs/adr/). References to the "spec" and "roadmap" (e.g. "roadmap §1.4") point to private design docs.

## Running the app

Living Diorama runs on Windows 11. It is a proof of concept.

1. Download `Living.Diorama_<version>_x64-setup.exe` from the [releases page](https://github.com/zhangwy324/living-diorama/releases).
2. Run it. The installer is not code-signed, so SmartScreen shows "Windows protected your PC". Choose **More info**, then **Run anyway**. It installs for your user only and needs no admin rights.
3. Start **Living Diorama** from the Start menu. The strip appears along the bottom of the screen and reserves that space, like the taskbar.

<!-- TODO(v0.2 release-candidate round): screenshot of the mossling in the strip, docs/screenshots/ (ADR 0016 §16). -->

### The strip

You can orbit, pan and zoom the camera inside the strip; double-click resets it. Drag the strip's top edge to make it taller or shorter. Hover over the strip and buttons fade in at the top right: **Creation Studio**, **Pause**, **Expand**, **Reset camera**, **debug overlays** and **Hide**. The strip never takes keyboard focus, so clicking it never pulls you out of the app you are typing in.

The tray icon has the rest. Left-click it to hide or show the strip. Right-click it for the menu: Creation Studio, Show/Hide, Expand, Pause, Always on top, Reserve screen space, Monitor, Open log folder and Quit. If something goes wrong, the log folder holds what to attach to a bug report; the log never leaves your machine. Uninstall it from **Settings > Apps > Installed apps**.

### The expanded window

**Expand** turns the strip into an ordinary window you can move, resize, maximize and Alt+Tab to, for looking at the diorama properly. The strip's space at the bottom of the screen is given back while it is expanded, so other windows grow; they shrink again when it collapses.

<!-- TODO(v0.2 release-candidate round): screenshot of the expanded window, docs/screenshots/ (ADR 0016 §16). -->

- The first time it opens maximized on the strip's monitor. After that it remembers its size, position, monitor and whether it was maximized or full screen. The app always starts as the strip.
- **F11** or the **Full screen** button toggles full screen. **Esc** leaves full screen. **Home** resets the camera.
- Its buttons are Creation Studio, Pause, **Collapse**, Reset camera, debug overlays and Full screen. It has its own camera, kept until you quit.
- **Collapse**, the window's close button (X) or the tray's **Collapse** turns it back into the strip. Closing it doesn't quit the app. Minimizing works as usual. Left-click on the tray icon brings the window to the front.

## Drawing a creature

Draw a creature in the Creation Studio and release it into the diorama, where it walks around as a solid 3D body built from your drawing.

<!-- TODO(v0.2 release-candidate round): screenshot of the Creation Studio, docs/screenshots/ (ADR 0016 §16). -->

1. **Open the Studio** with the pencil button on the strip or the expanded window, or **Creation Studio** in the tray menu. It is a normal window; opening it again brings it to the front.
2. **Draw your creature facing right, with its feet on the guide line.** You have a pen and an eraser, eleven colours, four brush sizes, **Undo** (Ctrl+Z), **Redo** (Ctrl+Y or Ctrl+Shift+Z) and **Clear**. A pen's pressure shapes the stroke; with a mouse, quick strokes come out thinner.
3. **Watch the 3D preview.** It turns slowly beside the canvas and updates a moment after each stroke. Hints below it say what may not work well: very thin parts (orange in the preview) can look flat, and parts that aren't joined (blue) each become a separate piece. The body is as thick as 40% of its height everywhere, and holes are filled in.
4. **Give it a name and a size.** It starts as "Creature N". The sizes are Tiny (20 cm), Small (40 cm), Medium (80 cm, the mossling's size) and Large (1.6 m). If a size doesn't fit everywhere in the world, a hint says so. For example, a large creature is too big to cross the wooden bridge and stays on its side of the river.
5. **Release it.** The creature appears in the world, and the Studio clears for the next one. The world holds up to 20 creatures; when it is full, take one out first.

**My creatures**, the panel beside the preview, lists every creature you have released, with how many are in the world. **+** adds another of that creature to the world, **−** takes the newest one out, and **Delete** (the bin) deletes it after asking. Deleting removes the creature for good, along with any in the world.

Your creatures are saved in `%APPDATA%\com.livingdiorama.desktop\library` and survive a relaunch. The world itself starts fresh on every launch, with the three mosslings and none of your creatures: add them back from My creatures. A drawing you haven't released is not saved. Closing the Studio asks first, but quitting the app doesn't.

## Development setup

Windows 11 only for now. Install the toolchain described in [`docs/development.md`](docs/development.md), then:

```bash
pnpm install
```

## Commands

| Command            | What it does                                                     |
| ------------------ | ---------------------------------------------------------------- |
| `pnpm dev`         | Run the desktop app with hot reload (`tauri dev`).               |
| `pnpm build`       | Typecheck all projects and build the web frontend.               |
| `pnpm test`        | Run all unit tests (Vitest).                                     |
| `pnpm lint`        | ESLint, including the "no branching on content IDs" rule.        |
| `pnpm boundaries`  | dependency-cruiser architectural boundary checks (roadmap §1.4). |
| `pnpm format`      | Format with Prettier (`format:check` to verify only).            |
| `pnpm worldgen`    | Regenerate the built-in world and its debug map.                 |
| `pnpm soak`        | Long simulation invariant runs over many seeds (not in CI).      |
| `pnpm sim`         | Headless simulation run: events, NDJSON trace, trajectory map.   |
| `pnpm check`       | Everything CI runs except the Tauri build.                       |
| `pnpm tauri build` | Build the Windows executable and NSIS installer.                 |

## Layout

```text
apps/desktop/              Tauri 2 shell, React UI host (composition root), Creation Studio
packages/content-schema/   Versioned content, drawing and library schemas
packages/extension-api/    Registries, namespaced IDs, versions, dependency resolution
packages/built-in-content/ The pre-built world and species
packages/simulation/       Headless simulation (runs in Node and a Web Worker)
packages/renderer/         Three.js scene, camera, creature bodies, debug overlays
packages/desktop-integration/  The frontend's view of the shell, library files, Studio channel
tools/development/         Fixtures, trace viewer, headless runner
```

Each package's README states what it owns and what it must not do.

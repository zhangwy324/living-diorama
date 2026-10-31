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

## Building a creature

Build a creature from parts in the Creation Studio and release it into the diorama, where it lives as a creature of small blocks. **Open the Studio** with the pencil button on the strip or the expanded window, or **Creation Studio** in the tray menu. It opens in **Build** mode, with a torso to build on.

1. **Pick a part** from the tray (torsos, legs, heads, eyes and more) and click one of the marked spots on your creature to attach it, or drag it onto one. A part that fits only one spot goes there at once. With **Mirror** on, the other side gets one too.
2. **Shape it.** Click a part to select it. Pick one of its colours and a suggested colour, or **Any colour…** for your own. **Turn part** (R) turns it a quarter turn, **Smaller part** (−) and **Bigger part** (+ or =) resize it, and **Delete** removes it. **Smaller creature** and **Bigger creature** resize the whole creature. **Randomize** builds a whole new creature to start from, **Fill empty** puts parts on every free spot and keeps yours, and **Reset** goes back to where you started. **Undo** (Ctrl+Z) and **Redo** (Ctrl+Y or Ctrl+Shift+Z) work as in drawing.
3. **Name it, choose how it moves and release it**, as for a drawn creature below: **Next: how it moves →**, then **Release**.

A built creature moves its parts as it lives: its legs step as it walks, its arms swing, it blinks, twitches its ears and flicks its tail, and when it eats or sleeps its head dips or droops.

To change a creature you built, press **Edit a copy** on it in **My creatures**: the Studio loads a copy to edit, and releasing it adds a new creature, keeping the old one.

## Drawing a creature

Press **Draw** in the Creation Studio to draw a creature instead and release it into the diorama, where it walks around as a solid 3D body built from your drawing.

<!-- TODO(v0.2 release-candidate round): screenshot of the Creation Studio, docs/screenshots/ (ADR 0016 §16). -->

1. **Open the Studio** with the pencil button on the strip or the expanded window, or **Creation Studio** in the tray menu. It is a normal window; opening it again brings it to the front.
2. **Draw your creature facing right, with its feet on the guide line.** You have a pen, an eraser, a fill bucket, eleven colours, four brush sizes, **Undo** (Ctrl+Z), **Redo** (Ctrl+Y or Ctrl+Shift+Z) and **Clear**. A pen's pressure shapes the stroke; a mouse always draws at the brush's full width.
3. **Watch the 3D preview.** It turns slowly beside the canvas and updates a moment after each stroke. Hints below it say what may not work well: very thin parts can look flat, and parts that aren't joined each become a separate piece. The preview shows the creature as it will look; press **Show warnings** on it to tint those parts (thin ones orange, separate ones blue), and press it again to hide the tint. The body is equally thick everywhere, 40% of its height unless you choose otherwise, and anything you leave undrawn inside the creature becomes a hole through it.
4. **Give it a name, a size and a thickness.** It starts with a playful suggested name such as "Mossy Pebble", picked to differ from the names already in your library. Edit it or clear it and type your own, or press the die beside it (Suggest another name) for a different one. The sizes are Tiny (20 cm), Small (40 cm), Medium (80 cm, the mossling's size class) and Large (1.6 m). If a size doesn't fit everywhere in the world, a hint says so. For example, a large creature is too big to cross the wooden bridge and stays on its side of the river. The **Thickness** slider sets how deep the body is, from 10% of its height (a flat card) to 80% (a chunky block); the preview follows it at once.
5. **Choose how it moves.** Press **Next: how it moves →**. The drawing is locked while you choose, and the preview plays the movement in place. Under **Moves**, tick **On land** (it **Walks** or **Hops**), **Swims**, or both; it must move one way at least. Its **Points** say where its body pivots: the center of gravity for moving on land, the tail for swimming. Each starts at a default; click the drawing to place it, or **Reset to default**. With both ways of moving, **Preview** switches between them. Hints say where in the world it won't fit, moving this way. **← Back** returns to the drawing; changing the drawing puts the points back at their defaults.
6. **Release it.** The creature appears in the world, and the Studio clears for the next one. The world holds up to 20 creatures; when it is full, take one out first.

**My creatures**, the panel at the side of the Studio (folded away in Build mode until you open it), lists every creature you have built or drawn and released, with its picture and how many are in the world. **+** adds another of that creature to the world, **−** takes the newest one out, and **Delete** (the bin) deletes it after asking. Deleting removes the creature for good, along with any in the world.

Your creatures are saved in `%APPDATA%\com.livingdiorama.desktop\library` and survive a relaunch. The world is saved too, as `world.json` in `%APPDATA%\com.livingdiorama.desktop`: every minute (even while the strip is hidden), whenever a creature is added or taken out, when you hide the strip and when you quit. The next launch brings back the same creatures, yours included, with their needs, their homes and what they know. Time away counts: after a night away they wake rested and fed, and at night they are asleep at home. A saved world that can't be used is replaced by a fresh one with the three mosslings. A creature you haven't released is not saved. Closing the Studio asks first, but quitting the app doesn't.

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

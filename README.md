# Living Diorama

A desktop companion strip with a small living 3D diorama. Developer docs live in [`docs/`](docs/), including the [world coordinate spec](docs/world-coordinates.md) and [architecture decision records](docs/adr/). References to the "spec" and "roadmap" (e.g. "roadmap §1.4") point to private design docs.

## Running the app

Living Diorama runs on Windows 11. It is a proof of concept.

1. Download `Living.Diorama_<version>_x64-setup.exe` from the [releases page](https://github.com/zhangwy324/living-diorama/releases).
2. Run it. The installer is not code-signed, so SmartScreen shows "Windows protected your PC". Choose **More info**, then **Run anyway**. It installs for your user only and needs no admin rights.
3. Start **Living Diorama** from the Start menu. The strip appears along the bottom of the screen and reserves that space, like the taskbar.

You can orbit, pan and zoom the camera inside the strip. Everything else is in the tray icon: left-click it to hide or show the strip, or right-click it for the menu (expand, pause, always on top, reserve screen space, monitor, quit). Uninstall it from **Settings > Apps > Installed apps**.

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
apps/desktop/              Tauri 2 shell + React UI host (composition root)
packages/content-schema/   Versioned content schemas
packages/extension-api/    Registries, namespaced IDs, versions, dependency resolution
packages/built-in-content/ The pre-built world and species
packages/simulation/       Headless simulation (runs in Node and a Web Worker)
packages/renderer/         Three.js scene, camera, debug overlays
packages/desktop-integration/  OS window placement, DPI, focus policy
tools/development/         Fixtures, trace viewer, headless runner
```

Each package's README states what it owns and what it must not do.

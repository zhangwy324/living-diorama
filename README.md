# Living Diorama

A desktop companion strip with a small living 3D diorama. Developer docs live in [`docs/`](docs/), including [architecture decision records](docs/adr/). References to the "spec" and "roadmap" (e.g. "roadmap §1.4") point to private design docs.

## Setup

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
| `pnpm check`       | Everything CI runs except the Tauri build.                       |
| `pnpm tauri build` | Build the Windows executable and installers.                     |

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

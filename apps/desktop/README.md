# @living-diorama/desktop

The Tauri 2 desktop shell and React UI host. This is the composition root: the only place (besides dev tools) that wires `built-in-content` into the registries, starts the simulation worker and mounts the renderer.

## Owns

- The Tauri window configuration, Rust entry point and capabilities (`src-tauri/`).
- The React controls overlay and app startup sequence.
- The Creation Studio page (`studio.html`, `src/studio/`): the drawing editor and its close dialog (ADR 0015). It never starts a simulation.
- The simulation Web Worker entry (`src/simulation.worker.ts`), which runs `runSimulationHost` from `simulation` on the built-in content, and the main-thread side that starts it (`src/simulation-client.ts`).

## Must not

- Hold engine logic. Behavior belongs in `packages/*`; OS-specific calls go through `desktop-integration`.
- Grant Tauri permissions the UI doesn't use. Each window has its own capability file: `default.json` for the strip, `studio.json` for the Creation Studio (ADR 0015 §3).

## Notes

- Icons in `src-tauri/icons/` are the Tauri defaults; regenerate with `pnpm tauri icon <source.png>` once there is artwork.

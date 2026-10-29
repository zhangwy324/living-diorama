# @living-diorama/desktop

The Tauri 2 desktop shell and React UI host. This is the composition root: the only place (besides dev tools) that wires `built-in-content` into the registries, starts the simulation worker and mounts the renderer.

## Owns

- The Tauri window configuration, Rust entry point and capabilities (`src-tauri/`).
- The Rust shell: the one main window, switched between the strip and a normal window with full screen (ADR 0016), the tray, settings, the species library's files (ADR 0014) and the Studio window (ADR 0015).
- The React controls overlay, the normal window's keys (`shortcuts.ts`) and cameras (`shape-cameras.ts`), and the app startup sequence.
- The species library's frontend (`src/species-library.ts`), which checks, registers and manages drawn species, and the strip's answers to the Studio (`src/studio-protocol.ts`).
- Keeping the world across launches (`src/world-saving.ts`, ADR 0019): restoring the save at startup, or spawning the starting creatures, and saving every minute, after creatures come and go, and on quit.
- The Creation Studio page (`studio.html`, `src/studio/`): the drawing editor, live preview, name, size and hints, the confirm step with the body plan (ways of moving and land gait, the points they use, an animated preview; ADR 0020 §12), release, My creatures and the dialogs (ADR 0015). It never starts a simulation.
- The drawn species' body plan defaults and the capabilities behind them (`src/body-plan.ts`, ADR 0020 §14), shared by the Studio and the species library.
- The simulation Web Worker entry (`src/simulation.worker.ts`), which runs `runSimulationHost` from `simulation` on the built-in content, and the main-thread side that starts it (`src/simulation-client.ts`).

## Must not

- Hold engine logic. Behavior belongs in `packages/*`; OS-specific calls go through `desktop-integration`.
- Grant Tauri permissions the UI doesn't use. Each window has its own capability file: `default.json` for the main window, `studio.json` for the Creation Studio (ADR 0015 §3).

## Notes

- Icons in `src-tauri/icons/` are the Tauri defaults; regenerate with `pnpm tauri icon <source.png>` once there is artwork.

# @living-diorama/desktop

The Tauri 2 desktop shell and React UI host. This is the composition root: the only place (besides dev tools) that wires `built-in-content` into the registries, starts the simulation worker and mounts the renderer.

## Owns

- The Tauri window configuration, Rust entry point and capabilities (`src-tauri/`).
- The React controls overlay and app startup sequence.

## Must not

- Hold engine logic. Behavior belongs in `packages/*`; OS-specific calls go through `desktop-integration`.
- Grant Tauri permissions the UI doesn't use. `src-tauri/capabilities/default.json` starts empty.

## Notes

- Icons in `src-tauri/icons/` are the Tauri defaults; regenerate with `pnpm tauri icon <source.png>` once there is artwork.

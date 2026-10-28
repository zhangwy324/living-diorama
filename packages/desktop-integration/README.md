# @living-diorama/desktop-integration

The frontend's OS-neutral view of the desktop shell (ADR 0008 §1). The OS work itself (window placement, monitors and DPI, focus policy, tray, always-on-top) happens in the Tauri app's Rust code; this package is how the React app asks for it.

## Owns

- The `DesktopShell` interface, its Tauri implementation and a no-op implementation for tests (the frontend is not supported in a plain browser; ADR 0008 §1).
- The `LibraryStore` interface to the species library's files, its Tauri implementation and one in memory for tests and the browser (ADR 0014).
- The window channel between the Creation Studio and the strip: typed requests with IDs and timeouts, and library snapshots pushed to the Studio, over targeted events, with an in-memory bus for tests (ADR 0015 §5). The app defines what the messages hold.
- The Studio window's close hook (`StudioWindow`), for the close dialog (ADR 0015 §10).
- Forwarding the frontend's console warnings and errors to the diagnostics log (ADR 0009 §14).

## Must not

- Leak OS-specific types or calls past its public interface.
- Be bypassed: it is the only workspace package that imports `@tauri-apps/api` or a Tauri plugin.

## Workspace dependencies

none

Boundary rules are enforced by `pnpm boundaries` (dependency-cruiser) and `pnpm lint`; see roadmap §1.4.

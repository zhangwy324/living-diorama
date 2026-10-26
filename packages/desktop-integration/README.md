# @living-diorama/desktop-integration

The frontend's OS-neutral view of the desktop shell (ADR 0008 §1). The OS work itself (window placement, monitors and DPI, focus policy, tray, always-on-top) happens in the Tauri app's Rust code; this package is how the React app asks for it.

## Owns

- The `DesktopShell` interface, its Tauri implementation and a no-op implementation for tests and for running the frontend in a plain browser.

## Must not

- Leak OS-specific types or calls past its public interface.
- Be bypassed: it is the only workspace package that imports `@tauri-apps/api`.

## Workspace dependencies

none

Boundary rules are enforced by `pnpm boundaries` (dependency-cruiser) and `pnpm lint`; see roadmap §1.4.

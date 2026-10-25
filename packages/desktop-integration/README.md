# @living-diorama/desktop-integration

OS-specific desktop behavior (Windows first) behind an OS-neutral interface.

## Owns

- Window placement, monitor and DPI handling, focus policy, tray and always-on-top.

## Must not

- Leak OS-specific types or calls past its public interface.

## Workspace dependencies

none

Boundary rules are enforced by `pnpm boundaries` (dependency-cruiser) and `pnpm lint`; see roadmap §1.4.

# @living-diorama/development-tools

Developer tooling: debug world fixtures, the simulation trace viewer and the headless runner.

## Owns

- Fixtures and scripts used only during development and testing, e.g. the `river-crossing` fixture world (a bridge deck stacked over a river).
- The world generator (`src/worldgen`, run with `pnpm worldgen`): it writes the built-in world and a debug map to `out/woodland-hollow.png`, and its tests cover the M2 exit criteria.

## Must not

- Be imported by any package or app.

## Workspace dependencies

`@living-diorama/content-schema`, `@living-diorama/extension-api`, `@living-diorama/simulation`, `@living-diorama/built-in-content`

Boundary rules are enforced by `pnpm boundaries` (dependency-cruiser) and `pnpm lint`; see roadmap §1.4.

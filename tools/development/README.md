# @living-diorama/development-tools

Developer tooling: debug world fixtures, the simulation trace viewer and the headless runner.

## Owns

- Fixtures and scripts used only during development and testing, e.g. the `river-crossing` fixture world (a bridge deck stacked over a river).
- The world generator (`src/worldgen`, run with `pnpm worldgen`): it writes the built-in world and a debug map to `out/woodland-hollow.png`, and its tests cover the M2 exit criteria.
- The long-run invariant checks (`src/simulation-run.ts`), used by the tests and by `pnpm soak`.
- The headless runner (`src/sim.ts`, run with `pnpm sim [--world hollow|river] [--seed 1] [--ticks 6000] [--creatures 1] [--no-map]`). It prints every event and a summary, and writes every decision and event to `out/sim-<world>-<seed>.ndjson` and the trajectories over the debug map to `out/sim-<world>-<seed>.png`.

## Must not

- Be imported by any package or app.

## Workspace dependencies

`@living-diorama/content-schema`, `@living-diorama/extension-api`, `@living-diorama/simulation`, `@living-diorama/built-in-content`

Boundary rules are enforced by `pnpm boundaries` (dependency-cruiser) and `pnpm lint`; see roadmap §1.4.

# @living-diorama/development-tools

Developer tooling: debug world fixtures, the simulation trace viewer and the headless runner.

## Owns

- Fixtures and scripts used only during development and testing, e.g. the `river-crossing` fixture world (a bridge deck stacked over a river).
- The world generator (`src/worldgen`, run with `pnpm worldgen`): it writes the built-in world and a debug map to `out/woodland-hollow.png`, and its tests cover the M2 exit criteria.
- The long-run invariant checks (`src/simulation-run.ts`) and the living-behavior checks of ADR 0018 §20 (`src/long-run-checks.ts`: needs in [0, 1], the decision and interruption bounds, and the meal and sleep checks: a meal at least every 3 hours awake for each creature that can reach food, and asleep for most of the night for each that sleeps at night). The tests, `pnpm soak` and `pnpm sim` use them, with the meal and sleep checks on for Woodland Hollow (`LIVING_BEHAVIOR_CHECKS`) and off for the river-crossing fixture, whose pebbles only wander. `pnpm check` runs a few seeds of a simulated day at 2 Hz, and `pnpm soak [--seeds 32] [--hours 24] [--hz 10] [--creatures 3]` runs more at the app's rate.
- The headless runner (`src/sim.ts`, run with `pnpm sim [--world hollow|river] [--seed 1] [--ticks 6000] [--creatures 1] [--hz 10] [--start 12:00] [--no-map]`). It prints every event, a summary and a line per creature (meals, sleep, time hungry, decisions and interruptions), and writes every decision and event to `out/sim-<world>-<seed>.ndjson` and the trajectories over the debug map to `out/sim-<world>-<seed>.png`.

## Must not

- Be imported by any package or app.

## Workspace dependencies

`@living-diorama/content-schema`, `@living-diorama/extension-api`, `@living-diorama/simulation`, `@living-diorama/built-in-content`

Boundary rules are enforced by `pnpm boundaries` (dependency-cruiser) and `pnpm lint`; see roadmap §1.4.

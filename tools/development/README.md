# @living-diorama/development-tools

Developer tooling: debug world fixtures, the simulation trace viewer and the headless runner.

## Owns

- Fixtures and scripts used only during development and testing, e.g. the `river-crossing` fixture world (a bridge deck stacked over a river).
- The world generator (`src/worldgen`, run with `pnpm worldgen`): it writes the built-in world and a debug map to `out/woodland-hollow.png`, and its tests cover the M2 exit criteria.
- The long-run invariant checks (`src/simulation-run.ts`) and the living-behavior checks of ADR 0018 §20 (`src/long-run-checks.ts`: needs in [0, 1], the decision and interruption bounds, and the meal and sleep checks: a meal at least every 3 hours awake for each creature that can reach food, and asleep for most of the night for each that sleeps at night). The tests, `pnpm soak` and `pnpm sim` use them, with the meal and sleep checks on for Woodland Hollow (`LIVING_BEHAVIOR_CHECKS`) and off for the river-crossing fixture, whose pebbles only wander. `pnpm check` runs a few seeds of a simulated day at 2 Hz, and `pnpm soak [--seeds 32] [--hours 24] [--hz 10] [--creatures 3] [--restores 4] [--compare-minutes 10] [--no-long-gap]` runs more at the app's rate. `pnpm soak:quick` is `pnpm soak --seeds 3 --hours 24`: still a full day and night per seed with every save/restore check, in about 45 s instead of about 7 min. Run the quick soak before a PR that touches simulation, navigation, world content or save/restore, and the full soak once when such a PR changes that logic substantially ([AGENTS.md](../../AGENTS.md)).
- The save and restore checks of the long runs (`src/save-cycles.ts`, ADR 0019): `pnpm soak` saves each run at random ticks drawn from its seed, through JSON text and `parseWorldSave`, restores it into a fresh world and checks that a restore without a gap carries on exactly as the unbroken run (compared tick by tick for `--compare-minutes`), and that one restore per run after a long gap leaves the world as the catch-up rules say.
- The headless runner (`src/sim.ts`, run with `pnpm sim [--world hollow|river] [--seed 1] [--ticks 6000] [--creatures 1] [--hz 10] [--start 12:00] [--save <file>] [--load <file> [--gap <minutes>]] [--no-map]`). `--save` writes the world as the run leaves it in the app's save format, and `--load` starts from such a save, `--gap` minutes of wall-clock time after it was made (default 0, an exact resume; 2 or more is caught up). Both run at the app's 10 Hz only, since a save doesn't record its tick rate. It prints every event, a summary and a line per creature (meals, sleep, time hungry, decisions and interruptions), and writes every decision and event to `out/sim-<world>-<seed>.ndjson` and the trajectories over the debug map to `out/sim-<world>-<seed>.png`.

## Must not

- Be imported by any package or app.

## Workspace dependencies

`@living-diorama/content-schema`, `@living-diorama/extension-api`, `@living-diorama/simulation`, `@living-diorama/built-in-content`

Boundary rules are enforced by `pnpm boundaries` (dependency-cruiser) and `pnpm lint`; see roadmap §1.4.

# @living-diorama/simulation

Headless simulation: clock, seeded RNG, world state, region graph, navigation, actions, behaviors and events.

## Owns

- All authoritative world and creature state.
- The world model: surfaces (`core:heightfield`, `core:deck`, `core:flat`), derived walkability masks, the capability-filtered region graph and the semantic world checks ([ADR 0005](../../docs/adr/0005-world-content-and-walkability.md)).
- The engine's own registry entries (`registerCoreEngine`) and the static scene data handed to the renderer.
- The fixed-tick clock (wall-clock time is fed in, never read directly) and the seeded, forkable RNG ([ADR 0006](../../docs/adr/0006-simulation-runtime-and-navigation.md)).
- The world state (`WorldState`): world model, creatures and one pathfinder per navigation profile.
- Path finding: crossings over portals, region-level search with exact walking costs, grid A* with smoothing inside each region, and the route cache.
- The tick loop (`Simulation`): action and behavior contracts (`ActionProvider`, `BehaviorProvider`), the core actions `core:idle` and `core:follow_path`, the `core:wander` behavior, kinematic locomotion, the stuck watchdog, simulation events and decision traces.
- The worker-side host and the versioned snapshot/command message protocol (`protocol.ts`).

## Must not

- Import `three`, `react`, `@tauri-apps/*`, Node built-ins or any DOM API. It must run unchanged in Node (tests) and in a Web Worker.
- Branch on content IDs.

## Workspace dependencies

`@living-diorama/content-schema`, `@living-diorama/extension-api`

Boundary rules are enforced by `pnpm boundaries` (dependency-cruiser) and `pnpm lint`; see roadmap §1.4.

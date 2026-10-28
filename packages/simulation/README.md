# @living-diorama/simulation

Headless simulation: clock, seeded RNG, world state, region graph, navigation, actions, behaviors and events.

## Owns

- All authoritative world and creature state.
- The world model: surfaces (`core:heightfield`, `core:deck`, `core:flat`), derived walkability masks, the capability-filtered region graph and the semantic world checks ([ADR 0005](../../docs/adr/0005-world-content-and-walkability.md)).
- The engine's own registry entries (`registerCoreEngine`) and the static scene data handed to the renderer.
- The fixed-tick clock (wall-clock time is fed in, never read directly) and the seeded, forkable RNG ([ADR 0006](../../docs/adr/0006-simulation-runtime-and-navigation.md)).
- The world state (`WorldState`): world model, creatures, the creature cap and one pathfinder per navigation profile, built at creation or when a species with a new profile registers ([ADR 0012](../../docs/adr/0012-runtime-species.md)).
- Path finding: walkable areas per profile and what a creature can reach from where it stands ([ADR 0013](../../docs/adr/0013-size-limits.md)), crossings over portals, region-level search with exact walking costs, grid A* with smoothing inside each region, and the route cache.
- Species registered while the world runs (`Simulation.registerSpecies`), checked like pack content, despawning creatures, and the read-only limits query for a size class (`Simulation.checkLimits`, ADR 0015 §8).
- The tick loop (`Simulation`): action and behavior contracts (`ActionProvider`, `BehaviorProvider`), the core actions `core:idle` and `core:follow_path`, the `core:wander` behavior, kinematic locomotion, the stuck watchdog, simulation events and decision traces.
- The worker-side host (`runSimulationHost`), which takes an injected message port, content loader and timer, and the versioned snapshot/command message protocol (`protocol.ts`). With `set_debug` on, snapshots carry each walking creature's remaining route.
- Static debug overlay data (`describeNavigation`): walkability cells, region graph anchors and portals of one navigation profile, as plain data for the renderer.

## Must not

- Import `three`, `react`, `@tauri-apps/*`, Node built-ins or any DOM API. It must run unchanged in Node (tests) and in a Web Worker.
- Branch on content IDs.

## Workspace dependencies

`@living-diorama/content-schema`, `@living-diorama/extension-api`

Boundary rules are enforced by `pnpm boundaries` (dependency-cruiser) and `pnpm lint`; see roadmap §1.4.

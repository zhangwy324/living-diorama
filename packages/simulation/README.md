# @living-diorama/simulation

Headless simulation: clock, seeded RNG, world state, region graph, navigation, actions, behaviors and events.

## Owns

- All authoritative world and creature state.
- The world model: surfaces (`core:heightfield`, `core:deck`, `core:flat`), prop placements resolved against their types (ADR 0018 §3), derived walkability masks, the capability-filtered region graph and the semantic world checks ([ADR 0005](../../docs/adr/0005-world-content-and-walkability.md)).
- The engine's own registry entries (`registerCoreEngine`): surfaces, `core:walk`, the affordances `core:crossable`, `core:food` and `core:shelter`, the needs `core:hunger` and `core:tiredness`, the sense `core:vision` and the traits `core:nocturnal` and `core:appetite` ([ADR 0018](../../docs/adr/0018-living-behavior.md)), and the static scene data handed to the renderer.
- The fixed-tick clock (wall-clock time is fed in, never read directly) and the seeded, forkable RNG ([ADR 0006](../../docs/adr/0006-simulation-runtime-and-navigation.md)).
- The world state (`WorldState`): world model, creatures, the creature cap and one pathfinder per navigation profile, built at creation or when a species with a new profile registers ([ADR 0012](../../docs/adr/0012-runtime-species.md)).
- Path finding: walkable areas per profile and what a creature can reach from where it stands ([ADR 0013](../../docs/adr/0013-size-limits.md)), crossings over portals, region-level search with exact walking costs, grid A* with smoothing inside each region, and the route cache.
- Species registered while the world runs (`Simulation.registerSpecies`), checked like pack content, despawning creatures, and the read-only limits query for a size class (`Simulation.checkLimits`, ADR 0015 §8).
- The tick loop (`Simulation`): action and behavior contracts (`ActionProvider`, `BehaviorProvider`), the core actions `core:idle`, `core:follow_path`, `core:eat` and `core:sleep`, the behaviors `core:wander`, `core:feed` and `core:rest`, kinematic locomotion, the stuck watchdog (on ticks an action walks), simulation events and decision traces.
- The needs engine ([ADR 0018](../../docs/adr/0018-living-behavior.md) §1, §7–§8, §15–§16, §18): a creature has the needs its behaviors declare as `needs` dependencies, with values drawn below `actAt` and per-individual variation drawn at spawn. Needs change every tick at their awake or asleep rate (the action reports `asleep`), scaled by the need's rate trait and the variation; actions change them with `adjustNeed`. A need rising across a trigger value, or the day phase changing (after a per-creature delay of up to 30 s), evaluates the behaviors; a challenger interrupts the running action only by beating its owner's current utility by 0.15, and only the chosen behavior's memory and random-stream use is kept. A need at 1 may slow walking (`atMax.speedFactor`). Snapshots carry each creature's cues, and with debug on its need values, knowledge (`creatures/knowledge.ts`) and home.
- Perception and food ([ADR 0018](../../docs/adr/0018-living-behavior.md) §10–§12): the engine scans once a second per creature, at an offset of its own, for props offering an affordance with a `remember` cap (`WorldModel.propsByAffordance`), within vision range or 1 m of touch, and records the 8 m grid cell it stands in (`creatures/perception.ts`). `core:feed` picks the remembered food with the shortest route or explores towards cells not visited recently, and `core:eat` walks to the creature's own spot beside the food (`creatures/spots.ts`) and lowers hunger over `eatSeconds` (`creatures/feed.ts`).
- Shelter, sleep and home ([ADR 0018](../../docs/adr/0018-living-behavior.md) §13–§14): `core:rest` proposes sleep from `core:tiredness`'s `actAt` or on the night bonus of the creature's sleeping phase (flipped by `core:nocturnal`), at home unless home's route is more than twice the nearest shelter's. `core:sleep` walks to the creature's spot beside the shelter, or sleeps where it stands, reports `asleep`, and ends when rested and the waking phase has begun, or at tiredness 0 for a daytime nap. The first shelter slept at becomes home (`ActionContext.setHome`). An action cut short by a challenger or the watchdog gets `ActionProvider.interrupted`, and the creature is awake from then on. A creature spawned as `released` from the Studio doesn't rest for 10 minutes (`creatures/rest.ts`).
- The worker-side host (`runSimulationHost`), which takes an injected message port, content loader and timer, and the versioned snapshot/command message protocol (`protocol.ts`). With `set_debug` on, snapshots carry each walking creature's remaining route, need values, knowledge and home.
- Static debug overlay data (`describeNavigation`): walkability cells, region graph anchors and portals of one navigation profile, as plain data for the renderer.

## Must not

- Import `three`, `react`, `@tauri-apps/*`, Node built-ins or any DOM API. It must run unchanged in Node (tests) and in a Web Worker.
- Branch on content IDs.

## Workspace dependencies

`@living-diorama/content-schema`, `@living-diorama/extension-api`

Boundary rules are enforced by `pnpm boundaries` (dependency-cruiser) and `pnpm lint`; see roadmap §1.4.

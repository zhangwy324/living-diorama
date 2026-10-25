# ADR 0006: Simulation runtime and navigation

- **Status:** Accepted
- **Date:** 2026-10-25
- **Context:** Roadmap M3 (headless simulation core). M3 ships as three PRs: **A** runtime and navigation (this ADR's §1–§6), **B** actions, behaviors, locomotion, the watchdog, events, traces and the long-run tests, **C** the worker host and the headless runner. Decisions for B and C are recorded here now so the PRs share one design; each PR updates this ADR if it has to deviate.

## Decisions

### Runtime

1. **Clock.** `FixedClock` turns fed-in wall-clock time into fixed ticks (100 ms at 10 Hz). The host passes a monotonic time to `advance(wallMs)`, which returns how many ticks are due; the simulation never reads a clock. One `advance` releases at most `maxCatchUpTicks` (default 10), and time beyond that is dropped, which also covers sleep/resume. The speed multiplier scales elapsed time, not the tick length. Pausing discards accumulated time and resuming re-baselines, so paused time never ticks. The tick counter itself belongs to the simulation state, not the clock, so it is saved and replayed with that state.

2. **Determinism contract.** The same seed and the same log of (tick, command) pairs produce the same trajectory. Commands are queued and applied at tick boundaries only (PR C).

3. **RNG.** sfc32 (128-bit state, 32-bit integer arithmetic only). Its state is plain data (`RngState`) stored in the simulation state; `Rng` is a view that advances it in place. `fork(name)` derives a stream from the parent's identity and the name only, never from how far the parent has advanced. So a creature's stream is `root.fork(creatureId)`, and spawning another creature never shifts an existing one's sequence. World generation keeps its own mulberry32: changing it would change the generated world for no gain.

4. **World state.** `WorldState.create(registries, { worldId, seed })` runs `checkWorld` and refuses a world with errors. It holds the world model, one `Pathfinder` per distinct navigation profile, and the creatures in an id-keyed `Map` with deterministic insertion order. Creature IDs come from a counter (`creature-1`, …). `CreatureState` is plain data so it can be saved later. It is a runtime record, separate from the `CreatureInstance` content schema, which stays the save format and is not widened until persistence arrives.

### Navigation

5. **Grid search in every region, including decks.** Every region already has a walkability mask (ADR 0005 §4), so one 8-connected grid A\* that never cuts a blocked corner covers ground and decks alike. A deck-specific "portal-to-portal" planner would mean branching on surface type. Paths are smoothed by string-pulling with a conservative line of sight: every cell the segment touches must be walkable, and passing exactly through a cell corner needs both side cells walkable, the same rule as a diagonal grid step. A smoothed path therefore never leaves walkable cells.

6. **Hierarchical routes with exact costs.**
   - **Crossings.** Each usable portal gets crossings: a walkable cell on each side, edge-adjacent, with the shared edge on the portal and the surfaces within `maxStepHeight`. A route changes region exactly on that shared edge, so a creature is always on a walkable cell of its current region. On a wide portal, crossings are picked from the middle of the usable span outwards, at least 1 m apart. Bidirectional connections get crossings both ways.
   - **Region-level search.** Crossing cells are the doors of a small graph. In-region edge costs come from walking-distance fields (Dijkstra over the mask from each door), so the chosen sequence of regions is truly shortest, not a straight-line estimate that would be wrong around cliffs and ramps. The connection's `cost` is added per crossing.
   - **Legs.** Grid A\* fills in each region's leg between the start, the crossings and the goal. A route is a list of legs, each with its region, smoothed waypoints and the crossing it leaves by.
   - **Caching.** Crossings and distance fields are built lazily and cached per profile. `invalidateRegions(ids)` drops them for those regions and the connections touching them, for future world edits; it is unused in v1. Rebuilding the walkability masks themselves after an edit is left until world editing exists.
   - Failures are structured: `start_not_walkable`, `goal_not_walkable` or `unreachable`, with a readable detail.

### Creatures (PR B)

7. **Actions and behaviors are registry entries with code**, like surface providers (ADR 0005): `ActionProvider` and `BehaviorProvider` extend the registered types, and a registered entry without an implementation is a load-time diagnostic.

8. **Behavior contract.** It refines the spec's behavior contract. `evaluate(observation, memory, rng)` returns `{ action, params, utility }` or nothing:
   - `observation` is read-only: the creature's state and read-only world and navigation queries;
   - `memory` is plain data the engine stores per creature and behavior, used for cooldowns and hysteresis;
   - the engine takes the highest-utility proposal, validates it and plans the path itself. A behavior proposes a destination, never a path;
   - behaviors are evaluated only on triggers (an action finishing or failing, the watchdog), never every tick.

   v1 has no senses, so the queries see the whole world.

9. **`core:wander`** picks a destination in another reachable region with probability about 0.3 (regions weighted by walkable area), idles 3–12 s between moves, and won't choose a point within about 2 m of where it stands. These are starting values to tune.

10. **`first_use_of_structure`** fires once per creature and structure placement.

### Worker and tooling (PRs B and C)

11. **The worker host lives in `simulation`; the worker entry lives in the app.** `simulation` cannot import `built-in-content`, so it exports a host that takes a minimal message port and injected `loadContent`, `now` and timer functions. Tests then run the host in Node with no DOM or worker types. `apps/desktop` provides the real `worker.ts`.

12. **Tests and traces.**
    - `pnpm check` runs randomized invariant runs (4 seeds × 100k ticks, kept to about 20 s); `pnpm soak` runs more seeds outside CI.
    - Decision traces are NDJSON. The headless runner prints a summary and can draw trajectories over the worldgen debug map.

## Consequences

- Speed, determinism and saving all rest on plain-data state: the RNG, creatures and behavior memory serialize as they are.
- Routing cost on Woodland Hollow: building the world state takes about 50 ms; the first cross-map route about 7 ms while it builds distance fields; later routes about 0.2 ms.
- On a narrow portal a creature always crosses at the same cell (the summit ramp has a 1.5 m walkable span at its portal, so one crossing). Acceptable for v1 (roadmap risk R6).

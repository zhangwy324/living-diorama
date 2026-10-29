# ADR 0006: Simulation runtime and navigation

- **Status:** Accepted
- **Date:** 2026-10-25
- **Context:** Roadmap M3 (headless simulation core). M3 ships as three PRs: **A** runtime and navigation (this ADR's §1–§6), **B** actions, behaviors, locomotion, the watchdog, events, traces and the long-run tests, **C** the worker host and the headless runner. Decisions for B and C are recorded here now so the PRs share one design; each PR updates this ADR if it has to deviate.

## Decisions

### Runtime

1. **Clock.** `FixedClock` turns fed-in wall-clock time into fixed ticks (100 ms at 10 Hz). The host passes a monotonic time to `advance(wallMs)`, which returns how many ticks are due; the simulation never reads a clock. One `advance` releases at most `maxCatchUpTicks` (default 10), and time beyond that is dropped, which also covers sleep/resume. The speed multiplier scales elapsed time, not the tick length. _Amended (issue #100):_ above speed 1 the limit is `ceil(maxCatchUpTicks × speed)`, about one real second of ticks, so a dev speed such as 60 is not held to 10×; speed is at most 100 (`MAX_SPEED`). Pausing discards accumulated time and resuming re-baselines, so paused time never ticks. The tick counter itself belongs to the simulation state (`WorldState.tick`), not the clock, so it is saved and replayed with that state.

2. **Determinism contract.** The same seed and the same log of (tick, command) pairs produce the same trajectory. Commands are queued and applied at tick boundaries only (PR C).

3. **RNG.** sfc32 (128-bit state, 32-bit integer arithmetic only). Its state is plain data (`RngState`) stored in the simulation state; `Rng` is a view that advances it in place. `fork(name)` derives a stream from the parent's identity and the name only, never from how far the parent has advanced. So a creature's stream is `root.fork(creatureId)`, and spawning another creature never shifts an existing one's sequence. World generation keeps its own mulberry32: changing it would change the generated world for no gain.

4. **World state.** `WorldState.create(registries, { worldId, seed })` runs `checkWorld` and refuses a world with errors. It holds the world model, one `Pathfinder` per distinct navigation profile, and the creatures in an id-keyed `Map` with deterministic insertion order. Creature IDs come from a counter (`creature-1`, …). `CreatureState` is plain data so it can be saved later. It is a runtime record, separate from the `CreatureInstance` content schema, which stays the save format and is not widened until persistence arrives.

   _Amended by [ADR 0019](0019-world-saving.md) §2 (M15 PR 1):_ `CreatureInstance` is gone. The save format is `WorldSaveSchema` in `content-schema`, whose `CreatureSave` mirrors `CreatureState` field for field; the simulation checks at type level that the two agree.

### Navigation

5. **Grid search in every region, including decks.** Every region already has a walkability mask (ADR 0005 §4), so one 8-connected grid A\* that never cuts a blocked corner covers ground and decks alike. A deck-specific "portal-to-portal" planner would mean branching on surface type. Paths are smoothed by string-pulling with a conservative line of sight: every cell the segment touches must be walkable, and passing exactly through a cell corner needs both side cells walkable, the same rule as a diagonal grid step. A smoothed path therefore never leaves walkable cells.

6. **Hierarchical routes with exact costs.**
   - **Crossings.** Each usable portal gets crossings: a walkable cell on each side, edge-adjacent, with the shared edge on the portal and the surfaces within `maxStepHeight`. A route changes region exactly on that shared edge, so a creature is always on a walkable cell of its current region. On a wide portal, crossings are picked from the middle of the usable span outwards, at least 1 m apart. Bidirectional connections get crossings both ways.
   - **Region-level search.** Crossing cells are the doors of a small graph. In-region edge costs come from walking-distance fields (Dijkstra over the mask from each door), so the chosen sequence of regions is truly shortest, not a straight-line estimate that would be wrong around cliffs and ramps. The connection's `cost` is added per crossing.
   - **Legs.** Grid A\* fills in each region's leg between the start, the crossings and the goal. A route is a list of legs, each with its region, smoothed waypoints and the crossing it leaves by.
   - **Caching.** Crossings and distance fields are built lazily and cached per profile. `invalidateRegions(ids)` drops them for those regions and the connections touching them, for future world edits; it is unused in v1. Rebuilding the walkability masks themselves after an edit is left until world editing exists.
   - Failures are structured: `start_not_walkable`, `goal_not_walkable` or `unreachable`, with a readable detail.

### Creatures (PR B)

7. **Actions and behaviors are registry entries with code**, like surface providers (ADR 0005): `ActionProvider` and `BehaviorProvider` extend the registered types. `Simulation.create` refuses any registered action or behavior without an implementation (`no_action_implementation`, `no_behavior_implementation`).
   - An action has `start(params, context)`, which checks preconditions and params and returns its initial plain-data state, and `step(state, context)`, which reports `running`, `done` or `failed`. Its state lives on the creature, so it is saved with it.
   - The context lets an action plan a route (a failure emits `path_failed`) and walk a path; the engine applies every change itself.
   - An action declares whether it `moves`. The stuck watchdog watches only those: one that gets less than 5 cm further in 5 s is interrupted, `creature_stuck` is emitted and behaviors are evaluated again. An interrupted action's state is dropped; there is no interruption hook until an action needs one.

8. **Behavior contract.** It refines the spec's behavior contract. `evaluate(observation, memory, rng)` returns `{ action, params, utility }` or nothing:
   - `observation` is read-only: the creature's state and read-only world and navigation queries;
   - `memory` is plain data the engine stores per creature and behavior, used for cooldowns and hysteresis;
   - the engine takes the highest-utility proposal (the first on a tie), validates it and plans the path itself. A behavior proposes a destination, never a path. A behavior may only start actions it lists in its `dependencies`;
   - a proposal that cannot start, or no proposal at all, makes the creature wait 1 s before deciding again. A failure shows in the next observation's `lastResult`;
   - behaviors are evaluated only on triggers (an action finishing or failing, the watchdog), never every tick.

   v1 has no senses, so the queries see the whole world. Every decision goes to an optional `onTrace` sink: the candidates, the chosen proposal and how starting it went, with the planned route for a walk.

9. **`core:wander`** picks a destination in another reachable region with probability about 0.3 (regions weighted by walkable area), idles 3–12 s between moves, and won't choose a point within about 2 m of where it stands. These are starting values to tune. Its memory alternates rest and walk, so a walk is always followed by a rest; if no destination turns up in 8 tries it rests again.

   **Locomotion** is kinematic. A creature walks its path at `baseSpeed` times the largest factor among its capabilities whose locomotion rule covers the current region's kind. Its heading follows the direction of travel (`0` faces +Z, world-coordinates.md). Height is never stored; it always comes from the current region's surface. On a crossing the region changes past the shared cell edge.

   _Amended by [ADR 0020](0020-body-plans-swimming-and-live-edits.md) §7 (planned, M16 PR 2, issue #121):_ setting off no longer snaps the heading to the direction of travel; the creature turns at ADR 0018's turn rate.

10. **`first_use_of_structure`** fires once per creature and structure placement, found through the crossed connection's or entered region's `structureId` (ADR 0004 §4).

### Worker and tooling (PRs B and C)

11. **The worker host lives in `simulation`; the worker entry lives in the app.** `simulation` cannot import `built-in-content`, so it exports a host that takes a minimal message port and injected `loadContent`, `now` and timer functions. Tests then run the host in Node with no DOM or worker types. `apps/desktop` provides the real worker entry (`simulation.worker.ts`).
    - `init` loads content and starts the loop. Every other command is queued and applied before the next tick, so a command never lands mid-tick.
    - The loop wakes once per tick interval and asks the `FixedClock` how many ticks are due. Each tick sends its own snapshot with its events, also when catching up.
    - `pause` and `resume` each send a snapshot when they are applied, so the UI sees `paused` change even though no tick runs.
    - A rejected command (sent before `init`, a second `init`, a failed spawn, an invalid speed, an unknown command or another protocol version) sends `error` and the host keeps running. Only a failed `init` leaves it idle. (Since ADR 0012 a failed spawn sends `rejected` instead.)

12. **Tests and traces.**
    - `pnpm check` runs randomized invariant runs (4 seeds × 100k ticks × 3 creatures on Woodland Hollow, plus the river-crossing fixture); `pnpm soak` runs 32 seeds outside CI. Every tick checks that each creature is on a walkable cell of a non-water region, inside the world bounds, on its region's surface and never under a water surface, and that it changes region only through a connection joining the two.
    - Decision traces are NDJSON. The headless runner prints a summary and can draw trajectories over the worldgen debug map.

    _Amended by [ADR 0020](0020-body-plans-swimming-and-live-edits.md), "Contradictions resolved" (planned, M16 PR 2):_ the water invariants hold per capability. Each creature is on a walkable cell of a region its locomotion covers, on that region's surface, and changes region only through a connection joining the two or a derived water entry. A walker still never enters water.

## Consequences

- Speed, determinism and saving all rest on plain-data state: the RNG, creatures, action state and behavior memory serialize as they are.
- A run of 100k ticks with 3 creatures on Woodland Hollow takes about 0.6 s, so the long-run tests cost little.
- Routing cost on Woodland Hollow: building the world state takes about 50 ms; the first cross-map route about 7 ms while it builds distance fields; later routes about 0.2 ms.
- On a narrow portal a creature always crosses at the same cell (the summit ramp has a 1.5 m walkable span at its portal, so one crossing). Acceptable for v1 (roadmap risk R6).

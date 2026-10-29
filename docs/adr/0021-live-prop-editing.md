# ADR 0021: Live prop editing

- **Status:** Accepted
- **Date:** 2026-10-29
- **Context:** Roadmap §3.2 step 7 paired drawing release 2 with live world edits. [ADR 0020](0020-body-plans-swimming-and-live-edits.md) built the first half as M16 and fixed M17's contracts in advance (§16–§21): edits to props and structures, a save that stores an edit list replayed onto the base world, and navigation rebuilt per touched region. When M17 started, the owner rescoped it on 2026-10-29. M17 now edits **props only** (add, remove, move, scale), **live** while creatures carry on, through **one pipeline** that rebuilds the whole derived world after each edit, and the **edited world itself is embedded in the save** instead of an edit list. Structures, terrain and region edits, and a library of user worlds come in later milestones (roadmap §3.2); this ADR keeps the door open for them without building them. The decisions below were agreed with the owner on 2026-10-29 and supersede ADR 0020 §16–§21. M17 lands as a series of PRs: **0** this ADR; **1** the edit ops, result and inverse in `content-schema`, and a measurement of the full rebuild's time (§1–§3, §10, §11); **2** the simulation: applying and validating an edit, the full rebuild, reconciling creatures, events, and the protocol and host messages (§1, §3, §5–§10); **3** the renderer: props (and overlays) rebuilt from new scene data, and a read-only prop picking API (§12); **4** persistence: the edited world in the save (§4); **5** tools: edits in `pnpm sim`, scenarios and random edits in the soak; **6** the app: a dev console hook and the in-strip editor, and the manual checklist (§12). PRs 1 and 3 come first, then 2, then 4 and 5, then 6. Each PR adds its own paragraph under "As built" below, recording what it built and where it departs from this ADR.

This ADR supersedes ADR 0020 §16–§21. How the Studio commits world edits stays as ADR 0020 settled it ("Contradictions resolved"): through the worker's one edit command, reached through the strip. It amends ADR 0019 §7 (a save of an edited world no longer needs the registry's world to match, §4) once PR 4 lands.

## Decisions

### The edit pipeline

1. **One edit pipeline, with a full rebuild.** An edit is a pure function from one `WorldDefinition` to the next. After applying it, the engine rebuilds everything derived from the world as if the world had just loaded: the world model, navigation for every profile and the scene data. It then reconciles the creatures with the new world (§6–§8). There is no per-region or dirty-rectangle rebuild; ADR 0020 §20's region rebuild is dropped. Terrain and region edits later add new ops to the same pipeline, not a new path. Every caller (the dev hook, `pnpm sim`, the in-strip editor, later the Studio and the agent bridge) reaches the world through the worker's one validated edit command, applied between ticks like every other command (ADR 0006 §11). Nothing else changes world content at run time.

2. **Edit ops are an extensible discriminated union.** M17 has `prop.add`, `prop.remove`, `prop.move` (position and rotation together) and `prop.scale` (uniform). Later ops (`terrain.*`, `region.*`) join the same union. A `prop.add` carries the new placement's ID. By default the engine generates it deterministically from a counter kept in the simulation state and saved with it; a caller may supply its own ID instead, which is rejected if already in use. A generated ID skips any ID already in use, including one a caller supplied earlier.

3. **Live.** The worker accepts an edit at any time and applies it between ticks, never in the middle of a step. The world is not paused. The editor shows a preview while dragging and commits only on release, so a drag costs one rebuild. **PR 1 measures the full rebuild's time on Woodland Hollow against the 100 ms tick.** If it does not fit comfortably, the work stops there and live editing against a background or incremental rebuild is decided again with the owner before PR 2.

### Persistence

4. **The edited world is embedded in the save.** Once a world has been edited, the save holds its derived `WorldDefinition`, and a restore builds the world from that, not from the registry's world. Such a save no longer needs the registry's world ID and version to match (amends ADR 0019 §7 for edited worlds). A library of user worlds comes in a later milestone. The edit log is session history for undo and redo only and is not saved. The save's `schemaVersion` goes up; no migration is written (AGENTS.md, backward compatibility).

### Props and creatures

5. **A prop sits on the ground.** On `prop.add` and `prop.move` the engine sets the prop's height to the ground's height at its new position. The `y` field stays in the schema until terrain edits arrive, when dropping it is decided.

6. **Every creature replans after an edit.** Each creature drops its current route and plans a new one on the rebuilt navigation.

7. **A covered creature is moved, never deleted.** When an edit leaves a creature off any walkable cell of its profile (a prop placed or moved onto it, grown over it), the engine moves it to the nearest walkable cell in the main walkable area (the largest connected piece) of its own region, or of the nearest region its profile can move in, and emits an event saying so. The edit is rejected only when no such cell exists.

8. **Removed and moved placements are cleaned up.** For a removed prop, home, knowledge and behavior memory that name it are pruned as a restore prunes them (ADR 0019 §7, the behaviors' `forgetPlacements`). An action that targets a moved or removed placement is interrupted through the existing `interrupted` path.

9. **Blocking an exit out of water is allowed, with a warning.** As in ADR 0020 §19, an edit that blocks one or more water→land exits applies, and the result warns and names each one: an authored exit by its connection ID, a derived bank as `{ waterRegion, landRegion }`, since banks have no IDs.

10. **Validate first; return the inverse.** The edit command has a dry-run `validate` that reports, without changing anything, whether the edit would be accepted, the edited prop's footprint (the cells it would occupy), the warnings and the water→land exits it would block. An applied edit returns its inverse edit, so undo is one more edit, and redo the inverse of that.

11. **Scale has no fixed range.** A scale must be greater than 0 and the scaled footprint must lie inside the world's bounds; the edit check (§7, §9) handles the rest. A minimum and maximum per prop type may come later.

### Editing tools

12. **A minimal editor in the strip, plus a dev hook and `pnpm sim`.** The in-strip editor selects a prop by clicking it, drags it on the ground, deletes it, adds one from a palette of the registered prop types, scales it with the mouse wheel, rotates it with a key, and has undo and redo. Development builds also get a console hook, and `pnpm sim` runs edit scripts. The renderer stays read-only: it offers picking and the drag preview, and the app sends edit commands to the worker.

13. **Records.** This ADR records M17, and ADR 0020's M17 section is marked superseded. The private design docs are updated in their own repository.

## Exit

M17 is done when:

- a prop can be added, removed, moved, rotated and scaled through one validated edit command;
- `validate` reports an edit's outcome, footprint, warnings and blocked exits as a dry run;
- edits apply live, between ticks, without pausing the world; the full rebuild's cost is recorded in PR 1's "As built";
- every applied edit returns its inverse;
- creatures covered by an edit are moved to a walkable cell, with an event;
- a removed placement is pruned from home, knowledge and behavior memory, and actions targeting a moved or removed placement are interrupted;
- an applied edit that blocks a water→land exit returns a warning naming the exits;
- every creature's route is replanned after an edit;
- an edited world survives quitting and relaunching;
- edits work from the dev hook, `pnpm sim` and the in-strip editor;
- `pnpm check` and the full `pnpm soak` pass, with random edit cycles that include comparing a save and restore;
- a manual checklist entry is added and run by the owner;
- this ADR records the decisions and every departure from them.

## As built

Each M17 PR adds its own paragraph here, in its own slot, so PRs landing in parallel don't conflict.

### PR 1: schema and rebuild timing

`content-schema` defines the edit contract in `edit.ts`. `WorldEditOpSchema` is a discriminated union on `op`: `prop.add` (`prop`, horizontal `position`, `rotationY` default 0, `scale` default 1, optional placement `id`, which the engine assigns when it is left out), `prop.remove` (`id`), `prop.move` (`id` with `position`, `rotationY` or both) and `prop.scale` (`id`, `scale`). A scale must be greater than 0 and has no upper bound. Positions carry no height, since the engine puts props on the ground (§5). A `WorldEdit` is `{ ops }` with at least one op, applied in order and all or nothing, so a compound change is one rebuild and one undo step, and its inverse is the ops' inverses in reverse order. `parseWorldEdit` checks only the shape, and an op without `op` gets its own message. Whether an edit fits its world (the placements exist, footprints stay inside the bounds, creatures can be relocated) is the simulation's to check. The engine answers with `WorldEditResult`, whose `edit` and `inverse` are `AppliedWorldEdit`s in which every `prop.add` names its placement, or, for a dry run, `WorldEditCheck`. Both carry `footprints` (centre and block radius × scale), `warnings`, `blockedExits` (a connection ID or a bank `{waterRegion, landRegion}`, with the navigation profiles that lose it) and `relocated` creatures. A rejection carries diagnostics whose paths point into the edit. An inverse is exact only up to the ground snap: undoing restores position, rotation and scale, but a placement authored off the ground comes back on it. `pnpm rebuild-time` measures the rebuild. On a Ryzen 7 9700X (warm, 30 runs, two invocations), `WorldState.create` for Woodland Hollow takes a median of 26 ms with one navigation profile (the mossling) and 80–83 ms with three (the soak's species). A realistic edit, which is `WorldState.create`, the lazily built pathfinder data the relocation and blocked-exit checks need (crossings, areas, bank crossings) and 20 route queries per profile, takes a median of 35 ms (max 42 ms) with one profile and 117–144 ms (max 122–203 ms) with three. That is over the 100 ms tick. Navigation costs about 26 ms per profile, mostly walkability mask building (`buildRegionMask`, `pointInPolygon`), while the world model and scene data take under 1 ms. Live editing against this cost is to be decided with the owner before PR 2 (§3).

### PR 2: simulation

### PR 3: renderer

### PR 4: persistence

### PR 5: tools

### PR 6: app

## Consequences

- One pipeline with a full rebuild is simple and leaves no stale derived data, but its cost grows with the world. If larger worlds or terrain brushes make it too slow, an incremental or background rebuild replaces it behind the same command.
- A save of an edited world carries the whole world definition, so it is larger and no longer follows changes to the built-in world. That is what a user world needs, and the world library builds on it.
- Undo and redo are lost on relaunch, since only the edited world is saved.
- Structures and terrain are not editable yet; the op union and the full rebuild are where they join.
- Every edit makes every creature replan. Its cost and how it looks (a brief change of course is expected) are recorded in PR 2's "As built".

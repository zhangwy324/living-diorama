# ADR 0005: World content and walkability

- **Status:** Accepted
- **Date:** 2026-10-25
- **Context:** Roadmap M2 (pre-built world content). Its exit criteria (the banks connect only through the bridge, spawn points are walkable) need surfaces, walkability and region connectivity, which the roadmap had scheduled for M3. M2 also resolved three design smells found while planning it.

## Decisions

1. **The world model, surfaces, walkability and region graph are built in M2**, in `simulation`. M3 keeps the clock, RNG, path finding (A\* over regions and cells), actions, behaviors and the worker.

2. **Capabilities and affordances are registered vocabulary.** Two registries join the v1 set: `capabilities` (`core:walk`) and `affordances` (`core:crossable`). Species capabilities, connection `requiredCapabilities` and structure affordances are references, so a typo such as `core:wlak` fails reference resolution instead of silently making a connection unusable. The engine registers the `core` entries in `registerCoreEngine`.

3. **Locomotion rules live on capabilities, not in engine code.** A capability may carry `locomotion: { regionKinds, maxSlopeDeg? }`. `core:walk` is `{ regionKinds: [land, cave], maxSlopeDeg: 35 }`. A species can move in a region whose kind one of its locomotion capabilities lists, with the most permissive slope limit among them. This is how region kinds affect navigation, refining ADR 0004 §5: the engine still never branches on a kind or a capability ID, it reads the rules. A later `core:swim` or `core:climb` is a new registry entry, not engine code.

   _Amended by [ADR 0020](0020-body-plans-swimming-and-live-edits.md) §2 (planned, M16 PR 2):_ `core:walk` becomes `core:land`, and `core:swim` covers `water`. A capability may also name an animation profile and a submersion.

4. **Walkability is derived at load time** for each region and navigation profile (size class plus locomotion rules), on the world's cell grid (the heightfield cells). A cell is judged at its centre:
   - outside the region's footprint: not part of the region;
   - no locomotion for the region's kind, no surface (e.g. beside a deck), or too steep (slope sampled at the centre and inside both terrain triangles): blocked;
   - **submerged**: a water region covers the point with its surface above the ground. Shorelines therefore come from the terrain, and footprints may overlap the river;
   - **covered**: another region's surface lies at most one step above, e.g. the ground under a deck's end. The creature stands on that region there, so this is not an obstacle;
   - **no headroom**: another region's surface is higher than that but lower than the creature;
   - then clearance for the creature's radius: blocked cells, props (`blockRadius` plus radius), the world's edge and the surface's own side edge.

   Water uses the new **`core:flat`** surface (`{ y }`): the water region stands on the water level, not the riverbed, which is just terrain.

   _Amended by [ADR 0020](0020-body-plans-swimming-and-live-edits.md) §3–§4 (planned, M16 PR 2):_ the rules apply per profile. A water region is walkable for a profile whose locomotion covers `water`, only where its surface lies above the ground; land under water stays submerged for every profile. A swimmer enters water from land by a derived one-way entry and leaves it only by an authored exit.

5. **World checks** (`checkWorld`) report structured diagnostics:
   - errors: a region whose walkable area splits into several pieces, an unusable portal (no walkable cells on both sides, or a step above `maxStepHeight`), two regions walkable at the same place and height, a spawn point that is not walkable;
   - warnings: two regions touching without a portal (an invisible wall), a region with no walkable area, a connection no species can use, no species registered.

   They run for every registered species' profile. "Banks connected only through the bridge" is a test of the built-in world (removing the bridge disconnects them), not engine logic.

   _Amended by [ADR 0020](0020-body-plans-swimming-and-live-edits.md) §5 (planned, M16 PR 2):_ `unsatisfiable_connection` is removed: reference resolution already rejects an unregistered capability, so it could only fire for a registered capability no species has yet, which is the normal case for swimmers drawn later. `spawn_unusable` fires only for a spawn point in a region kind no registered capability covers. Per-profile checks skip a connection with a side in a region kind the profile can't move in, and the bank beside a derived water entry is not a `region_seam`.

6. **The built-in world is generated.** `tools/development/src/worldgen` turns a layout (river spline, plateau, ramp, bridge, groves, spawns) into the whole world definition with a seeded generator. `pnpm worldgen` writes `packages/built-in-content/src/woodland-hollow/world.json` and a top-down debug map (`tools/development/out/`). A test fails if the JSON differs from the generator's output. Heights are inline, in millimetres: the schema validates them fully and no decoder is needed. The asset heightfield path stays in the schema for larger worlds.

7. **The built-in pack has its own namespace, `hollow`.** `core` is for engine vocabulary (surfaces, actions, behaviors, capabilities, affordances), so the pack registers exactly like a third-party one.

8. **Prop `blockRadius` is in world metres** and is not scaled by `transform.scale`.

   _Amended by [ADR 0018](0018-living-behavior.md) §3 (M14 PR 2b):_ `blockRadius` moved to the prop type and is in metres at scale 1. A placement blocks `blockRadius × transform.scale`.

9. **A 3D preview is pulled forward from M4** so the layout can be judged in the strip:
   - `simulation` turns the world model into plain `SceneData` (terrain samples, surface meshes from each surface type, edge water, props), so the renderer never interprets surface types or parameters;
   - decks are drawn from their surface mesh, so the bridge's visuals cannot drift from its walkable surface (roadmap risk R2);
   - props are placeholders keyed by model ref, supplied by the app (a map lookup, not branching) until M4 adds real assets.

## Consequences

- `REGISTRY_NAMES` has eight entries. Content that uses a capability or affordance needs it registered first.
- Any locomotion mode must be a registered capability with a rule before a species can move with it.
- Region footprints may overlap. The walkability rules, not polygon precision, decide where the ground ends.
- Changing the world means editing the layout and running `pnpm worldgen`, never editing the JSON.
- Water standing above a lower region (a lake over a cave) would mark that region submerged. Water regions will need a depth or bottom when caves arrive.

# ADR 0012: Runtime species and creatures

- **Status:** Accepted
- **Date:** 2026-10-27
- **Context:** Roadmap M9. Until now the worker registered all content once, at `init` (ADR 0010), and the app could only add creatures. Drawn species (M10, M11) arrive while the world runs, and the player removes creatures again. Both have to go through the same schemas, registries and checks as pack content, and no engine code may tell a drawn species from a pack's.

## Decisions

1. **Protocol version 4 adds request commands.** `register_species` (a species definition and the URL of its appearance image), `despawn` (a creature ID), and the existing `spawn` can fail in normal use: a drawing the world can't support, a full world, a creature that already left. Each carries an optional `requestId`, and the worker answers with the same ID:
   - `species_registered` with the species and asset summaries the renderer needs, `spawned` or `despawned` with the creature ID;
   - `rejected` with the command and its diagnostics. It is not a fault: the world keeps running.

   `error` is kept for misuse (a command before `init`, another protocol version, an unknown command, invalid settings) and stays fatal in the app (ADR 0009 §2).

2. **A species' appearance is an image asset named by the species.** `register_species` carries only a URL; the asset's ID is the species' `appearance` and its version the species' version, so the two can't disagree.

3. **Registration is all or nothing.** `Registry.validate` checks what `register` checks without registering. `addEntries` in `extension-api` validates a batch of entries, resolves their references against what is registered plus the batch, and registers them only if everything passes. Existing entries can't refer to the new ones, so there is no cycle check. References are only resolved once every entry is valid, so a broken asset isn't reported again as an unresolved reference from the species.

4. **A species with a new navigation profile gets navigation built when it registers.** A profile is the size class plus the capabilities, and navigation was only built at `init`, for the profiles of the species registered then. Now `checkNavigation` builds one profile's navigation and runs the per-profile half of `checkWorld`: split regions, unusable portals, region seams and spawn points. Errors reject the species with the world's diagnostics, just as a broken pack species fails startup. The pathfinder is kept only if the registration succeeds. A build takes about 30 ms in the worker, once per profile.

5. **The `user` namespace is the app's convention.** `apps/desktop/src/user-species.ts` generates `user:<uuid>` species IDs and `user:<uuid>/appearance.png` asset IDs. The engine doesn't reserve the namespace, since that would be engine code treating user species differently, and UUIDs can't collide with pack IDs.

6. **The world holds at most `maxCreatures` creatures.** `init` sets the cap from `startup.ts` (20, the count the invariant test and the development check cover). A spawn beyond it is rejected with `world_full`: "The world is full (20 creatures). Remove one to add another." In development builds a `VITE_CREATURE_COUNT` above the cap raises it, so the app can still be checked with more creatures.

7. **Events.** `species_introduced` follows the `creature_spawned` of the first creature of a species in the world, built-in species included; it carries that creature's ID. Registering alone doesn't introduce a species, because M10 registers every library species at each launch. `creature_despawned` carries the species and the region the creature left.

8. **The main thread keeps its lookups in step.** `SimulationClient.registerSpecies`, `spawn` and `despawn` return promises of a `Result`, matched to replies by request ID. `onSpeciesRegistered` runs before `registerSpecies` resolves, and `App.tsx` adds the species and asset to the maps the renderer resolves from. The renderer resolves species when it first meets one of their creatures, so it needs no change. Starting creatures go through `spawn` too; one that can't be added is logged as a warning instead of stopping the app.

## Consequences

- A headless test registers a species mid-run in the Woodland Hollow, spawns and despawns its creatures, and every M3 invariant still holds. The invariant runner now checks each creature against its own species' navigation.
- **The Woodland Hollow only supports medium creatures.** With decision 4 the world checks run for other size classes, and they fail. For tiny and small, a few dry cells in the outermost row, where the river meets the world's edge, form walkable islands (`disconnected_region`); medium never stands in that row. For large, the walkable areas also split, and the bridge ends are too narrow (`portal_unusable`). Pack species with those size classes would fail startup in the same way. Drawn species of other sizes need the world (or the checks) to change before M11 offers a size choice. **Superseded by [ADR 0013](0013-size-limits.md):** creatures go only where they fit, and those failures are warnings.
- Registered species can't be removed yet: registries have no unregister. Deleting a species comes with the library (M10).
- The protocol and architecture docs list the new messages and events.

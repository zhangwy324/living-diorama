# @living-diorama/content-schema

Versioned data contracts for worlds, terrain, regions, connections, structures, prop types, prop categories, species, voxel part types and socket types, voxel parts and assemblies, part definitions (a voxel part registered by a pack), the files of the species library, and the world save.

## Owns

- Schema definitions and their schema versions, and the params schemas of the core affordances.
- The species body plan: the style per medium (the land gait), with its default ([ADR 0020](../../docs/adr/0020-body-plans-swimming-and-live-edits.md) §11, §13). A species' shape, depth and anchors come from its voxel assembly ([ADR 0025](../../docs/adr/0025-drawing-voxel-parts.md) §11).
- The species library's entry schema, and the migrations that bring older entries up to date ([ADR 0014](../../docs/adr/0014-species-library.md)). An entry holds its voxel assembly inline, and its stored size class must be the measured one ([ADR 0022](../../docs/adr/0022-voxel-creatures.md) §17, M19 decisions).
- Voxel parts and assemblies (ADR 0022): the run-length encoding of a part's cubes, the structural checks run on load (caps, the step ladder, one root, free sockets, mirror pairs, quarter-turn rest rotations, joint depth and grid snapping in whole units of half the finest step), the type fit checks run on release against a lookup of registered types, flush-face warnings, and `measureAssembly`: rest-pose bounds, size class, ground contact, centre of gravity and tail, as pure functions.
- `assembleParts`, the seeded part assembler (ADR 0022, M20 decisions): it fills an assembly's free sockets with library parts that fit them, mirroring pairs, within the validator's rules, the same way for the same seed. Pure.
- Assembly edit operations for the Studio (ADR 0023): attach, replace, remove, rotate, step and recolour, mirroring pairs and copying shared parts on write, each returning a valid assembly or a refusal; free compatible sockets, socket scoring, and an undo history of immutable snapshots. Pure.
- Drawn parts (ADR 0025): the part drawing schema (a 32×32 grid of colours, its view (side, front or top), depth rule (puffy, tube or flat), chubby factor and step), `voxelizeDrawing`, which gives each painted pixel a depth by the rule and crops the cubes to the drawing, and `fitDrawnPart`, which moves a base part's attach point and sockets onto the drawn cubes (or keeps points the player placed), each socket aiming for its base socket's joint depth and mirror pairs kept mirrored, and reports how deep each socket sits. The player part entry schema (`user-part:<uuid>`): a part the player drew and its drawing. Pure.
- The world save schema: the simulation's state as plain data, mirrored field for field (action state and behavior memory stay `unknown`).
- World edits (ADR 0021): the edit ops (`prop.add`, `prop.remove`, `prop.move`, `prop.scale`; an edit is one or more ops applied all or nothing) and their validation, and the shapes of the engine's answers to applying or checking an edit (footprints, warnings, blocked water exits, relocated creatures, the inverse edit). Applying an edit is the simulation's job.
- Validation of content data, with structured, readable diagnostics.
- Namespaced and local ID formats, and the constants from [world coordinates](../../docs/world-coordinates.md).

## Must not

- Contain runtime behavior or engine logic.
- Depend on any other workspace package.

## Workspace dependencies

none (external: `zod`, which stays internal to this package; see [ADR 0002](../../docs/adr/0002-content-schema.md))

Boundary rules are enforced by `pnpm boundaries` (dependency-cruiser) and `pnpm lint`; see roadmap §1.4.

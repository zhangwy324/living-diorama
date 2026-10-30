# @living-diorama/content-schema

Versioned data contracts for worlds, terrain, regions, connections, structures, prop types, prop categories, species, voxel part types and socket types, voxel parts and assemblies, part definitions (a voxel part registered by a pack), the files of the species library, and the world save.

## Owns

- Schema definitions and their schema versions, and the params schemas of the core affordances.
- The species body plan: thickness, the style per medium (the land gait) and the optional anchors (center of gravity, tail) in drawing pixels, with their defaults ([ADR 0020](../../docs/adr/0020-body-plans-swimming-and-live-edits.md) §10–§11, §13).
- The species library's drawing and entry schemas, and the migrations that bring older library files up to date ([ADR 0014](../../docs/adr/0014-species-library.md)). An entry's body is drawn or voxel; a voxel one holds its assembly inline, and its stored size class must be the measured one ([ADR 0022](../../docs/adr/0022-voxel-creatures.md) §17, M19 decisions).
- Voxel parts and assemblies (ADR 0022): the run-length encoding of a part's cubes, the structural checks run on load (caps, the step ladder, one root, free sockets, mirror pairs, quarter-turn rest rotations, joint depth and grid snapping in whole units of half the finest step), the type fit checks run on release against a lookup of registered types, flush-face warnings, and `measureAssembly`: rest-pose bounds, size class, ground contact, centre of gravity and tail, as pure functions.
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

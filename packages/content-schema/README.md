# @living-diorama/content-schema

Versioned data contracts for worlds, terrain, regions, connections, structures, prop types and species, the files of the species library, and the world save.

## Owns

- Schema definitions and their schema versions, and the params schemas of the core affordances.
- The species library's drawing and entry schemas, and the migrations that bring older library files up to date ([ADR 0014](../../docs/adr/0014-species-library.md)).
- The world save schema: the simulation's state as plain data, mirrored field for field (action state and behavior memory stay `unknown`).
- Validation of content data, with structured, readable diagnostics.
- Namespaced and local ID formats, and the constants from [world coordinates](../../docs/world-coordinates.md).

## Must not

- Contain runtime behavior or engine logic.
- Depend on any other workspace package.

## Workspace dependencies

none (external: `zod`, which stays internal to this package; see [ADR 0002](../../docs/adr/0002-content-schema.md))

Boundary rules are enforced by `pnpm boundaries` (dependency-cruiser) and `pnpm lint`; see roadmap §1.4.

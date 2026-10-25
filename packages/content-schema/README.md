# @living-diorama/content-schema

Versioned data contracts for worlds, terrain, regions, connections, structures and species.

## Owns

- Schema definitions and their schema versions.
- Validation of content data, with structured, readable diagnostics.
- Namespaced and local ID formats, and the constants from [world coordinates](../../docs/world-coordinates.md).

## Must not

- Contain runtime behavior or engine logic.
- Depend on any other workspace package.

## Workspace dependencies

none (external: `zod`, which stays internal to this package; see [ADR 0002](../../docs/adr/0002-content-schema.md))

Boundary rules are enforced by `pnpm boundaries` (dependency-cruiser) and `pnpm lint`; see roadmap §1.4.

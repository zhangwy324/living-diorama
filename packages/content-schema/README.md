# @living-diorama/content-schema

Versioned data contracts for worlds, terrain, regions, connections, structures and species.

## Owns

- Schema definitions and their schema versions.
- Validation of content data, with structured, readable diagnostics.

## Must not

- Contain runtime behavior or engine logic.
- Depend on any other workspace package.

## Workspace dependencies

none

Boundary rules are enforced by `pnpm boundaries` (dependency-cruiser) and `pnpm lint`; see roadmap §1.4.

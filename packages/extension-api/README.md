# @living-diorama/extension-api

Registries, namespaced IDs, content versions and dependency resolution.

## Owns

- The generic `Registry<T>` and the v1 registries (`worlds`, `structures`, `species`, `surfaces`, `actions`, `behaviors`, `capabilities`, `affordances`, `assets`), including capability locomotion rules ([ADR 0005](../../docs/adr/0005-world-content-and-walkability.md)) and asset entries ([ADR 0007](../../docs/adr/0007-renderer.md)).
- Registration (validation, duplicate detection) and reference resolution across entries: existence, semver ranges, surface params and load order ([ADR 0003](../../docs/adr/0003-content-versioning.md)).
- Adding entries to resolved registries all or nothing (`addEntries`), e.g. a species registered while the app runs ([ADR 0012](../../docs/adr/0012-runtime-species.md)).

## Must not

- Know about any specific content (built-in or otherwise).

## Workspace dependencies

`@living-diorama/content-schema` (external: `semver`)

Boundary rules are enforced by `pnpm boundaries` (dependency-cruiser) and `pnpm lint`; see roadmap §1.4.

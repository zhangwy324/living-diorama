# @living-diorama/extension-api

Registries, namespaced IDs, content versions and dependency resolution.

## Owns

- The generic `Registry<T>` and the v1 registries (`worlds`, `structures`, `species`, `surfaces`, `actions`, `behaviors`).
- Namespaced IDs (`core:…`), semver content versions, schema-version checks, duplicate detection and dependency resolution.

## Must not

- Know about any specific content (built-in or otherwise).

## Workspace dependencies

`@living-diorama/content-schema`

Boundary rules are enforced by `pnpm boundaries` (dependency-cruiser) and `pnpm lint`; see roadmap §1.4.

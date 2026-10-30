# @living-diorama/extension-api

Registries, namespaced IDs, content versions and dependency resolution.

## Owns

- The generic `Registry<T>` and the registries (`worlds`, `structures`, `props`, `propCategories`, `species`, `surfaces`, `actions`, `behaviors`, `capabilities`, `affordances`, `assets`, `needs`, `senses`, `traits`), including capability locomotion rules ([ADR 0005](../../docs/adr/0005-world-content-and-walkability.md)) with their animation profile and submersion, and `animationProfile`, which resolves a rule's profile for a species' body plan ([ADR 0020](../../docs/adr/0020-body-plans-swimming-and-live-edits.md) §8–§9), asset entries ([ADR 0007](../../docs/adr/0007-renderer.md)), and prop types, affordance params checked against each affordance's params schema, affordance memory caps, need rates, thresholds, starting ranges, cues, effects, rate traits and individual variation, sense and trait ranges, and action cues ([ADR 0018](../../docs/adr/0018-living-behavior.md)), and prop categories with the category a prop type names, listed in drawer order by `sortedPropCategories` ([ADR 0021](../../docs/adr/0021-live-prop-editing.md)).
- Registration (validation, duplicate detection) and reference resolution across entries: existence, semver ranges, surface params, species sense and trait values within their ranges, a species having at least one locomotion capability (checks across an entry's references, `RegistryOptions.check`), and load order ([ADR 0003](../../docs/adr/0003-content-versioning.md)).
- Adding entries to resolved registries all or nothing (`addEntries`), e.g. a species registered while the app runs ([ADR 0012](../../docs/adr/0012-runtime-species.md)).

## Must not

- Know about any specific content (built-in or otherwise).

## Workspace dependencies

`@living-diorama/content-schema` (external: `semver`)

Boundary rules are enforced by `pnpm boundaries` (dependency-cruiser) and `pnpm lint`; see roadmap §1.4.

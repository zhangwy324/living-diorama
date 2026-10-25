# ADR 0003: Content versioning

- **Status:** Proposed
- **Date:** 2026-10-25
- **Context:** Roadmap M1 task 3, resolving spec §15.1. The illustrative contracts mixed a numeric `schemaVersion` on species, a string `speciesVersion` on instances, and no content version on species at all.

## Decisions

1. **Every registered definition has two version fields:**
   - `schemaVersion`: a positive integer. The version of the **data format** for that definition type (world, structure, species), owned by `content-schema` (`SCHEMA_VERSIONS`). It changes only when the format changes, and a change comes with a migration.
   - `version`: a **semver** string. The version of **this piece of content**, owned by its author. It changes whenever the content changes.
2. **The schema version is checked before anything else.** An unsupported `schemaVersion` gives one clear diagnostic ("world schema version 2 is not supported; supported: 1") instead of a cascade of shape errors. This is also where migrations will hook in.
3. **A registry holds one version per ID.** Registering the same ID twice is a `duplicate_id` error, whatever the versions. Side-by-side versions can be added if migrations ever need them.
4. **References inside content are bare content IDs**, resolved to whatever version is registered. **Dependencies** between registry entries may add a semver **range** (`^1.2.0`). Resolution reports an error when the registered version does not satisfy it.
5. **Creature instances pin the exact species version** (`speciesVersion`, semver). A loader treats the instance as compatible when the registered species has the same major version. This matters once saves exist (post-MVP); v1 spawns always use the registered version.
6. **Worker protocol messages carry their own integer `protocolVersion`**, independent of content versions. See `PROTOCOL_VERSION` in `simulation`.

## Consequences

- `extension-api` depends on the `semver` package for range checks. `content-schema` only checks the format with a regex.
- Pack-level manifests (post-MVP) will reuse the same pair: `version` for the pack, `schemaVersion` for the manifest format.

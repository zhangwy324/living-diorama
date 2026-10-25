# ADR 0002: Content schema

- **Status:** Proposed
- **Date:** 2026-10-25
- **Context:** Roadmap M1 task 2. Content (worlds, structures, species) is JSON-shaped data that built-in content and future packs provide. It needs one validation layer that gives readable diagnostics.

## Decisions

1. **Zod 4** defines every content schema in `@living-diorama/content-schema`. TypeScript types are inferred from the schemas (`z.output`), so a schema and its type can't drift apart. Zod was picked over TypeBox for its readable issue paths and messages and its easy cross-field refinements. Its JSON Schema export is available if packs ever need an editor schema. Validation speed doesn't matter: content is validated once, at load.
2. **Zod stays inside `content-schema`.** Other packages call `validate(schema, input)` and the `parse*` functions, and receive a `Result<T>` with structured `Diagnostic`s (`severity`, `code`, `message`, `path`, `source`). `extension-api` refers to schemas only through the `Schema<T>` type alias.
3. **Objects are strict.** Unknown keys are errors, so typos in hand-written content fail loudly instead of being ignored.
4. **Two kinds of ID:**
   - **Content IDs** are namespaced, `namespace:name` (e.g. `core:wander`, `community.glow-frog:frog`), for anything registered in a registry or referenced across packs. The namespace may contain dots; the name may contain `/` and `.` (asset paths).
   - **Local IDs** (`north-bank`, `bridge-west`) name things inside one world: regions, connections, structure placements, props and spawn points. They are unique across the whole world, including regions contributed by structures.
5. **Structure type vs placement.** The roadmap lists a single `StructureDefinition` with both type data (kind, visuals, affordances) and instance data (transform, regions, connections). It is split in two:
   - `StructureDefinition` is a registered **type** (`core:wooden-bridge`): visual asset refs and affordances.
   - `StructurePlacement` is an **instance** inside a world: a local ID, the structure type's content ID, a transform, and the **regions and connections it contributes, in world coordinates**.

   This matches where structures are heading. A sketched bridge is a generated instance with its own geometry and portals, made from a reusable type. Removing a placement removes exactly the regions and connections it contributed.

6. **Surface parameters are validated by the surface type.** A region's surface is `{ type: <content id>, params }`. Each `surfaces` registry entry carries a params schema. `extension-api` validates the params when it resolves references, so a new surface type needs no change to `content-schema`. The v1 params schemas (`HeightfieldSurfaceParamsSchema`, `DeckSurfaceParamsSchema`) are exported for the simulation to register.
7. **Validation layers:**
   - `content-schema` checks shape plus integrity **within one definition**: unique local IDs, connection endpoints exist, heightfield size matches bounds, positions inside bounds.
   - `extension-api` checks **references across entries**: structure types, surface types, behaviors, dependencies and versions.
   - Semantic and geometric checks (banks connected only by the bridge, spawn points walkable, portal step heights) happen when the simulation builds the world in M2/M3.
8. **Material zones carry their own colour.** The terrain palette gives each zone a name and a colour, so the renderer never branches on zone names.

## Consequences

- The ESLint content-ID pattern now allows dotted namespaces.
- `extension-api` can't use Zod APIs directly. If it ever needs to, add a helper to `content-schema`, not a Zod dependency.
- Spec appendix A types are superseded by the schemas in `content-schema`.

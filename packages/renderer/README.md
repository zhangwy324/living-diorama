# @living-diorama/renderer

Three.js scene: terrain, water, structures, props, creatures, camera and debug overlays.

## Owns

- Everything drawn on screen, including camera state (which never reaches the simulation).
- Interpolation between simulation snapshots.
- The scene built from the simulation's `SceneData`: terrain, diorama base, animated water, structure decks with railings, and props instanced from their model assets, in layers with clipping-plane support ([ADR 0007](../../docs/adr/0007-renderer.md)).

## Must not

- Mutate simulation state. It may only import `simulation` for types (snapshots, events); data arrives as messages.
- Branch on content IDs.

## Workspace dependencies

`@living-diorama/content-schema`, `@living-diorama/simulation`

Boundary rules are enforced by `pnpm boundaries` (dependency-cruiser) and `pnpm lint`; see roadmap §1.4.

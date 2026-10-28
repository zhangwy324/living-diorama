# @living-diorama/renderer

Three.js scene: terrain, water, structures, props, creatures, camera and debug overlays.

## Owns

- Everything drawn on screen, including camera state (which never reaches the simulation).
- Interpolation between simulation snapshots.
- The scene built from the simulation's `SceneData`: terrain, diorama base, animated water, structure decks with railings, and props instanced from their model assets, in layers with clipping-plane support ([ADR 0007](../../docs/adr/0007-renderer.md)).
- Creatures: solid bodies extruded from the species `appearance` image ([ADR 0011](../../docs/adr/0011-extruded-creature-bodies.md)), turned to their heading, true to scale, casting shadows from the sun, drawn one tick behind the newest snapshot. A grey block stands in while a drawing loads or if it fails.
- The Creation Studio's body preview and its checks for thin parts and separate shapes ([ADR 0015](../../docs/adr/0015-creation-studio.md) §7): one body turning over a grid, lit like the diorama, in a WebGL context of its own.
- Camera limits: the orbit target stays over the world and the camera above the terrain. The view hands out and takes back its camera state (`cameraState`, `setCameraState`), so the app can keep one camera per window shape (ADR 0016 §6).
- Pixel density: the diorama view and the body preview follow `devicePixelRatio` when the window moves to a monitor with another scale, up to 2× (ADR 0016 §8, issue #55).
- Debug overlays, hidden until `setDebug(true)`: walkability cells, the region graph and portals, creature routes, structure surfaces as wireframes, and an FPS and tick panel. Walkability and the graph come from the app as `NavigationOverlay` data; routes come in snapshots.
- Render throttling: the display rate while hovered or while the camera moves, about 30 fps otherwise, nothing while the page is hidden.

## Must not

- Mutate simulation state. It may only import `simulation` for types (snapshots, events); data arrives as messages.
- Branch on content IDs.

## Workspace dependencies

`@living-diorama/content-schema`, `@living-diorama/simulation`

Boundary rules are enforced by `pnpm boundaries` (dependency-cruiser) and `pnpm lint`; see roadmap §1.4.

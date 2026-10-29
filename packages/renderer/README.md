# @living-diorama/renderer

Three.js scene: terrain, water, structures, props, creatures, camera and debug overlays.

## Owns

- Everything drawn on screen, including camera state (which never reaches the simulation).
- Interpolation between simulation snapshots.
- The scene built from the simulation's `SceneData`: terrain, diorama base, animated water, structure decks with railings, and props instanced from their model assets, in layers with clipping-plane support ([ADR 0007](../../docs/adr/0007-renderer.md)).
- Creatures: solid bodies extruded from the species `appearance` image ([ADR 0011](../../docs/adr/0011-extruded-creature-bodies.md)), turned to their heading, true to scale, casting shadows from the sun, drawn one tick behind the newest snapshot. A grey block stands in while a drawing loads or if it fails.
- Cues (ADR 0018 §15): a creature's `cues` from its snapshot pose its body (a gentle bob and peck while eating, with a ring above the head filling with the snapshot's `cueProgress`; lowered by about 10% and breathing slowly while sleeping) and add sprites (rising, leaning z's while sleeping, two at a time at strip size; a round food bubble with a neutral food icon while hungry). Each cue fades in and out. The sprites are drawn procedurally, unlit and over the scene, with thick outlines and sharpened texture sampling, sized in CSS pixels with a minimum so they stay readable in the strip, and pooled. The z's are dark on light by day and light on dark at night, following the snapshot's time of day. `CueSprites.reducedMotion` is a hook for a future reduced-motion setting. A creature hidden from the camera by the terrain or a deck, or clipped away, fades its cues out (`cue-visibility.ts`, a few cheap CPU checks a second per creature); props, trees and other creatures never hide cues. The renderer knows only the cue vocabulary, no action or need IDs.
- The Creation Studio's body preview and its checks for thin parts and separate shapes ([ADR 0015](../../docs/adr/0015-creation-studio.md) §7): one body turning over a grid, lit like the diorama, in a WebGL context of its own.
- Camera limits: the orbit target stays over the world and the camera above the terrain. The view hands out and takes back its camera state (`cameraState`, `setCameraState`), so the app can keep one camera per window shape (ADR 0016 §6).
- Pixel density: the diorama view and the body preview follow `devicePixelRatio` when the window moves to a monitor with another scale, up to 2× (ADR 0016 §8, issue #55).
- Debug overlays, hidden until `setDebug(true)`: walkability cells, the region graph and portals, creature routes, structure surfaces as wireframes, an FPS and tick panel, and per creature a label with its action, home, needs and knowledge, with lines to its home and known places and squares for its recent cells (ADR 0018 §15). Walkability and the graph come from the app as `NavigationOverlay` data; routes, needs, knowledge and home come in snapshots, and need and affordance IDs are shown generically by their name after the namespace.
- Render throttling: the display rate while hovered or while the camera moves, about 30 fps otherwise, nothing while the page is hidden.

## Must not

- Mutate simulation state. It may only import `simulation` for types (snapshots, events); data arrives as messages.
- Branch on content IDs.

## Workspace dependencies

`@living-diorama/content-schema`, `@living-diorama/simulation`

Boundary rules are enforced by `pnpm boundaries` (dependency-cruiser) and `pnpm lint`; see roadmap §1.4.

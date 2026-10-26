# ADR 0007: Renderer

- **Status:** Accepted
- **Date:** 2026-10-25
- **Context:** Roadmap M4 (renderer). ADR 0005 §9 pulled a 3D preview forward into M2: terrain, the diorama base, water, a deck slab drawn from its surface mesh, placeholder props and orbit controls. M4 turns it into the real renderer. It ships as three PRs: **A** scene and assets (this ADR's §1–§5), **B** creatures, interpolation and camera, **C** debug overlays and throttling. Decisions for B and C are recorded here now so the PRs share one design; each PR updates this ADR if it has to deviate.

## Decisions

### Scene and assets (PR A)

1. **Assets are registry entries.** A ninth registry, `assets`, holds `{ id, version, kind, url, scale? }`:
   - `id` is the asset ref content already uses (`hollow:models/pine.glb`), so refs resolve like any other reference;
   - `kind` is `image` or `model`, so the renderer picks a loader without looking at file extensions;
   - `url` is where the file is served from. A pack computes it with `new URL("./file", import.meta.url)`, which Vite turns into a bundled asset and which Node (tests, tools) reads as a file URL;
   - `scale` is metres per model unit, for models authored in another unit. It is import metadata, so placements keep meaning "world metres".

   Species `appearance`, structure `visualAssets` and prop `model` are references into `assets`, so a missing or misspelled asset fails `resolveReferences`. A prop model must be of kind `model`. The renderer gets a resolver `(ref) => AssetEntry | undefined` from the app and draws a neutral fallback (a grey block sized from the prop's `blockRadius`) for any asset it cannot load, so a broken file never blanks the scene. The app-supplied placeholder map from ADR 0005 §9 is removed.

2. **Prop art is Kenney's Nature Kit** (CC0, kenney.nl). Only the models the pack uses are committed, under `packages/built-in-content/src/woodland-hollow/assets/`, with the licence text beside them. Each model is loaded once and drawn as instanced meshes, one per model part, so the ~100 props cost a handful of draw calls.

3. **Structure railings come from the simulation's data, not from renderer guesses.** `SceneData` gains `openEdges` on structure surfaces: the rim edges of the surface mesh that no portal of the region covers, i.e. where a creature could step off. The renderer draws posts and rails along them. The visuals are still derived from the walkable surface (roadmap risk R2), and the renderer never interprets surface types.

4. **Scene layers and clipping.** The scene is split into `terrain` (terrain and base), `water`, `structures`, `props` and `creatures` groups. Every material is created with the layer's shared clipping-plane array, and the view exposes `setClipping(layer, planes)` with planes as plain data. Nothing calls it in v1; the cave cutaway (roadmap §1.5) then needs no rework.

5. **Lighting and framing are derived from the world.** The sun's shadow camera fits the world bounds instead of fixed numbers. The default framing looks at the mean terrain height, a tenth of the world's depth behind its centre, with the full width in view (ADR 0005 §9). One shared water material serves the water surfaces and the base's water cross-sections; it animates with slowly drifting light bands in world space (no textures, no reflections), driven by the render clock.

### Creatures, interpolation and camera (PR B)

6. **Creature look:** a sprite from the species `appearance` image on a plane that turns only about the vertical axis, so it stays upright when the camera looks down. It is mirrored when its heading points left on screen, and a soft shadow blob sits under it, tilted to the terrain or deck it stands on (found by a short downward ray, so slopes and arched decks do not cut into it). The mossling's sprite is a hand-made SVG placeholder until creature drawing exists.

7. **No minimum on-screen size.** Sprites are drawn true to scale, at their size class's height. A minimum of about 24 px was tried in PR B and dropped: it only took effect when zooming out past the default framing, where it made creatures taller than the trees. Legibility in the strip is a matter of the sprite art (contrast, outline), not of scaling.

8. **Interpolation:** the renderer draws one tick behind the newest snapshot, interpolating world positions between the last two. Headings blend the short way round. A creature that spawns, or moves more than a few metres between two snapshots, snaps instead of sliding.

9. **Camera:** full controls in both compact and expanded mode (roadmap §1.9 Q1). Limits: the existing pan clamp to the world footprint and polar-angle cap, plus a minimum height above the terrain under the camera. Double-click resets for now; M5 adds a button. The app spawns 3 creatures (roadmap §1.9 Q3), so nothing in the renderer assumes one.

### Overlays and throttling (PR C)

10. **Debug data.** A `set_debug` command makes the worker add each creature's remaining route (waypoints per leg) to its snapshots; `PROTOCOL_VERSION` becomes 2. The walkability masks, region graph and portals are static, so the app computes them on the main thread from the world model and hands them to the renderer as plain data, keeping the renderer's import of `simulation` type-only. The overlay shows the profile of the species the app spawns. Until M5's controls overlay, the D key toggles every overlay at once; it reaches the view and the worker together. Cells of a region with no locomotion (the river, for a walker) have no surface height in its mask and are not drawn.

11. **Render throttling.** The strip never takes focus (M5), so focus is the wrong signal. The renderer runs at the display rate while the pointer is over it, during camera interaction and during the reset animation; at about 30 fps otherwise; and not at all while the page is hidden. The frame after any camera change also runs at the display rate, so damping settles smoothly. The idle schedule advances by a fixed interval rather than restarting at each frame, because some browsers round frame timestamps to 10 ms. The simulation is not throttled.

12. **Testing.** WebGL does not run in Vitest, so tests cover what can run without it: scene building (three.js objects work in Node), framing, camera limits, interpolation, open edges and overlay data. Legibility at 180, 220 and 260 px strip height is checked by screenshots of the dev app.

## Consequences

- `REGISTRY_NAMES` has nine entries. A pack must register every file its content refers to.
- Adding a model means adding the file, its `assets` entry and, if it is not in metres, its `scale`.
- Wander tuning (ADR 0006 §9) is revisited in a small simulation PR once creatures are visible, not in M4's PRs.

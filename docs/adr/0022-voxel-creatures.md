# ADR 0022: Voxel creatures

- **Status:** Accepted
- **Date:** 2026-10-29
- **Context:** Roadmap §3.2: after M17, creatures are built from voxel parts (M18–M24). A drawn body (ADR 0011, ADR 0017) is one extruded slab: it has no parts to move, its thickness is the same everywhere, and its real size is set by stretching the drawing to its size class's height. Voxel parts give a creature real parts that can be animated one by one (M22), a size measured from its cubes, and a format that a drawing (M23) and a block editor (M24) can both produce. M18 is a look spike and this ADR. The spike, in a throwaway branch, put hand-made voxel parts in today's world at their true size and compared cube sizes, colours and lighting in day and night screenshots at close-up and strip size, and a benchmark timed meshing. It found:
  - **Cube sizes.** Tiny, large and house-sized objects side by side read well with four cube sizes, each twice the last. A step coarser than 10 cm makes a roof too blocky. The finest step is under a pixel at strip size on a tiny creature, which is accepted: it still shows close up.
  - **Colour.** Saturated creature colours clash with the world's softer ones. Keeping the creature's hues but toning them toward the world's looks best.
  - **Look.** The body glow drawn bodies use (0.35) flattens voxel shading; 0.15 keeps the cubes readable at night. Today's ambient occlusion strength is right. Per-cube colour variation and outlines didn't earn their cost yet.
  - **Rendering.** A skinned mesh with one bone per part, each vertex fully weighted to its part's bone, draws a whole creature in one call and moves its parts rigidly. Three's frustum culling then uses the mesh's rest bounds, so it must be off or the bounds kept up to date.
  - **Joints.** A socket buried one parent cube deep buries a finer detail part (an eye) completely, so depth must be counted in the child's cubes. Where two parts overlap, their flush coplanar faces z-fight.
  - **Size.** One extra cube can move a creature into the next size class.
  - **Meshing.** The spike's mesher (maps keyed by strings) takes 23–51 ms per 32³ part. A mesher over typed arrays (a padded `Uint8Array` grid, indexed quads, preallocated output) meshes a whole 8-part creature in about 2 ms and one part in 1–4 ms, and a 64³ part in 10–52 ms (Ryzen 7 9700X, Node 24). Greedy meshing isn't worth it: creature shapes keep about 70% of their faces.

  The decisions below were agreed with the owner on 2026-10-29, partly from the spike's screenshots. The spike branch is thrown away; only this ADR merges. M19 builds the part and assembly schema, the mesher and an assembled body in the world.

This ADR amends ADR 0011 §3 and §6, ADR 0013, ADR 0015 §7 (the size picker), ADR 0020 §8 and §10, and the library entry schema of ADR 0014 §5 and ADR 0020 §13, for voxel creatures. Drawn bodies keep their ADRs until they are dropped (§22). See "Departures".

## Decisions

### Cube sizes and size class

1. **A ladder of four cube sizes: 1.25, 2.5, 5 and 10 cm.** Each step is twice the one below. 1.25 cm is the detail step, for eyes and other small features on tiny creatures. 10 cm is the coarsest and also the step for houses. No 20 cm step for now.

2. **Any part may use any step.** The format allows every step on every part. The Studio hints, without blocking, when a part is two or more steps from the creature's main step, the step of the assembly's root part (§11).

3. **A creature is the size of its cubes; its size class is derived.** A creature's bounds are measured from its assembled cubes (cubes × step) in the rest pose (§9), and its size class is the smallest class that contains it in both height and footprint: its height within the class's height and its footprint within the class's radius (issue #145). The body is not scaled to the class's height. The Studio's size buttons become a display of the derived class, updated live as parts are added, moved or changed, since one cube can tip it. The Studio blocks the release of a creature that doesn't fit inside the large class.

### Colour

4. **The format stores plain sRGB; the palette is a suggestion.** Nothing in the format limits colours. The Studio offers a list of suggested colours that match the world's theme, plus a free colour picker for any colour.

5. **Creature colours meet the world in the middle.** Starter parts and the suggested colours keep creature hues but tone them toward the world's colours, rather than using the world's colours as they are or keeping fully saturated ones.

### Look

6. **Lit like the rest of the world, with less glow.** Voxel creatures share the world's lighting. Their emissive glow is 0.15 of their colour, down from ADR 0011 §6's 0.35. This is for voxel creatures only: drawn creatures keep 0.35 until they go (§22).

7. **Ambient occlusion as today; no colour variation, no outlines.** Each cube face takes per-vertex ambient occlusion at today's strength, and each quad is split along the diagonal that interpolates its occlusion evenly. Per-cube colour variation is off and there are no outlines. Fine-tuning these (glow, variation, outlines, contact darkening, other tricks) is issue #200.

8. **The world stays as it is.** Terrain keeps its per-face colours (their zone edges are sawtoothed, which is accepted). Whether props become voxels is decided at M27.

### Parts, sockets and assembly

9. **Typed sockets at fixed points, rotation at the socket.** A part declares any number of sockets, each at a fixed point with a socket type; a torso may have several leg sockets. A part fits any free socket whose type matches it. A part turns only about its socket: it is attached at its attach point, which is also its pivot, and the assembly may rotate it there. In the rest pose that rotation is limited to quarter turns, so cubes stay on the grid; animation may then rotate parts freely. The rest rotation is stored in a general form (not as a quarter-turn count), so loosening the limit later is a change to the validator only. Bounds, size class (§3) and ground contact (§21) are measured in the rest pose.

10. **Socket types and part types are content.** They are registered by packs like M17's prop categories, so a pack can add them. Engine and app code never branch on their IDs. M22 adds a motion field to part types.

11. **An assembly is a tree of parts with one root part,** the torso in practice. Each part other than the root hangs from one socket of its parent. Part types are content (§10), so the engine knows the root by its place in the tree, not by its type.

12. **A socket lies at least one cube deep inside its parent part,** so a part that swings never shows a gap at its joint. Depth is counted in cubes of the finer of the two grids: when the child is finer (a detail part, the spike's case) that is one of the child's cubes, not one of its parent's, so the detail isn't buried. A coarser child still sits inside its parent. The validator checks it.

13. **A child snaps to the finer grid.** At its attach point, a child part is placed on the finer of its own and its parent's grids.

14. **Overlapping parts don't z-fight.** Where two parts overlap, their flush coplanar faces must not both be drawn: the mesher culls them, or the validator warns. M19 picks which.

### Format

15. **A part is at most 32³ cubes,** its voxels stored as indices into the part's own list of sRGB colours, run-length encoded. Raising the cap moves meshing to a worker (§19).

16. **Axes: +X forward, Y up, +Z to the creature's right.** The frame is right-handed and is ADR 0011 §7's: a creature faces +X. Mirroring uses paired sockets with a mirror flag: the part on the mirrored socket of a pair is mapped z → −z (reflected in the XY plane), which swaps left and right.

17. **A released species keeps a frozen copy of its parts.** Parts come from content packs (the starter parts, M20) and from the player's own parts library (M23). The assembly is stored inline in the library entry, which goes to version 5, and holds a copy of every part it uses, each with the ID of the part it was copied from, kept as provenance only. Editing or deleting a part later never changes a released creature. The assembly sits beside the species data the simulation sees, not inside it (§20). No migration (AGENTS.md, backward compatibility).

### Rendering

18. **One draw call per creature, a rigid transform per part.** A creature's parts are meshed into one geometry whose vertices carry their part's index (a `Uint8`), and each part has one transform. It is drawn either as a skinned mesh with one bone per part, every vertex weighted 1 to its part's bone so the skin index is the part index (what the spike proved), or with the part index read by a custom shader; M19 picks one. M22's per-part animation only sets those transforms. Because the parts move away from the mesh's rest pose, frustum culling is off for the creature or its bounds are updated as it moves. Ambient occlusion is computed per part, so parts don't darken each other at a joint (issue #200).

19. **The mesher is a pure function over typed arrays, run on the main thread.** It takes a part's voxels and colours as typed arrays and returns vertex and index arrays, with no three.js, so it is tested in Vitest and can move to a worker unchanged. At the 32³ cap it meshes a creature in a few milliseconds on the main thread; if the cap is raised (64³ costs 10–52 ms per part), it moves to a worker. When many creatures appear at once (startup, a restore), their meshing is spread over frames. It culls hidden faces and doesn't greedy-mesh; vertex size is kept small instead (for example `Uint8` positions within a part).

20. **A voxel body frame replaces drawing pixels.** ADR 0020 §10's anchors, the centre of gravity and the tail, are points in the body's frame (metres, axes as §16) and come from the assembly instead of from a drawing. M19 fixes how they are derived from the assembly. The simulation is unchanged: it sees a species' size class and capabilities, never its cubes. The assembly must not travel through the simulation worker. Today `species.body` does (the worker's content summary hands it back to the main thread), so the assembly is kept beside the species data the simulation gets, and the renderer receives it on a path that doesn't go through the worker. M19 picks the mechanism.

21. **A creature rests on its lowest cube.** The bottom of the assembly's lowest cube in the rest pose is the body's ground contact, which replaces ADR 0011 §3's feet for voxel bodies.

### Drawn creatures

22. **Drawn, extruded creatures stay until M23, then go.** At M23 ("draw a part") a drawing becomes a voxel part instead of an extruded body, and the extruded bodies are dropped. The mossling is rebuilt in voxels at M20.

## Departures

- **ADR 0011 §3:** a voxel body isn't scaled to its size class's height (§3), and stands on its lowest cube (§21).
- **ADR 0011 §6:** voxel creatures glow at 0.15, not 0.35 (§6).
- **ADR 0013 and ADR 0015 §7:** a voxel creature's size class is derived from its measured bounds (§3), not picked. The limits of ADR 0013 still apply per size class.
- **ADR 0020 §8:** voxel creatures have one rigid transform per part (§18), in place of "no skinned meshes, no bones". The whole-body profiles still apply on top.
- **ADR 0020 §10:** anchors are in the voxel body frame (§20), not drawing pixels.
- **ADR 0014 §5, ADR 0020 §13:** library entries go to version 5 with the assembly inline (§17).

## Consequences

- A creature's real size, not its class, decides how big it looks, so two creatures of one class can differ in size. The navigation profile is still per class.
- Small changes to a part can change the size class and so the creature's limits; the Studio shows it as it happens (§3).
- One draw call per creature and a small vertex layout keep many creatures cheap to draw.
- The look values are starting points, not tuned (issue #200).
- Open for M19: whether coplanar faces are culled or warned (§14); how anchors are derived (§20); whether colour index 0 means an empty cube; the run-length encoding's scan order (§15); how a socket type declares which parts fit it (§9); and whether the derived size class is stored on release or recomputed on load. Since a species keeps frozen parts (§17), recomputing gives the same answer, but M19 says which it does.
- Next: M19 builds the part and assembly schema, the mesher and an assembled body that lives, saves and restores in the world.

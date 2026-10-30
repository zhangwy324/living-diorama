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

    _Amended in M19 (see "M19 decisions"):_ both faces are drawn, but never at the same depth. The renderer shrinks every part a little toward its own centre, by an amount that grows with its depth in the tree (none for the root), so a part's faces never share a plane with its parent's. Two parts at the same depth, such as siblings, may still have flush faces in one plane and z-fight; the validator warns about flush faces.

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

## M19 decisions

Agreed with the owner on 2026-10-29 for M19 (part and assembly schema, mesher, assembled body, library entry version 5). They settle the questions left open above.

### Owner decisions

- **Fixtures, not content.** A development console hook builds a fixture creature in code (box parts: a torso, four legs, a head, two eyes at the detail step and a tail) for a chosen body plan and saves it as a version 5 library entry. `pnpm sim` gets a fixture voxel species whose size class comes from the same measurement. The built-in pack ships no test creature. M19 ends with a short hand check by the owner: walk, hop, swim, save, relaunch, day and night.
- **A core set of types.** The built-in pack registers part types for a torso, head, leg, arm, tail, ear, eye, nose, mouth and fin, with matching socket types. Art comes in M20.
- **Fits live on the part type.** A part type lists the socket types it fits, so a new pack's part can fit an existing pack's socket (§9, §10).
- **Fits are checked at release, structure on load.** Loading a released species doesn't need its part and socket types registered; only the release checks them. M22 needs a fallback for unknown types, which have no motion.
- **Recolouring edits the frozen copy.** A part's own colour list is the only palette; an assembly has none.
- **No migration.** Library entries go to version 5 and older ones fail to load (AGENTS.md, backward compatibility).
- **Placeholder thumbnails** for voxel species in the Studio's creature list until M21.
- **Measured anchors (§20, §21).** The body frame's origin is the middle of the rest-pose bounds across X and Z, with the lowest cube's bottom at y = 0. The size class is the smallest whose height holds the body and whose radius holds its farthest cube corner, measured across X and Z from the origin; a long creature moves up a class (this eases issue #142 for voxel creatures). The centre of gravity is the centroid of the cubes' volume. The tail is the attach point of a part whose type has the `tail` role, a role a part type declares; with none, it is the middle of the rear end (least x, half the height, z = 0). Engine code reads roles, never part type IDs. Voxel species have no player-placed anchors in M19.
- **The exit checks every movement.** The fixture takes a body plan (walk, hop, swim, land and swim) through the existing body plan mapping.
- **Soaks.** `pnpm soak:quick` runs on M19 pull requests that touch the simulation, the registries or built-in content, and one full `pnpm soak` runs at the end.
- **Flush faces (§14).** Each part is shrunk toward its own centre by about 1% of the finest step for each level it hangs below the root (the root not at all, a head on the torso once, an eye on the head twice), so a part's flush faces never share a plane with its parent's or its grandparent's. Parts at the same depth, such as two siblings, may still share one; the validator warns about flush faces.

### Engineering decisions

- **Colour indices.** Index 0 is an empty cube; 1–255 are the part's colours, so a part has at most 255.
- **Run-length order.** Cubes are listed x fastest, then y, then z (`x + X·(y + Y·z)`), as a flat `[run, index, …]` array whose runs add up to X·Y·Z, each axis at most 32.
- **Points in cubes, checks in whole units.** Sockets and attach points are stored in the part's own cubes, half cubes allowed. The checks of §12 and §13 convert them to whole units of half the finest step (0.625 cm), so they are exact.
- **Rest rotation as a quaternion.** It is stored as a unit quaternion `[x, y, z, w]`, and the validator checks that it is a quarter turn, within a small tolerance.
- **Mirrored parts are listed.** A part on the mirrored socket of a pair is listed in the assembly like any other, marked `mirrored: true`, and the validator checks the flag against the socket pair.
- **The two sides of a pair may differ** (owner). `mirrored` only means "draw this part reflected": a crab may have a big left claw and a small right one, so nothing checks that the mirrored side uses the same part or rotation as its pair. The Studio (M21) uses the same part on both sides by default when it mirrors.
- **At most 32 parts** in an assembly.
- **Library entry version 5.** The entry's body is `{ kind: "drawn" }` or `{ kind: "voxel", assembly }`. The desktop shell's entry size limit rises and the drawing and image become optional per entry, with the run-length encoding as plain JSON numbers; that amends ADR 0014 §3–§5 in a later M19 pull request.
- **The size class is stored and checked.** A voxel species stores its size class, and loading recomputes it from the assembly and rejects a mismatch.
- **An asset kind for assemblies.** A voxel species' appearance names its assembly, `user:<id>/assembly.json`, of a new `voxel` asset kind. The app registers the assembly's JSON as a blob URL as it does images today, the worker sees only the URL, and the renderer fetches and parses it (§20). Added in M19 PR 3a (see its As built section).
- **Voxel species keep their gait.** They keep `body.locomotion`, which the simulation reads; the drawn-only settings (thickness, anchors) are forbidden. The library entry refuses them; the worker drops them from the species summary it sends back; refusing them for voxel species a pack registers comes in M20. The body plan is split when drawn bodies go (M23).
- **Measurement is pure.** Bounds, size class, ground contact, centre of gravity and tail are pure functions in content-schema, with no three.js.
- **Rendering (§18, §19).** A skinned mesh with one bone per part, each vertex weighted 1, the geometry shared per species and a skeleton per creature, frustum culling off. Four-level per-vertex ambient occlusion with each quad split along the more even diagonal. Emissive 0.15 from the vertex colours. A small vertex layout (`Uint8` positions within the part, packed normals, `Uint8` colour, ambient occlusion and part index). Each species is meshed once, new species queued about one per frame. Voxel bodies cast shadows but don't receive them (ADR 0011 §10). The mesher stays a pure typed-array function on the main thread, capped at 32³ per part.

## As built: M19 PR 1

The part and assembly schema, the validator, measurement, the part and socket type registries and library entry version 5:

- **Format.** A part is `{ type, source?, size, step, colors, voxels, attach, sockets }`, with `step` in metres from the ladder and colours as `#rrggbb` in either case. An assembly is `{ parts, instances }`: `parts` maps a local key to a frozen part copy, so instances can share one (four legs, a mirror pair); `instances` lists `{ id, part, parent?: { instance, socket }, rotation, mirrored }`, the root first and every instance after the one it hangs from, which rules out cycles. A part copy no instance uses is an error. A socket's `mirrors` names the socket of the same part and type it mirrors; the part on it is the mirrored one.
- **Mirroring.** A mirrored instance stores its part's attach point and its rotation unmirrored, as they would be on the pair's other socket; consumers derive the mirrored ones. The part is reflected about its own middle plane (z → Z − z in its cubes), its attach point likewise, and its rotation `[x, y, z, w]` becomes `[−x, −y, z, w]` (`mirrorQuaternion`). Placed in its parent's frame, that is `M · R · (p − attach) + socket` with `M` the reflection z → −z: the mirror image, in the creature's XY plane, of the same part placed unmirrored on the pair's other socket. The mesher, `measureAssembly` and the validator all use this convention, and M22 mirrors per-part animation the same way. The reflection carries down the tree: a part is drawn reflected when an odd number of the instances on its path from the root are mirrored, so a hand on a mirrored arm is reflected though its own flag is false, and a mirrored part on a mirrored part is not. `placeInstances` gives that as `InstancePlacement.mirrored`; on a reflected part the socket positions map z → Z − z too. The bone's rest rotation is `linear · (mirrored ? M : I)`, a proper rotation, and `boneTransform` gives it with its offset.
- **Joint depth (§12)** is checked as: every cube within one cube of the finer grid of the socket, along every axis, is a filled cube of the parent. **Snapping (§13):** the child's grid, placed and turned, lines up with the finer grid in the parent's frame.
- **Caps.** Besides those above, an assembly shows at most 131,072 cube faces, counted per part as the mesher draws them, which bounds what one creature costs to draw.
- **Flush faces** are warned about by `assemblyWarnings`, apart from the schema, since a warning doesn't stop a load. The renderer's shrink is `instanceInset(depth)`, `CHILD_PART_INSET` per level, with the depth from `InstancePlacement.depth`.
- **Measurement** returns the bounds, height, footprint radius, size class (undefined when the body is too large for every class), the ground contact's X and Z extent, the centre of gravity and the tail, in metres in the body frame, and the body frame's origin in the root's frame in whole units, as `placeInstances` places parts, so a renderer can place bones without walking the cubes again. The tail takes roles from a lookup the caller passes, so loading needs no registered types.
- **Library entries.** Version 5 entries carry `body`. Every entry's appearance must be `<species id>/appearance.png` (drawn) or `<species id>/assembly.json` (voxel). The drawn-only body settings are refused on the entry as written, since parsing fills in their defaults.
- **Built-in types.** The `hollow` pack registers the core part types (`hollow:torso` … `hollow:fin`, `hollow:tail` with the `tail` role) and ten socket types (`hollow:neck`, `waist`, `hip`, `shoulder`, `tail-base`, and a mount each for ears, eyes, noses, mouths and fins). A leg fits a hip or a shoulder, a fin its mount, a hip, a shoulder or the tail base, and a torso a waist, for creatures of several segments.

## As built: M19 PR 2

The mesher (§7, §18, §19) is `packages/renderer/src/voxel/mesher.ts`. `meshVoxelPart(part, partIndex)` meshes one part and `meshVoxelParts(parts)` meshes a creature's parts into one set of arrays, each vertex tagged with its part's position in the list. A part is given as its size (1 to 32 cubes per axis), a `Uint8Array` of colour indices (0 is empty, i ≥ 1 is colour i − 1; x fastest, then y, then z) and its `#rrggbb` colours, plus a `mirrored` flag. The output is indexed quads in separate arrays: `Uint8` positions in the part's own cube units (0 to 32), `Int8` normals (±127, normalized), `Uint8` colour, `Uint8` ambient occlusion and `Uint8` part index, with `Uint16` indices up to 65,536 vertices and `Uint32` beyond. Faces are culled and occlusion computed within a part only.

- **Occlusion** has four levels per vertex, 0.5, 0.65, 0.8 and 1 (`VOXEL_AO`), stored as the factor's bytes (128, 166, 204, 255), so the shader multiplies it in directly; retuning the levels (issue #200) means meshing again.
- **The diagonal:** each quad is split along the diagonal whose two corners' levels differ least; on a tie, the one joining the lighter pair, so two dark opposite corners stay two corner shadows. Shading then doesn't depend on how a quad is turned.
- **Colour** stays sRGB bytes; the shader decodes them to linear.
- **Mirroring:** a mirrored part is reflected about its own middle plane, z → Z − z (Z its cube count along z), with its normals and triangle winding fixed so its faces stay outward; a negative-scale bone would turn them inside out. To match §16's reflection in the creature's XY plane, the assembled body must mirror the part's attach point the same way (az → Z − az, in the part's cube units) and its rest rotation, quaternion [x, y, z, w] → [−x, −y, z, w]. Measurement (bounds, size class, ground contact, centre of gravity) must use the same convention.
  _Correction (M19 PR 1):_ the mesher's `mirrored` input is `InstancePlacement.mirrored`, whether the part is reflected after its parents' mirroring, not the instance's own `mirrored` flag.
- **Not here:** the bind transform (offset, cube step, rest rotation) and the slight shrink of child parts against flush faces belong to the skeleton that draws the body.

Timings: 32³ parts mesh in 0.9 to 5.4 ms (solid to checkerboard, the most faces a part can have), a 9-part creature in 0.4 ms (Node 24, `packages/renderer/src/voxel/mesher.timing.ts`).

## As built: M19 PR 4a

The species library stores voxel species (§17; ADR 0014 §1–§5 amended).

- **No assembly file.** The assembly lives inline in `entry.json` (§17), so a voxel species' folder holds `entry.json` alone. Its appearance, `user:<uuid>/assembly.json`, is a name, not a file: the app makes a `blob:` URL of the assembly's JSON from the entry it already read, as it makes one from a drawn species' PNG. A separate file would hold the same data twice and need a load command of its own.
- **Drawn files are optional, as a pair.** `save_library_entry` takes the drawing and the image as optional arguments, both or neither. Listing skips a folder with one and not the other. Rust still never reads an entry, so it doesn't check that a drawn entry has them; loading a missing image fails in the frontend, which lists that species as unavailable. In `desktop-integration`, `LibraryStore.save(id, entry, drawn?)` takes `{ drawing, image }` for a drawn species and nothing for a voxel one; `loadDrawing` and `loadImage` reject for a voxel entry.
- **The entry limit is 8 MB** (was 64 KB). Faces are capped at 131,072, runs are not: a full 32³ part whose cubes alternate between two colours is 32,768 runs and only 6,144 faces, so 21 of them fit under the face cap, about 4.2 MB of compact JSON. 8 MB covers it with room for the species. `entry.json` is now written compact, since pretty printing would put each number of the runs on its own line. The drawing (16 MB) and image (4 MB) limits are unchanged.

## As built: M19 PR 3a

The `voxel` asset kind, so a voxel species' assembly reaches the renderer by URL without its cubes going through the simulation worker:

- **The kind.** `ASSET_KINDS` is `image`, `model` and `voxel`. A species' appearance must be an asset of a kind in `SPECIES_APPEARANCE_KINDS` (`image` or `voxel`), checked when references resolve, so a pack's species can name a voxel asset file the same way as an image: an asset entry with the kind and the URL it is served from.
- **Registering.** `registerSpecies(input, appearanceUrl, appearanceKind)` and the `register_species` command (protocol version 16) take the appearance's kind as well as its URL. The worker registers the asset with that kind and URL and nothing else; it never reads the file. A kind a species' appearance can't have is rejected like any other bad reference.
- **What the worker sends back.** `species_registered` and `ready` carry the asset's kind and URL in its `AssetSummary`, which the renderer branches on. A voxel species' `SpeciesSummary.body` is only `{ locomotion }` (`VoxelBodySummary`): its thickness and anchors aren't sent. For a library species they exist after parsing only as defaults, since the entry refuses them as written; a species registered another way may still set them (refused in M20), and they are dropped all the same. The species definition is a strict object, so the worker can't be handed cubes inside it either.
- **The renderer** draws a voxel species as the fallback block until the assembled body comes (a later M19 pull request); it doesn't read the asset. `RenderSpecies.body` has `thickness` and `anchors` optional for that reason.
- **§20, reread.** "The simulation is unchanged" now means: the simulation never sees cubes; it carries the appearance asset's kind and URL.
- The app registers its library species, all drawn until the app's voxel path lands, with the kind `image`.

## As built: M19 PR 4b

The app saves voxel species to the library and registers them, and a development console hook adds a sample voxel creature:

- **Saving.** `SpeciesLibrary.saveVoxel(assembly, name, plan)` checks the assembly's structure, measures its size class from its cubes (refusing one too large for every class), has the world check its part and socket types, then registers and stores it with `LibraryStore.save(id, entry)` and no drawn files. The plan's ways of moving give the capabilities and gait through the same mapping as a drawn release (`locomotionCapabilities`, `planVoxelBody`); the species' `body` is its gait alone. Entries are stored as written, drawn ones too.
- **The fit check at release, in the worker.** The registered part and socket types live in the simulation worker (ADR 0010), so the release asks it: the `check_assembly` request (protocol version 17) takes the assembly and is answered by `assembly_checked` with its structure's diagnostics, or else `checkAssemblyTypes`'s. This is the one time an assembly crosses into the worker, and only to be checked: the worker doesn't keep it, and the simulation never stores or simulates cubes (§20). A failed or rejected check refuses the release with a diagnostic.
- **Part types for the main thread.** The worker's content summary (`ready`) lists every registered part type with its role (`partTypes`), so the renderer can find a creature's tail part without the registries. The app passes it to the renderer as its `partRole` lookup (M19 PR 3b).
- **Parsed voxel entries stay as written.** Parsing a voxel entry drops the thickness and anchors the species schema fills in by default, so a parsed entry validates again and can be stored again as it is (M21's recolouring).
- **Loading.** A voxel entry's appearance must be `<species id>/assembly.json`, a drawn one's `<species id>/appearance.png`. Its image isn't loaded; it is registered with the kind `voxel` and a `blob:` URL of its assembly's JSON, made from the entry. Library species are registered before the saved world is restored, as before, so voxel creatures aren't dropped as `species_missing`. A listed species says whether its body is drawn or voxel.
- **The sample.** `sampleVoxelAssembly()` in `built-in-content` builds a small creature of 2.5 cm boxes (a torso, two front legs on shoulders, two back legs on hips, a head with two 1.25 cm eyes, a tail with the tail role), the right-hand legs and eye mirrored, of the built-in part and socket types. It has no flush faces, and its size class is `small`. The pack exports it but doesn't register it, and no world has it. `livingDiorama.library.saveVoxelSample(plan, name?)` in development builds saves it with the plan `walk`, `hop`, `swim` or `land+swim` and adds one of its creatures.
- **My creatures** shows a placeholder block for a voxel species' picture, and the Studio loads no image for it, until M21.

## As built: M19 PR 3b

The assembled body (§6, §7, §18, §20, §21), in `packages/renderer/src/voxel/body.ts` and `creatures.ts`:

- **Reading.** For a voxel species the renderer reads its assembly's JSON from the asset's URL with an injectable `readAssembly` (like `readImage`), checks it with `VoxelAssemblySchema`, and keeps the fallback block until it is meshed. An assembly that fails to load or check is logged and the block stays. Checked assemblies wait in a queue; each `update` meshes one, so many species arriving at once (startup, a restore) spread over frames. A read that finishes after `dispose` builds nothing. Looks are cached by species ID: a species summary carries no version, and the registry refuses a second species with the same ID, so a new assembly can't arrive under an ID already drawn. Should re-registering become possible, the cache needs the version or the asset URL in its key.
- **Geometry, once per species.** `buildVoxelBody` measures the assembly, meshes one grid per instance (the mesher's `mirrored` is `InstancePlacement.mirrored`) and keeps the mesher's small arrays as they are: `Uint8` positions in cube units, normalized `Int8` normals, `Uint8` sRGB colour, `Uint8` occlusion, and the part index as a one-component `skinIndex`. The skin weights are a four-byte `(1, 0, 0, 0)` per vertex: three's skinning chunks and the shadow pass's depth material read a four-component weight, and a missing one would weight a second bone.
- **Bones, per creature.** Each instance's bone takes a vertex of its part from cube units to the body frame in metres: `boneTransform`'s rotation and offset, the step, then the body frame's origin (`AssemblyMeasure.origin`) and `VOXEL_UNIT`. Before that, a child part shrinks toward its own centre by `instanceInset(depth)` along each axis. The inset isn't capped: at the deepest possible part (31 levels) it is 3.9 mm per side, and the smallest cube is 12.5 mm, so a part never turns inside out. A creature is a `SkinnedMesh` of the shared geometry with a skeleton of its own, in detached bind mode with identity bind and inverse matrices, its bones outside the scene graph, so a bone's world matrix is its transform in the body frame (M22 sets it). Frustum culling is off. A departing creature frees its skeleton's bone texture; `dispose` frees the geometries and the material.
- **Joints, for M22.** A voxel body keeps, per instance, its parent's index (−1 for the root) and its rest joint: a rigid transform (a proper rotation and a translation in metres, no scale) whose origin is the part's attach point in the body frame. The bone is `joint · shape`, the shape taking the mesh's cube units to the joint's frame (step, shrink, attach point). M22 turns a part about its joint and carries the turn to its children through the joints alone, so no parent's step or shrink passes down the tree.
- **Material.** One `MeshStandardMaterial` shared by every voxel body: the vertex colour decoded from sRGB to linear in the vertex shader, the occlusion multiplied into the diffuse colour, and an emissive glow of 0.15 of that colour. The glow is taken after the occlusion, so corners stay darker at night too, when the glow is most of the light. Bodies cast shadows and receive none, with `shadowSide` front as drawn bodies have.
- **Anchors.** Height, reach and depth come from the measured bounds; the pivots from the measured centre of gravity and tail (`placePivots`), so M16's whole-body profiles apply as for drawn bodies. The tail takes part types' roles from an injectable `partRole`. The app builds it from the part types the worker's `ready` lists (`partRoleLookup`), since the registries live in the worker; without it, or with no tail-role part, the tail is the middle of the rear end.
- A test checks the mirror contract: every face of the meshed grids, through its bone, lies on a cube `placeInstances` places, facing out. Its fixture has a mirrored part turned about X and a mirrored part below a parent turned about Y, rotations that don't commute with the reflection, so the order of mirror and rotation is checked.

# ADR 0025: Drawing voxel parts

- **Status:** Accepted
- **Date:** 2026-10-30
- **Context:** Roadmap §3.2, M23: user story 2 (roadmap §3.2), end to end. The player draws a small pixel picture, the Studio turns it into a voxel part, the part is saved to the player's own parts library, and the player uses it in Build mode ([ADR 0023](0023-creature-assembly-studio.md)) like a starter part. Since M18 the plan has been that drawn, extruded creatures ([ADR 0011](0011-extruded-creature-bodies.md), [ADR 0017](0017-hollow-bodies-and-fill.md)) go when drawing becomes a way to make parts ([ADR 0022](0022-voxel-creatures.md) §22), so M23 also removes them, from the Studio, the library, the desktop shell and the renderer. M23 ships as PRs, in waves: **0** this ADR and the notes on the ADRs it supersedes or amends; then, in parallel, **1** the voxelizer, the base-part fit and the player-part schema (new files in `content-schema`), **2** the drawing recipe on part types and protocol version 24, and **3** the drawn Studio, the drawn library entry and the shell's drawing files removed (the Studio is Build-only until PR 6); then **4** drawn bodies dropped from the engine (the renderer's `body/`, the `image` appearance kind for species, the body-plan split, the dev tools' fixtures) and **5** the player parts store; then **6** Draw mode for parts and **7** Build mode's use of them (the tray, My parts); and last **8** the exit (the checklist, voxel performance samples, docs, issues #61 and #68). The decisions below were agreed with the owner on 2026-10-30.

This ADR supersedes ADR 0011 and ADR 0017. It amends ADR 0014 (§1–§7, §10, §12), ADR 0015 (Draw mode), ADR 0016 §11 (the performance samples), ADR 0020 §10, §11 and §13, ADR 0022 §22 and its M19 decision that the body plan is split at M23, and ADR 0023 §1. See "Departures".

## Decisions

### The drawing

1. **A part type may name a drawing recipe.** `PartTypeDefinition` gains an optional `drawing: { view, rule }` (`PartDrawingRecipe`, `PartDrawingRecipeSchema`), beside M22's `motion` ([ADR 0024](0024-per-part-animation.md) §8). `view` is `side`, `front` or `top`, the direction the part is drawn from (`top` is for parts flat in the horizontal plane: the built-in fin's recipe is `top` `flat`, since the starter fin is a horizontal paddle and only `top` gives depth along Y); `rule` is `puffy`, `tube` or `flat`, how the drawing gets its depth (§14). `PartTypeSummary` carries it in `ready` (protocol version 24), and the built-in pack's `part-types.json` gives each type one. The recipe is a starting point: the player can switch the rule while drawing (a tail drawn as a tube can be made flat). A type with no recipe is drawn flat, from the side. The engine and the Studio read the recipe, never the part type's ID. The field changes the part-type format, so its schema version goes up, with no migration (AGENTS.md).

2. **No stamps.** Faces are not painted onto other parts. An eye, a nose or a mouth is drawn like any part, flat (one cube deep) at a fine step, and hangs from its mount as the starter face parts do (ADR 0022, M20 "Face features are small parts"; ADR 0024 §2). Painting onto another part's surface belongs to the block editor (M24).

3. **A drawn part takes its joints from a base part.** A part needs an attach point and, unless it is a leaf, sockets. The player picks a base part of the same part type, by default that type's starter part: the first pack part of that type in registration order (for a root type, the part its pack marks `starter`, ADR 0023 PR 5a). Its attach point and sockets, mirror pairs and offsets across the depth included, are scaled from the base part's bounds to the drawing's and then snapped, so every joint keeps the depth rule (ADR 0022 §12, and §13 as amended by ADR 0023). On the grid the player sees them as markers and can drag each one to another cube.
   - **The depth rule, exactly.** Lying in a filled cube isn't enough: the validator (`isBuried` in `voxel-assembly.ts`) needs every cube within one finer-grid cube of the socket to be filled.
   - **Each socket keeps its base socket's depth.** A fitted socket aims for the depth its base socket has on the base part: a base eye socket half a cube in stays half a cube in. The snap moves each socket to the nearest position at that depth.
   - **When that depth can't be reached** (a thin stroke, or a flat part one cube deep), the socket snaps to the deepest cube available and Draw mode flags it. Saving is still allowed; Build's existing fit check reports the problem when the part is used.
   - **The fit reports each socket's depth level:** buried one of the drawn part's own cubes deep, buried only one finer cube deep (enough for a finer child only), or touching (not buried).
   - **Mirror pairs** are snapped and dragged together, mirrored about the part's middle plane. The base part's silhouette shows faintly behind the grid as a guide. If carrying sockets over proves too costly to build or to explain, the fallback is to allow drawing leaf parts only, with no sockets; that switch is reported to the owner first, not made silently.

4. **A fixed 32 × 32 grid at a ladder step.** One cell is one cube. The player picks the step from the ladder (ADR 0022 §1), by default the base part's. Saving crops the part to the drawn cells' bounds. A ruler in centimetres and the base part's ghost (§3) show how big the part will be. Depth is capped at 32 cubes too, so a part never exceeds ADR 0022 §15's 32³.

5. **One canvas per part.** A part is drawn from one view only. Several views carved together, or layers, are not in M23.

### The player's parts

6. **A parts store of its own, in Rust.** Player parts are stored by a new `parts.rs` in the desktop shell, modelled on `library.rs`: a `parts/` folder in the app data directory, one `<uuid>.json` file per part, written through a `.tmp` file and renamed into place, read with a size cap through `read_limited` (which reads at most the cap plus one byte, #208), and only for lowercase UUIDs, so no path leaves the folder. The Studio reaches it through a new `connectPartsStore` in `desktop-integration`, with an in-memory store for tests, as `connectLibrary` has. Player parts never pass through the simulation worker: they aren't registered as pack content, and registering parts while the app runs (#226) stays deferred.

7. **IDs, versions, edits and deletes.** A player part's ID is `user-part:<uuid>`, which the content ID pattern in `content-schema` accepts. Editing a part saves it in place under the same ID with its version raised. Thumbnails are keyed by `id@version` (ADR 0023 §20), so an edited part draws afresh. Deleting a part asks first. Creatures already released keep their frozen copies (ADR 0022 §17): neither an edit nor a delete changes them.

8. **A saved part keeps its drawing.** Beside its cubes, a player part stores the drawing it was made from (`PartDrawing`, `PartDrawingSchema`): the grid, its palette, the view, the rule, the chubby factor and the step. Opening the part again opens the drawing, not just the cubes.

### The Studio

9. **Draw mode draws a part.** The Build/Draw switch stays (ADR 0023 §1), and Draw mode is now where a part is drawn. It ends with Save to My parts and with Use in Build, which switches to Build mode with the new part picked. Each section of Build's parts tray gets a "Draw your own" tile that opens Draw mode with that part type chosen.

10. **Randomize and Fill empty use pack parts only.** Player parts are placed by hand.

### Drawn creatures go

11. **Drawn bodies are removed in full.** Nothing of the extruded body stays:
    - **The library entry** goes to version 6 and holds voxel species only. `LibraryBodySchema`, `DrawingSchema` and the drawing's migrations are removed.
    - **The desktop shell** drops `drawing.json` and `appearance.png` and the `load_library_drawing` and `load_library_image` commands.
    - **The species' body** (`BodyShapeSchema`) keeps only `locomotion`: `thickness`, `anchors`, `AnchorSchema`, `drawnOnlySettings`, `defaultAnchor` and `DRAWING_SIZE` go.
    - **Appearances:** `image` is no longer a species appearance kind (`SPECIES_APPEARANCE_KINDS`). The `image` asset kind may stay for other uses.
    - **Old entries:** a drawn entry no longer parses, so it is skipped with a line in the log, as any unreadable entry is (ADR 0014 §3). No migration (AGENTS.md).
    - **The fallback block** (ADR 0011 §8) took its depth from the species' `thickness`, which goes. PR 4 chooses a new depth for it and records it.

12. **The performance samples become voxel species.** The 20 drawn species used to measure the app with many creatures (ADR 0016 §11's seeding hook) are replaced by 20 voxel species that a development hook assembles with `assembleParts` from fixed seeds. Issue #68 is reworded for voxel species, and epic #61 (how drawings become 3D bodies) is closed as obsolete.

### The voxelizer

13. **The voxelizer is pure code in `content-schema`.** `packages/content-schema/src/voxel-draw.ts` turns a drawing into a part's cubes with no DOM and no three.js, and is tested in Vitest. The distance transform it needs moves there from `renderer/src/body/distance.ts`.

14. **Axes and depth rules.** In the part's frame (ADR 0022 §16: +X forward, Y up, +Z to the right):
    - **Side view:** the canvas's x runs along +X (forward), its y downward along −Y, and the depth lies along Z, centred.
    - **Front view:** the canvas shows the creature from in front, so the canvas's x runs along −Z (the canvas's right is the creature's left), its y downward along −Y, and the depth lies along X, centred.
    - **Top view:** the canvas shows the part from above, so the canvas's x runs along +X (forward), its y downward along +Z (the creature's right), and the depth lies along Y, centred.
    - **Puffy:** each cell's half-depth comes from its distance to the drawing's edge, shaped to a round profile and scaled by the chubby factor.
    - **Tube:** each cell's half-depth is the local radius, the distance to the edge at the nearest point on the shape's midline, so a limb is round across its own width.
    - **Flat:** one cube deep, or two with a toggle.
    - The exact constants are tuned from a contact sheet of screenshots that the owner reviews.

### The editor

15. **Undo keeps snapshots of the grid.** Each step is an immutable copy of the 32 × 32 grid, as Build mode keeps assembly snapshots (ADR 0023 §16). The old pixel-patch history of the drawn Studio (`studio/history.ts`) is deleted.

### Issues to respect

- **#240:** the Studio should share one WebGL renderer. Draw mode's 3D preview must not add a third context that is made eagerly.
- **#247:** the assembly view rebuilds when its `client` prop changes identity, so Draw and Build pass it stable props.
- **#224, #208:** thumbnails stay asynchronous and keyed by `id@version`, and every stored file keeps a size cap.

## Departures

- **ADR 0011, ADR 0017:** superseded. Extruded bodies, the fill tool on the 256 px drawing and the drawing's thickness go (§11).
- **ADR 0014 §1–§7, §10, §12:** a library folder holds `entry.json` alone; entries are version 6 and voxel only; the drawing's schema, its migration (`parseDrawing`) and its size limits go, and so does `load_library_image` (§11). The library now holds voxel species only, and the drawn `saveSample()` hook goes. Player parts live in their own store, not in the library (§6).
- **ADR 0015:** Draw mode no longer draws a creature; it draws a part (§9), with a grid editor whose undo keeps snapshots (§15). Its §7 (the body preview and hints), §9 and §11 (the 256 px drawing, strokes and pixel patches) go with drawn bodies.
- **ADR 0016 §11:** the seeding hook makes 20 voxel species from seeds instead of 20 drawn ones (§12).
- **ADR 0020 §10, §11, §13:** player-placed anchors in drawing pixels go; every species' anchors are derived from its assembly (ADR 0022 §20). `species.body` keeps only `locomotion`. Library entries are version 6.
- **ADR 0022 §22, M19 "Voxel species keep their gait":** carried out here. The body plan is split by removing the drawn-only settings (§11), not by adding a field for voxel bodies.
- **ADR 0023 §1:** Draw mode stays, repurposed to draw parts (§9), instead of being removed.
- **Research plan, V5:** no stamp rule (§2); sockets come from a base part (§3).
- **Research plan, V6:** a part edited later doesn't update released creatures, which keep frozen copies (§7).

## Exit

M23 is done when:

- the player opens Draw mode, draws a part of a chosen type, sees it in 3D, saves it to My parts, uses it in Build mode and releases a creature with it, and the creature lives in the world (user story 2);
- a saved part reopens as its drawing, can be edited in place (its version raised) and deleted after a confirmation, and released creatures keep their copies;
- drawn creatures are gone from the Studio, the library, the desktop shell and the renderer, and an old drawn library entry is skipped with a log line;
- the performance samples are voxel species, issue #68 is reworded and #61 is closed;
- the owner has reviewed the depth rules from a contact sheet (§14);
- `pnpm check` and `pnpm test:rust` pass, and `pnpm soak:quick` on the PRs that touch content or saves;
- a manual checklist entry is added and run by the owner;
- this ADR records the decisions and every departure from them.

## As built

Each M23 PR adds its own paragraph here, under its own heading, so PRs landing in parallel don't conflict.

### PR 0: This ADR

Records §1–§15 and the PR plan. ADR 0011 and ADR 0017 are marked superseded by this ADR. Four choices of ADR 0011 live on and are noted there: a creature faces +X (§7, now ADR 0022 §16), a grey block stands in until a body is ready (§8), creatures cast real sun shadows with no shadow blob (§9), and a body draws its sun-facing side into the shadow map (§10), as voxel bodies do (ADR 0022, M19 "Rendering"). Short notes point here from ADR 0014, ADR 0015, ADR 0016 §11, ADR 0020 §10, §11 and §13, ADR 0022 §22 and its M19 body-plan decision, and ADR 0023 §1. The roadmap's M23 section is in the private design repo. There is no ADR index to update.

### PR 1: Voxelizer, base-part fit and player-part schema

Built in #252, all in `content-schema` and pure. The distance transform is copied into `distance.ts` (not exported); the renderer's copy stays until PR 4.

**Drawing.** `PartDrawingSchema` is `{ pixels, palette, view, rule, chubby, flatThickness, step }`. `pixels` is a plain array of 1024 colour indices (32×32, row by row from the top-left, 0 empty), not run-length encoded. `view` and `rule` use `PART_DRAWING_VIEWS` and `PART_DRAWING_RULES` from PR 2. `chubby` runs from 0.25 to 2 (default 1) and scales the depth of `puffy` and `tube`. `flatThickness` is 1 or 2 (default 1).

**Voxelizer.** `voxelizeDrawing` crops to the painted pixels and keeps only the colours used. It returns `DrawnVoxels`: size, step, colours, the grid, and `origin`, the crop's top-left pixel on the canvas. An empty drawing gives `undefined`. Each pixel becomes a column of its colour along the depth axis, centred.

- **Axes.** `VIEW_AXES` maps each view's canvas x, canvas y and depth onto the part's axes, one row per view (§14). A new view is one row.
- **puffy.** A round profile over the whole shape: depth = 2·√(R² − (R − d)²) × chubby. Here d is a pixel centre's distance from the shape's edge (its distance to the nearest empty pixel centre less half a pixel), and R is the largest distance in the shape. A disc becomes roughly a ball.
- **tube.** Measured on a grid of half pixels, so a shape of any width, odd or even, has its width exactly. The midline is where the distance to the edge is at least that of all eight neighbours. Each half pixel takes the width at its nearest midline half pixel, and a pixel the largest of its four, × chubby. A bar is as deep as it is wide all along, ends included.
- **flat.** `flatThickness` cubes.
- **Rounding.** Depths are rounded, at least 1 and at most 32. Each column is then rounded up to the parity (odd or even) of the deepest column, so the cubes are an exact mirror image about the middle plane and a mirror pair of sockets fits them.

**Fit.** `fitDrawnPart(drawn, base, overrides?)` returns `{ part, sockets, attachOnCubes }`. The base's attach point and sockets are scaled from the base's box to the drawn box. Each then moves to the nearest half-cube point where it belongs, measured from the scaled point rounded to half cubes, with ties to the smaller offset in z, then y, then x. The attach point goes onto a filled cube.

- **Depth levels.** A socket's depth is measured in levels, deepest first: `own` (every cube within one cube of it filled, so a child at the part's own step fits, as the validator's `isBuried` checks), `finer` (within half a cube; on half-cube points every smaller depth asks for the same cubes, and a part at the finest step, `VOXEL_STEPS[0]`, has no such level), `touching` (on a filled cube) and `loose` (off the cubes, only for a point the player placed).
- **Target.** Each socket aims for the level its base socket has on the base part, measured the same way, so an eye socket half a cube inside a face aims for half a drawn cube (owner's decision; a base socket off its cubes aims for `touching`). If no point reaches the target, the socket takes the next shallower level there is. `sockets[id]` is `{ depth, target, shallow }`, `shallow` meaning shallower than the target, so Draw mode can show it. The fit never refuses, and the part is always valid.
- **Mirror pairs.** Two sockets whose base positions mirror each other are placed together, the mirrored one at the mirror image of the other about the middle plane, at the first level both reach. Only when no mirrored place touches the cubes at all (a lopsided front view) is each placed on its own.
- **Overrides.** `overrides` takes an attach point and sockets by ID, for dragging in Draw mode. Each given point is kept and snapped to the nearest half-cube point in the part, and its depth reported. A mirror-pair socket whose partner alone is given takes the mirror image of its partner's point.
- **Speed.** Points are tried nearest-first from a precomputed sorted list of offsets out to 8 cubes, and the first that passes wins. Farther points are counting-sorted by distance. Whether any point reaches a level is found once per fit, so levels nothing reaches aren't searched. Filled cubes are counted from a summed-volume table. A fit takes about 2 ms for typical drawings (Ryzen 7 9700X, Node 24, warm). The slowest case measured is about 11.5 ms, a lopsided front-view torso whose mirror pair has its nearest mirrored place far away. If dragging needs it faster, the next step is to work out once per fit which points reach each level.

**Player part.** `PlayerPartEntrySchema` v1 is `{ schemaVersion, id, name, version, createdAt, updatedAt, part, drawing }`. `id` is `user-part:<lowercase uuid>` (`playerPartId`), which the content-ID pattern already accepts. `version` is a whole number from 1, bumped on each edited save, rather than a semver string. The dates are ISO date-times with an offset, as in the library. The entry refuses a part with a `source` (a player part is a source itself, as a registered part is) and a part whose step isn't its drawing's. `parsePlayerPartEntry` validates without migrations. `voxel.ts` exports its step schema as `VoxelStepSchema` for the drawing.

### PR 2: Drawing recipe

Built in #251. `content-schema` (`definitions.ts`), beside `PART_MOTIONS`: the closed lists `PART_DRAWING_VIEWS` (`side`, `front`, `top`) and `PART_DRAWING_RULES` (`puffy`, `tube`, `flat`), the strict `PartDrawingRecipeSchema` / `PartDrawingRecipe` (`{ view, rule }`, both required) and `DEFAULT_PART_DRAWING_RECIPE` (`side`, `flat`). The views' doc comment gives each one's mapping of the canvas onto the part's axes (§14). `PartTypeDefinition.drawing` is optional, with no default in the schema: left out, it stays out of the parsed definition and the summary. An unknown name is refused at `drawing.view` or `drawing.rule` ("Unknown drawing view (expected …)"). The field changes the part-type format, so `SCHEMA_VERSIONS.partType` is 3, with no migration. The built-in types: torso and head `side` `puffy`; leg, arm and tail `side` `tube`; tail fin `side` `flat`; fin `top` `flat`; ear, eye, nose and mouth `front` `flat`. `PartTypeSummary` gains `drawing?: PartDrawingRecipe`, filled by `describeVoxelParts` only when the type has one (protocol version 24). The default is applied only by the app's `partDrawingRecipeLookup(partTypes)` in `apps/desktop/src/part-types.ts`, beside `partMotionLookup`, which gives `DEFAULT_PART_DRAWING_RECIPE` for a type without a recipe or one the summary doesn't list. It isn't used yet (PR 6). `docs/adding-content.md` now documents part types' `drawing`, and their `motion`, which M22 left out.

### PR 3: Drawn Studio and library removed

Draw mode is gone, along with what only it used. The Studio is Build-only for now. `StudioMode` is `"build"` and `STUDIO_MODES` lists the modes. The mode switch shows nothing while there is only one mode, so PR 6 re-adds `"draw"` and restores the Edit-a-copy test of switching modes, which can't be written with one mode. A library entry is version 6, voxel-only and flat: `{ schemaVersion, species, assembly, createdAt }`, with no `body` wrapper. Its appearance is `libraryAppearance(speciesId)`, `<speciesId>/assembly.json`. An older entry, a drawn one included, fails with `missing_migration` and is skipped with a warning. Its files stay on disk: Rust lists the folder by its `entry.json` and ignores `drawing.json` and `appearance.png`. A skipped entry isn't listed, so it can't be deleted from My creatures. `load_library_drawing` and `load_library_image` are gone, and `save_library_entry` takes only the entry. The released-creature behaviour test now uses the voxel sample at small, medium and large; the sample can't reach tiny. It checks when each creature sets off for bed (its rest behaviour starts) within two minutes of the grace ending, not when it falls asleep, which measured how far its spawn point was from a shelter. It runs on seed 5. Seeds 3 and 4 (the large creature sleeps in the open) and 7 (the medium one sleeps at another shelter after eating) fail on simulation behaviour, tracked in #254.

### PR 4: Drawn bodies dropped from the engine

_To be written by PR 4._

### PR 5: Player parts store

`src-tauri/src/parts.rs` keeps the player's parts as `parts/<uuid>.json` in the data directory, which `LIVING_DIORAMA_DEV_DATA_DIR` moves in development builds as it moves the library. Its commands are `list_parts`, `save_part` and `delete_part`; app commands need no capability entry. Rust treats each file as opaque JSON, and the Studio validates it as a player part entry. A listing checks that each file is JSON but passes its text on as a `RawValue`, without building a value tree per number (#208). A save writes `<uuid>.json.tmp` and renames it into place, and replaces an existing part, since an edit saves in place (§7). Deleting a missing part succeeds. Listing skips, with a warning, a file that isn't JSON or is too large, and anything not named `<uuid>.json`; it removes `<uuid>.json.tmp` leftovers of an interrupted save. The store runs one operation at a time (`storage::locked`), so a listing never removes the temporary file of a save in progress. The library's commands now do the same, so a listing never removes the pending folder of a library save or delete. Each file is limited to 1 MiB. The worst entry Draw mode can make is about 206 KB of compact JSON: a full 32³ part whose cubes all start a new run (32,768 runs of `1,255,`, about 197 KB), 255 colours, and a drawing of 1,024 pixels of index 255 with a 255-colour palette (about 9 KB together), so 1 MiB leaves room for sockets and the name, which aren't capped. A Rust test saves and lists that entry. `read_limited` in `storage.rs`, which the library uses too, now reads at most the limit plus one byte, so a file that grows while it is read is refused without reading it all (#208). The lowercase UUID check moved there from `library.rs`, for both stores. `desktop-integration` has `PartsStore`, `connectPartsStore()` and `createMemoryPartsStore()`; the memory store refuses the IDs the Rust store refuses. The library's memory store now lets a missing entry be deleted, as the Rust library does.

### PR 6: Draw mode for parts

_To be written by PR 6._ Open: the close dialog (ADR 0015 §10) asks before an unsaved part drawing is lost.

### PR 7: Build mode integration

_To be written by PR 7._ Open: an edited part (a new version) shows in the tray, but an assembly already in progress keeps the copy it holds until the player swaps it.

### PR 8: Exit

_To be written by PR 8._

## Consequences

- Both user stories run in one Studio: assemble a creature from parts, or draw a part and use it.
- Every creature in the world is a voxel creature, so the renderer, the library and the species schema each lose a second code path.
- Drawn creatures saved before M23 no longer load. They are skipped, not deleted.
- A saved world with creatures of drawn `user:` species drops those creatures on restore (`species_missing`), since their species is no longer registered.
- A drawn part is as deep as its rule makes it, from one view, so shapes that need two views or hand-placed cubes wait for the block editor (M24).
- Open for later PRs: the grid editor's tools (pen, eraser, a fill) are PR 6's to choose and record; senses or stats from drawn parts are part attributes, out of M23.

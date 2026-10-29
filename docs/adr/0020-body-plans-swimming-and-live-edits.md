# ADR 0020: Body plans, swimming and live world edits

- **Status:** Accepted
- **Date:** 2026-10-28
- **Context:** Roadmap §3.2 step 7 pairs drawing release 2 (a body plan for drawn creatures, swimming, an animation per way of moving) with live world edits, because both meet in capabilities, water regions and connections. The step is split in two milestones. **M16** builds body plans, swimming, hopping and a simple animation per locomotion mode. **M17** builds live world edits. This ADR records the decisions for both, agreed with the owner on 2026-10-28: M16's to build now, M17's contracts fixed now and built later. M16 lands as a series of PRs: **0** this ADR; **1** the schema: the body plan (template, land gait, anchors) on the species, library entries version 3, the capability's animation profile and submersion (§1, §2, §9–§11, §13); **2** the simulation: `core:walk` renamed `core:land`, `core:swim` added, movement in water, the derived way into water, speed per medium, the animation profile and submersion in the snapshot, the invariants, the relaxed startup warnings, protocol 11 and a smooth turn when setting off (§2–§5, §7–§9); **3** content: ways out of the water and a water spawn point in Woodland Hollow (§4, §6); **4** the renderer: whole-body animation per profile, anchors as pivots and the submersion offset (§8–§10); **5** the Studio's confirm panel (§12); **6** app wiring: the body plan replaces the drawn species' fixed capabilities (§14); **7** headless swim and hop scenarios, soak, the manual checklist and `docs/development.md`. PR 1 comes first; PRs 2, 3 and 4 can then run in parallel; PRs 5, 6 and 7 follow in order. Each PR adds its own paragraph under "As built" below where it departs from this ADR.

This ADR amends ADR 0004 §1 and ADR 0005 §3 (`core:walk` becomes `core:land`; hopping is a gait, not a capability), ADR 0005 §4 and §5 (walkability and startup warnings per capability), ADR 0006 §9 and §12 (heading when setting off, the water invariants), ADR 0014 §11 (drawn species defaults) and ADR 0015 §8 (`check_limits` asks with each species' own capabilities, not one fixed set), each once the PR named there lands. It resolves five places where the spec and the ADRs disagree (see "Contradictions resolved").

## Decisions

### Locomotion (M16)

1. **Capabilities say where a creature can be; a style says how it moves there.** There are two locomotion capabilities: land movement and swimming. Swimming is a new capability, `core:swim`, not a mode that makes every swimmer amphibious. A species has land movement, swimming or both, and at least one.

   How a creature moves within a medium is a separate choice, made per medium in the body plan (§11). On land it is the **gait**: walk or hop, never both, used only when the species has land movement. A gait is a style: it picks the animation profile on land (§8), and may later tune speed or rhythm. It is not a capability, so connections never require a gait, navigation never sees one, and a walker and a hopper of the same size share a navigation profile.

   **Water styles later.** M16 has a single way of swimming: the creature moves on the water's surface plane, lowered by its submersion (§9). There is no water depth and no vertical movement. Water creatures will later get styles of their own, parallel to the land gait: swimming submerged like a fish, floating at the surface, or both. That is the extension path: a water style chosen per medium in the body plan beside the land gait, mapped to a profile and a submersion, which the snapshot already carries. No field for it is added until it is built.

   Water-only creatures have no food or shelter yet. That is accepted for M16: water food and shelter come later. Until then a water-only creature's hunger rises and its hungry cue shows, it sleeps where it is (ADR 0018 §13's fallback), and nothing dies (sanctuary mode).

2. **The land capability becomes `core:land`; `core:swim` is a registry entry, not engine code** (ADR 0005 §3).
   - `core:walk` is renamed `core:land` in PR 2, so the capability isn't confused with the walk gait. Its locomotion rule is unchanged (`land`, `cave`, 35°). Every reference moves with it (the mossling, connections, drawn species, tests and docs). No backward compatibility is required (AGENTS.md), so there is no alias.
   - `core:swim`: `regionKinds: [water]`, no slope limit (the water surface is flat).
   - There is no `core:hop`: hopping is a gait (§1).
   - A capability gains an optional animation profile (§8). `core:swim` declares `swim`. `core:land` declares that the species' land gait chooses its profile, so the engine resolves it to `walk` or `hop` from the species' data without naming either capability.

   A hop is a way of drawing the creature, not a way of moving it: the simulation moves a hopper along its path as smoothly as a walker, and the renderer draws the hops (§8). Speed per medium needs nothing new: ADR 0006 §9 already moves a creature at `baseSpeed` times the largest factor among the capabilities whose rule covers the current region's kind, so an amphibious creature moves at its `core:land` factor on land and its `core:swim` factor in water.

3. **Walkability in water follows the rules that already exist** (ADR 0005 §4), applied per profile. A water region's cells are walkable for a profile whose locomotion covers `water`, on the region's flat surface, subject to clearance like any region. A cell of a water region counts only where its surface lies above the ground, the mirror of ADR 0005 §4's _submerged_ rule, so a water footprint drawn over the bank doesn't make dry ground swimmable. Land under water stays submerged and blocked for land regions, for swimmers too. PR 2 records any detail it needs at the bank.

4. **Into the water by a derived entry; out only by an authored exit.**
   - **Land → water.** A creature that can swim may enter water from any walkable land cell edge-adjacent to a walkable water cell of its profile. The entry is derived when navigation is built, is one-way, and needs no connection in the world content. It joins the region-level search (ADR 0006 §6) like a crossing, with the in-region costs worked out the same way; it has no `structureId`, so it never fires `first_use_of_structure`. For the seam check (`region_seam`, ADR 0005 §5), a walkable land cell edge-adjacent to a walkable water cell counts as joined by the derived entry, in the land→water direction only; otherwise every bank would warn of an invisible wall.
   - **Water → land.** Only through connections in the world content that require `core:swim`: shore or beach exits. No exit is derived. An exit may be one-way (water to land) or two-way; a two-way exit only adds an entry the creature already has. A water-only species can't use an exit, because the land side is in a region kind it can't move in, so no special rule keeps it in the water; its checks skip the exit (§5).
   - For every profile that can swim, the region graph is directed: derived entries lead only into water, and the way out is the exits.
   - Woodland Hollow gets exits on both banks in PR 3, so an amphibious creature that jumps in can always get out. A world with water and no exits would keep an amphibious creature in the water once it jumps in. PR 2 adds a per-profile check for a water region the profile can enter but not leave. It runs in `checkNavigation` (at registration and for `check_limits`), not in `checkWorld` at startup, where no swimmer is registered. It is a limit, a warning the Studio shows as a hint (ADR 0013 §4, ADR 0015 §8), not an error: the species can still be released.

5. **The startup warnings no longer assume today's species.** With swimmers drawn in the Studio, the species that use an exit or a water spawn point are registered from the library after startup, if at all, so warnings keyed on the species registered at startup would fire on every launch of a correct world.
   - **`unsatisfiable_connection` is removed** (ADR 0005 §5). Reference resolution already rejects a connection whose `requiredCapabilities` name an unregistered capability before `checkWorld` runs (ADR 0005 §2), so the only case left is a registered capability no species has yet, which is exactly the swimmer case.
   - **`spawn_unusable` is relaxed:** it fires only for a spawn point in a region whose kind no registered capability's locomotion rule covers, whatever species are registered.

   **Per-profile checks treat a medium the profile can't move in as not applicable.** When a profile is checked (`checkNavigation`, at registration and for `check_limits`), a connection one of whose sides is in a region kind the profile has no locomotion for is skipped, as a connection needing a capability the profile lacks is (`missing_capability`). It is not reported as `no_walkable_side` and gives no `portal_unusable` limit. So a water-only swimmer gets no hint about shore exits, and a walker none about them either.

6. **A water-only species needs somewhere to appear.** A profile that fits no spawn point can't be registered (ADR 0012 §4, `no_spawn_point`), and Woodland Hollow's spawn points are all on land. PR 3 adds at least one spawn point in the river alongside the exits, and spawning a creature picks only spawn points its profile can stand on, as it does now.

### Heading (M16)

7. **Setting off turns smoothly** (issue #121, folded into PR 2 because it touches the same movement and heading code). Walking no longer snaps the heading to the direction of travel the moment a creature sets off; it turns with ADR 0018's turn rate, as eating and sleeping already do. Whether the creature turns before moving or while moving, and how sharp corners are eased, is PR 2's choice. Runs with the same seed stay identical, and a save taken mid-turn restores the same turn.

### Animation and drawing (M16)

8. **Whole-body animation only, kept easy to replace.** Procedural animation and per-part skeletons come later and will replace what M16 builds, so M16 keeps it small:
   - a profile moves the whole body: squash and stretch, tilt, bob, and a sway or undulation made from these. No skinned meshes, no bones, no vertex-shader bending;
   - three profiles: `walk` (a gait: a small bob and tilt in step with speed), `hop` (squash before take-off, an arc, squash on landing) and `swim` (a side-to-side sway or undulation plus a bob);
   - each profile is a small function from its inputs (the profile, the creature's speed, its own phase, the elapsed time) to a body transform. The renderer calls all of them through one interface, so swapping the whole approach later touches one module;
   - profiles combine with ADR 0018's cues (the eating bob, the sleeping squash) rather than replace them; PR 4 decides how they add up;
   - a profile names an entry in the renderer's profile table; an unknown or missing profile draws no motion, as an asset the renderer can't load draws a neutral fallback (ADR 0007 §1).

   The snapshot carries each creature's animation profile, taken from the capability in use (the one ADR 0006 §9 picks for the current region): `swim` in water, and on land the profile of the species' gait. The renderer reads profile names and never capability IDs, region kinds or action IDs.

9. **Swimmers sit lower in water.** The snapshot carries a submersion value per creature, a share of the body's height to lower it by, which the renderer applies as an offset. It comes from the capability in use: a capability may declare `submersion` (0 to 1, default 0), and `core:swim` declares one. The renderer never interprets region kinds; it just lowers the body.

10. **Anchors are optional, few, and in drawing pixels.** A template has a few named anchors: a walker has `feet`, a swimmer `tail`, a hopper none. Each defaults to a point taken from the drawing's bounds (the feet at the bottom edge of the drawn shape's bounds, horizontally centred on them, which is where the body meets the ground, ADR 0011 §3; the tail at the middle of the bounds' left edge, the rear, since drawings face right, ADR 0011 §7), and the player may move it in the confirm panel (§12). Anchors are stored in the drawing's pixels in `species.body`, on the image, which is the drawing (ADR 0017 §8). M16's profiles may use them as pivots (tilting about the feet, swaying about the tail); otherwise they are kept for the per-part animation that replaces M16's.

### The body plan (M16)

11. **The species carries its body plan.** `species.body` (ADR 0017 §11, today only `thickness`) gains:
    - `template`: `walker`, `hopper` or `swimmer` for now, with more later. The template chooses which anchors apply and what the confirm panel starts from (walker: land movement with the walk gait; hopper: land movement with the hop gait; swimmer: swimming only). The player can then add or remove swimming or land movement, and switch the gait, within §1's rules;
    - the style per medium: for now only the land gait, `walk` or `hop`, used when the species has land movement and walk by default. A water style joins it later (§1);
    - `anchors`: the template's anchors that the player placed or accepted, by name, as `{ x, y }` in drawing pixels.

    Where a species can move stays where it is, in the species' `capabilities` map (ADR 0004 §2): land movement and swimming are `core:land` and `core:swim` entries with their speed factors. The gait is not in that map, and nothing is stored twice. PR 1 chooses the field names, but the style should be shaped per medium, for example `locomotion: { land: { gait } }`, so a water style can later sit beside it (`locomotion.water.style`) without renaming anything.

12. **A confirm step in the Studio.** Between drawing and Release, the Studio shows a panel: the template, land movement and swimming, the land gait, clicks to place the anchors, and an animated preview of the body in each way it moves. The size limits (ADR 0015 §8) are asked for the chosen capabilities, since a navigation profile is the size class plus the capabilities (ADR 0012); the gait doesn't change them. The release moment (#51) and the size suggestion (#49) stay separate issues.

13. **Library entries go to version 3.** The body plan is stored with every species the library saves. An entry or a species without a body plan is read as a walker with default anchors. That is a cheap default for content with no plan, not a migration path: no backward compatibility is required (AGENTS.md), and entries of version 2 may simply fail to load.

14. **The body plan replaces the drawn species' fixed capabilities.** ADR 0014 §11's `DRAWN_SPECIES_DEFAULTS` gave every drawn species `core:walk` 1. From PR 6 a drawn species takes its capabilities (`core:land`, `core:swim` or both) and its gait from its body plan, with a speed factor of 1 for each capability unless PR 1 or PR 6 tunes it. The other defaults (base speed, behaviors, senses, traits) stay app configuration until drawing release 3 reads them from the drawing (roadmap §3.2 step 8).

15. **Out of scope:** changing the body plan of a species already released (ADR 0015: a redraw is a new species; editing comes later).

### Live world edits (M17; fixed now, built later)

16. **What an edit can do.** M17's edits add, remove and move prop and structure placements. No terrain edits yet. They are made through a development hook in the app and through `pnpm sim`; a player-facing tool comes with structure drawing.

17. **One edit path, in the simulation.** Every world edit goes through a single validated edit command in the worker, applied between ticks like every other command (ADR 0006 §11). Nothing else changes world content at run time. The Studio, the dev hook, the headless runner and later structure drawing and the agent bridge all reach the world through it.

18. **A save stores edits, not a new world.** A save keeps an ordered list of the edits applied since the base world, and a restore replays them onto the base world before restoring the creatures. Edits never bump the world's version (ADR 0003); the base world's ID and version still decide whether a save matches (ADR 0019 §7). The save schema's version goes up when the list is added.
    - **A replayed edit that fails is skipped.** If an edit no longer applies on restore (its placement or type is gone, or it fails validation), it is skipped with a warning event and in the restore report, and the edits after it still apply. Edits after it that refer to a placement it would have added fail and are skipped the same way.
    - **Placements keep their IDs.** An add-placement edit carries the new placement's ID, chosen when the edit is made, so later edits, inverse edits and replays all refer to the same placement.
    - **Storage stays JSON.** The edit list lives in `world.json` with the rest of the save, which closes the question ADR 0019 §1 left open for this step: no SQLite and no `persistence` package. SQLite can be revisited if edit lists grow large enough that writing the save whole costs too much.

19. **A trapped creature is moved, never deleted.** When an edit leaves a creature off any walkable cell of its profile (a bridge removed under it, a prop placed on it), the engine moves it to the nearest valid cell in a region's main walkable area (the region's largest connected piece, so it isn't put on an island it can't leave): its own region's if that region still exists, else the nearest region its profile can move in. It emits an event saying so. The edit is rejected only when no such cell exists. A creature is never deleted. Routes that cross the edited area are replanned. Home and knowledge entries naming a removed placement are pruned as a restore prunes them (ADR 0019 §7).

    **Blocking an exit out of water is allowed, with a warning.** An edit that blocks one or more water→land exits, even the last one out of a water region, still applies; the result warns and names each blocked exit. Amphibious creatures in that water stay there until an exit opens again. Rejection is kept only for a creature trapped inside new solid geometry with no valid cell to move to (above).

20. **Navigation rebuilds whole regions first.** An edit rebuilds the walkability masks, crossings and distance fields of every region it touches, for every profile, extending ADR 0006 §6's `invalidateRegions`. Finer, dirty-rectangle rebuilds wait until measurement shows whole regions are too slow.

21. **Validate first; return the inverse.** The edit command has a dry-run `validate` that reports, without changing anything:
    - whether the edit would be accepted;
    - which creatures it would move;
    - preview data: the cells the edited placement would occupy (its footprint) and the water→land exits it would block.

    The preview data is a contract for a later edit UI, which can show how much room a prop takes and highlight a blocked exit while the player places it. That preview UI is built with the player edit UI (structure drawing); M17 provides only the data in the `validate` result, with no dev overlay. An applied edit returns its inverse edit, so an undo is one more edit. A player-facing undo comes later.

## Contradictions resolved

The spec predates several ADRs. Where they disagree, this ADR settles it; the private design docs are updated to match.

- **Strokes or image as the source of truth.** The spec's creature flow and asset list keep vector strokes as the editable original. Since ADR 0017 §8 the 256 px image is the drawing and the strokes are a record that is never replayed. That stands, and anchors (§10) are stored in the image's pixels.
- **The template list.** The spec lists eight creature body plans and names a different first set in its open questions. The templates are walker, hopper and swimmer for now (§11); others (flyer, crawler and so on) come later. A walker and a hopper differ in gait, not in capability.
- **What animation deforms.** The spec's baseline is a 2D billboard animated with squash, sway, bob and limb anchors. Since ADR 0011 the body is an extruded mesh, and M16 animates that mesh as a whole (§8). The billboard is gone.
- **The water invariants.** ADR 0006 §12 checks that every creature stands on a non-water region and never under a water surface. That was true while only walkers existed. The invariants now hold per capability: each creature is on a walkable cell of a region its capabilities' locomotion covers, on that region's surface, and changes region only through a connection joining the two or, from land into water only, a derived water entry (§4). Water to land is only ever through a connection. A walker still never enters water; a swimmer is in water only on a water region's surface.
- **How the Studio commits to the world.** The spec has the Studio commit through a world-edit interface, while the app has the Studio ask the strip, which sends worker commands (ADR 0015). For creatures nothing changes: a release registers a species and spawns creatures, which are not world edits. For world edits M17 settles it: the one edit path is the worker's edit command (§17), and the Studio reaches it through the strip like any other command.

## Exit

M16 is done when:

- a drawn species can be a walker, hopper or swimmer, with swimming on or off for walkers and hoppers and land movement (walking or hopping) on or off for swimmers;
- `core:walk` is renamed `core:land` everywhere, and there is no hop capability;
- an amphibious creature jumps into the river from the bank and leaves it only by a shore or beach exit; a water-only creature stays in the water; a walker never enters it;
- walking, hopping and swimming each show their own animation, and a swimmer sits lower in the water;
- creatures turn smoothly when they set off (#121);
- the Studio's confirm panel sets the template, locomotion and anchors and previews the animation;
- `pnpm check` and `pnpm soak` pass with swim and hop scenarios and the per-capability invariants;
- a manual checklist entry is added and run by the owner;
- this ADR records the decisions and every departure from them.

M17's exit is set when it starts.

## As built

Each M16 PR adds its own paragraph here, in its own slot, so PRs landing in parallel don't conflict.

### PR 1: schema

- **The body plan is `species.body`** (`BodyShapeSchema` in `content-schema`; the name stays `BodyShape`, so the protocol and renderer types carry the plan unchanged). Every field has a default, and `defaultBody()` returns a walker:
  - `template`: `"walker" | "hopper" | "swimmer"`, default `"walker"` (`BODY_TEMPLATES`). It is kept separate from locomotion because it chooses the anchors and what the confirm panel starts from, which the capabilities and gait don't say (a swimmer that can also move on land still has a tail).
  - `locomotion: { land: { gait: "walk" | "hop" } }`, always present after parsing, gait default `"walk"` (`LAND_GAITS`). There is no `water` key: §1 adds none until a water style is built, and it will sit beside `land` as `locomotion.water`. `LocomotionMedium` (now `"land"`) and `LOCOMOTION_MEDIA` are derived from these keys. A swimmer-only species still carries a land gait, unused, so the confirm panel keeps the choice if land movement is switched back on.
  - `anchors: { feet?: { x, y }, tail?: { x, y } }`, default `{}`, in drawing pixels from the top left, each coordinate from 0 to `DRAWING_SIZE` (256, now the one constant behind the Studio's `CANVAS_SIZE` and the renderer's `BODY_IMAGE_SIZE`). Only the template's anchors are allowed (`BODY_TEMPLATE_ANCHORS`: walker `feet`, swimmer `tail`, hopper none). An anchor left out is placed by `defaultAnchor(name, bounds)` from the drawn shape's bounds (left and top inclusive, right and bottom exclusive), which PR 4 and PR 5 share.
- **"At least one medium" is checked on the capabilities**, not in the body plan, since where a species can move lives only there (§11): a species whose capabilities include no locomotion rule fails reference resolution with `no_locomotion`. It runs in `resolveReferences` and `addEntries` through a new entry-wide check (`RegistryOptions.check`), because no single reference can make it.
- **A capability's animation and submersion sit on its locomotion rule** (`LocomotionRule` in `extension-api`), since both only mean something for a way of moving: `animation?: string | { fromStyle: LocomotionMedium }` and `submersion?: number` (0 to 1, a share of the body's height, 0 if omitted). PR 2 gives `core:land` `animation: { fromStyle: "land" }` and `core:swim` `animation: "swim"` with a submersion. `animationProfile(rule, body)` resolves the profile name: the string, the species' gait for `{ fromStyle: "land" }` (each gait is a profile of the same name), or undefined for none. A water style later only adds a case there; the switch is exhaustive, so a new medium doesn't compile until it does. Submersion may likewise widen to `number | { fromStyle }` when water styles arrive (a fish deeper than a floater), so PR 2 should read it through one helper rather than treat it as a plain number in several places.
- **No capability-level speed factor.** The species' `capabilities` map already gives each capability its speed factor, and ADR 0006 §9 picks the factor per region (§2), so a drawn species' factor of 1 per capability is PR 6's to set there.
- **Library entries are version 3** and are not migrated: entries of versions 1 and 2 fail to load with `missing_migration`. The version 1 migration (ADR 0018's feeding, resting and vision) is removed with its tests, as it could no longer complete. The species definition stays at schema version 1, since its new fields all have defaults.

### PR 2: simulation

_Not yet built._

### PR 3: content

_Not yet built._

### PR 4: renderer

_Not yet built._

### PR 5: Studio confirm panel

_Not yet built._

### PR 6: app wiring

_Not yet built._

### PR 7: tools, soak and docs

_Not yet built._

## Consequences

- A new place to move (air, say) is a capability with a locomotion rule and a profile. A new style within a medium (a land gait now, water styles later) is a body-plan choice and a profile function in the renderer. Neither changes the engine.
- Water-only creatures go hungry until water food arrives. That is visible (the hungry cue) and accepted.
- Every world with water needs authored exits for amphibious creatures and a water spawn point for water-only ones. The per-profile checks report where they are missing: a hint for a water region without a way out, and `no_spawn_point` for a water-only species with nowhere to appear.
- M16's animation is deliberately thin and will be thrown away when per-part animation arrives; keeping it behind one interface makes that cheap.
- Body plans add a field to every library entry, and entries saved before M16 may stop loading. That is accepted until backward compatibility is required.
- M17 starts with its contracts fixed: one edit path, edits in the save, relocation over rejection, whole-region rebuilds, dry runs and inverse edits.

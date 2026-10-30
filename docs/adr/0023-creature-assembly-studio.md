# ADR 0023: Creature Assembly Studio

- **Status:** Accepted
- **Date:** 2026-10-30
- **Context:** Roadmap §3.2, M21: user story 1 (roadmap §3.2), end to end. M19 and M20 ([ADR 0022](0022-voxel-creatures.md)) built everything below the editor: the part and assembly format, the validator and measurement (`measureAssembly`, `checkAssemblyFit`, `assemblyWarnings`, `placeInstances`), the seeded assembler (`assembleParts`), the assembled body (`buildVoxelBody`), part and assembly thumbnails (`VoxelThumbnails`), the starter parts with their part and socket types in `ready` (protocol version 19), and the library's `saveVoxel`. Until now voxel creatures are made only from the development console. The Studio ([ADR 0015](0015-creation-studio.md), with ADR 0020 §12's confirm step) draws creatures only. M21 ships as PRs: **0** this ADR; **1** pure assembly edit operations and undo history in `content-schema`; **2** the renderer's assembly view and asynchronous voxel thumbnails; **3** the plumbing: part-type names in `ready` and the Studio channel requests (protocol version 20); **4** content: tighter part-type fits, a `root` role and suggested colours end to end (protocol version 21, after PR 3); **5a** the Studio's Build mode; **5b** recolouring, steps, rotation, Randomize and drag-to-socket; **6** voxel thumbnails in My creatures, the manual checklist entry and the developer docs. The decisions below were agreed with the owner on 2026-10-30.

This ADR amends ADR 0015 §4, §5, §7, §10 and §12 (the Studio gains a Build mode beside drawing), and refines ADR 0022 §4, §9 and its M19 and M20 decisions on recolouring, mirroring, thumbnails and the `root` role. See "Departures".

## Decisions

### Studio structure

1. **One Studio, two modes.** A Build/Draw switch in the one Studio window chooses between assembling a voxel creature and drawing one. Draw mode is today's Studio, unchanged; it is removed at M23, when drawn bodies go (ADR 0022 §22). There is no second window.

2. **The confirm step is shared.** Build mode ends with Next, which shows the confirm step (ADR 0020 §12) without the drawn-only settings: no thickness (in `CreatureDetails`) and no anchors (in `BodyPlanPanel`), since a voxel body's anchors are derived (ADR 0022 §20). The flow is Next → body plan → Release, as for a drawing.

3. **Edit a copy, never in place.** A released creature can be loaded into Build mode with "Edit a copy". Its saved assembly becomes the starting point, and a release makes a new species. A released species is never changed.

### Placing parts

4. **Click to place.** Selecting a part in the tray highlights the free sockets it fits; clicking one places it there. When only one socket fits, the part is placed at once. Drag-to-socket (PR 5b) picks the socket with the same scorer, by distance and angle, so the two ways agree.

5. **Dropping on an occupied socket replaces the part.** The old part's children hang again from the new part by socket ID wherever they still fit; the rest are removed. A replacement is one undo step.

6. **A global Mirror toggle, on by default.** With it on, a part placed on one socket of a mirror pair is placed on the other too, mirrored (ADR 0022 §16). With it off, the two sides of a pair may differ (ADR 0022, M19: "the two sides of a pair may differ"). Mirroring covers whole branches (owner, M21): a part's mirror image is found from the nearest part on its path to the root, itself included, that hangs from a socket of a mirror pair, by following the same sockets down from the part on that pair's other socket. A hand placed on the left arm goes on the right arm too. Only the nearest pair counts, so parts mirror in twos, never fours, and where the other side has no part at the end of that path there is no image. Every edit that mirrors uses the image.

7. **One rotate button.** It turns the selected part a quarter turn about its socket's Y axis, cycling. Turns that would make the assembly invalid, such as failing the joint depth (ADR 0022 §12), are skipped. The rest rotation stays a stored quaternion (ADR 0022 §9), so other axes can be added later without a format change.

8. **Ladder steps, per part and per creature.** A part's step can go one rung up or down the ladder (ADR 0022 §1): it changes the step of the part copy for the instance and its mirror twin only, copying the part first when the copy is shared beyond that pair, the same reach as recolouring (§12; owner, M21). It is refused if a joint (ADR 0022 §12) or the snap to the finer grid (ADR 0022 §13) would break. The whole creature can step up or down too: every part's step moves together, keeping their ratios. Stepping can push the derived size class up.

9. **Randomize and Fill empty.** Randomize builds a new creature with `assembleParts` from a new root and seed; Fill empty fills the current assembly's free sockets and keeps its parts. Part-type fits are tightened first (#225, PR 4), so random creatures stay plausible. An `optional` flag on sockets (ADR 0022, M20 PR 5a) is deferred.

10. **A new creature starts from a default torso.** Part types gain a `root` role (#225), a content role like `tail`, so the tray lists torsos first without reading part-type IDs (the engine still never branches on IDs).

### Colour

11. **Suggested colours are pack content.** A pack registers its suggested colours, and `ready` lists them, so themes and worlds can supply their own later (ADR 0022 §4). PR 4 owns them end to end: the schema, the built-in content, `extension-api`, and listing them in `ready` and the `parts` request (protocol version 21). It lands after PR 3. If that proves expensive in PR 4, the colours fall back to an app constant, and PR 4's "As built" says so.

12. **Recolouring changes one colour slot** of the selected instance's part copy, and of its mirror pair's. When the copy is shared beyond that pair (four legs of one copy, say), the edited instances get a copy of their own first (copy on write).

### Preview, validation and release

13. **A test walk in place.** The Studio's preview walks the assembled creature in place with M16's whole-body motion profiles, as the drawn preview does. Per-part motion is M22.

14. **Release is blocked only for what can't live in the world.** A creature larger than `large` (ADR 0022 §3) or with a limit error for its size and ways of moving (such as `no_spawn_point`, ADR 0015 §8) can't be released. Everything else, a part two or more steps from the main step (ADR 0022 §2) or flush faces (§14 there), is a hint and never blocks.

15. **Edits produce only valid assemblies.** Every edit operation either returns an assembly that passes the validator or is refused, so the Studio never holds an invalid assembly. Speeding up `assemblyWarnings` for live editing (#205) is deferred.

16. **Undo and redo keep immutable snapshots.** Each step is a whole assembly, sharing every unchanged part and instance with the step before (structural sharing), rather than a command with its inverse. Assemblies are small trees of at most 32 parts, so a snapshot costs little, and undo can't drift from what an edit did. This departs from the research plan's "command-based" undo (roadmap §3.2, M21 plan). Draw mode keeps its pixel patches (ADR 0017).

17. **Release through the Studio channel.** A `releaseVoxel` request carries `{ releaseId, assembly, name, plan }`. It reuses ADR 0015 §12's retry map, so a timed-out release sent again with the same `releaseId` never saves twice; the Studio keeps the `releaseId` while the assembly, name and plan are unchanged, and saves with `SpeciesLibrary.saveVoxel` (ADR 0022, M19 PR 4b). An assembly whose serialized JSON is over 8 MB, the library entry limit, is refused before anything else (#208).

### Plumbing

18. **Parts reach the Studio by request.** A `parts` channel request returns the registered parts, part types, socket types and suggested colours from the strip's latest `ready`. `PartTypeSummary` gains the type's `name`, for the tray's headings. PR 3 owns protocol version 20: the part-type `name` and the Studio channel requests (`parts`, `assembly`, `releaseVoxel`). The suggested colours join the `parts` answer with PR 4 (§11). Parts registered while the app runs still don't reach the main thread (#226, deferred).

19. **Assemblies for My creatures by request.** An `assembly` channel request returns one saved species' assembly on demand, and the Studio draws its thumbnail with `VoxelThumbnails`, replacing the placeholder block (ADR 0022, M19 PR 4b).

20. **Asynchronous, keyed thumbnails.** The thumbnail API becomes asynchronous and scheduled, so drawing a tray of parts doesn't stall a frame, and is cached by `id@version` rather than by object identity (#224).

21. **Closing asks first.** Closing the Studio with an assembly that isn't released and isn't the default start keeps ADR 0015 §10's dialog. Drafts stay out of scope.

22. **This ADR records M21.** It amends ADR 0015 and refines ADR 0022 where noted.

## Departures

- **Research plan, undo:** immutable snapshots with structural sharing, not command-based undo (§16).
- **ADR 0015 §4, §5:** the Studio also holds an assembly and the parts list, and the channel gains `parts`, `assembly` and `releaseVoxel` (§17–§19).
- **ADR 0015 §7:** in Build mode the preview is the renderer's assembly view, not `buildBody`.
- **ADR 0015 §10:** the close dialog also covers an unreleased assembly (§21).
- **ADR 0015 §12:** a release in Build mode starts over in Build mode from the default torso (§10), not at drawing; My creatures draws voxel thumbnails (§19) and offers Edit a copy (§3).
- **ADR 0022 §4:** the suggested colours are pack content listed in `ready` (§11).
- **ADR 0022, M19 "Recolouring edits the frozen copy":** copy on write when the copy is shared beyond a mirror pair (§12).
- **ADR 0022, M20 PR 3:** thumbnails are asynchronous and cached by `id@version`, not synchronous and kept by identity (§20).
- **ADR 0022, M20 PR 5b:** the `root` role is added (§10).

## Exit

M21 is done when:

- the player opens the Studio, picks parts from the built-in library, assembles a new creature and releases it, and it lives in the world (user story 1);
- placing, replacing, removing, mirroring, rotating, stepping, recolouring, Randomize, Fill empty, undo and redo work in Build mode, and every edit leaves a valid assembly;
- the size class shows live, and release is blocked only as §14 says;
- My creatures shows voxel thumbnails and Edit a copy;
- `pnpm check` passes, and `pnpm soak:quick` on PRs 3 and 4;
- a manual checklist entry is added and run by the owner;
- this ADR records the decisions and every departure from them.

## As built

Each M21 PR adds its own paragraph here, in its own slot, so PRs landing in parallel don't conflict.

### PR 1: assembly edit operations

`packages/content-schema/src/voxel-edit.ts` holds the edit operations as pure functions: `attachPart`, `replacePart`, `removePart`, `rotatePart`, `stepPart`, `stepAssembly`, `recolorPart`, with `compatibleSockets`, `mirrorImage` and `scoreSockets`. Each takes an assembly and returns `{ ok: true, assembly, instances }` or `{ ok: false, refusal: { code, message } }`, and checks its result with `VoxelAssemblySchema`, so it never returns an invalid assembly (§15); placing also checks part-type fits against `assembleParts`' `PartFitLookup`. An edit shares every part and instance it doesn't change with its input. `compatibleSockets` lists exactly the free sockets `attachPart` would accept. The Mirror toggle is an option on every operation that acts on one instance. Its twin is `mirrorImage`'s whole-branch image (§6), found by walking up to the nearest paired socket and following the same socket IDs down the other side. Placing mirrors onto the other socket of a pair, or onto the same socket of the parent's image, when that socket is free and the part fits it; both go on or neither does, and a taken or unfitting other socket is left alone. Replacing, removing, turning, stepping and recolouring act on an existing image too. With the toggle off, they act on the one instance. A library part is held once while its copy is unedited; an edited copy is copied again for the next placement. A replaced instance keeps its ID and goes back to rest; its children hang again where their socket ID, type fit and validity allow, one by one in order. The root can be replaced but not removed or turned. Turns are snapped to exact quarter-turn quaternions with a canonical sign; with the toggle on, the twin takes the turned part's stored rotation, so a pair is mirror images again even when its sides were turned apart with the toggle off. Per-part steps and recolouring share one copy-on-write rule (§8, §12; owner, M21): the copy is edited in place when only the instance and its twin use it, and copied under a new key otherwise. Recolouring leaves a twin whose part has no colour at that index alone, and returns the assembly unchanged (the same object, which `recordEdit` skips) when the colour is already set. A copy of a copy is keyed from the base key (`legs-long-3`, not `legs-long-2-2`). The helpers the edits share with `assembleParts` live in an internal module that the package index doesn't export. Replacing the root checks no part-type role yet; PR 4's `root` role is meant to be checked there. `scoreSockets` ranks sockets in the body frame by the angle off a probe ray plus distance from its origin (weight 1 rad/m, tunable in PR 5b). The undo history (`startHistory`, `recordEdit`, `undoEdit`, `redoEdit`) keeps at most `MAX_UNDO_STEPS` (100) snapshots. Found while writing it: a half turn about Y always keeps a valid part on the grid, so `rotatePart` can't refuse with `no_turn` today; the code stays for future checks.

### PR 2: renderer assembly view and thumbnails

The renderer's `createAssemblyView(container, { roleOf })` (`voxel/assembly-view.ts`) is a plain API, no React, for PR 5a to mount: `setAssembly`, `setHighlightedSockets`, `setSelection`, `setGhost`, `pick(clientX, clientY)`, `setTestWalk` and `dispose`, plus `thumbnails`, a `VoxelThumbnails` on the view's own renderer, so the Studio needs no second WebGL context. It draws one assembly on the body preview's ground grid and light, in a WebGL context of its own, through an orbit camera (drag to orbit, wheel to zoom, no pan, down to 0.8π from the top so a belly can be seen) that frames the first body and afterwards keeps its direction, turns to the new body's centre and moves out only if the body grew. The body is rebuilt with `buildVoxelBody` and `skinVoxelBody` only when the assembly object changes (undo snapshots are immutable, §16), and the old geometry and skeletons are freed at once. Socket markers are spheres of constant screen size at the sockets the Studio passes by `{ instance, socket }`, drawn over the body so a socket behind it can still be clicked; the view doesn't work out which sockets are free or fit, which stays PR 1's. The selection tint is the body's geometry on a second skeleton whose unselected bones collapse to a point. A ghost is the part, see-through, at each socket given (the Studio passes the mirror pair's twin while Mirror is on), mirrored on a mirrored socket, placed by `placeInstances` as if attached but in the current body frame, so a part that would widen the body doesn't shift the rest. `pick` returns a marked socket before a part, a part from the hit face's skin index, and never a ghost; a pick of the mossling takes about 1.5 ms. `probe(clientX, clientY)` gives the pointer's ray in the body frame, with the test walk's motion taken out, as PR 1's `SocketProbe`, for `scoreSockets` in drag-to-socket (PR 5b); sockets are named by PR 1's `SocketRef`. While a ghost sits on an occupied socket, the part there and everything hanging from it collapse to a point in the body (and its tint), as a replacement would take them away, and can't be picked. `setGhost` meshes the part anew, so the Studio calls it when the part, sockets or rotation change, not per pointer move. The camera takes its first aspect from the container and frames again on the canvas's first resize; every call after `dispose` does nothing. The test walk takes the body preview's `PreviewMotion` and plays M16's whole-body profiles about the measured centre of gravity and tail, lowered by its submersion over water. `VoxelThumbnails` is now asynchronous and keyed by kind, `id@version` and size rather than by object: `part({ id, version, part }, size)` (a protocol `PartSummary` fits) and `assembly({ id, version, assembly }, size)` return promises, queued and drawn at animation frames for up to 6 ms each, at least one a frame; a failure rejects and is forgotten, and `dispose` resolves what is queued to undefined. The diorama view's `partThumbnail` and `assemblyThumbnail` follow; nothing in the app called them yet. Like everything drawn at animation frames, queued thumbnails wait while the page is hidden. `iconStage` copied the material for each draw and freed the copy after it, so three.js freed the shader program and compiled it again for every thumbnail (#224): measured over the 25 starter parts at 112 px in a Chromium WebGL context, 25 programs compiled and about 6.7 ms a thumbnail (median of 5 rounds, PNG encoding left out). `VoxelThumbnails` now keeps its staged copy until `dispose` (`iconStage`'s optional `kept` map), so one program is compiled and a thumbnail takes about 2 ms; the 25 take about 70 ms instead of 180 ms.

### PR 3: plumbing

`PartTypeSummary` carries the type's `name` (protocol version 20). The Studio channel gains three requests, typed in the app's `studio-protocol.ts`, with `studioClient` as the Studio's end. `parts` answers `StudioParts` (`parts`, `partTypes`, `socketTypes`), kept from the strip's `ready`; before `ready` it is refused as `not_ready` rather than waiting, so the Studio asks again. The suggested colours join `StudioParts` with protocol version 21 (§11). `assembly { speciesId }` answers `{ speciesId, version, assembly }` from the library, which now keeps each voxel entry's assembly and version in memory (`SpeciesLibrary.assembly`), also for a species the world didn't take; a drawn species is refused as `not_voxel`. `releaseVoxel { releaseId, assembly, name, plan }` (`plan` is only its ways of moving) shares `release`'s retry map, keyed by `releaseId`, and saves with `saveVoxel`. Refusals are typed: the channel carries a `StudioRequestError`'s `code` with its message (desktop-integration), read with `studioErrorCode`, and `StudioErrorCode` lists them. Release is blocked as §14 says with `too_large` (no size class fits) and `no_spawn_point` (the limit error), each with a message in the player's words; any other failure to save is `release_failed`, and bad settings, a full world and a library still opening are `invalid_request`, `world_full` and `not_ready`. The serialized-size cap (#208) is `MAX_ASSEMBLY_BYTES`, 8 MiB of UTF-8 JSON, the store's entry limit: `releaseVoxel` checks it before anything else, and `saveVoxel` checks it first too, so the development console is held to it (`assembly_too_big`). It lives in the app, not in the content-schema validator as #208 suggests, while PR 1 owns the voxel schema files. The cap guards the store, not the channel, which still carries an oversized assembly to be refused; and in the rare case that an assembly just under the cap and its species together pass 8 MiB, the Rust store's own entry limit refuses the save, which reaches the Studio as `release_failed`.

### PR 4: content

**Fits (#225).** Each built-in socket type now takes one part type, so `assembleParts` puts only plausible parts on a socket: a leg fits only a leg mount (it no longer fits a shoulder), an arm only a shoulder, a fin only a fin mount (no longer a leg mount, shoulder or tail base), a tail only a tail base. For that, `hollow:hip` is renamed `hollow:leg-mount`, which carries any leg, front or back, the four-legged torso's front legs hang from leg mounts rather than shoulders, and the fish's tail takes a new part type, `hollow:tail-fin` (the fan fin, with the `tail` role, so a fish's tail anchor is now its tail fin), on a new socket type, `hollow:tail-fin-mount`, so a fish never gets a bushy tail and a fox never a fan fin. The torso fits no socket, and the `hollow:waist` socket type, there only so that a torso fitted nothing any part offered, is gone. A test pins, over 32 seeds per torso, which part type each torso's sockets get. A random fish still wears a head with ears and a nose: heads fill every mount until an `optional` socket flag exists (§9). **The `root` role** joins `tail` in `PART_ROLES`, and the built-in torso has it. It is what tools offer, not a rule of the format: an assembly's root may still be any part (ADR 0022 §11). `assembleParts` takes its root from the caller and infers none, so it is unchanged; the development console's `starterRoots` now picks the parts whose type has the role, rather than the parts no part has a socket for. `PartFitLookup` gains `roleOf`, which `partFitLookup` reads from `ready`, and PR 1's `replacePart` now refuses a part whose type lacks the role as the root's replacement (`not_root`), closing the gap PR 1's paragraph notes: its sentence "Replacing the root checks no part-type role yet" is superseded. **Suggested colours (§11)** are pack content after all, so there is no app constant: a `palette` definition (`{ id, version, name, colors }`, plain `#rrggbb` per ADR 0022 §4, at least one colour, each once ignoring case), registered in the `palettes` registry of `extension-api`. `suggestedColors(registries)` merges every palette into one list of lower-case `#rrggbb`, by palette ID, a colour two palettes share kept where it first appears; there is no choosing a palette by theme or world yet. `ready` lists that list as `suggestedColors` (protocol version 21), and the Studio's `parts` answer carries it (`StudioParts.suggestedColors`). The built-in pack's palette, `hollow:woodland`, has 20 colours: the starter parts' hues (near-black, browns, tan, cream, fox orange, pinks, moss greens, teals) with stone grey from the world and a few more toned toward it (mustard, berry, slate blue, plum), none pure black or white (ADR 0022 §5). The host builds `ready`'s voxel lists with `describeVoxelParts`, which the app's tests now use instead of building them by hand.

### PR 5a: Build mode

_To be written by PR 5a._

### PR 5b: recolour, steps, rotation and Randomize

_To be written by PR 5b._

### PR 6: My creatures, checklist and docs

_To be written by PR 6._

## Consequences

- Drawn and voxel creatures share one Studio, one confirm step and one release path until M23 removes Draw mode.
- Undo snapshots keep the Studio's edit code free of inverse operations; their memory grows with the history's length, which PR 1 may cap.
- A creature can be made larger than `large` or with hints while editing; only release stops it.
- Deferred: an `optional` socket flag, faster assembly warnings (#205), run-time parts on the main thread (#226), drafts, and editing a released species in place.

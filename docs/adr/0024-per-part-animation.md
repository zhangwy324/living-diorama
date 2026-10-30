# ADR 0024: Per-part animation

- **Status:** Accepted
- **Date:** 2026-10-30
- **Context:** Roadmap §3.2, M22. Since M19 ([ADR 0022](0022-voxel-creatures.md)) a voxel creature is a skinned mesh with one bone per part, and each part keeps a rest joint and its parent's index ("Joints, for M22" in ADR 0022's M19 PR 3b), but every bone stays in its rest pose: the creature moves only as a whole, through M16's profiles ([ADR 0020](0020-body-plans-swimming-and-live-edits.md) §8) and ADR 0018 §15's cues. M22 makes the parts move. The part's type picks its motion, the part's shape scales it, and the gait sets one rhythm for the whole creature, so creatures assembled at random from any parts still move as one animal. Its exit: every starter part type that has a motion animates in the strip, and two different leg parts visibly move differently. M22 ships as PRs: **0** this ADR; **1** the motion field: the part-type schema, the built-in types' motions, the part-type summary in `ready` (protocol version 23) and the app's motion lookup; **2** the motion module: pure motion functions, the per-species rig and the composer in `packages/renderer/src/voxel/`, with tests; **3** world wiring: the creatures in the strip take their parts' motion, and the frame cost is measured; **4** the Studio: the test walk and the body-plan preview animate; **5** tuning: amplitudes and cadences reviewed by the owner from captures, and the exit's contact sheet. PRs 1 and 2 run in parallel with this one; 3 follows them; 4 and 5 follow 3. The decisions below were agreed with the owner on 2026-10-30.

This ADR amends ADR 0022's "Joints, for M22" (a small scale in the animation layer, §2) and refines ADR 0020 §8 and ADR 0023 §13 for voxel creatures. See "Departures".

## Decisions

### What moves

1. **Idle is nearly still.** A creature standing still blinks every few seconds and now and then flicks its tail or twitches an ear. Its legs don't move. Each creature has its own phase (as cues do, `cuePhase`), so a group doesn't blink together.

2. **A blink squashes the eye.** The eye's bone is scaled down along the vertical for a moment, about its attach point. No eye is swapped for another, and no part has a second look to show: a face part is a raised part like any other (ADR 0022, M20 "Face features are small parts"). This is the one scale in the motion: the animation layer may scale a bone, where ADR 0022 §18 gives each part a rigid transform and "Joints, for M22" a rest joint with no scale; the rest pose stays rigid, and the scale is applied to that part's bone alone, never passed down to its children, so the joint chain stays rigid.

3. **Cues pose the parts.** ADR 0018 §15's cues gain a pose: sleeping droops the head, drops the ears, closes the eyes (a held blink) and curls the tail a little; eating dips the head in time with the eating bob the body already shows. The whole-body cue motion stays as it is. Mouths stay still in every cue, and noses have no motion at all. The motion reads the renderer's cue weights (0 to 1, eased), so a pose fades in and out with its cue, and never action or need IDs.

4. **Legs follow the gait.** Walking, a creature with four legs moves them in diagonal pairs (a trot: front left with back right), one with two legs alternates them, and one with six or more alternates them in an X: each leg moves with the legs diagonal to it and against its neighbours. An odd count (one, three or five legs, as Mirror off in the Studio can make) falls back to the same X-order alternation. Every limb whose part type's motion is `swing` joins the gait cycle, arms as well as legs: on an upright creature the arms swing against the legs, the left arm with the right leg. Hopping, all legs move together: tucked in the air, stretched at take-off and landing. Swimming, legs and fins paddle slowly. In a bank leap (ADR 0020, #132, #162) the legs tuck. The gait is the snapshot's animation profile (ADR 0020 §8), read by name.

5. **The whole body moves with its legs.** On voxel bodies the walk profile's roll and squash are damped, since the legs now carry the motion, and its bob is locked to the leg cycle: one bob per step. The swim profile's yaw and the hop's arc are unchanged. Drawn bodies keep their profiles as they are until they go (ADR 0022 §22).

6. **Start values, then the owner's eye.** Motion starts from fixed values: a leg's swing capped at about 35°, a cadence within a fixed range, the other motions small. They are tuned by the owner from captures at strip size and close up (PR 5). The values are the motion module's constants, not content: a pack doesn't set them.

7. **The Studio animates its previews only.** The Studio's test walk (ADR 0023 §13) and the body-plan preview on the confirm step take the parts' motion. Build mode at rest, where parts are placed and picked, and every thumbnail stay in the rest pose, so a socket marker or a ghost never sits on a moving part.

### The motion field

8. **A part type may name a motion.** `PartTypeDefinition` gains an optional `motion`, carried by `PartTypeSummary` in `ready` (protocol version 23). The app builds a motion lookup from it, as it builds `partRoleLookup`, and passes it to the renderer, which has no registries (ADR 0010). The motion is the type's, not the part's: library entries, part definitions and assemblies are unchanged, so a released creature's frozen parts take whatever motion their types have when it is drawn.

9. **Motion names are a closed list.** `content-schema` lists them as it lists `PART_ROLES`: `swing`, `wag`, `bob`, `paddle`, `flop` and `blink`. A pack can give its part types any of them but can't add one, since a motion is code. A part whose type names no motion, or whose type isn't registered (ADR 0022, M19 "Fits are checked at release, structure on load"), has no motion and stays in its rest pose. The engine reads the motion name, never the part type's ID.

### How a motion is applied

10. **Motions are in the body frame, on top of the rest joint.** A motion is a rotation about the part's joint (its attach point), with its axis given in the creature's rest body frame (ADR 0022 §16: +X forward, Y up, +Z right, before any motion), so a leg swings forward and back about Z however its rest rotation turned it. It is applied after the rest joint and carried to the part's children through the joints alone (ADR 0022, "Joints, for M22"). A reflected part (ADR 0022, M19 PR 1, "Mirroring", the parity down the tree) takes its motion mirrored by the same rule as its rest rotation, quaternion `[x, y, z, w]` → `[−x, −y, z, w]`, so a mirror pair moves as mirror images. The two sides alternate through their phase offsets (§11), not through the mirroring. The exact order in which the composer (§16) combines a rest joint, its motion and its parent's motion is fixed by PR 2 and recorded in its "As built" paragraph.

11. **Limbs are placed by where they hang, never by ID.** Which side a limb is on comes from its socket's position in the body frame (the sign of Z, or the mirrored half of a pair when the socket is on the middle plane), and whether it is in front or behind from the socket's X against the centre of gravity (ADR 0022, M19 "Measured anchors"). The order of limbs along X gives the X pattern of §4. This is worked out once per species, never per frame, and gives each limb its phase offset in the gait cycle.

12. **A part's shape scales its motion.** A part's length is the distance from its attach point to its farthest cube corner, in metres, measured once per species. A swing's amplitude comes from the stride and the part's length, so a long leg swings through a smaller angle than a stubby one for the same stride, within the cap of §6. The stride and the creature's cadence come only from its ground-contacting limbs, those whose lowest cube in the rest pose lies at the ground contact (ADR 0022 §21), never from arms and never from IDs; the cadence from the longest of them: long legs step slowly, short ones patter, and every part of a creature keeps that one rhythm. The walk profile may take an optional stride, so the body's bob and the legs' steps stay in step (§5); without one it keeps today's stride from the body's height.

13. **Feet may lift off the ground.** A swinging leg turns about its hip, so its foot rises and sinks a little through the stride. With the small amplitudes of §6 this is accepted. Keeping a foot on the ground (ground locking) is a follow-up, the first job of the IK extension point (§16).

14. **Motion functions are pure.** A motion is a function of the elapsed time, the distance the creature has travelled, its phase and its cue weights, returning a pose and keeping no state. The same inputs give the same pose, so the functions are tested in Vitest with no three.js scene. A paused world advances neither time nor distance, so its creatures hold still.

15. **The frame cost is measured.** The motion and the composer run on the main thread each frame for every voxel creature. Their cost with about 20 creatures of about 15 bones each is measured as `docs/performance.md` describes and recorded below (PR 3's "As built"), as M19 recorded the mesher's.

### Keeping IK possible

16. **IK has a slot; it isn't built.** Procedural animation with inverse kinematics (feet that find the ground, a head that looks at something) is a planned extension, so M22's pipeline leaves room for it without building any of it:
    - **Motion functions return local joint rotations,** one per part (plus the blink's scale, §2), not bone matrices. A separate **composer** walks the joint chain from the root, turning each part's rest joint and rotation into its bone matrix (`joint · shape`, ADR 0022, M19 PR 3b).
    - **Between the two is a slot.** The pipeline is motion → (IK) → compose. A later IK pass takes the motion's rotations and overrides or blends them per chain before the composer runs; in M22 the slot passes them through unchanged.
    - **The rig is data, kept per species.** What the motion needs of an assembly, the limb classification (§11), the part lengths (§12), the attach points and the joint chain (each part's parent and rest joint), is computed once per species into one structure that the motion, the composer and a later IK pass all read.
    - **Purity covers the motion layer.** §14 binds the motion functions. An IK layer may keep state from frame to frame (where a foot was planted, so it stays locked while the body moves over it).
    - **What IK will need,** none of which M22 provides: the ground's height under each foot; chains at least two parts deep (a leg of an upper and a lower part, so a knee can bend; today's limbs are one part); and each foot's contact phases (when it is planted, when it swings) from the gait cycle, which §4 and §11 define.

## Departures

- **ADR 0022 §18 and "Joints, for M22":** each part's transform and rest joint stay rigid, but the animation layer may scale one bone, the eye's, for a blink (§2).
- **ADR 0020 §8:** per-part motion is layered on the whole-body profiles rather than replacing them, and on voxel bodies the walk profile's roll and squash are damped and its bob locked to the legs (§5).
- **ADR 0023 §13:** the Studio's test walk takes the parts' motion as well as the whole-body profiles (§7).

## Exit

M22 is done when:

- every starter part type that has a motion animates in the strip, and two different leg parts visibly move differently (§12);
- legs follow each gait as §4 says, and the cues pose the parts as §3 says;
- the Studio's test walk and body-plan preview animate, and Build mode and thumbnails stay at rest (§7);
- the frame cost is measured and recorded (§15);
- the owner has reviewed the tuned motion from captures at strip size and close up (§6);
- `pnpm check` passes, and `pnpm soak:quick` on PR 1;
- this ADR records the decisions and every departure from them.

## As built

Each M22 PR adds its own paragraph here, under its own heading, so PRs landing in parallel don't conflict.

### PR 1: Motion field

_Not built yet._

### PR 2: Motion module

_Not built yet._

### PR 3: World wiring

_Not built yet._

### PR 4: Studio

_Not built yet._

### PR 5: Tuning

_Not built yet._

## Consequences

- A creature assembled from any parts moves as one animal, with no motion authored per part or per creature: a pack names a motion per part type, and the shape does the rest.
- The pose is a pure function per frame, so it costs no memory per creature and is the same in the strip and the Studio.
- Feet may slide or float a little until ground locking lands (§13).
- Deferred: ground locking and IK (§16), limbs of several parts, per-part motion styles (stiff, floppy, bouncy), and motion for mouths and noses.

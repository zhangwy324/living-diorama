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

Built in #243. Motion names are a closed enum, `PART_MOTIONS` / `PartMotion` in `content-schema` (`definitions.ts`), beside `PART_ROLES`: `swing`, `wag`, `bob`, `paddle`, `flop`, `blink`. `PartTypeDefinition.motion` is optional, with no default. Left out, it stays out of the parsed definition and the summary, and the part doesn't move. An unknown name is refused at `motion` ("Unknown part motion (expected …)"). The field changes the part-type format, so `SCHEMA_VERSIONS.partType` is 2, with no migration. The built-in types: leg and arm `swing`, tail and tail fin `wag`, head `bob`, ear `flop`, eye `blink`, fin `paddle`. Torso, nose and mouth have none. The tail fin takes `wag`, not `paddle`, because a fish's tail fin sweeps side to side about its base, as a tail does. `paddle` is the side fins' slower stroke. `PartTypeSummary` gains `motion?: PartMotion`, filled by `describeVoxelParts` only when the type has one (protocol version 23). Library entries are unchanged. The app's `partMotionLookup(partTypes)` in `apps/desktop/src/part-types.ts`, beside `partRoleLookup`, gives a type's motion, and none for a type the summary doesn't list. It isn't injected into the renderer yet. The Studio's test fixture of built-in parts is now built with `describeVoxelParts`, so it carries motions too.

### PR 2: Motion module

In `packages/renderer/src/voxel/`: `motion-rig.ts`, `part-motion.ts` and `compose-pose.ts`, tested in `part-motion.test.ts`. Not wired in yet (PR 3).

- **Pipeline (§16).** `buildMotionRig(body, motionOf)` builds the rig once per species. `motionOf` gives a part's motion by its instance index. `writeMotion(rig, input, pose)` fills a `MotionPose` allocated once per creature (`createMotionPose`): per part a quaternion (`rotations`, four numbers per part) and a vertical `squash`. A later IK pass goes between the two steps and may override or blend `pose.rotations` per chain. Chains are the `RigPart.parent` links and the pivots are `RigPart.origin`. `composePose(rig, pose, bones)` writes the bone matrices and leaves each part's turn from rest in `pose.turns`. The frame path allocates nothing.
- **Composition order (§10).**
  - A part's turn is `D_i = D_parent · T(o_i) · R_i · T(−o_i)`, where `o_i` is its attach point in the rest body frame and `R_i` is its motion's rotation. The root's parent turn is the identity, and parents are composed first.
  - Its bone is `D_i · joint_i · shape_i`, which is `D_i · rest bone_i`. While blinking it is `D_i · joint_i · S_i · shape_i`. `S_i` scales along the body's vertical, expressed in the joint's frame, about the attach point (§2).
  - Children inherit `D` alone, never `S`.
  - Axes: +Z swings a part forward, +Y turns its top to the left, +X tilts its top towards +Z.
  - A part drawn reflected (`VoxelBody.mirrored`, the parity down the tree) takes `[x, y, z, w]` → `[−x, −y, z, w]`.
- **Limbs (§4, §11, §12).**
  - All `swing` parts join the gait.
  - Every part's side (`RigPart.side`) comes from its attach point's Z against the root part's middle plane, the middle of the root's cubes, not the body bounds' middle, which an asymmetric creature moves. A point within 1e-6 m of that plane counts as right when the part is drawn reflected (the mirrored half of a pair), else as left. Front or back comes from X against the centre of gravity.
  - A limb is grounded when its lowest rest cube is within `VOXEL_UNIT` (half the finest cube, more than any shrink lifts it) of the ground contact, y = 0.
  - Grounded limbs are taken front to back, then top to bottom, then by index. They alternate per side, and the right side starts half a cycle later. This gives: two legs alternate, four trot in diagonal pairs, six walk in tripods, and odd counts alternate in X order.
  - A limb off the ground swings against the frontmost grounded limb on its side, so with the opposite leg. A side with no grounded limb falls back to X order.
- **Stride and amplitude (§6, §12).**
  - The stride, in metres per full cycle (two footfalls of a trot), is `STRIDE_PER_LEG` (1.5) × the longest grounded limb. It falls back to the longest limb, then to half the body's height. It is clamped to `STRIDE_RANGE` (0.06–0.6 m).
  - A limb's walk swing is `asin(¼ stride ÷ its length)`, capped at `MAX_SWING` (35°). The longest leg swings about 22°, and shorter limbs swing further, so every foot sweeps a quarter stride.
  - The walk profile's cycle is metres per step, so PR 3 passes it `stride / 2`.
- **Motions.** Gait motion is weighted by `ease(speed / FULL_MOTION_SPEED)`, so limbs are still at rest. Cue weights are eased as `bodyMotion` eases them. The start values are named constants.
  - `swing`:
    - Walk: a sine at the limb's offset.
    - Swim: a slow paddle, 0.35 rad, one stroke per two strides.
    - Hop: all limbs together, timed by `locomotion.ts`'s `hopProgress` with the height the body's profile is given (`MotionInput.height`), so the legs keep to the body's hop even when a preview scales it. They reach out 0.3 rad at landing and take-off and tuck 0.5 rad mid-air.
    - Bank leap: replaces the gait and tucks 0.55 rad.
  - `wag`:
    - A flick, twice side to side, about every 7 s.
    - A 0.25 rad wag with the walk or swim.
    - Curled 0.45 rad about Y asleep.
  - `bob`:
    - A 0.06 rad nod on each footfall.
    - A 0.35 rad dip with each peck, using `cues.ts`'s `eatingPeck`, the same bob as `bodyMotion`.
    - A 0.3 rad droop asleep.
  - `flop`:
    - A 0.3 rad twitch outward about every 5.5 s. Outward is taken from the ear's side, not from its parity, so an unpaired ear on either side twitches away from the middle.
    - A bounce with the walk and a trail in a hop.
    - Dropped back 0.5 rad and out 0.25 rad asleep.
  - `blink`: about every 4 s for 0.16 s, squashed to 0.15. Shut asleep.
  - `paddle` (fins): scull only in water, 0.35 rad over 1.6 s, at 40% at rest.
- **Purity (§1, §14).** Idle events come from a hash of the period's index and the creature's phase, with a stream per motion, at a jittered point within the first 60% of each period. Nothing reads a clock or a random number. A motion that is unknown or absent leaves the part at identity, and so does the root, which the whole-body profiles move.
- **Motion names.** `MotionName` is a local union in `motion-rig.ts` mirroring the content-schema enum until PR 1 lands. PR 3 swaps it for `PartMotion`.
- **Cost (§15).** Headless under Node, `pnpm tsx packages/renderer/src/voxel/part-motion.timing.ts` gives about 22–25 µs per frame (median) for 20 creatures of 15 bones. That covers motion and composing, on the reference machine. PR 3 measures the in-app cost.

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

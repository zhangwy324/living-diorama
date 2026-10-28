# ADR 0017: Hollow bodies and the fill tool

- **Status:** Accepted
- **Date:** 2026-10-28
- **Context:** Roadmap M13 (code issue #58). Bodies (ADR 0011) fill every hole in a drawing, so a drawn ring becomes a disc and a player can't leave a gap open. The Studio has no way to make an area solid except colouring it in stroke by stroke. M13 makes undrawn areas holes in the body and adds a fill (paint bucket) tool. The decisions were settled after prototyping: renders of the six Studio fixtures and the mossling with every hole kept, three wall shapes, two wall colourings, anti-aliased against hard-edged strokes, a fill inside a ring, and a survey of how painting apps design their fill tools. M13 ships as PRs in this order: **0** no spikes on stroke edges (issue #59); **1** hollow bodies (issue #72, this ADR); **2** the image as the source of truth (issue #73); **3** the fill tool (issue #58); **4** a thickness setting (issue #74). Decisions for all of them are recorded here. PR 1 implements §1–§6; the others are decided here and implemented in their own PRs, each of which updates this ADR if it has to deviate.

This ADR amends ADR 0011 §2, §4 and §5 and its consequences, ADR 0014, and ADR 0015 §7, §9 and §11 (see _Amendments_).

## Decisions

### Hollow bodies (PR 1)

1. **Every undrawn area is a hole, whatever its size.** An enclosed area that isn't part of the drawing goes through the body. That includes gaps nobody meant: slivers left when colouring in up to an outline, the two gaps under the mossling's hairs, and pinholes of a pixel or two in the anti-aliased edge of a stroke. The body shows the drawing as it is. There is no minimum hole size and nothing closes gaps: the prototype's proposals of a minimum size (about 5% of the height) and of closing gaps of 2 px were both rejected. The fill tool (§9) is how a player makes an area solid.
   - **What is solid:** opaque pixels (alpha ≥ 128) grouped into 4-connected shapes, specks (under 0.5% of the opaque area) left out, as before. A speck inside a hole is part of the hole.
   - **What is a hole:** an area of pixels that aren't solid, 8-connected (the dual of 4-connected shapes), that doesn't reach the image's edge. An area that reaches the outside only through a diagonal gap between two pixels isn't enclosed. Each hole belongs to the shape around it, and its boundary is traced along pixel edges like a shape's.
   - **A shape inside a hole stays its own slab,** like any shape that isn't joined to the rest.
   - **One definition for the body and the hints.** `solidShapes` in `outline.ts` says what is solid; the body builder and the Studio's hints check (`checkBody`) both read the drawing through it, so they can't disagree. The hints see the real shapes: the thin wall of a ring is a thin part, and a shape inside a hole is loose ("Parts aren't joined").

2. **Straight walls, no rounded edge.** The walls run straight from the front face to the back, through the full thickness, which stays 40% of the drawn height. The silhouette is exactly the traced drawing. The old rounded edge (4% of the height, growing outward) crossed itself in any gap or notch narrower than about twice its width, giving spikes and folded slivers in the prototype, which every honest narrow gap would trigger. Straight walls can't cross each other. The walls have plain flat normals; smoothed shading, which hides the banding of a traced outline and softens the corner without changing the shape, is deferred (#70).

3. **The walls take the rim's own colour.** Each point of a wall takes the colour of the drawn pixel nearest it, by Euclidean distance. Only pixels at least half opaque count, read un-premultiplied (canvas `ImageData` holds them so), so the faint soft edge of a stroke never seeds a colour and the walls don't speckle. There is no blur and no outline detection. A dark outline makes dark walls, which is accepted: the 3D body follows the drawing rather than guessing what the player meant. On the fixtures, at least 98% of the pixels the walls read are one of the drawing's own colours; the rest are seams of a pixel or two where two colours meet.
   - This replaces the side texture of issue #40 (ADR 0011 §5), which measured the outline and left it off the sides. That technique, and a middle way that carries the rim's colour only a few pixels onto the wall, are kept for later as issue #71.
   - Faces and walls now read the same texture: each pixel that isn't drawn takes the colour of the nearest drawn pixel. A body has one texture and one material instead of two.

4. **Simplified loops must not cross.** Each traced loop is simplified (Ramer–Douglas–Peucker) at 1 px as before. Where a wall is only a pixel or two thick, the outer loop and a hole's loop are each simplified on their own and can end up crossing, which breaks the body into slivers; a prototype showed this on a thin ring. So after simplifying, the loops are checked against themselves and each other (crossing, overlapping, or a corner landing on another loop's side; sharing a corner is allowed, as traced loops do at a diagonal). A loop that crosses is simplified again at 0.5 px, and then not at all: loops traced along pixel edges never cross. Only the loops involved get finer, so a drawing keeps its low triangle count elsewhere. A hole that simplifying would shrink below three corners (a one-pixel pinhole) is kept as traced, so §1 holds for the smallest holes too.

5. **The back stays the front, mirrored,** which reads as the creature facing the other way (ADR 0011 §5 unchanged).

6. **The mossling goes through the same pipeline.** It isn't special-cased: its two gaps under the hairs become holes, along with a few pinholes. A 256 px rendering of its SVG is a test fixture (`packages/renderer/src/body/fixtures/mossling.png`). The README has no screenshots yet (they are TODO comments from the v0.2 round), so there are none to redo; the screenshots of the mossling should show the hollow body when they are taken.

### The drawing (PR 2)

7. **The image is the source of truth.** This reverses ADR 0014's rule that the strokes are the source of truth and the image is derived from them. The drawing is the 256 px image the player sees. The Studio paints strokes, and later fills, into a bitmap; undo and redo keep bitmap snapshots (about 256 KB a step). The library keeps the image and, next to it, the history of strokes and fills in order, as a record that is never replayed to make the image.
   - **Why:** a fill or a recolour is exact on pixels, but replaying it over strokes breaks as soon as stroke rendering changes (#59 is such a change): changed anti-aliasing can open a gap, and an old fill floods the canvas. Part detection for procedural animation or attributes will most likely work on the image (shape analysis, a vision model, or the player marking parts), because strokes don't map to parts once a player goes back and forth between them.
   - **The history** costs a few kilobytes. If it proves useless it can be dropped without breaking anything.
   - **No backward compatibility.** Library files may change freely and need no migration (the migration mechanism of ADR 0014 §6 isn't needed for this). Existing entries already hold their image.

8. **Strokes keep the canvas's native anti-aliasing.** Hard-edged strokes (each stroke thresholded at 50% alpha) were compared. They make an exact fill clean, but every curve shows pixel steps at the Studio's size, where one canvas pixel is about 2.3 screen pixels, which works against #59. The fill handles soft edges itself (§9).

### The fill tool (PR 3)

9. **A paint bucket, designed after what painting apps converge on** (Krita, Clip Studio, GIMP and Kleki; MS Paint and Aseprite for exact matching):
   - **The area** is a 4-connected scanline flood fill over the pixels exactly matching the clicked one: on the background, every fully transparent pixel (alpha 0), so any visible pixel is a wall; on a colour, the exact RGBA. No tolerance and no gap closing.
   - **No halo.** On the background, the area then grows into the strokes' soft edge by up to 2 px, stepping only to pixels no less opaque and stopping at fully opaque ones, and is painted **under** the drawing (`destination-over`). The soft edges blend into the fill rather than leaving a pale fringe, and a faint spot in a line holds the fill and becomes solid, so the body agrees with what the player saw.
   - **Recolouring.** Clicking a coloured area replaces that connected colour. There is no "under" there, so a seam of a pixel of the old blended colour stays: the known cost of zero tolerance.
   - **Open areas fill too.** A fill leaks only through truly empty pixels and fills everything connected up to the canvas's edge. Undo puts it right. (The prototype's proposal to refuse open areas was rejected.)
   - **Later, if needed:** one tolerance slider defaulting to 0; gap closing would be a second, opt-in one.
   - **The toolbar** gets its own button, with an icon clearly different from the eraser's, which players took for a bucket.
   - **History and preview.** A fill is one undo step and is recorded in the history (§7). The preview rebuilds after a fill as after a stroke, so filling a gap closes that hole in the body.

### Thickness (PR 4)

10. **One thickness setting per creature** in the Studio, beside the size, defaulting to today's 40% of the height (the same rule as now). It is saved in the species and shown in the preview at once. Thickness varying with local width (thin limbs thinner) comes later, with part detection.

### Order

11. **Spikes on stroke edges (#59) are fixed first,** before any other M13 PR. Once the image is the source of truth, a later fix to stroke rendering can't smooth drawings already saved. The spikes are unnatural points on a stroke's edge, most likely from the pressure derived from mouse speed (ADR 0015 §11), not pixel steps or anti-aliasing. The stepped edge on the 3D walls is a different thing: it comes from tracing the outline from pixels.

### Deferred

12. **Out of M13:** smoothed wall shading (#70), walls without the outline's colour (#71), thickness from local width, smoothing the traced outline (the stepped walls), fill tolerance and gap closing, and editing a released creature. Whether M13 ships as a release is decided later.

## Amendments

- **ADR 0011 §2:** holes are no longer filled; every enclosed undrawn area is a hole (§1), and a shape inside a hole is kept.
- **ADR 0011 §4:** no rounded edge; straight walls through the full 40% (§2). The fallback block keeps its rounded edge.
- **ADR 0011 §5:** one texture for faces and walls; the walls take the rim's colour (§3), replacing the #40 side texture.
- **ADR 0011, Consequences:** "holes are filled" and "the silhouette is slightly larger than the drawing" no longer hold; "the sides show the drawing's edge, without its outline" is replaced by §3.
- **ADR 0014:** the image becomes the source of truth and the strokes a record (§7), with no backward compatibility, in PR 2.
- **ADR 0015 §7:** the hints check runs on the real shapes with holes (§1). **§9 and §11:** the editor paints into a bitmap with snapshot undo instead of replaying strokes (§7), in PR 2.

## Consequences

- A drawn ring becomes a ring. Gaps a player didn't mean show as slits through the body, including anti-aliasing pinholes of a pixel or two (visible as specks of light at close range). The fill tool (§9) is the answer, not a size threshold.
- The hints change with the bodies: a ring with a thin wall is flagged as thin, and a shape inside a hole is flagged as loose.
- Straight walls show the traced staircase of the outline along every wall, more plainly where §4 had to keep a loop as traced. Smoothing it is deferred.
- Bodies are cheaper. Measured in PR 1 (Chromium, median of 7 builds), compared with the rounded edge: the mossling has 658 triangles instead of 1308 and builds in 7.2 ms instead of 13.7 ms; the six fixtures have 176–668 triangles instead of 716–1320 and build in 7–8 ms instead of 11–13 ms. Tracing with holes and the crossing check take about 5 ms of that. A body has one 256 px texture instead of two.
- The mossling's walls are dark olive, its outline's colour, rather than green.

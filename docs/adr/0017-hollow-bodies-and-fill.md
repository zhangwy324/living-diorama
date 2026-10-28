# ADR 0017: Hollow bodies and the fill tool

- **Status:** Accepted
- **Date:** 2026-10-28
- **Context:** Roadmap M13 (issue #58). Bodies (ADR 0011) fill in every hole of a drawing, so a ring turns into a disc and there is no way to leave an opening in a creature. Nor can a player make a region solid other than by scribbling over it. M13 turns undrawn regions into openings through the body and gives the Studio a paint bucket. The choices below were made after prototypes: the six Studio fixtures and the mossling rendered with all their openings, three ways of building the walls, two ways of colouring them, soft against hard-edged strokes, a bucket fill inside a ring, and a look at the fill tools of common painting programs. M13 lands as a series of PRs: **0** stroke edges without spikes (issue #59); **1** hollow bodies (issue #72, which adds this ADR); **2** the bitmap as the drawing (issue #73); **3** the bucket (issue #58); **4** a thickness control (issue #74). This ADR records the decisions for the whole series. PR 1 builds §1–§7, PR 2 builds §8–§9 and PR 3 builds §10. The rest are settled here and built later; a PR that has to depart from this ADR updates it.

This ADR amends ADR 0011 §2, §4 and §5 and its consequences, ADR 0014, and ADR 0015 §7, §9 and §11 (see _Amendments_).

## Decisions

### Hollow bodies (PR 1)

1. **Anything left undrawn and enclosed is an opening, however small.** It passes right through the body. Accidents count too: thin crescents left between a colour fill and its outline, the two little gaps beneath the mossling's hairs, and one- or two-pixel pinholes along a soft stroke edge. The model is a faithful copy of the picture. No size threshold applies and gaps are never bridged; the prototype suggested both (a threshold near 5% of the height, bridging of 2 px), and both were turned down. To make a region solid, the player fills it (§9).
   - **Solid** means what it meant before: pixels with alpha ≥ 128, joined through their sides into shapes, with specks (under 0.5% of the opaque area) ignored. A speck sitting in an opening is counted as part of the opening.
   - **An opening** is a group of non-solid pixels joined through sides or corners (the counterpart of side-joined shapes) that never touches the image border. If its only route to the outside is a diagonal step between two pixels, it is open, not enclosed. Each opening belongs to the shape that surrounds it, and its edge is followed along pixel boundaries just as a shape's edge is.
   - **A shape lying inside an opening** is a separate slab, the same as any other unconnected piece.
   - **The body and the hints agree by construction.** `solidShapes` in `outline.ts` decides what is solid, and both the body builder and the Studio's `checkBody` call it. The hints therefore see openings: the narrow rim of a ring is reported as thin, and a piece floating inside a ring is reported as not joined.

2. **Plain vertical walls; the bevel is gone.** Each wall goes from the front face to the back face in a single straight step, and the depth stays at 40% of the drawn height. The outline of the body is the traced picture with nothing added. The old bevel (4% of the height, pushed outward) folded over itself wherever an opening or notch was less than roughly two bevels wide, which in the prototype produced spikes and creased slivers, and keeping honest narrow openings would have made that common. Vertical walls cannot intersect. Their normals are the flat face normals; softer shading that rounds off the corner and hides the faceting of the traced edge, with the same geometry, is left for later (#70).

3. **A wall is coloured like the edge of the drawing next to it.** For any point on a wall, the colour is that of the closest drawn pixel in straight-line distance. A pixel counts as drawn when it is at least half opaque, and its colour is taken un-premultiplied (as canvas `ImageData` stores it), so the barely visible fringe of a stroke can never colour a wall and the walls stay free of speckles. Nothing is blurred and no outline is detected. If the drawing has a dark outline, its walls are dark; that is the intended trade, since the body copies the picture instead of guessing intent. Over the fixtures, 98% or more of the pixels the walls sample are colours the drawing was made with, and the remainder are thin blends where two colours touch.
   - This takes the place of the issue #40 side texture (ADR 0011 §5), which found the outline and kept it off the sides. Bringing that back, or a compromise that wraps the edge colour a short way onto the wall, is issue #71.
   - Faces and walls share one texture, in which every undrawn pixel carries the colour of the closest drawn one. Each body therefore has a single texture and material where it had two.

4. **No two simplified loops may intersect.** Loops are still simplified with Ramer–Douglas–Peucker at 1 px. Where only a pixel or two of solid separates an outer edge from an opening, simplifying each loop on its own can make them overlap, and the body then splits into fragments; a thin ring showed this in the prototype. After simplifying, every loop is tested against itself and all the others: proper crossings, overlapping or repeated segments, and a corner lying on another loop's segment all count, while two loops meeting at a shared corner (as pixel-traced loops do across a diagonal) do not. Any loop that fails is redone at 0.5 px, and if it still fails it is used as traced, since loops following pixel boundaries cannot intersect. Only failing loops lose detail, so the rest of the drawing keeps few triangles. A loop that simplifying would reduce to fewer than three corners, such as a single-pixel pinhole or a line one pixel wide, is used as traced instead of being dropped, and the body's bounds come from the loops that are kept.

5. **three's triangulator is checked as well.** On rare noisy shapes, earcut covers an opening of a simplified shape even though no loops intersect (found in 4 of 4000 random blobs). For each shape the body builder triangulates the front face the way `ExtrudeGeometry` will and compares the triangles' total area with the shape's area (outer loop minus openings). If they differ, that shape is built from its loops as traced.

6. **Front and back are unchanged:** the back is the drawing reversed left to right, so the creature reads as facing the other way (ADR 0011 §5 still holds).

7. **The mossling is not a special case.** It is built like any drawing, so the two gaps beneath its hairs become openings, along with a handful of pinholes. A 256 px raster of its SVG is now a test fixture (`packages/renderer/src/body/fixtures/mossling.png`). The README has no screenshots yet, only TODO markers from the v0.2 round, so nothing needs redoing now; when they are taken they should show the hollow body.

### The drawing (PR 2, implemented)

8. **The bitmap is the drawing.** This overturns ADR 0014, where the strokes were authoritative and the picture was produced from them. From PR 2 the drawing is the 256 px raster on the Studio canvas. Strokes, and later fills, are painted straight into that raster. Undo and redo put pixels back: as built, each step keeps only the rectangle of pixels it changed, before and after, within a 32 MB budget, rather than a whole 256 KB copy (ADR 0015 §11 amendment). The library saves the raster and, beside it, an ordered log of the strokes and fills; the log is informational and is never used to rebuild the raster.
   - **Reasons:** bucket fills and recolouring are exact operations on pixels. Replaying them on top of strokes is fragile: any change to how strokes are rasterised (#59 is one) can open a one-pixel leak, and an old fill would then spill across the canvas. Later work that finds a creature's parts, for animation or traits, is expected to look at the picture (through shape analysis, a vision model, or parts the player marks by hand); strokes are a poor guide to parts because players switch between parts while drawing.
   - **The log** adds only kilobytes. Should nothing ever use it, removing it later breaks nothing.
   - **No backward compatibility is owed to old library files.** Every stored entry already contains its picture. As built, the drawing format went to version 2 (`history`, a list of operations told apart by `kind`), and a small migration still reads version 1 drawings, because it cost a few lines (ADR 0014 §5 amendment).

9. **Strokes stay anti-aliased as the canvas draws them.** Thresholding each stroke at 50% alpha was tried: it gives exact fills, but at the Studio's zoom (one canvas pixel is roughly 2.3 screen pixels) curves become visibly stair-stepped, the opposite of what #59 is after. The bucket deals with soft edges on its own terms (§10).

### The fill tool (PR 3, implemented)

10. **A bucket that behaves like the ones in established painting programs** (modelled on Krita, Clip Studio, GIMP and Kleki, with MS Paint and Aseprite as the reference for exact matching):
    - **Region:** a scanline flood through side-joined pixels identical to the one clicked. Clicking the background selects pixels with alpha exactly 0, so anything at all visible stops the flood; clicking a colour selects pixels with exactly that RGBA. There is no tolerance and nothing bridges gaps.
    - **No pale fringe:** after a background fill, the region spreads up to 2 px further into the soft rim of neighbouring strokes, only onto pixels at least as opaque as the one it came from and never onto fully opaque ones, and the colour is composited beneath the existing pixels (`destination-over`). Soft edges then fade into the new colour instead of showing a light ring, and a near-transparent pixel inside a line stops the flood and ends up solid, so what the player sees and the body built from it match.
    - **Recolouring:** clicking an already coloured region swaps it for the current colour. Because nothing lies beneath a colour, a one-pixel band of the previous blend survives at the edge; with zero tolerance that is expected.
    - **Unenclosed regions:** a background fill escapes only through fully transparent pixels and, if it reaches the border, covers everything it can reach. The player can undo it. (The prototype had proposed rejecting such fills; that was not adopted.)
    - **Possible later controls:** a tolerance slider starting at 0, and separately an opt-in gap-bridging setting.
    - **Toolbar:** a dedicated button whose icon cannot be confused with the eraser, which players had mistaken for a bucket.
    - **Undo and preview:** each fill is a single undo step and appears in the log (§8). The 3D preview is rebuilt after a fill exactly as after a stroke, so filling an opening closes it in the body.
    - **As built** (`apps/desktop/src/fill.ts`, a pure function on the RGBA pixels, tested without a canvas):
      - The flood is a span (scanline) fill over a mask. On the background every pixel with alpha 0 matches whatever its RGB, so the eraser's leftovers count as background.
      - The growth into soft edges goes breadth first, 2 steps at most, each step to a side-joined pixel whose alpha is above 0, below 255 and no lower than the pixel it steps from. Fully opaque pixels are never entered: painting under them would change nothing, and they are the wall that stops the growth. It never steps back onto a transparent pixel, so it cannot leak across a faint line one or two pixels thick.
      - Painting under is done on un-premultiplied values: each painted pixel becomes `colour × a + fill × (1 − a)` with alpha 255. Everything a background fill paints therefore ends opaque, so the body sees the filled region as solid.
      - A recolour writes the new colour at alpha 255, also when the clicked area was semi-transparent (a click on a soft edge pixel). Such a click recolours only the few edge pixels of that exact RGBA; this is kept as designed, and the manual checks watch for how often players hit it.
      - A click that would change nothing (on an area already exactly the fill colour) is not recorded, so it adds no undo step; a background click always changes something.
      - The log entry is `{ kind: "fill", x, y, color }`: the clicked pixel in canvas pixels (integers) and the colour. Whether it filled or recoloured follows from the image, so it isn't stored. The drawing format stays at version 2, since adding a kind leaves every older file valid. `paintHistory` (formerly `paintStrokes`), used only for drawings made by code, replays fills as well as strokes.
      - The colour is the palette colour selected for the pen. Picking a swatch keeps the fill tool selected; only the eraser switches back to the pen on a swatch click. The brush sizes are disabled while the fill tool is selected, since a fill has no width. The tools have no single-key shortcuts, so the fill has none either. Over the canvas the cursor is a small bucket outlined in white, whose drop marks the pixel filled.
      - It takes about 1 ms on a 256 px image in Node (inside a ring, and a whole empty canvas).

### Thickness (PR 4)

11. **A per-creature depth control** sits next to the size picker in the Studio. Its default comes from the current rule, 40% of the height. The value is stored with the species and the preview reflects it immediately. Depth that follows local width, so that thin limbs are thinner, waits for part detection. _Built in PR 4 (issue #74):_
    - **Field:** the species definition has an optional `body` object whose `thickness` is the depth as a share of the drawn height, from 0.1 to 0.8, defaulting to 0.4 (`BODY_THICKNESS` in `content-schema`). Grouping it under `body` leaves room for later body settings without crowding the top level. Content that leaves it out, the mossling included, keeps the old depth, so no pack changes and the species schema version stays 1. The library stores the value explicitly with every species it saves.
    - **Range:** 10% makes a flat card that still reads as a solid from the side (the thin-part hint's fin is then about 3 times deeper than wide); 80% makes a deep block, about as deep as most drawings are wide. Beyond that bodies stop looking like their drawing from the side. Values outside are refused, for pack content and library entries alike.
    - **Control:** a native range slider labelled Thickness under the sizes, in whole percent with steps of 5, its value shown beside it and announced as "40% of the height". It goes back to 40% after a release, like the size goes back to Medium.
    - **Preview:** the slider does not rebuild the body. The preview builds it as deep as it is tall and scales it in depth: with straight walls, normals and texture coordinates that don't depend on depth, that is the body a rebuild would make (a test checks it). A rebuild costs about 9–11 ms per fixture in Node, without the texture upload; the scale is a matrix change, so dragging stays smooth.
    - **World:** the worker passes `body` in each species summary (protocol version 5) and the renderer builds each species' body, and its fallback block, at that depth.

### Order

12. **#59 (spiky stroke edges) goes first,** ahead of every other M13 PR. After PR 2, drawings are saved as pixels, so a later change to stroke rendering could no longer clean up drawings already in the library. The defect is sharp points sticking out of a stroke's edge, not pixel stepping or anti-aliasing. It was first blamed on the pressure derived from mouse speed; PR 0 traced it to perfect-freehand's outline and now draws strokes with the canvas's own round-capped `stroke()` (ADR 0015 §9 and §11, as amended there). Done before this PR. The staircase visible on 3D walls is unrelated: it is a product of following the outline pixel by pixel.

### Deferred

13. **Not in M13:** softer wall shading (#70), wall colours that skip the outline (#71), depth varying with local width, smoothing traced outlines to remove the staircase on walls, bucket tolerance and gap bridging, and changing a creature after release. Whether M13 becomes its own release is open.

## Amendments

- **ADR 0011 §2:** openings are kept instead of filled (§1), and shapes inside them are kept too.
- **ADR 0011 §4:** the bevel is removed in favour of straight walls through the full 40% (§2). The grey fallback block still has rounded edges. From PR 4 the depth is the species' own (§11), 40% by default.
- **ADR 0011 §5:** faces and walls use one texture, and walls take the colour of the adjacent edge (§3) instead of the #40 side texture.
- **ADR 0011, Consequences:** "holes are filled" and "the silhouette is slightly larger than the drawing" are no longer true, and the description of the sides is replaced by §3.
- **ADR 0014:** PR 2 makes the raster authoritative and keeps strokes only as a log (§8), drawing format version 2 with a migration from version 1.
- **ADR 0015 §7:** the hints now run on the real shapes, openings included (§1). **§9 and §11:** PR 2 has the editor paint into a raster, with undo by changed-pixel patches instead of replaying strokes, and draws the live stroke a run at a time (§8).

## Consequences

- A ring now produces a ring. Gaps the player did not intend become slits, and anti-aliasing pinholes of a pixel or two become points of light visible up close. The bucket (§10) is the remedy, not a size cut-off.
- The hints track the new bodies: a narrow ring rim is flagged as thin and a piece inside an opening as not joined.
- Plain walls show the pixel staircase of the traced edge everywhere, most plainly on loops that §4 or §5 had to use as traced. Smoothing is deferred.
- Bodies got cheaper to build. Measured in PR 1 in Chromium (median of 7 builds) against the bevelled version: the mossling went from 1308 to 658 triangles and from 13.7 to 7.2 ms; the six fixtures went from 716–1320 to 176–668 triangles and from 11–13 to 7–8 ms. Tracing with openings plus the intersection test accounts for about 5 ms. Each body uses one 256 px texture rather than two.
- The mossling's walls take its dark olive outline colour instead of green.

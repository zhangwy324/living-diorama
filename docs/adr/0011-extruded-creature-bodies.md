# ADR 0011: Extruded creature bodies

- **Status:** Accepted
- **Date:** 2026-10-27
- **Context:** Roadmap M8. Creatures are upright sprites that turn towards the camera and mirror to their heading (ADR 0007 §6). From above or at a steep angle they read as flat cards, and v0.2 has players draw creatures that have to hold up from every angle. M8 replaces the sprite, for every species, with a solid body built from the species' `appearance` image. It ships as three PRs: **A** this ADR, the body pipeline, the fallback block and bodies in the creature layer; **B** real shadows and the shadow blob fix (issue #29); **C** docs and the mossling art. Decisions for all three are recorded here; each PR updates this ADR if it has to deviate.

**Amended by [ADR 0017](0017-hollow-bodies-and-fill.md)** (M13): holes are kept (§2), walls are straight with no rounded edge (§4), and the walls take the rim's own colour instead of the side texture (§5). The notes in those sections say what changed.

This ADR supersedes ADR 0007 §6. ADR 0007 §7 (no minimum on-screen size) still holds.

## Decisions

### The body (PR A)

1. **Read the image as pixels, behind an injectable reader.** An `ImageReader` turns a URL into RGBA pixels. The default decodes the image and draws it into a canvas scaled so its longer side is 256 px (roadmap §2.6 R4), whatever its own size; SVGs rasterize at that size too. Everything after the reader is plain array code, so outline tracing, extrusion and textures run in Vitest without a DOM. The reader replaces the renderer's `ImageLoader` option.

2. **Trace the outline of each opaque shape.** A pixel is opaque at alpha ≥ 128. Opaque pixels are grouped into 4-connected shapes; a shape under 0.5% of the opaque area is a speck and is dropped. Holes in a shape are filled. Each shape's outer boundary is followed along pixel edges and simplified (Ramer–Douglas–Peucker, 1 px tolerance).

   _Amended by [ADR 0017](0017-hollow-bodies-and-fill.md) §1 and §4:_ holes are no longer filled. Every enclosed undrawn area is a hole through the body, whatever its size, and a shape inside a hole is kept as its own slab. Loops that would cross after simplifying are simplified less.

3. **Size from the drawn content, not the image.** The body is trimmed to the bounds of the shapes it keeps: the size class's height is the height of the body, its feet touch the ground, and it is centred on the creature's position across its width. Transparent padding around a drawing no longer makes a creature float or shrink.

4. **Extrude with rounded edges that grow outward.** Each shape becomes its own slab (`THREE.ExtrudeGeometry`), all centred on the same plane. The body is 40% of its height thick, including the rounded edges. The rounded edge is 4% of the height, in 3 segments, and grows outward from the outline: the drawing's outline is the edge of the front and back faces, and the silhouette is that much larger than the drawing. Growing outward can't break on thin strokes, where shrinking the faces to keep the silhouette exact would turn them inside out.

   _Amended by [ADR 0017](0017-hollow-bodies-and-fill.md) §2:_ the bevel is removed. Each wall is a single vertical step between the two faces, the depth stays 40%, and the body's outline is the traced picture; the bevel folded over itself in narrow openings.

5. **One projection, two textures.** Every vertex takes its texture coordinates from its position in the drawing's plane, so front, back, sides and rounded edges all line up with the drawing.

   _Amended by [ADR 0017](0017-hollow-bodies-and-fill.md) §3:_ faces and walls share one texture. A wall is coloured like the closest drawn pixel (alpha at least half), outline included, with no blur. The side texture below and its outline detection were removed (kept for later as issue #71). The back is still the drawing mirrored.
   - The **front and back** use the drawing. Its transparent pixels take the colour of the nearest opaque pixel, so the slight overreach of a simplified outline never shows the background. The back shows the drawing mirrored, which reads as the creature facing the other way.
   - The **sides and rounded edges** use the drawing's colours without its outline (amendment, M12, issue #40). The outline is measured from the drawing rather than assumed:
     - Its colour is the commonest colour of the boundary (opaque pixels at most 2 px deep, depth by Euclidean distance). It counts as an outline if it covers at least half the boundary, differs from the commonest colour of the drawing's core (pixels at least half as deep as the deepest), and is a band no thicker than a third of that deepest depth. Thickness is the 90th percentile depth of the pixels of that colour joined to the boundary, so eyes and other details of the same colour don't count. Colours within an RGB distance of 40 count as one.
     - Every pixel of the outline's colour is dropped, anywhere in the drawing, along with pixels within 2 px of one, which are blended with it. Every other opaque pixel keeps its own colour, so the sides show what is at the drawing's edge: thin limbs and separate shapes keep their own colours, and strokes of the outline's colour inside it (the mossling's hairs) never reach the sides.
     - The remaining colours spread to the rest of the image, each pixel taking the nearest one by Euclidean distance (an exact distance transform), then are blurred (radius 1.5%). A drawing that is all outline keeps its colours as they are.
     - It replaces a fixed band of 3% of the image's longer side and a 4-connected spread, tuned on the mossling alone. The fixed band left thick outlines and the dark start of a stroke on the sides, streaked details just deeper than the band (the reason the mossling's hairs were removed), and gave thin limbs and separate small shapes the colour of the nearest large part. Six drawings made in the Creation Studio are the test fixtures (`packages/renderer/src/body/fixtures/`): with an outline, without one, a thick coloured outline, dark body with details at the edge, thin limbs, separate shapes. Building the textures takes about 14 ms for the mossling, down from about 27 ms.
     - Artistic questions this rule leaves open, such as whether a thick coloured rim is an outline or the creature's skin, belong to epic #61.

6. **Lit, with some of its own colour as emission.** `MeshStandardMaterial` (roughness 0.9, like props), with the texture also as the emissive map at intensity 0.35, so a body in shade keeps the drawing's brightness. Geometry, textures and materials are built once per species and shared by its creatures.

7. **Orientation by heading.** The drawing faces +x in the body's own frame; the body turns about the vertical axis to the creature's heading. The camera-facing turn and the mirroring are gone.

8. **A neutral fallback block.** Until the image has loaded, or if it fails or has no opaque shape, a creature is a grey rounded box at its size class's height, 0.75 of that wide and 0.4 deep, oriented like a body. _No longer true since [ADR 0017](0017-hollow-bodies-and-fill.md) §11: the block is as deep as the species' thickness, 0.4 of its height by default._ When the image arrives every creature of the species switches to the body.

### Shadows (PR B)

9. **Bodies cast real shadows from the sun, and nothing else.** The shadow blob is gone. PR B first kept it as a contact shadow, but with the sun's shadow beside it a creature looked as if it had two shadows. A smaller oval patch under the body, turned with it, was tried and looked worse. Without the blob, no ground probing is needed.

10. **Bodies draw their faces towards the sun into the shadow map** (`shadowSide` front), not three's default of the far side. With the far side, the light ray leaves the body only a centimetre or two above the ground next to the feet and under a low belly. That is within the sun's shadow bias (−0.0005 of a 77 m depth range, about 4 cm) and normal bias (2 cm), so a lit strip showed between the feet and the shadow. Rays cast towards the sun showed that ground is in shadow. Changing either bias alone didn't close the gap, and lowering both would risk shadow acne on terrain and props. With the near side the shadow starts at the feet. Bodies receive no shadows, so they can't shadow themselves this way.

    Issue #29, the blob hidden where two surfaces meet, went away with the blob. PR B had fixed it by probing the ground at five points; the measurement that confirmed the cause is in that PR.

### Docs and checks (PR C)

11. **Docs:** `docs/adding-content.md` explains how to draw an appearance image for a body (facing right, a clear outline, no holes that matter, no hair-thin parts); the renderer README describes bodies.

12. **Mossling art:** the placeholder gets more contrast with the grass, if it stays a small change to the SVG. Done by turning its greens blue-green (body `#3f9470` against grass `#86b45a`). Two dark strokes along the top of its head were removed and the moss dots moved inward: they lay deeper than the outline band, so the top of the body's sides took their colour. The strokes came back in M12 (issue #40): they are the outline's colour, which the measured side rule (§5) drops.

13. **Checks move to the v0.2 build** (roadmap M12), so the release build is checked once rather than twice: screenshots of the mossling in the strip at 180–260 px, in expanded mode and from straight above, and measurements with 3 and with 20 creatures against `docs/performance.md`, together with that milestone's checks of drawn species.

## Consequences

Known limits, for pack authors and the Creation Studio's hints (roadmap M11):

- **Holes are filled.** A doughnut becomes a disc, with the hole's colour on its faces. _No longer true since [ADR 0017](0017-hollow-bodies-and-fill.md): a doughnut is a doughnut, the silhouette is exactly the drawing, and the walls take the edge's colour, outline included._
- **The silhouette is slightly larger than the drawing,** by the rounded edge (about 1–2 px in the strip). Thin strokes get thicker rather than breaking. At sharp inward corners the rounded edge can overlap itself a little.
- **Parts that aren't joined are separate slabs,** floating where they were drawn. Parts touching only at a corner count as separate.
- **The sides show the drawing's edge, without its outline** (§5). A rim of one colour around a different core, up to a third of the shape's depth, counts as an outline even if it was meant as the creature's colour. A detail of another colour right behind the outline shows on the sides there. Where two colours meet at the edge, the sides blend them over a few pixels.
- **Thickness is the same everywhere,** 40% of the height, so a thin limb is as deep as the body. _No longer true since [ADR 0017](0017-hollow-bodies-and-fill.md) §11: each species chooses its thickness, 10% to 80% of the height, 40% by default; it is still the same everywhere on one body._
- Building a body takes about 30 ms per species on the main thread (the mossling, measured in development), once, when its image arrives. Each species costs two 256 px textures.

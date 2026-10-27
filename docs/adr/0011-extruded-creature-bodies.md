# ADR 0011: Extruded creature bodies

- **Status:** Accepted
- **Date:** 2026-10-27
- **Context:** Roadmap M8. Creatures are upright sprites that turn towards the camera and mirror to their heading (ADR 0007 §6). From above or at a steep angle they read as flat cards, and v0.2 has players draw creatures that have to hold up from every angle. M8 replaces the sprite, for every species, with a solid body built from the species' `appearance` image. It ships as three PRs: **A** this ADR, the body pipeline, the fallback block and bodies in the creature layer; **B** real shadows and the shadow blob fix (issue #29); **C** docs, the mossling art, screenshots and performance numbers. Decisions for all three are recorded here; each PR updates this ADR if it has to deviate.

This ADR supersedes ADR 0007 §6. ADR 0007 §7 (no minimum on-screen size) still holds.

## Decisions

### The body (PR A)

1. **Read the image as pixels, behind an injectable reader.** An `ImageReader` turns a URL into RGBA pixels. The default decodes the image and draws it into a canvas scaled so its longer side is 256 px (roadmap §2.6 R4), whatever its own size; SVGs rasterize at that size too. Everything after the reader is plain array code, so outline tracing, extrusion and textures run in Vitest without a DOM. The reader replaces the renderer's `ImageLoader` option.

2. **Trace the outline of each opaque shape.** A pixel is opaque at alpha ≥ 128. Opaque pixels are grouped into 4-connected shapes; a shape under 0.5% of the opaque area is a speck and is dropped. Holes in a shape are filled. Each shape's outer boundary is followed along pixel edges and simplified (Ramer–Douglas–Peucker, 1 px tolerance).

3. **Size from the drawn content, not the image.** The body is trimmed to the bounds of the shapes it keeps: the size class's height is the height of the body, its feet touch the ground, and it is centred on the creature's position across its width. Transparent padding around a drawing no longer makes a creature float or shrink.

4. **Extrude with rounded edges that grow outward.** Each shape becomes its own slab (`THREE.ExtrudeGeometry`), all centred on the same plane. The body is 40% of its height thick, including the rounded edges. The rounded edge is 4% of the height, in 3 segments, and grows outward from the outline: the drawing's outline is the edge of the front and back faces, and the silhouette is that much larger than the drawing. Growing outward can't break on thin strokes, where shrinking the faces to keep the silhouette exact would turn them inside out.

5. **One projection, two textures.** Every vertex takes its texture coordinates from its position in the drawing's plane, so front, back, sides and rounded edges all line up with the drawing.
   - The **front and back** use the drawing. Its transparent pixels take the colour of the nearest opaque pixel, so the slight overreach of a simplified outline never shows the background. The back shows the drawing mirrored, which reads as the creature facing the other way.
   - The **sides and rounded edges** use the drawing's interior colours: the opaque area shrunk by a band of 3% of the image's longer side, which removes a drawn outline, spread outward to fill the rest of the image, then blurred (radius 1.5%). If the band would remove everything, the opaque pixels are used as they are.

6. **Lit, with some of its own colour as emission.** `MeshStandardMaterial` (roughness 0.9, like props), with the texture also as the emissive map at intensity 0.35, so a body in shade keeps the drawing's brightness. Geometry, textures and materials are built once per species and shared by its creatures.

7. **Orientation by heading.** The drawing faces +x in the body's own frame; the body turns about the vertical axis to the creature's heading. The camera-facing turn and the mirroring are gone.

8. **A neutral fallback block.** Until the image has loaded, or if it fails or has no opaque shape, a creature is a grey rounded box at its size class's height, 0.75 of that wide and 0.4 deep, oriented like a body. When the image arrives every creature of the species switches to the body.

### Shadows (PR B)

9. **Bodies cast real shadows** from the sun. The shadow blob stays, as the contact shadow under the feet.

10. **The blob follows creases** (issue #29). The ground is probed at the centre and at four points around the blob's rim. The blob tilts to the average normal of the hits and sits at the highest hit, measured along that normal, so on an even slope it still lies on the surface and its far side no longer sinks under a neighbouring surface at a bridge end or the ramp foot. The cause was confirmed by measurement in the built-in world rather than by eye with the debug overlay. With the single probe, at both bridge ends and the ramp foot up to 44% of the blob lay 2–5 cm under the neighbouring surface, more than its 2 cm lift. With five probes none of it does, at the cost of the blob floating up to about 7–10 cm over the lower surface where it straddles a step or a concave crease.

### Docs and checks (PR C)

11. **Docs:** `docs/adding-content.md` explains how to draw an appearance image for a body (facing right, a clear outline, no holes that matter, no hair-thin parts); the renderer README describes bodies.

12. **Mossling art:** the placeholder gets more contrast with the grass, if it stays a small change to the SVG.

13. **Checks:** screenshots of the mossling in the strip at 180–260 px, in expanded mode and from straight above; `pnpm measure` with 3 and with 20 creatures against `docs/performance.md`.

## Consequences

Known limits, for pack authors and the Creation Studio's hints (roadmap M11):

- **Holes are filled.** A doughnut becomes a disc, with the hole's colour on its faces.
- **The silhouette is slightly larger than the drawing,** by the rounded edge (about 1–2 px in the strip). Thin strokes get thicker rather than breaking. At sharp inward corners the rounded edge can overlap itself a little.
- **Parts that aren't joined are separate slabs,** floating where they were drawn. Parts touching only at a corner count as separate.
- **The side colour band is fixed,** not measured from the drawing's outline: a very thick outline still shows on the sides, and a drawing with no outline loses some edge colour there.
- **Thickness is the same everywhere,** 40% of the height, so a thin limb is as deep as the body.
- Building a body takes about 30 ms per species on the main thread (the mossling, measured in development), once, when its image arrives. Each species costs two 256 px textures.

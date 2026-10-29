# World coordinates

The single coordinate convention shared by content (terrain, regions, structures), the simulation (surfaces, navigation, collision) and the renderer (scene graph, camera). Resolves spec §14 Q5. Constants named here are exported from `@living-diorama/content-schema` (`WORLD_TOLERANCES`, `SIZE_CLASSES`) so code never re-types them.

## Units

- **Length:** 1 unit = 1 metre at miniature scale. Content, simulation and renderer all use metres. Nothing converts.
- **Angles:** radians. Content may not use degrees, except for the `maxWalkableSlopeDeg` constant, which is named in degrees on purpose.
- **Speed:** metres per second of simulation time.

## Axes

Y-up and right-handed, matching Three.js.

| Axis | Positive direction                            |
| ---- | --------------------------------------------- |
| +X   | East (right in the default view)              |
| +Y   | Up                                            |
| +Z   | South (toward the viewer in the default view) |

The default camera sits on the +Z side looking toward −Z, so north (−Z) is "into the screen".

**Heading** is a rotation about +Y. A heading of `θ` faces direction `(sin θ, 0, cos θ)`: `0` faces +Z (south, toward the camera) and `π/2` faces +X (east). This is exactly `Object3D.rotation.y = θ` for a model that faces +Z, which is the glTF convention. Headings are normalised to `[-π, π)`.

Structure and prop transforms use the same yaw convention (`rotationY`) and a uniform `scale`. v1 has no pitch or roll.

## World bounds and origin

- Each world declares its own **bounds** as an axis-aligned box (`bounds.min`, `bounds.max`). Worlds may differ in size and shape. The engine has no hard-coded world size.
- By convention a world is **centred on the origin** in X and Z. Built-in worlds follow this, so the camera can orbit `(0, 0, 0)`.
- `Y = 0` is the world's reference datum. Heights are absolute Y values in metres, not offsets.
- Every authored position (region footprints, portals, spawn points, props, structure transforms) must lie inside the bounds in X and Z. Every height must lie in `[bounds.min.y, bounds.max.y]`.
- Non-rectangular worlds will be expressed later as regions and masks inside a rectangular bounds box, not as a different bounds type.

**v1 default:** the pre-built world (M2) is **64 m (X) × 40 m (Z)**, so `bounds.min = (-32, minY, -20)` and `bounds.max = (32, maxY, 20)`. That is content data, not an engine constant.

## Heightfield grid

The terrain heightfield is a regular grid of height **samples at grid vertices** that covers the world's XZ bounds exactly.

- `columns` samples along X and `rows` samples along Z, spaced `cellSize` metres apart.
- Coverage must match the bounds: `(columns − 1) × cellSize = max.x − min.x` and `(rows − 1) × cellSize = max.z − min.z`. Validation rejects a mismatch.
- Sample `(i, j)` (column `i`, row `j`) sits at `x = min.x + i × cellSize`, `z = min.z + j × cellSize`.
- Storage is row-major, rows from north (`min.z`) to south: `index = j × columns + i`. In an image asset, the top row of pixels is row `j = 0`, so the image reads like a map with north up.
- **Inline** heights are metres. **Asset** heights (16-bit PNG or raw little-endian `uint16`) decode as `y = heightOffset + raw × heightScale`.
- The v1 default grid uses `cellSize = 0.5`, which gives 129 × 81 samples for 64 m × 40 m.

### Sampling

Height between samples uses **triangle interpolation with a fixed diagonal**, never bilinear. That way the simulation's surface is exactly the mesh the renderer draws.

Each cell `(i, j)`–`(i+1, j+1)` splits along the diagonal from `(i, j)` to `(i+1, j+1)`. With local coordinates `fx, fz ∈ [0, 1]` and corner heights `h00 = h(i, j)`, `h10 = h(i+1, j)`, `h01 = h(i, j+1)`, `h11 = h(i+1, j+1)`:

- if `fx ≥ fz`: `y = h00 + fx·(h10 − h00) + fz·(h11 − h10)`
- otherwise: `y = h00 + fz·(h01 − h00) + fx·(h11 − h01)`

The renderer must build its terrain index buffer with the same diagonal. Queries outside the grid clamp to the edge, but a valid position is never outside the bounds.

The **surface normal** at a point is the face normal of the triangle containing it. **Slope** is the angle between that normal and +Y.

### Material zones

Terrain material zones (grass, rock, sand, riverbed, …) use the same grid: one palette index per sample, so the renderer can use vertex colours or a splat map. The palette lives in the terrain definition and gives each zone a name and a colour. The renderer never looks up zones by name.

## Regions and region-relative positions

A **region** is a semantic area with a kind (`land`, `water`, `cave`, `air`), a **surface** and an XZ **footprint** polygon. Footprints may overlap: the bridge deck region sits above the river region. This is what makes positions region-relative.

- A creature's position is **`{ regionId, x, z }`**. The world Y is not stored.
- World Y is resolved as `region.surface.heightAt(x, z)`. It is never a global "terrain height at (x, z)" lookup. Two regions can therefore give different heights at the same `(x, z)`: deck vs river, or cave floor vs ground later.
- Snapshots sent to the renderer carry the resolved world position `(x, y, z)`, so the renderer does no surface lookups.

Surface types are registered in the `surfaces` registry. v1 has three:

| Type               | Parameters                                      | Height                                                                                                                                                                                                                                              |
| ------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core:heightfield` | none (uses the world terrain)                   | Terrain sampling as above.                                                                                                                                                                                                                          |
| `core:deck`        | `centerline` (≥ 2 points, world space), `width` | Project `(x, z)` onto the nearest centerline segment in XZ and interpolate that segment's Y linearly. The deck is flat across its width. Points farther than `width / 2` from the centerline, or beyond its first and last points, are off-surface. |
| `core:flat`        | `y`                                             | `y` everywhere. Used for water levels: a water region stands on its water surface, and the riverbed is ordinary terrain.                                                                                                                            |

A future `cave-floor` surface type plugs in the same way.

Footprint polygons are simple (not self-intersecting). Their winding may be either way: consumers normalise it. Footprints may overlap. Where ground lies below an overlapping water surface it is submerged and unwalkable, so a shoreline comes from the terrain rather than from polygon precision. Walkability rules are in [ADR 0005](adr/0005-world-content-and-walkability.md).

## Connections and portals

A **connection** links two regions through a **portal**: a segment `a`–`b` in XZ, which is where a creature crosses. Portal endpoints are XZ only. Each side's height comes from its own region's surface. A connection is traversable in both directions unless `bidirectional` is false.

## Tolerances

| Constant              | Value   | Meaning                                                                                                                                                             |
| --------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxWalkableSlopeDeg` | 35°     | A surface steeper than this is unwalkable (a cliff) for `core:land`. The engine reads it from the `core:land` capability's locomotion rule.                         |
| `maxStepHeight`       | 0.25 m  | The largest height discontinuity a walker crosses at a portal, e.g. from bank to deck. Across a portal, the two surfaces' heights must differ by no more than this. |
| `maxBankJumpHeight`   | 0.75 m  | The largest height between a land surface and a water surface that a creature that swims and moves on land jumps down or climbs up across a bank, either way.       |
| `maxBankJumpGap`      | 1.75 m  | The widest horizontal gap across a bank, between such a creature's body on land and in the water, edge to edge: centres at most twice its radius plus this apart.   |
| `surfaceEpsilon`      | 0.001 m | Tolerance when checking that a creature's height matches its surface.                                                                                               |
| `positionEpsilon`     | 0.01 m  | Tolerance for "on the portal", "inside the footprint" and "inside the bounds" checks.                                                                               |

## Size classes

Species declare a size class rather than exact dimensions. Navigation uses the radius for clearance around obstacles, and the height for future cave and tunnel clearance.

| Size class | Radius | Height |
| ---------- | ------ | ------ |
| `tiny`     | 0.1 m  | 0.2 m  |
| `small`    | 0.2 m  | 0.4 m  |
| `medium`   | 0.4 m  | 0.8 m  |
| `large`    | 0.8 m  | 1.6 m  |

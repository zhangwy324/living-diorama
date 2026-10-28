# Adding content

How to add props, species and worlds through `extension-api`. The built-in content in [`packages/built-in-content`](../packages/built-in-content/) is the working example: it registers exactly as a third-party pack would. [Architecture](architecture.md#content) explains where registration fits in the app's startup.

## Packs

v1 has no runtime pack loading. A pack is a workspace package, wired into the app at build time:

1. Create `packages/<pack>/` with a `package.json`, a `tsconfig.json` and a `src/index.ts`, like `built-in-content`. Depend on `@living-diorama/content-schema` and `@living-diorama/extension-api`, with a `references` entry for each in `tsconfig.json`.
2. Pick a namespace for every ID in the pack, for example `meadow`. IDs look like `meadow:hedgehog`; `core` is the engine's.
3. Export a function that registers everything and returns each result:

   ```ts
   export function registerMeadow(registries: Registries): Result<unknown>[] {
     return [
       ...assets.map((a) => registries.assets.register(a)),
       ...props.map((p) => registries.props.register(p)),
       registries.species.register(hedgehog),
       registries.worlds.register(meadowWorld),
     ];
   }
   ```

4. Call it from `loadContent()` in [`apps/desktop/src/content.ts`](../apps/desktop/src/content.ts), after `registerBuiltInContent`. Only the simulation worker runs it; the main thread draws what the worker describes ([ADR 0010](adr/0010-content-startup.md)).

`pnpm boundaries` treats every package under `packages/` that isn't an engine package as a content pack, so engine packages can't import yours.

Registration order doesn't matter within the pack: references are resolved once everything is registered. Registering an ID twice is an error, whichever version each has.

Definitions are plain JSON-compatible objects. Keep them in `.json` files (as the built-in pack does) or build them in TypeScript (as the [`river-crossing` fixture](../tools/development/src/fixtures/river-crossing.ts) does). The schemas are in [`packages/content-schema/src`](../packages/content-schema/src/).

## Assets

Every file content refers to (a prop model, a creature drawing) is registered in `assets`. The asset's ID is the reference other content uses:

```ts
registries.assets.register({
  id: "meadow:models/oak.glb",
  version: "1.0.0",
  kind: "model", // or "image"
  url: new URL("./assets/oak.glb", import.meta.url).href,
  scale: 2, // metres per model unit; 1 if omitted
});
```

Write `new URL("…", import.meta.url)` literally, so Vite bundles the file. Models are glTF binaries (`.glb`); images are anything the WebView can load. Check the licence of anything you didn't make and keep it next to the files, as the built-in pack does for Kenney's models.

## Props

A prop is a model placed in a world, such as a tree or a rock. Register its model (above) and a prop type in `props`, then place the type in a world ([ADR 0018](adr/0018-living-behavior.md) §3):

```json
{
  "schemaVersion": 1,
  "id": "meadow:oak",
  "version": "1.0.0",
  "name": "Oak",
  "model": "meadow:models/oak.glb",
  "blockRadius": 0.35,
  "affordances": { "core:shelter": {} }
}
```

- `blockRadius` is where creatures can't walk, in metres at scale 1. A placement blocks `blockRadius × transform.scale`. Use 0 for something they walk through, like grass.
- `affordances` (optional) maps what the prop offers to its parameters, checked against the affordance's params schema when references resolve. The engine registers `core:food` (`{ "eatSeconds": 5 }`: creatures may eat here, for that long) and `core:shelter` (`{}`: creatures may sleep beside it). Leave it out for a prop that offers nothing. Creatures find food and shelter by affordance, so a new food prop needs no engine change.

A placement in the world's `props` names the type and says where it stands:

```json
{
  "id": "oak-1",
  "prop": "meadow:oak",
  "transform": { "position": { "x": 3, "y": 0.4, "z": -2 }, "rotationY": 0.5, "scale": 1.2 }
}
```

- `transform.position` is in world metres; `y` should be the ground height there. `rotationY` uses the heading convention and `scale` is uniform.
- A model that fails to load is drawn as a simple placeholder shape, so a broken file never blanks the scene.

## Species

```json
{
  "schemaVersion": 1,
  "id": "meadow:hedgehog",
  "version": "1.0.0",
  "name": "Hedgehog",
  "appearance": "meadow:sprites/hedgehog.svg",
  "sizeClass": "small",
  "body": { "thickness": 0.3 },
  "capabilities": { "core:walk": 0.8 },
  "baseSpeed": 0.6,
  "behaviors": ["core:wander"],
  "senses": { "core:vision": 8 },
  "traits": { "core:nocturnal": 0 }
}
```

- `appearance` is an image asset the renderer builds a solid body from; see [Drawing an appearance](#drawing-an-appearance).
- `sizeClass` sets the creature's size, and the body's height matches it:

  | Size class | Radius (m) | Height (m) |
  | ---------- | ---------: | ---------: |
  | `tiny`     |        0.1 |        0.2 |
  | `small`    |        0.2 |        0.4 |
  | `medium`   |        0.4 |        0.8 |
  | `large`    |        0.8 |        1.6 |

- `body.thickness` (optional) is how deep the body is from front to back, as a share of its height: from 0.1 to 0.8, 0.4 if left out. The Studio's Thickness slider sets it for drawn creatures.
- `capabilities` maps each capability to a speed factor: the creature moves at `baseSpeed × factor` metres per second. v1 has one locomotion capability, `core:walk` (land and cave regions, slopes up to 35°). A creature only uses connections whose `requiredCapabilities` it has all of ([ADR 0004](adr/0004-capabilities-actions-connections.md)).
- `behaviors` lists what decides the creature's next action. The engine has `core:wander` (rest and walk about) `core:feed` (when hungry, eat at remembered food, or explore to find some; it gives the creature `core:hunger`) and `core:rest` (when tired or at night, sleep beside a remembered shelter, its home if it has one, or where it stands; it gives the creature `core:tiredness`). A behavior is code: an object with `id`, `version`, `dependencies` and an `evaluate` function (`BehaviorProvider` in [`packages/simulation/src/creatures/contracts.ts`](../packages/simulation/src/creatures/contracts.ts)), registered in `behaviors`. See `core:wander` in `wander.ts`.
- `senses` (optional) maps each sense the creature has to its strength. A sense left out is one it lacks. The engine registers `core:vision`, its range in metres (1 to 30).
- `traits` (optional) maps traits to values. A trait left out takes its default. The engine registers `core:nocturnal` (0 sleeps at night, 1 by day; a whole number; default 0) and `core:appetite` (scales how fast hunger rises, 0.5 to 2; default 1).

  Senses and traits are registered in `senses` and `traits` with a `default`, `min` and `max`, and a species value outside that range is an error ([ADR 0018](adr/0018-living-behavior.md) §4). With `integer: true`, the value must also be a whole number. Needs (`core:hunger`, `core:tiredness`) are registered in `needs`. A need's `rateTrait` names the trait that scales its rates (`core:hunger` uses `core:appetite`). A need's or sense's `variation` makes individuals differ: each one's rates or value are scaled once by a factor in [1 − variation, 1 + variation] (0.15 for hunger, tiredness and vision). A creature with `core:vision` notices places offering food or shelter within that many metres, once a second; without it, it learns of a place only on coming within 1 m of it ([ADR 0018](adr/0018-living-behavior.md) §10).

The app spawns the starting creatures listed in [`apps/desktop/src/startup.ts`](../apps/desktop/src/startup.ts). To see a new species, add it there with a count.

### Drawing an appearance

The renderer traces the drawing's outline, with any holes in it, and extrudes it into a slab with straight walls, `body.thickness` of the creature's height thick ([ADR 0011](adr/0011-extruded-creature-bodies.md), [ADR 0017](adr/0017-hollow-bodies-and-fill.md)). The front shows the drawing, the back shows it mirrored, and the walls are coloured like the edge of the drawing beside them.

- **Draw the creature facing right, side on,** with its feet at the bottom. The body turns to the creature's heading, so the drawing is what you see from the side.
- **Use a transparent background.** A pixel counts as part of the body at 50% opacity or more. Padding around the drawing is ignored: the body is sized to what is drawn.
- **The walls take the edge's colour.** A dark outline gives dark walls, and a thin brown arm has brown walls. Where two colours meet at the edge, the wall changes colour there.
- **Undrawn areas are holes.** Every enclosed gap goes right through the body, whatever its size, including slivers left when colouring in up to an outline and pinholes in the anti-aliased edge of a stroke. Colour in fully where the body should be solid.
- **Avoid hair-thin parts.** The image is read at 256 px on its longer side, and a part under a few pixels wide is lost or comes out much thicker than drawn. Whiskers and antennae work better as solid strokes.
- **Parts that don't touch become separate slabs,** floating where they were drawn. Touching only at a corner doesn't count; tiny specks are dropped.

Until the image loads, or if it fails or has nothing opaque, the creature is a grey block.

## Worlds

A world is one definition with its terrain, regions, connections, structures, props and spawn points. The [world coordinate spec](world-coordinates.md) defines the axes, units, heightfield grid and tolerances; read it first. The small [`river-crossing` fixture](../tools/development/src/fixtures/river-crossing.ts) shows every part.

| Field         | What it is                                                                                                                                                                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bounds`      | The world's box in metres. The heightfield must cover exactly its X and Z extent, and every height must lie within its Y range.                                                                                                                                                   |
| `terrain`     | A heightfield (`columns × rows` samples, `cellSize` apart, inline or from a 16-bit PNG or raw asset) and material zones: a colour palette and one palette index per sample.                                                                                                       |
| `regions`     | Areas creatures move in, each with a `kind` (`land`, `water`, `cave`, `air`), a `surface` and an XZ `footprint` polygon. Surfaces: `core:heightfield` follows the terrain, `core:flat` is a level plane (`y`), `core:deck` is a strip along a centerline (`centerline`, `width`). |
| `connections` | How creatures pass between two regions: a `portal` segment both regions touch, the `requiredCapabilities`, an optional extra `cost` and `bidirectional` (default true). Regions can only be entered through portals.                                                              |
| `structures`  | Placements of registered structure types, such as a bridge. A placement brings its own regions and connections, like the bridge deck and its two ends. A structure type is a small definition with `affordances` (`{ "core:crossable": {} }`).                                    |
| `props`       | Placements of registered prop types, as above.                                                                                                                                                                                                                                    |
| `spawnPoints` | Named region positions where creatures appear. At least one.                                                                                                                                                                                                                      |

All local IDs (regions, connections, structures, props, spawn points) share one namespace within the world.

The built-in world isn't written by hand: `pnpm worldgen` generates `world.json` from a layout in [`tools/development/src/worldgen`](../tools/development/src/worldgen/) and writes a debug map to `tools/development/out/woodland-hollow.png`. For anything bigger than a test fixture, a generator is easier than editing heightfield arrays.

The app runs one world, `worldId` in [`apps/desktop/src/startup.ts`](../apps/desktop/src/startup.ts). To see a new world, change it there.

## Checking a pack

The app checks everything at startup and shows any error on its error screen, but a test is quicker. Register as the app does and assert there are no errors:

```ts
const registries = createRegistries();
const results = [...registerCoreEngine(registries), ...registerMeadow(registries)];
const diagnostics = [
  ...results.flatMap((r) => (r.ok ? [] : r.diagnostics)),
  ...resolveReferences(registries).diagnostics,
  ...checkWorld(registries.worlds.get("meadow:meadow")!, registries).diagnostics,
];
expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
```

Diagnostics say what is wrong and where (`error: worlds/meadow:meadow regions[2].footprint[0]: … (code)`). The world checks run per navigation profile (each distinct size class and set of capabilities among the registered species). A creature only goes where it fits, so a size that doesn't fit somewhere is a warning, not an error: a large creature can't cross a narrow bridge and never tries ([ADR 0013](adr/0013-size-limits.md)). If your species should go everywhere, check that it gets no warnings either.

| Code                       | Severity | Meaning                                                                                                           |
| -------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `no_walkable_area`         | warning  | A region has nowhere this profile can stand.                                                                      |
| `disconnected_region`      | warning  | A region's walkable area splits into pieces this profile can't cross between. Pieces of 1 m² or less are ignored. |
| `portal_unusable`          | warning  | A portal has no room for this profile on one side.                                                                |
| `portal_unusable`          | error    | A portal's surfaces don't meet within the step height.                                                            |
| `spawn_not_walkable`       | warning  | A spawn point has no room for this profile.                                                                       |
| `no_spawn_point`           | error    | This profile can't stand on any spawn point, so its creatures can't appear.                                       |
| `ambiguous_overlap`        | error    | Two regions are walkable at the same place and height.                                                            |
| `region_seam`              | warning  | Two regions touch away from any portal, so creatures meet an invisible wall.                                      |
| `unsatisfiable_connection` | warning  | No registered species has every capability a connection requires.                                                 |
| `spawn_unusable`           | warning  | No registered species can move in a spawn point's region.                                                         |

In the running app, the debug overlays (**Show debug overlays** in the strip's controls) show walkability cells, the region graph, portals and each creature's route.

## Versions

Every entry has a semantic `version`, and definitions have a `schemaVersion` for their data format. Code entries (behaviors, actions, surfaces) can declare `dependencies` with semver ranges, which `resolveReferences` checks. The rules for bumping each are in [ADR 0003](adr/0003-content-versioning.md).

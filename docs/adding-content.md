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

Every file content refers to (a prop model, a creature sprite) is registered in `assets`. The asset's ID is the reference other content uses:

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

A prop is not a registry type: it is a model asset placed in a world. Register the model (above), then add a placement to the world's `props`:

```json
{
  "id": "oak-1",
  "model": "meadow:models/oak.glb",
  "transform": { "position": { "x": 3, "y": 0.4, "z": -2 }, "rotationY": 0.5, "scale": 1.2 },
  "blockRadius": 0.4
}
```

- `transform.position` is in world metres; `y` should be the ground height there. `rotationY` uses the heading convention and `scale` is uniform.
- `blockRadius` (world metres, not scaled) is where creatures can't walk. Use 0 for something they walk through, like grass.
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
  "capabilities": { "core:walk": 0.8 },
  "baseSpeed": 0.6,
  "behaviors": ["core:wander"]
}
```

- `appearance` is an image asset drawn as an upright sprite. Draw it facing right with its feet on the bottom edge; the renderer mirrors it when the creature walks left.
- `sizeClass` sets the creature's size, and the sprite's height matches it:

  | Size class | Radius (m) | Height (m) |
  | ---------- | ---------: | ---------: |
  | `tiny`     |        0.1 |        0.2 |
  | `small`    |        0.2 |        0.4 |
  | `medium`   |        0.4 |        0.8 |
  | `large`    |        0.8 |        1.6 |

- `capabilities` maps each capability to a speed factor: the creature moves at `baseSpeed × factor` metres per second. v1 has one locomotion capability, `core:walk` (land and cave regions, slopes up to 35°). A creature only uses connections whose `requiredCapabilities` it has all of ([ADR 0004](adr/0004-capabilities-actions-connections.md)).
- `behaviors` lists what decides the creature's next action. v1 has `core:wander`. A behavior is code: an object with `id`, `version`, `dependencies` and an `evaluate` function (`BehaviorProvider` in [`packages/simulation/src/creatures/contracts.ts`](../packages/simulation/src/creatures/contracts.ts)), registered in `behaviors`. See `core:wander` in `wander.ts`.

The app spawns the starting creatures listed in [`apps/desktop/src/startup.ts`](../apps/desktop/src/startup.ts). To see a new species, add it there with a count.

## Worlds

A world is one definition with its terrain, regions, connections, structures, props and spawn points. The [world coordinate spec](world-coordinates.md) defines the axes, units, heightfield grid and tolerances; read it first. The small [`river-crossing` fixture](../tools/development/src/fixtures/river-crossing.ts) shows every part.

| Field         | What it is                                                                                                                                                                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bounds`      | The world's box in metres. The heightfield must cover exactly its X and Z extent, and every height must lie within its Y range.                                                                                                                                                   |
| `terrain`     | A heightfield (`columns × rows` samples, `cellSize` apart, inline or from a 16-bit PNG or raw asset) and material zones: a colour palette and one palette index per sample.                                                                                                       |
| `regions`     | Areas creatures move in, each with a `kind` (`land`, `water`, `cave`, `air`), a `surface` and an XZ `footprint` polygon. Surfaces: `core:heightfield` follows the terrain, `core:flat` is a level plane (`y`), `core:deck` is a strip along a centerline (`centerline`, `width`). |
| `connections` | How creatures pass between two regions: a `portal` segment both regions touch, the `requiredCapabilities`, an optional extra `cost` and `bidirectional` (default true). Regions can only be entered through portals.                                                              |
| `structures`  | Placements of registered structure types, such as a bridge. A placement brings its own regions and connections, like the bridge deck and its two ends. A structure type is a small definition with `affordances` (`core:crossable`).                                              |
| `props`       | Model placements, as above.                                                                                                                                                                                                                                                       |
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

Diagnostics say what is wrong and where (`error: worlds/meadow:meadow regions[2].footprint[0]: … (code)`). The world checks run per navigation profile (each distinct set of capabilities among the registered species):

| Code                       | Severity | Meaning                                                                                    |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `no_walkable_area`         | warning  | A region has nowhere this profile can stand.                                               |
| `disconnected_region`      | error    | A region's walkable area is split in pieces with no way between them.                      |
| `portal_unusable`          | error    | A connection's portal can't be crossed, for example it has no walkable ground on one side. |
| `spawn_not_walkable`       | error    | A spawn point isn't on walkable ground.                                                    |
| `ambiguous_overlap`        | error    | Two regions are walkable at the same place and height.                                     |
| `region_seam`              | warning  | Two regions touch away from any portal, so creatures meet an invisible wall.               |
| `unsatisfiable_connection` | warning  | No registered species has every capability a connection requires.                          |
| `spawn_unusable`           | warning  | No registered species can move in a spawn point's region.                                  |

In the running app, the debug overlays (**Show debug overlays** in the strip's controls) show walkability cells, the region graph, portals and each creature's route.

## Versions

Every entry has a semantic `version`, and definitions have a `schemaVersion` for their data format. Code entries (behaviors, actions, surfaces) can declare `dependencies` with semver ranges, which `resolveReferences` checks. The rules for bumping each are in [ADR 0003](adr/0003-content-versioning.md).

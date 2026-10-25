import {
  DeckSurfaceParamsSchema,
  HeightfieldSurfaceParamsSchema,
  type Vec2,
} from "@living-diorama/content-schema";
import type { Registries } from "@living-diorama/extension-api";

// A tiny synthetic world: two banks split by a river, joined only by a bridge whose deck region
// sits above the water region (the stacked case from roadmap §1.5). Used by tests and dev tools.

const rect = (x0: number, z0: number, x1: number, z1: number): Vec2[] => [
  { x: x0, z: z0 },
  { x: x1, z: z0 },
  { x: x1, z: z1 },
  { x: x0, z: z1 },
];

const COLUMNS = 9;
const ROWS = 5;
// Row j sits at z = -2 + j. Row 2 (z = 0) is the riverbed.
const rowHeight = (j: number) => (j === 2 ? -0.3 : 0.5);
const heights = Array.from({ length: COLUMNS * ROWS }, (_, k) =>
  rowHeight(Math.floor(k / COLUMNS)),
);
const materials = heights.map((h) => (h < 0 ? 1 : 0));

const walk = ["core:walk"];

export const riverCrossingWorld = {
  schemaVersion: 1,
  id: "fixture:river-crossing",
  version: "1.0.0",
  name: "River crossing (fixture)",
  bounds: { min: { x: -4, y: -1, z: -2 }, max: { x: 4, y: 3, z: 2 } },
  terrain: {
    heightfield: { source: "inline", columns: COLUMNS, rows: ROWS, cellSize: 1, heights },
    materials: {
      palette: [
        { name: "grass", color: "#7fae5a" },
        { name: "riverbed", color: "#8a7a5c" },
      ],
      indices: { source: "inline", values: materials },
    },
  },
  regions: [
    {
      id: "north-bank",
      kind: "land",
      surface: { type: "core:heightfield" },
      footprint: rect(-4, -2, 4, -0.6),
    },
    {
      id: "river",
      kind: "water",
      surface: { type: "core:heightfield" },
      footprint: rect(-4, -0.6, 4, 0.6),
    },
    {
      id: "south-bank",
      kind: "land",
      surface: { type: "core:heightfield" },
      footprint: rect(-4, 0.6, 4, 2),
    },
  ],
  structures: [
    {
      id: "bridge",
      structure: "fixture:plank-bridge",
      transform: { position: { x: 0, y: 0.6, z: 0 }, rotationY: Math.PI / 2 },
      regions: [
        {
          id: "bridge-deck",
          kind: "land",
          surface: {
            type: "core:deck",
            params: {
              centerline: [
                { x: 0, y: 0.5, z: -0.8 },
                { x: 0, y: 0.7, z: 0 },
                { x: 0, y: 0.5, z: 0.8 },
              ],
              width: 0.6,
            },
          },
          footprint: rect(-0.3, -0.8, 0.3, 0.8),
        },
      ],
      connections: [
        {
          id: "bridge-north-end",
          from: "north-bank",
          to: "bridge-deck",
          portal: { a: { x: -0.3, z: -0.8 }, b: { x: 0.3, z: -0.8 } },
          requiredCapabilities: walk,
        },
        {
          id: "bridge-south-end",
          from: "bridge-deck",
          to: "south-bank",
          portal: { a: { x: -0.3, z: 0.8 }, b: { x: 0.3, z: 0.8 } },
          requiredCapabilities: walk,
        },
      ],
    },
  ],
  props: [
    {
      id: "pine-1",
      model: "fixture:models/pine.glb",
      transform: { position: { x: -3, y: 0.5, z: -1.5 } },
      blockRadius: 0.3,
    },
    {
      id: "rock-1",
      model: "fixture:models/rock.glb",
      transform: { position: { x: 2.5, y: 0.5, z: 1.4 }, scale: 0.5 },
      blockRadius: 0.2,
    },
  ],
  spawnPoints: [
    { id: "north-meadow", position: { regionId: "north-bank", x: -2, z: -1.2 } },
    {
      id: "south-meadow",
      position: { regionId: "south-bank", x: 2, z: 1.2 },
      heading: Math.PI / 2,
    },
  ],
};

export const plankBridge = {
  schemaVersion: 1,
  id: "fixture:plank-bridge",
  version: "1.0.0",
  name: "Plank bridge",
  affordances: ["core:crossable"],
};

export const pebble = {
  schemaVersion: 1,
  id: "fixture:pebble",
  version: "0.1.0",
  name: "Pebble",
  appearance: "fixture:sprites/pebble.png",
  sizeClass: "small",
  capabilities: { "core:walk": 1 },
  baseSpeed: 0.6,
  behaviors: ["core:wander"],
};

/** Engine-side entries the fixture depends on. M3 replaces these with the real implementations. */
export function registerEngineStubs(registries: Registries) {
  return [
    registries.surfaces.register({
      id: "core:heightfield",
      version: "1.0.0",
      paramsSchema: HeightfieldSurfaceParamsSchema,
    }),
    registries.surfaces.register({
      id: "core:deck",
      version: "1.0.0",
      paramsSchema: DeckSurfaceParamsSchema,
    }),
    registries.actions.register({ id: "core:idle", version: "1.0.0" }),
    registries.actions.register({ id: "core:follow_path", version: "1.0.0" }),
    registries.behaviors.register({
      id: "core:wander",
      version: "1.0.0",
      dependencies: [
        { registry: "actions", id: "core:idle", version: "^1.0.0" },
        { registry: "actions", id: "core:follow_path", version: "^1.0.0" },
      ],
    }),
  ];
}

/** Registers the fixture content as a pack would. Returns each registration result. */
export function registerRiverCrossing(registries: Registries) {
  return [
    registries.structures.register(plankBridge),
    registries.species.register(pebble),
    registries.worlds.register(riverCrossingWorld),
  ];
}

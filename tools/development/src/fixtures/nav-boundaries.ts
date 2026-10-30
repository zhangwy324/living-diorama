import { SIZE_CLASSES, type Vec2 } from "@living-diorama/content-schema";
import type { Registries } from "@living-diorama/extension-api";

// A tiny synthetic world whose numbers sit exactly on walkability's boundaries, for the navigation
// oracle test (`navigation-build.test.ts`): flat ground at y = 0 under pads whose surfaces lie
// exactly `surfaceEpsilon`, one step and each size class's height above it; water exactly
// `surfaceEpsilon` above the ground and exactly level with it; and per size class a prop exactly
// its block radius plus the class's radius from a cell centre. Only the world model is built from
// it: it doesn't pass `checkWorld` (its pads overlap the ground without portals).

const rect = (x0: number, z0: number, x1: number, z1: number): Vec2[] => [
  { x: x0, z: z0 },
  { x: x1, z: z0 },
  { x: x1, z: z1 },
  { x: x0, z: z1 },
];

const COLUMNS = 25;
const ROWS = 17;
const CELL = 0.5;

const flat = (id: string, kind: "land" | "water", y: number, footprint: Vec2[]) => ({
  id,
  kind,
  surface: { type: "core:flat", params: { y } },
  footprint,
});

const SIZES = Object.entries(SIZE_CLASSES);

export const navBoundariesWorld = {
  schemaVersion: 2,
  id: "fixture:nav-boundaries",
  version: "1.0.0",
  name: "Navigation boundaries (fixture)",
  bounds: { min: { x: -6, y: -1, z: -4 }, max: { x: 6, y: 3, z: 4 } },
  terrain: {
    heightfield: {
      source: "inline",
      columns: COLUMNS,
      rows: ROWS,
      cellSize: CELL,
      heights: new Array<number>(COLUMNS * ROWS).fill(0),
    },
    materials: {
      palette: [{ name: "grass", color: "#7fae5a" }],
      indices: { source: "inline", values: new Array<number>(COLUMNS * ROWS).fill(0) },
    },
  },
  regions: [
    {
      id: "ground",
      kind: "land",
      surface: { type: "core:heightfield" },
      footprint: rect(-6, -4, 6, 4),
    },
    // Corners off the cell grid, so each pad covers whole cells and their corner samples.
    flat("pad-epsilon", "land", 0.001, rect(-5.1, -3.1, -4.4, -2.4)),
    flat("pad-step", "land", 0.25, rect(-3.6, -3.1, -2.4, -2.4)),
    ...SIZES.map(([size, { height }], k) =>
      flat(`pad-${size}-height`, "land", height, rect(-1.6 + 1.5 * k, -3.1, -0.4 + 1.5 * k, -2.4)),
    ),
    flat("water-epsilon", "water", 0.001, rect(-5.1, -1.6, -3.9, -0.4)),
    flat("water-level", "water", 0, rect(-3.1, -1.6, -1.9, -0.4)),
  ],
  connections: [],
  structures: [],
  // Each prop's centre is a cell centre plus (1, 0), and its block radius is 1 minus a size class's
  // radius, so that class's creature is exactly its reach away from that cell's centre.
  props: SIZES.map(([size, { radius }], k) => ({
    id: `post-${size}`,
    prop: "fixture:post",
    transform: { position: { x: -4.75 + 2.5 * k + 1, y: 0, z: 1.75 }, scale: 1 - radius },
  })),
  spawnPoints: [{ id: "middle", position: { regionId: "ground", x: 0, z: 0 } }],
};

export const fixturePost = {
  schemaVersion: 2,
  id: "fixture:post",
  version: "1.0.0",
  name: "Post",
  model: "fixture:models/post.glb",
  blockRadius: 1,
};

/** Registers the boundaries world and its prop as a pack would. */
export function registerNavBoundaries(registries: Registries) {
  return [
    registries.assets.register({
      id: fixturePost.model,
      version: "1.0.0",
      kind: "model",
      url: "-",
    }),
    registries.props.register(fixturePost),
    registries.worlds.register(navBoundariesWorld),
  ];
}

import type { Vec2 } from "@living-diorama/content-schema";
import type { Registries } from "@living-diorama/extension-api";

// A tiny synthetic world for swimming (ADR 0020 §3–§4): a channel of water between two gently
// sloping banks, so a creature that swims and walks can jump between land and water along both.
// The south bank also has an authored one-way shore exit, which banks make optional. The water's
// footprint reaches over both banks, where it is dry. Variants (`pond`) raise either bank to a
// cliff too high to jump, or move the waterline off the cell edges. Used by tests.

const rect = (x0: number, z0: number, x1: number, z1: number): Vec2[] => [
  { x: x0, z: z0 },
  { x: x1, z: z0 },
  { x: x1, z: z1 },
  { x: x0, z: z1 },
];

const COLUMNS = 25;
const ROWS = 17;
const CELL = 0.5;
/** A cliff bank stands this high, more than `maxBankJumpHeight` above the water at y = 0. */
const CLIFF = 1;

export interface PondOptions {
  id?: string;
  /** The water's level; 0 by default, where the waterline falls on cell edges. */
  water?: number;
  /** Banks that rise as a cliff from the waterline instead of sloping gently. */
  cliffs?: readonly ("north" | "south")[];
}

/**
 * The pond world. By default the ground rises 0.2 m per metre away from z = 0 (about 11°) and
 * the water lies at y = 0, so the waterline is at z = ±2. A cliff bank drops from `CLIFF` to the
 * pond floor within half a metre of the waterline. The shore exit is only on a gentle south bank.
 */
export function pond({ id = "fixture:pond", water = 0, cliffs = [] }: PondOptions = {}) {
  const groundAt = (z: number) => {
    const cliff = cliffs.includes(z < 0 ? "north" : "south");
    return cliff && Math.abs(z) >= 2.5 ? CLIFF : 0.2 * Math.abs(z) - 0.4;
  };
  const heights = Array.from({ length: COLUMNS * ROWS }, (_, k) =>
    groundAt(-4 + Math.floor(k / COLUMNS) * CELL),
  );
  return {
    schemaVersion: 2,
    id,
    version: "1.0.0",
    name: "Pond (fixture)",
    bounds: { min: { x: -6, y: -1, z: -4 }, max: { x: 6, y: 2, z: 4 } },
    terrain: {
      heightfield: { source: "inline", columns: COLUMNS, rows: ROWS, cellSize: CELL, heights },
      materials: {
        palette: [
          { name: "grass", color: "#7fae5a" },
          { name: "pondbed", color: "#8a7a5c" },
        ],
        indices: { source: "inline", values: heights.map((h) => (h < 0 ? 1 : 0)) },
      },
    },
    regions: [
      {
        id: "north-bank",
        kind: "land",
        surface: { type: "core:heightfield" },
        footprint: rect(-6, -4, 6, 0),
      },
      {
        id: "pond",
        kind: "water",
        surface: { type: "core:flat", params: { y: water } },
        footprint: rect(-6, -2.5, 6, 2.5),
      },
      {
        id: "south-bank",
        kind: "land",
        surface: { type: "core:heightfield" },
        footprint: rect(-6, 0, 6, 4),
      },
    ],
    connections: cliffs.includes("south")
      ? []
      : [
          {
            // The waterline on the south side lies at z = 2.
            id: "south-shore",
            from: "pond",
            to: "south-bank",
            portal: { a: { x: 1, z: 2 }, b: { x: 4, z: 2 } },
            requiredCapabilities: ["core:swim"],
            bidirectional: false,
          },
        ],
    structures: [],
    props: [],
    spawnPoints: [
      { id: "north", position: { regionId: "north-bank", x: -3, z: -3.2 } },
      { id: "south", position: { regionId: "south-bank", x: 3, z: 3.2 } },
      { id: "middle", position: { regionId: "pond", x: 0, z: 0 } },
    ],
  };
}

export const pondWorld = pond();

const species = (id: string, name: string, capabilities: Record<string, number>) => ({
  schemaVersion: 1,
  id,
  version: "1.0.0",
  name,
  appearance: `${id}.png`,
  sizeClass: "small",
  capabilities,
  baseSpeed: 0.6,
  behaviors: ["core:wander"],
});

/** Walks and swims, at half its walking speed in water; hops on land. */
export const newt = {
  ...species("fixture:newt", "Newt", { "core:land": 1, "core:swim": 0.5 }),
  body: { template: "hopper", locomotion: { land: { gait: "hop" } } },
};
/** Only swims. */
export const minnow = species("fixture:minnow", "Minnow", { "core:swim": 1 });
/** Only walks. */
export const vole = species("fixture:vole", "Vole", { "core:land": 1 });

/** Registers the pond world, or `world`, and its three species as a pack would. */
export function registerPond(registries: Registries, world: object = pondWorld) {
  return [
    ...[newt, minnow, vole].flatMap((s) => [
      registries.assets.register({ id: s.appearance, version: "1.0.0", kind: "image", url: "-" }),
      registries.species.register(s),
    ]),
    registries.worlds.register(world),
  ];
}

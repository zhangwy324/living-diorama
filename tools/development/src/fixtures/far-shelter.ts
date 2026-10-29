import type { Vec2 } from "@living-diorama/content-schema";
import type { Registries } from "@living-diorama/extension-api";

// A tiny synthetic world for a home a creature can't get to (issue #171): a meadow sloping down
// into a pond to the west, a round tree standing in the pond, and another round tree out in the
// meadow to the east, too far to see from where the creature starts. The wader walks well but
// makes no headway in water, so the stuck watchdog stops every trip to the tree in the pond right
// where it lands after jumping in. It hasn't moved from there, so its way out starts with the
// jump back. Used by tests.

const rect = (x0: number, z0: number, x1: number, z1: number): Vec2[] => [
  { x: x0, z: z0 },
  { x: x1, z: z0 },
  { x: x1, z: z1 },
  { x: x0, z: z1 },
];

const X0 = -12;
const X1 = 24;
const Z0 = -6;
const Z1 = 6;
const CELL = 0.5;
const COLUMNS = (X1 - X0) / CELL + 1;
const ROWS = (Z1 - Z0) / CELL + 1;
/** The ground rises 0.2 m per metre eastwards from the pond bed; the waterline is at x = -4. */
const groundAt = (x: number) => Math.min(0.6, Math.max(-0.6, 0.2 * (x + 4)));
const heights = Array.from({ length: COLUMNS * ROWS }, (_, k) =>
  groundAt(X0 + (k % COLUMNS) * CELL),
);

export const farShelterWorld = {
  schemaVersion: 2,
  id: "fixture:far-shelter",
  version: "1.0.0",
  name: "Far shelter (fixture)",
  bounds: { min: { x: X0, y: -1, z: Z0 }, max: { x: X1, y: 3, z: Z1 } },
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
      id: "meadow",
      kind: "land",
      surface: { type: "core:heightfield" },
      footprint: rect(-6, Z0, X1, Z1),
    },
    {
      id: "pond",
      kind: "water",
      surface: { type: "core:flat", params: { y: 0 } },
      footprint: rect(X0, Z0, -2.5, Z1),
    },
  ],
  connections: [],
  structures: [],
  props: [
    {
      // The wader's home: 9 m west of where it starts, out in the pond.
      id: "pond-tree",
      prop: "fixture:round-tree",
      transform: { position: { x: -9, y: groundAt(-9), z: 0 } },
    },
    {
      // 14 m east of where it starts: further than it sees (8 m), within its last search (20 m).
      id: "meadow-tree",
      prop: "fixture:round-tree",
      transform: { position: { x: 14, y: groundAt(14), z: 0 } },
    },
  ],
  spawnPoints: [{ id: "start", position: { regionId: "meadow", x: 0, z: 0 } }],
};

export const fixtureRoundTree = {
  schemaVersion: 1,
  id: "fixture:round-tree",
  version: "1.0.0",
  name: "Round tree",
  model: "fixture:models/round-tree.glb",
  blockRadius: 0.35,
  affordances: { "core:shelter": {} },
};

/**
 * Walks like a mossling. Its swim speed is too small to move it at all (each step rounds away),
 * so in water it stays exactly where it landed: stuck, but never stranded.
 */
export const wader = {
  schemaVersion: 1,
  id: "fixture:wader",
  version: "1.0.0",
  name: "Wader",
  appearance: "fixture:sprites/wader.png",
  sizeClass: "medium",
  capabilities: { "core:land": 1, "core:swim": 1e-20 },
  baseSpeed: 0.6,
  behaviors: ["core:rest"],
  senses: { "core:vision": 8 },
};

/** Registers the far-shelter world, its prop and its species as a pack would. */
export function registerFarShelter(registries: Registries) {
  return [
    registries.assets.register({
      id: wader.appearance,
      version: "1.0.0",
      kind: "image",
      url: "-",
    }),
    registries.assets.register({
      id: fixtureRoundTree.model,
      version: "1.0.0",
      kind: "model",
      url: "-",
    }),
    registries.props.register(fixtureRoundTree),
    registries.species.register(wader),
    registries.worlds.register(farShelterWorld),
  ];
}

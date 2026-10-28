import { builtInDefinitions } from "@living-diorama/built-in-content";
import type { Vec2, Vec3 } from "@living-diorama/content-schema";
import { distanceToPolyline, polylineSegments, Terrain } from "@living-diorama/simulation";
import { createRng, fbm, lerp, mm, smoothstep } from "./noise";

// Generator for the v1 world, Woodland Hollow (roadmap M2). Everything is derived from LAYOUT,
// so tune the world here and regenerate with `pnpm worldgen`; never edit the generated JSON.
//
// Top-down, with the default camera on the south (+Z) side:
// - a river runs from the back-left to the front-right, splitting west woods from the east meadow;
// - a plateau fills the back of the east bank. Its south and west faces are cliffs. A ramp climbs
//   eastward along the south face onto it (the summit region);
// - one wooden bridge crosses the river near the centre, seen side-on from the default view.

export const LAYOUT = {
  seed: 20261025,
  bounds: { min: { x: -32, y: -3, z: -20 }, max: { x: 32, y: 10, z: 20 } },
  cellSize: 0.5,
  meadow: { y: 1.2, noise: 0.25, noiseScale: 9 },
  river: {
    // Control points of a Catmull-Rom centerline; the ends extend past the bounds.
    points: [
      { x: -6, z: -24 },
      { x: -7, z: -14 },
      { x: -4, z: -7 },
      { x: -1, z: -2 },
      { x: -1, z: 4 },
      { x: 2, z: 10 },
      { x: 5, z: 16 },
      { x: 6, z: 24 },
    ],
    waterY: 0.5,
    bedY: -0.2,
    /** Flat riverbed out to this distance from the centerline, then the bank rises. */
    bedHalfWidth: 1.4,
    bankHalfWidth: 3,
    /** The water region is drawn generously; the terrain decides where the shore is. */
    footprintHalfWidth: 4.2,
  },
  plateau: {
    westX: 4,
    southZ: -8.5,
    topY: 5,
    cliffWidth: 1.6,
    noise: 0.35,
    /** How far the cliff lines wander, away from the ramp. */
    wobble: 1.3,
  },
  dome: { x: 21, z: -15, height: 2.5, spread: 40 },
  /** Climbs east along the south face from fromX to riseToX, then runs level onto the plateau. */
  ramp: { fromX: 4, riseToX: 16, toX: 19, southZ: -5, northZ: -10.5, edge: 0.6, portalX: 6.5 },
  groves: [
    { x: -21, z: -8, radius: 12 },
    { x: -26, z: 13, radius: 6 },
    { x: 24, z: 10, radius: 4 },
  ],
  bridge: { z: 1, halfSpan: 4, width: 1.4, rise: 0.55, endLift: 0.02, padRadius: 2.5 },
  spawns: [
    { id: "woods-glade", regionId: "west-woods", x: -15, z: 7, heading: Math.PI / 2 },
    { id: "woods-north", regionId: "west-woods", x: -22, z: -9, heading: 0 },
    { id: "meadow", regionId: "east-meadow", x: 13, z: 6, heading: -Math.PI / 2 },
    { id: "summit-dome", regionId: "summit", x: 22, z: -14, heading: 0 },
  ],
} as const;

const MATERIALS = [
  { name: "grass", color: "#86b45a" },
  { name: "forest-floor", color: "#5f8a43" },
  { name: "highland", color: "#9cbc68" },
  { name: "shore", color: "#d8c48f" },
  { name: "riverbed", color: "#8f7f5e" },
  { name: "rock", color: "#8e8a82" },
  { name: "path", color: "#b8956a" },
] as const;
const MATERIAL = Object.fromEntries(MATERIALS.map((m, i) => [m.name, i])) as Record<
  (typeof MATERIALS)[number]["name"],
  number
>;

const WALK = ["core:walk"];

// ---- River centerline ---------------------------------------------------------------------

function catmullRom(points: readonly Vec2[], stepsPerSegment: number): Vec2[] {
  const out: Vec2[] = [];
  for (let k = 0; k < points.length - 1; k++) {
    const p1 = points[k];
    const p2 = points[k + 1];
    if (!p1 || !p2) continue;
    const p0 = points[k - 1] ?? p1;
    const p3 = points[k + 2] ?? p2;
    for (let s = 0; s < stepsPerSegment; s++) {
      const t = s / stepsPerSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 *
        (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), z: f(p0.z, p1.z, p2.z, p3.z) });
    }
  }
  out.push(...points.slice(-1));
  return out;
}

const riverLine = catmullRom(LAYOUT.river.points, 16);

const riverDistance = (x: number, z: number) => distanceToPolyline(x, z, riverLine);

/** The centerline's x where it crosses `z` (it runs monotonically north to south). */
function riverXAt(z: number): number {
  for (const [a, b] of polylineSegments(riverLine)) {
    if ((a.z - z) * (b.z - z) <= 0) return lerp(a.x, b.x, (z - a.z) / (b.z - a.z || 1));
  }
  throw new Error(`River does not cross z = ${z}`);
}

/** Centerline points inside the bounds, about 1 m apart, ending exactly on the bounds. */
function riverInsideBounds(): Vec2[] {
  const { min, max } = LAYOUT.bounds;
  const inside = riverLine.filter((p, k) => p.z > min.z && p.z < max.z && k % 4 === 0);
  return [{ x: riverXAt(min.z), z: min.z }, ...inside, { x: riverXAt(max.z), z: max.z }];
}

// ---- Bridge -------------------------------------------------------------------------------

const bridgeX = Math.round(riverXAt(LAYOUT.bridge.z) * 2) / 2;
const bridgeEnds = [
  { x: bridgeX - LAYOUT.bridge.halfSpan, z: LAYOUT.bridge.z },
  { x: bridgeX + LAYOUT.bridge.halfSpan, z: LAYOUT.bridge.z },
] as const;

// ---- Heights ------------------------------------------------------------------------------

const { seed } = LAYOUT;

function plateauTop(x: number, z: number): number {
  const { topY, noise } = LAYOUT.plateau;
  const { dome } = LAYOUT;
  const r2 = (x - dome.x) ** 2 + (z - dome.z) ** 2;
  return topY + noise * fbm(seed + 13, x / 7, z / 7) + dome.height * Math.exp(-r2 / dome.spread);
}

/** Mid-cliff line of the plateau's south face. Straight behind the ramp, wandering east of it. */
function southCliffZ(x: number): number {
  const { southZ, wobble } = LAYOUT.plateau;
  const ramp = LAYOUT.ramp;
  return southZ + wobble * smoothstep(ramp.toX, ramp.toX + 4, x) * fbm(seed + 21, x / 5, 0.5);
}

/** Mid-cliff line of the plateau's west face. Straight near the ramp's foot. */
function westCliffX(z: number): number {
  const { westX, southZ, wobble } = LAYOUT.plateau;
  return westX + wobble * smoothstep(southZ - 2, southZ - 5, z) * fbm(seed + 23, z / 5, 0.5);
}

/** Signed distance inside the plateau (positive inside); zero on the mid-cliff lines. */
function plateauDistance(x: number, z: number): number {
  return Math.min(x - westCliffX(z), southCliffZ(x) - z);
}

const rampTopY = plateauTop(LAYOUT.ramp.riseToX, LAYOUT.plateau.southZ - 1);

function heightAt(x: number, z: number): number {
  const { meadow, river, plateau, ramp, bridge } = LAYOUT;
  // Meadow with gentle rolls, flattened into level pads at the bridge ends.
  const rolled = meadow.y + meadow.noise * fbm(seed, x / meadow.noiseScale, z / meadow.noiseScale);
  const pad = Math.max(
    ...bridgeEnds.map(
      (e) => 1 - smoothstep(bridge.padRadius * 0.6, bridge.padRadius, Math.hypot(x - e.x, z - e.z)),
    ),
  );
  const base = lerp(rolled, meadow.y, pad);

  const cliff = smoothstep(-plateau.cliffWidth / 2, plateau.cliffWidth / 2, plateauDistance(x, z));
  const plateauY = lerp(base, plateauTop(x, z), cliff);

  const inRamp = Math.min(ramp.southZ - z, z - ramp.northZ, x - ramp.fromX, ramp.toX - x);
  const rise = Math.max(0, Math.min(1, (x - ramp.fromX) / (ramp.riseToX - ramp.fromX)));
  const rampY = lerp(
    base,
    lerp(meadow.y, rampTopY, rise),
    smoothstep(-ramp.edge / 2, ramp.edge / 2, inRamp),
  );

  const land = Math.max(base, plateauY, rampY);
  const d = riverDistance(x, z);
  const bed = river.bedY + 0.08 * fbm(seed + 7, x / 3, z / 3);
  return d < river.bedHalfWidth
    ? bed
    : lerp(bed, land, smoothstep(river.bedHalfWidth, river.bankHalfWidth, d));
}

// ---- Materials ----------------------------------------------------------------------------

const PATHS: readonly (readonly Vec2[])[] = [
  [{ x: -15, z: 7 }, { x: -9, z: 3.5 }, bridgeEnds[0]],
  [bridgeEnds[1], { x: 3.5, z: -1.5 }, { x: 4.5, z: -6.5 }],
];

const forestWeight = (x: number, z: number) =>
  Math.max(
    ...LAYOUT.groves.map(
      (g) => 1 - smoothstep(g.radius * 0.4, g.radius, Math.hypot(x - g.x, z - g.z)),
    ),
  ) +
  0.45 * fbm(seed + 17, x / 5, z / 5);

function materialAt(x: number, z: number, h: number, slopeDeg: number): number {
  const { river, ramp, plateau } = LAYOUT;
  if (h < river.waterY) return MATERIAL.riverbed;
  if (slopeDeg > 35) return MATERIAL.rock;
  if (h < river.waterY + 0.35 && riverDistance(x, z) < river.bankHalfWidth + 0.5)
    return MATERIAL.shore;
  const onRamp = x > ramp.fromX && x < ramp.toX && z < ramp.southZ && z > ramp.northZ;
  if (onRamp || PATHS.some((p) => distanceToPolyline(x, z, p) < 0.7)) return MATERIAL.path;
  if (plateauDistance(x, z) > plateau.cliffWidth / 2) return MATERIAL.highland;
  if (forestWeight(x, z) > 0.5) return MATERIAL["forest-floor"];
  return MATERIAL.grass;
}

// ---- Props --------------------------------------------------------------------------------

interface PropKind {
  /** The prop type, from the built-in pack (`built-in-content/src/woodland-hollow/props`). */
  prop: string;
  scale: readonly [number, number];
}

const PROP_KINDS = {
  pine: { prop: "hollow:pine", scale: [0.8, 1.3] },
  roundTree: { prop: "hollow:round-tree", scale: [0.8, 1.25] },
  rock: { prop: "hollow:rock", scale: [0.6, 1.4] },
  bush: { prop: "hollow:bush", scale: [0.7, 1.2] },
  mushroom: { prop: "hollow:mushroom", scale: [0.7, 1.3] },
} satisfies Record<string, PropKind>;

/** A prop type's block radius at scale 1, in metres, as its definition declares it. */
function typeRadius(prop: string): number {
  const type = builtInDefinitions.props.find((p) => p.id === prop);
  if (!type) throw new Error(`No built-in prop type "${prop}"`);
  return type.blockRadius;
}

interface PlacedProp {
  id: string;
  prop: string;
  transform: { position: Vec3; rotationY: number; scale: number };
}

function scatterProps(terrain: Terrain): PlacedProp[] {
  const rng = createRng(seed + 101);
  const { bounds, ramp, river } = LAYOUT;
  const placed: PlacedProp[] = [];
  const keepClear: Vec2[] = [
    ...LAYOUT.spawns,
    ...bridgeEnds,
    { x: ramp.portalX, z: (ramp.southZ + LAYOUT.plateau.southZ) / 2 },
  ];
  const counters: Record<string, number> = {};
  // Block radius of each placed prop, rounded as placements stored it before ADR 0018 §3 moved
  // it to the type, so the scatter (and so the world) stays the same.
  const radii: number[] = [];

  const tryPlace = (
    kind: keyof typeof PROP_KINDS,
    count: number,
    zone: (x: number, z: number) => boolean,
    spacing: number,
  ) => {
    const spec: PropKind = PROP_KINDS[kind];
    const radius = typeRadius(spec.prop);
    for (let attempt = 0, n = 0; n < count && attempt < count * 400; attempt++) {
      const x = lerp(bounds.min.x + 1.5, bounds.max.x - 1.5, rng());
      const z = lerp(bounds.min.z + 1.5, bounds.max.z - 1.5, rng());
      const scale = mm(lerp(spec.scale[0], spec.scale[1], rng()));
      const rotationY = mm(lerp(-Math.PI, Math.PI, rng()) * 0.999);
      if (!zone(x, z)) continue;
      if (terrain.heightAt(x, z) < river.waterY + 0.3) continue;
      if ((terrain.slopeAt(x, z) * 180) / Math.PI > 24) continue;
      if (riverDistance(x, z) < river.bankHalfWidth + 0.6) continue;
      if (Math.abs(plateauDistance(x, z)) < 1.6) continue;
      if (x > ramp.fromX - 1 && x < ramp.toX + 1 && z < ramp.southZ + 1 && z > ramp.northZ - 1)
        continue;
      if (PATHS.some((p) => distanceToPolyline(x, z, p) < 1.2)) continue;
      if (keepClear.some((p) => Math.hypot(p.x - x, p.z - z) < 3)) continue;
      const blockRadius = mm(radius * scale);
      // Leave room for a medium creature (0.8 m) plus margin between any two props.
      const crowded = placed.some(
        (p, i) =>
          Math.hypot(p.transform.position.x - x, p.transform.position.z - z) <
          Math.max(spacing, (radii[i] ?? 0) + blockRadius + 1.4),
      );
      if (crowded) continue;
      counters[kind] = (counters[kind] ?? 0) + 1;
      n++;
      placed.push({
        id: `${kind.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}-${counters[kind]}`,
        prop: spec.prop,
        transform: {
          position: { x: mm(x), y: mm(terrain.heightAt(x, z)), z: mm(z) },
          rotationY,
          scale,
        },
      });
      radii.push(blockRadius);
    }
  };

  const forest = (x: number, z: number) => forestWeight(x, z) > 0.5;
  const onPlateau = (x: number, z: number) => plateauDistance(x, z) > 2.5;
  const westBank = (x: number, z: number) => x < riverXAt(Math.max(-20, Math.min(20, z)));
  tryPlace("pine", 34, forest, 2.6);
  tryPlace("roundTree", 8, (x, z) => forest(x, z) || (westBank(x, z) && z > 4), 3.2);
  tryPlace("pine", 12, onPlateau, 3.4);
  tryPlace("roundTree", 7, (x, z) => !westBank(x, z) && plateauDistance(x, z) < -2 && z > -2, 6);
  tryPlace("rock", 8, (x, z) => riverDistance(x, z) < 7, 3);
  tryPlace("rock", 5, (x, z) => x > 20 && z > southCliffZ(x) + 2.5 && z < -3, 2.5);
  tryPlace("rock", 5, onPlateau, 4);
  tryPlace("bush", 16, (x, z) => !onPlateau(x, z), 3);
  tryPlace("mushroom", 18, forest, 1.2);
  return placed;
}

// ---- World --------------------------------------------------------------------------------

const rect = (x0: number, z0: number, x1: number, z1: number): Vec2[] => [
  { x: x0, z: z0 },
  { x: x1, z: z0 },
  { x: x1, z: z1 },
  { x: x0, z: z1 },
];

const point = (p: Vec2): Vec2 => ({ x: mm(p.x), z: mm(p.z) });

/** from, from + 1, …, to (inclusive). */
const range = (from: number, to: number) =>
  Array.from({ length: Math.floor(to - from) + 1 }, (_, k) => from + k);

function riverFootprint(centerline: readonly Vec2[]): Vec2[] {
  const { min, max } = LAYOUT.bounds;
  const w = LAYOUT.river.footprintHalfWidth;
  const side = (sign: number) =>
    centerline.map((p, k) => {
      const prev = centerline[k - 1] ?? p;
      const next = centerline[k + 1] ?? p;
      const length = Math.hypot(next.x - prev.x, next.z - prev.z);
      const nx = (-(next.z - prev.z) / length) * sign * w;
      const nz = ((next.x - prev.x) / length) * sign * w;
      return point({
        x: Math.max(min.x, Math.min(max.x, p.x + nx)),
        z: Math.max(min.z, Math.min(max.z, p.z + nz)),
      });
    });
  return [...side(1), ...side(-1).reverse()];
}

/** Generates the Woodland Hollow world definition (the input form, before defaults). */
export function generateWoodlandHollow() {
  const { bounds, cellSize, river, plateau, ramp, bridge } = LAYOUT;
  const columns = (bounds.max.x - bounds.min.x) / cellSize + 1;
  const rows = (bounds.max.z - bounds.min.z) / cellSize + 1;

  const heights: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      heights.push(mm(heightAt(bounds.min.x + i * cellSize, bounds.min.z + j * cellSize)));
    }
  }
  const terrain = new Terrain(columns, rows, cellSize, bounds.min.x, bounds.min.z, heights);

  const values: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const at = (di: number, dj: number) =>
        terrain.sample(
          Math.max(0, Math.min(columns - 1, i + di)),
          Math.max(0, Math.min(rows - 1, j + dj)),
        );
      const gx = (at(1, 0) - at(-1, 0)) / (2 * cellSize);
      const gz = (at(0, 1) - at(0, -1)) / (2 * cellSize);
      const slopeDeg = (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
      values.push(
        materialAt(bounds.min.x + i * cellSize, bounds.min.z + j * cellSize, at(0, 0), slopeDeg),
      );
    }
  }

  const centerline = riverInsideBounds().map(point);
  const { min, max } = bounds;
  // The summit's edge runs along the ramp's drop and the plateau's mid-cliff lines, so the only
  // walkable way between it and the meadow is the portal across the ramp.
  const southFace = range(ramp.toX, max.x).map((x) => point({ x, z: southCliffZ(x) }));
  const westFace = [
    ...range(min.z, plateau.southZ - 0.5).map((z) => point({ x: westCliffX(z), z })),
    { x: plateau.westX, z: plateau.southZ },
  ];
  const summitEdge = [
    { x: ramp.portalX, z: ramp.southZ },
    { x: ramp.toX, z: ramp.southZ },
    ...southFace,
    { x: max.x, z: min.z },
    ...westFace,
    { x: ramp.portalX, z: plateau.southZ },
  ];

  // The deck ends sit just above the level pads; the middle arches over the water.
  const westY = mm(terrain.heightAt(bridgeEnds[0].x, bridge.z) + bridge.endLift);
  const eastY = mm(terrain.heightAt(bridgeEnds[1].x, bridge.z) + bridge.endLift);
  const midY = mm(Math.max(westY, eastY) + bridge.rise);
  const halfWidth = bridge.width / 2;

  return {
    schemaVersion: 2,
    id: "hollow:woodland-hollow",
    version: "1.0.0",
    name: "Woodland Hollow",
    bounds,
    terrain: {
      heightfield: { source: "inline", columns, rows, cellSize, heights },
      materials: { palette: MATERIALS, indices: { source: "inline", values } },
    },
    regions: [
      {
        id: "west-woods",
        kind: "land",
        surface: { type: "core:heightfield" },
        footprint: [{ x: min.x, z: min.z }, ...centerline, { x: min.x, z: max.z }],
      },
      {
        id: "east-meadow",
        kind: "land",
        surface: { type: "core:heightfield" },
        footprint: [
          ...[...centerline].reverse(),
          ...westFace,
          { x: ramp.portalX, z: plateau.southZ },
          { x: ramp.portalX, z: ramp.southZ },
          { x: ramp.toX, z: ramp.southZ },
          ...southFace,
          { x: max.x, z: max.z },
        ],
      },
      {
        id: "summit",
        kind: "land",
        surface: { type: "core:heightfield" },
        footprint: summitEdge,
      },
      {
        id: "river",
        kind: "water",
        surface: { type: "core:flat", params: { y: river.waterY } },
        footprint: riverFootprint(centerline),
      },
    ],
    connections: [
      {
        id: "summit-ramp",
        from: "east-meadow",
        to: "summit",
        portal: {
          a: { x: ramp.portalX, z: ramp.southZ },
          b: { x: ramp.portalX, z: plateau.southZ },
        },
        requiredCapabilities: WALK,
      },
    ],
    structures: [
      {
        id: "bridge",
        structure: "hollow:wooden-bridge",
        transform: { position: { x: bridgeX, y: midY, z: bridge.z }, rotationY: mm(Math.PI / 2) },
        regions: [
          {
            id: "bridge-deck",
            kind: "land",
            surface: {
              type: "core:deck",
              params: {
                centerline: [
                  { x: bridgeEnds[0].x, y: westY, z: bridge.z },
                  { x: bridgeX, y: midY, z: bridge.z },
                  { x: bridgeEnds[1].x, y: eastY, z: bridge.z },
                ],
                width: bridge.width,
              },
            },
            footprint: rect(
              bridgeEnds[0].x,
              bridge.z - halfWidth,
              bridgeEnds[1].x,
              bridge.z + halfWidth,
            ).map(point),
          },
        ],
        connections: [
          {
            id: "bridge-west-end",
            from: "west-woods",
            to: "bridge-deck",
            portal: {
              a: point({ x: bridgeEnds[0].x, z: bridge.z - halfWidth }),
              b: point({ x: bridgeEnds[0].x, z: bridge.z + halfWidth }),
            },
            requiredCapabilities: WALK,
          },
          {
            id: "bridge-east-end",
            from: "bridge-deck",
            to: "east-meadow",
            portal: {
              a: point({ x: bridgeEnds[1].x, z: bridge.z - halfWidth }),
              b: point({ x: bridgeEnds[1].x, z: bridge.z + halfWidth }),
            },
            requiredCapabilities: WALK,
          },
        ],
      },
    ],
    props: scatterProps(terrain),
    spawnPoints: LAYOUT.spawns.map((s) => ({
      id: s.id,
      position: { regionId: s.regionId, x: s.x, z: s.z },
      heading: mm(s.heading),
    })),
  };
}

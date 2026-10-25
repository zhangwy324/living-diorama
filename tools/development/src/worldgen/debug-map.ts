import type { WorldDefinition } from "@living-diorama/content-schema";
import {
  CellState,
  pointInPolygon,
  polygonEdges,
  type Navigation,
  type WorldModel,
} from "@living-diorama/simulation";
import { deflateSync } from "node:zlib";

// A top-down debug map of a world: shaded terrain colours, water, walkability for one navigation
// profile, region outlines, portals, props and spawn points, plus optional creature trajectories.
// North is up. Written as a PNG.

const PX = 6; // pixels per terrain cell

type Rgb = [number, number, number];

const hex = (color: string): Rgb => [
  parseInt(color.slice(1, 3), 16),
  parseInt(color.slice(3, 5), 16),
  parseInt(color.slice(5, 7), 16),
];

const REGION_COLORS: Rgb[] = [
  [255, 255, 255],
  [255, 214, 64],
  [255, 120, 200],
  [120, 220, 255],
  [255, 150, 60],
];

class Canvas {
  readonly data: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8Array(width * height * 3);
  }
  blend(x: number, y: number, [r, g, b]: Rgb, alpha = 1) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const k = (y * this.width + x) * 3;
    [r, g, b].forEach((c, n) => {
      const old = this.data[k + n] ?? 0;
      this.data[k + n] = old + (c - old) * alpha;
    });
  }
  line(x0: number, y0: number, x1: number, y1: number, color: Rgb, thickness = 1) {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    const r = Math.floor(thickness / 2);
    for (let s = 0; s <= steps; s++) {
      const x = x0 + ((x1 - x0) * s) / steps;
      const y = y0 + ((y1 - y0) * s) / steps;
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) this.blend(x + dx, y + dy, color);
    }
  }
  disc(cx: number, cy: number, radius: number, color: Rgb, alpha = 1) {
    for (let y = Math.floor(cy - radius); y <= cy + radius; y++) {
      for (let x = Math.floor(cx - radius); x <= cx + radius; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= radius * radius) this.blend(x, y, color, alpha);
      }
    }
  }
  png(): Buffer {
    const raw = Buffer.alloc((this.width * 3 + 1) * this.height);
    for (let y = 0; y < this.height; y++) {
      raw[y * (this.width * 3 + 1)] = 0;
      Buffer.from(this.data.buffer, y * this.width * 3, this.width * 3).copy(
        raw,
        y * (this.width * 3 + 1) + 1,
      );
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(this.width, 0);
    header.writeUInt32BE(this.height, 4);
    header.set([8, 2, 0, 0, 0], 8);
    return Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function chunk(type: string, body: Buffer): Buffer {
  const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
  let crc = 0xffffffff;
  for (const byte of typed) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  const out = Buffer.alloc(typed.length + 8);
  out.writeUInt32BE(body.length, 0);
  typed.copy(out, 4);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, typed.length + 4);
  return out;
}

const TRAJECTORY_COLORS: Rgb[] = [
  [20, 20, 20],
  [0, 90, 255],
  [255, 255, 255],
  [150, 0, 200],
  [0, 170, 120],
];

/** `trajectories` holds one polyline of world positions per creature, drawn over the map. */
export function renderDebugMap(
  world: WorldDefinition,
  model: WorldModel,
  nav: Navigation,
  trajectories: readonly (readonly { x: number; z: number }[])[] = [],
): Buffer {
  const { terrain, bounds } = model;
  const cells = { x: terrain.columns - 1, z: terrain.rows - 1 };
  const canvas = new Canvas(cells.x * PX, cells.z * PX);
  const toPx = (x: number, z: number): [number, number] => [
    ((x - bounds.min.x) / terrain.cellSize) * PX,
    ((z - bounds.min.z) / terrain.cellSize) * PX,
  ];
  const materials = world.terrain.materials;
  const palette = materials.palette.map((m) => hex(m.color));
  const indices = materials.indices.source === "inline" ? materials.indices.values : [];
  const water = [...model.regions.values()].filter((r) => r.kind === "water");

  for (let j = 0; j < cells.z; j++) {
    for (let i = 0; i < cells.x; i++) {
      const x = bounds.min.x + (i + 0.5) * terrain.cellSize;
      const z = bounds.min.z + (j + 0.5) * terrain.cellSize;
      const h = terrain.heightAt(x, z);
      // Hillshade from the north-west plus a height tint.
      const gx = terrain.heightAt(x + 0.25, z) - terrain.heightAt(x - 0.25, z);
      const gz = terrain.heightAt(x, z + 0.25) - terrain.heightAt(x, z - 0.25);
      const shade = Math.max(0.45, Math.min(1.25, 1 - (gx + gz) * 1.2 + h * 0.03));
      const base = palette[indices[j * terrain.columns + i] ?? 0] ?? [255, 0, 255];
      let color: Rgb = base.map((c) => Math.min(255, c * shade)) as Rgb;
      const level = water.find(
        (r) => (r.surface.heightAt(x, z) ?? -Infinity) > h && pointInPolygon(x, z, r.footprint),
      );
      if (level) {
        const depth = Math.min(1, ((level.surface.heightAt(x, z) ?? h) - h) / 0.6);
        const tint: Rgb = [70, 140, 210];
        color = color.map((c, k) => c + ((tint[k] ?? c) - c) * (0.55 + 0.35 * depth)) as Rgb;
      }
      let blocked = false;
      for (const mask of nav.masks.values()) {
        const cell = mask.cellAt(x, z);
        if (cell === -1 || mask.region.kind === "water") continue;
        const state = mask.state(cell);
        if (
          state !== CellState.outside &&
          state !== CellState.walkable &&
          state !== CellState.covered
        ) {
          blocked = true;
        }
      }
      for (let y = 0; y < PX; y++) {
        for (let xx = 0; xx < PX; xx++) {
          const px = i * PX + xx;
          const py = j * PX + y;
          canvas.blend(px, py, color);
          if (blocked && !level && (xx + y) % 3 === 0) canvas.blend(px, py, [200, 40, 40], 0.6);
        }
      }
    }
  }

  [...model.regions.values()].forEach((region, k) => {
    const color = REGION_COLORS[k % REGION_COLORS.length] ?? [255, 255, 255];
    for (const [p, q] of polygonEdges(region.footprint)) {
      canvas.line(...toPx(p.x, p.z), ...toPx(q.x, q.z), color, 1);
    }
  });
  for (const prop of model.props) {
    const r = Math.max(1.5, (prop.blockRadius / terrain.cellSize) * PX);
    canvas.disc(
      ...toPx(prop.transform.position.x, prop.transform.position.z),
      r,
      prop.blockRadius > 0 ? [30, 60, 25] : [235, 225, 200],
      0.9,
    );
  }
  for (const connection of model.connections) {
    const check = nav.portals.get(connection.id);
    const { a, b } = connection.portal;
    canvas.line(
      ...toPx(a.x, a.z),
      ...toPx(b.x, b.z),
      check?.usable ? [255, 235, 0] : [255, 0, 0],
      3,
    );
  }
  for (const spawn of world.spawnPoints) {
    canvas.disc(...toPx(spawn.position.x, spawn.position.z), 5, [230, 30, 180]);
  }
  trajectories.forEach((points, k) => {
    const color = TRAJECTORY_COLORS[k % TRAJECTORY_COLORS.length] ?? [0, 0, 0];
    for (let n = 1; n < points.length; n++) {
      const p = points[n - 1];
      const q = points[n];
      if (p && q) canvas.line(...toPx(p.x, p.z), ...toPx(q.x, q.z), color, 1);
    }
    const last = points.at(-1);
    if (last) canvas.disc(...toPx(last.x, last.z), 3.5, color);
  });
  return canvas.png();
}

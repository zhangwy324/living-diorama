import type { Vec3 } from "@living-diorama/content-schema";
import type { CreatureSnapshot, SceneData, SimulationSnapshot } from "@living-diorama/simulation";
import * as THREE from "three";
import type { CreaturePose } from "./interpolation";

// Debug labels above creatures (ADR 0018 §15, Q24 amendment): each creature's action, home,
// need values and what it knows, plus lines to its home and known places and squares for the
// grid cells it visited recently. The renderer knows no need, action or affordance IDs; it shows
// them by the part after the namespace ("core:hunger" → "hunger").

/** Side of the knowledge grid's cells in metres; mirrors the simulation's `KNOWLEDGE_CELL_SIZE`. */
const CELL_SIZE = 8;
/** The label's bottom edge sits this far above the creature's feet, in metres. */
const LABEL_LIFT = 1.2;
/** The label as shown, in screen pixels; drawn at twice that for sharp text. */
const LABEL_WIDTH = 220;
const LABEL_HEIGHT = 100;
const CANVAS_SCALE = 2;
const LINE_HEIGHT = 13;
const FONT = `${11 * CANVAS_SCALE}px ui-monospace, Consolas, monospace`;
const LIFT = 0.04;
const HOME = "#ff5fd2";
const PLACE = "#7fe7ff";
const CELL = "#ffffff";

/** The part of a namespaced ID after its last colon: "core:hunger" → "hunger". */
export const shortName = (id: string) => id.slice(id.lastIndexOf(":") + 1);

/**
 * The label's lines: the action (or "idle"), then with debug data its home, each need with two
 * decimals, and how many places per affordance and recent cells it knows.
 */
export function labelLines(creature: CreatureSnapshot): string[] {
  const lines = [creature.currentAction ? shortName(creature.currentAction) : "idle"];
  if (creature.home !== undefined) lines.push(`home ${creature.home ?? "none"}`);
  const needs = Object.entries(creature.needs ?? {}).sort(([a], [b]) => a.localeCompare(b));
  for (const [id, value] of needs) lines.push(`${shortName(id)} ${value.toFixed(2)}`);
  const knowledge = creature.knowledge;
  if (knowledge) {
    const known = Object.entries(knowledge.places)
      .filter(([, places]) => places.length > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, places]) => `${shortName(id)} ${places.length}`);
    lines.push([...known, `${knowledge.recentCells.length} cells`].join(" · "));
  }
  return lines;
}

/** A texture a label is drawn into. */
export interface LabelSurface {
  readonly texture: THREE.Texture;
  draw(lines: readonly string[]): void;
  dispose(): void;
}

/** Draws labels into an `OffscreenCanvas`: light text on a dark panel, from the bottom up. */
export function canvasLabelSurface(): LabelSurface {
  const width = LABEL_WIDTH * CANVAS_SCALE;
  const height = LABEL_HEIGHT * CANVAS_SCALE;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return {
    texture,
    draw(lines) {
      if (!context) return;
      const line = LINE_HEIGHT * CANVAS_SCALE;
      const fitting = Math.floor((height - 8) / line);
      const shown = lines.length > fitting ? [...lines.slice(0, fitting - 1), "…"] : lines;
      context.clearRect(0, 0, width, height);
      context.font = FONT;
      const panelWidth = Math.min(
        width,
        Math.max(...shown.map((l) => context.measureText(l).width)) + 16,
      );
      const panelHeight = shown.length * line + 8;
      const left = (width - panelWidth) / 2;
      context.fillStyle = "rgba(20, 24, 28, 0.72)";
      context.fillRect(left, height - panelHeight, panelWidth, panelHeight);
      context.fillStyle = "#f2f4f5";
      context.textBaseline = "top";
      shown.forEach((text, i) =>
        context.fillText(text, left + 8, height - panelHeight + 4 + i * line + 2),
      );
      texture.needsUpdate = true;
    },
    dispose() {
      texture.dispose();
    },
  };
}

interface Label {
  sprite: THREE.Sprite;
  surface: LabelSurface;
  text: string;
}

/** Nearest terrain sample's height at (x, z), for laying cell squares on the ground. */
function terrainHeight(scene: SceneData, x: number, z: number): number {
  const { columns, rows, cellSize, heights } = scene.terrain;
  const { min } = scene.bounds;
  const i = THREE.MathUtils.clamp(Math.round((x - min.x) / cellSize), 0, columns - 1);
  const j = THREE.MathUtils.clamp(Math.round((z - min.z) / cellSize), 0, rows - 1);
  return heights[j * columns + i] ?? 0;
}

/**
 * Where each placement a creature can know stands: a prop at its transform, a structure at the
 * mean of its surfaces' vertices.
 */
export function placementPositions(scene: SceneData): Map<string, Vec3> {
  const positions = new Map(scene.props.map((p) => [p.id, p.transform.position]));
  const sums = new Map<string, { x: number; y: number; z: number; n: number }>();
  for (const surface of scene.surfaces) {
    if (surface.structureId === undefined) continue;
    const sum = sums.get(surface.structureId) ?? { x: 0, y: 0, z: 0, n: 0 };
    const p = surface.mesh.positions;
    for (let i = 0; i + 2 < p.length; i += 3) {
      sum.x += p[i] ?? 0;
      sum.y += p[i + 1] ?? 0;
      sum.z += p[i + 2] ?? 0;
      sum.n++;
    }
    sums.set(surface.structureId, sum);
  }
  for (const [id, { x, y, z, n }] of sums) {
    if (n > 0) positions.set(id, { x: x / n, y: y / n, z: z / n });
  }
  return positions;
}

const segments = (color: string, opacity: number) => {
  const material = new THREE.LineBasicMaterial({ color, opacity });
  material.depthTest = false;
  material.depthWrite = false;
  material.transparent = true;
  const lines = new THREE.LineSegments(new THREE.BufferGeometry(), material);
  lines.renderOrder = 11;
  lines.frustumCulled = false;
  return lines;
};

/**
 * Labels and knowledge lines for every creature. Labels are pooled and redrawn only when their
 * text changes, which with two decimals is a few times a minute per need. Does nothing until
 * `update`, which the view calls only while debug overlays show.
 */
export class CreatureLabels {
  readonly group = new THREE.Group();
  readonly #createSurface: () => LabelSurface;
  readonly #places: Map<string, Vec3>;
  readonly #scene: SceneData;
  readonly #labels = new Map<string, Label>();
  readonly #free: Label[] = [];
  readonly #home = segments(HOME, 0.9);
  readonly #known = segments(PLACE, 0.6);
  readonly #cells = segments(CELL, 0.25);
  #creatures = new Map<string, CreatureSnapshot>();

  constructor(scene: SceneData, createSurface: () => LabelSurface = canvasLabelSurface) {
    this.group.name = "creature-labels";
    this.#scene = scene;
    this.#createSurface = createSurface;
    this.#places = placementPositions(scene);
    this.group.add(this.#home, this.#known, this.#cells);
  }

  /** Keeps the creatures of the newest snapshot. */
  setSnapshot(snapshot: SimulationSnapshot): void {
    this.#creatures = new Map(snapshot.creatures.map((c) => [c.id, c]));
  }

  /**
   * Places labels above `poses` and draws the knowledge lines. `pixelSize` is the height of one
   * screen pixel at one metre from the camera, so labels keep their size in pixels.
   */
  update(poses: readonly CreaturePose[], pixelSize: number): void {
    const seen = new Set<string>();
    const home: THREE.Vector3[] = [];
    const known: THREE.Vector3[] = [];
    const cells: THREE.Vector3[] = [];
    for (const pose of poses) {
      const creature = this.#creatures.get(pose.id);
      if (!creature) continue;
      seen.add(pose.id);
      const label = this.#label(pose.id);
      const text = labelLines(creature).join("\n");
      if (text !== label.text) {
        label.surface.draw(text.split("\n"));
        label.text = text;
      }
      label.sprite.position.set(pose.world.x, pose.world.y + LABEL_LIFT, pose.world.z);
      label.sprite.scale.set(LABEL_WIDTH * pixelSize, LABEL_HEIGHT * pixelSize, 1);

      const from = new THREE.Vector3(pose.world.x, pose.world.y + LIFT, pose.world.z);
      const to = (id: string) => {
        const p = this.#places.get(id);
        return p && new THREE.Vector3(p.x, p.y + LIFT, p.z);
      };
      const homeAt = creature.home ? to(creature.home) : undefined;
      if (homeAt) home.push(from, homeAt);
      for (const places of Object.values(creature.knowledge?.places ?? {})) {
        for (const place of places) {
          const at = to(place.placementId);
          if (at) known.push(from, at);
        }
      }
      for (const cell of creature.knowledge?.recentCells ?? []) cells.push(...this.#square(cell));
    }
    for (const [id, label] of this.#labels) {
      if (seen.has(id)) continue;
      label.sprite.removeFromParent();
      this.#labels.delete(id);
      this.#free.push(label);
    }
    for (const [lines, points] of [
      [this.#home, home],
      [this.#known, known],
      [this.#cells, cells],
    ] as const) {
      lines.geometry.dispose();
      lines.geometry = new THREE.BufferGeometry().setFromPoints(points);
    }
  }

  /** Labels shown now. */
  get count(): number {
    return this.#labels.size;
  }

  dispose(): void {
    for (const label of [...this.#labels.values(), ...this.#free]) {
      label.surface.dispose();
      label.sprite.material.dispose();
      label.sprite.removeFromParent();
    }
    this.#labels.clear();
    this.#free.length = 0;
    for (const lines of [this.#home, this.#known, this.#cells]) {
      lines.geometry.dispose();
      (lines.material as THREE.Material).dispose();
    }
  }

  #label(id: string): Label {
    let label = this.#labels.get(id);
    if (label) return label;
    label = this.#free.pop();
    if (!label) {
      const surface = this.#createSurface();
      const material = new THREE.SpriteMaterial({
        map: surface.texture,
        sizeAttenuation: false,
        depthTest: false,
        depthWrite: false,
        transparent: true,
      });
      const sprite = new THREE.Sprite(material);
      sprite.center.set(0.5, 0);
      sprite.renderOrder = 12;
      label = { sprite, surface, text: "" };
    }
    // A reused label belonged to another creature, so it is redrawn on its first update.
    label.text = "";
    this.#labels.set(id, label);
    this.group.add(label.sprite);
    return label;
  }

  /** The outline of a knowledge grid cell, as four segments, on the terrain at its centre. */
  #square(cell: { x: number; z: number }): THREE.Vector3[] {
    const x0 = cell.x * CELL_SIZE;
    const z0 = cell.z * CELL_SIZE;
    const y = terrainHeight(this.#scene, x0 + CELL_SIZE / 2, z0 + CELL_SIZE / 2) + LIFT;
    const inset = 0.2;
    const a = new THREE.Vector3(x0 + inset, y, z0 + inset);
    const b = new THREE.Vector3(x0 + CELL_SIZE - inset, y, z0 + inset);
    const c = new THREE.Vector3(x0 + CELL_SIZE - inset, y, z0 + CELL_SIZE - inset);
    const d = new THREE.Vector3(x0 + inset, y, z0 + CELL_SIZE - inset);
    return [a, b, b, c, c, d, d, a];
  }
}

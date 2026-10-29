import type { CreatureSnapshot, SceneData, SimulationSnapshot } from "@living-diorama/simulation";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  CreatureLabels,
  labelLines,
  placementPositions,
  shortName,
  type LabelSurface,
} from "./creature-labels";
import type { CreaturePose } from "./interpolation";
import { createDebugOverlays } from "./overlays";

const scene = {
  bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 16, y: 4, z: 16 } },
  terrain: { columns: 3, rows: 3, cellSize: 8, heights: [0, 0, 0, 0, 2, 0, 0, 0, 0], colors: [] },
  surfaces: [
    {
      regionId: "deck",
      kind: "land",
      structureId: "bridge",
      mesh: { positions: [0, 1, 0, 2, 1, 0, 1, 1, 3], indices: [0, 2, 1] },
    },
  ],
  props: [
    {
      id: "oak",
      model: "m",
      transform: { position: { x: 4, y: 1, z: 4 }, rotationY: 0, scale: 1 },
    },
    {
      id: "bush",
      model: "m",
      transform: { position: { x: 9, y: 0, z: 2 }, rotationY: 0, scale: 1 },
    },
  ],
} as unknown as SceneData;

const creature = (fields: Partial<CreatureSnapshot> = {}): CreatureSnapshot => ({
  id: "a",
  speciesId: "s",
  position: { regionId: "meadow", x: 1, z: 1 },
  world: { x: 1, y: 0, z: 1 },
  heading: 0,
  animation: undefined,
  submersion: 0,
  cues: [],
  ...fields,
});

const debugged = (hunger: number) =>
  creature({
    currentAction: "core:eat",
    needs: { "core:tiredness": 0.1, "core:hunger": hunger },
    knowledge: {
      places: {
        "core:food": [{ placementId: "bush", lastSeenTick: 3 }],
        "core:shelter": [],
      },
      recentCells: [{ x: 0, z: 0, tick: 5 }],
    },
    home: "oak",
  });

const snapshot = (...creatures: CreatureSnapshot[]): SimulationSnapshot => ({
  tick: 1,
  timeMs: 100,
  paused: false,
  timeOfDay: 720,
  creatures,
});

const pose = (id: string): CreaturePose => ({
  id,
  speciesId: "s",
  world: { x: 1, y: 0, z: 1 },
  heading: 0,
  cues: [],
  animation: undefined,
  submersion: 0,
});

/** Records draws and disposals instead of painting a canvas. */
function fakeSurfaces() {
  const drawn: string[][] = [];
  let disposed = 0;
  let created = 0;
  const create = (): LabelSurface => {
    created++;
    return {
      texture: new THREE.Texture(),
      draw: (lines) => drawn.push([...lines]),
      dispose: () => disposed++,
    };
  };
  return {
    create,
    drawn,
    get disposed() {
      return disposed;
    },
    get created() {
      return created;
    },
  };
}

const vertexCount = (labels: CreatureLabels, index: number) =>
  (labels.group.children[index] as THREE.LineSegments).geometry.getAttribute("position")?.count ??
  0;

describe("creature labels", () => {
  it("shortens namespaced IDs", () => {
    expect(shortName("core:hunger")).toBe("hunger");
    expect(shortName("plain")).toBe("plain");
  });

  it("lists the action, home, needs with two decimals and what the creature knows", () => {
    expect(labelLines(debugged(0.4567))).toEqual([
      "eat",
      "home oak",
      "hunger 0.46",
      "tiredness 0.10",
      "knows 1 food",
      "1 recent cells",
    ]);
    expect(labelLines(creature({ home: null }))).toEqual(["idle", "home none"]);
    // Without debug data only the action shows.
    expect(labelLines(creature({ currentAction: "core:wander" }))).toEqual(["wander"]);
  });

  it("starts hidden in the overlay group and adds a label per creature", () => {
    const surfaces = fakeSurfaces();
    const { group, labels } = createDebugOverlays(scene, undefined, surfaces.create);
    expect(group.visible).toBe(false);
    expect(group.getObjectByName("creature-labels")).toBe(labels.group);
    labels.setSnapshot(snapshot(debugged(0.5), creature({ id: "b" })));
    labels.update([pose("a"), pose("b")], 0.001);
    expect(labels.count).toBe(2);
    const sprite = labels.group.children.find((o) => o instanceof THREE.Sprite)!;
    expect(sprite.position.y).toBeCloseTo(1.2);
    expect(sprite.scale.y).toBeCloseTo(0.13);
  });

  it("redraws a label only when its text changes at two decimals", () => {
    const surfaces = fakeSurfaces();
    const labels = new CreatureLabels(scene, surfaces.create);
    labels.setSnapshot(snapshot(debugged(0.5)));
    labels.update([pose("a")], 0.001);
    labels.setSnapshot(snapshot(debugged(0.501)));
    labels.update([pose("a")], 0.001);
    labels.update([pose("a")], 0.001);
    expect(surfaces.drawn).toHaveLength(1);
    labels.setSnapshot(snapshot(debugged(0.51)));
    labels.update([pose("a")], 0.001);
    expect(surfaces.drawn).toHaveLength(2);
    expect(surfaces.drawn[1]).toContain("hunger 0.51");
  });

  it("draws lines to home and known places, and squares for recent cells per snapshot", () => {
    const labels = new CreatureLabels(scene, fakeSurfaces().create);
    labels.setSnapshot(snapshot(debugged(0.5)));
    // Recent cells come with the snapshot; the lines follow the creature each frame.
    expect(vertexCount(labels, 2)).toBe(8); // one cell
    const cells = (labels.group.children[2] as THREE.LineSegments).geometry;
    expect(cells.getAttribute("position").getY(0)).toBeCloseTo(0.54); // terrain at (4, 4)
    labels.update([pose("a")], 0.001);
    expect(vertexCount(labels, 0)).toBe(2); // home
    expect(vertexCount(labels, 1)).toBe(2); // the bush
    expect((labels.group.children[2] as THREE.LineSegments).geometry).toBe(cells);
  });

  it("pools labels of creatures that left and disposes every one", () => {
    const surfaces = fakeSurfaces();
    const labels = new CreatureLabels(scene, surfaces.create);
    labels.setSnapshot(snapshot(debugged(0.5)));
    labels.update([pose("a")], 0.001);
    labels.setSnapshot(snapshot());
    labels.update([], 0.001);
    expect(labels.count).toBe(0);
    expect(labels.group.children.some((o) => o instanceof THREE.Sprite)).toBe(false);
    labels.setSnapshot(snapshot(creature({ id: "b" })));
    labels.update([pose("b")], 0.001);
    expect(surfaces.created).toBe(1);
    expect(surfaces.drawn.at(-1)).toEqual(["idle"]);
    labels.dispose();
    expect(surfaces.disposed).toBe(1);
    expect(labels.count).toBe(0);
  });
});

it("finds props at their transform and structures at their surfaces' middle", () => {
  const positions = placementPositions(scene);
  expect(positions.get("oak")).toEqual({ x: 4, y: 1, z: 4 });
  expect(positions.get("bridge")).toEqual({ x: 1, y: 1, z: 1 });
});

it("disposes every overlay's geometries, materials and label textures", () => {
  const surfaces = fakeSurfaces();
  const overlays = createDebugOverlays(scene, undefined, surfaces.create);
  overlays.labels.setSnapshot(snapshot(debugged(0.5)));
  overlays.labels.update([pose("a")], 0.001);
  const disposed: string[] = [];
  overlays.group.traverse((object) => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Line)) return;
    object.geometry.addEventListener("dispose", () => disposed.push(`geometry ${object.name}`));
    (object.material as THREE.Material).addEventListener("dispose", () =>
      disposed.push("material"),
    );
  });
  const parent = new THREE.Group().add(overlays.group);
  overlays.dispose();
  // The deck wireframe and the three label line sets, each with a geometry and a material.
  expect(disposed.filter((d) => d.startsWith("geometry"))).toHaveLength(4);
  expect(disposed.filter((d) => d === "material")).toHaveLength(4);
  expect(surfaces.disposed).toBe(1);
  expect(parent.children).toHaveLength(0);
});

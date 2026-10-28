import type { Vec3 } from "@living-diorama/content-schema";
import type { CreatureSnapshot, SceneData, SimulationSnapshot } from "@living-diorama/simulation";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { CreatureBodies } from "./creatures";
import {
  MIN_CAMERA_CLEARANCE,
  SnapshotInterpolator,
  lerpHeading,
  limitCamera,
  terrainHeightAt,
} from "./index";
import { SceneLayer } from "./layers";

const creature = (id: string, world: Vec3, heading = 0): CreatureSnapshot => ({
  id,
  speciesId: "test:critter",
  position: { regionId: "r", x: world.x, z: world.z },
  world,
  heading,
});

const snapshot = (tick: number, creatures: CreatureSnapshot[]): SimulationSnapshot => ({
  tick,
  timeMs: tick * 100,
  paused: false,
  timeOfDay: 720,
  creatures,
});

describe("lerpHeading", () => {
  it("turns the short way round across ±π", () => {
    const halfway = lerpHeading(Math.PI - 0.1, -Math.PI + 0.1, 0.5);
    expect(Math.abs(Math.cos(halfway) + 1)).toBeLessThan(1e-9); // pointing at π, not 0
  });
});

describe("SnapshotInterpolator", () => {
  const at = (x: number, heading = 0) => creature("a", { x, y: 0, z: 0 }, heading);

  it("draws one tick behind, blending towards the newest snapshot", () => {
    const interpolator = new SnapshotInterpolator(100);
    interpolator.push(snapshot(1, [at(0)]), 0);
    interpolator.push(snapshot(2, [at(1, 1)]), 100);
    expect(interpolator.sample(100)[0]!.world.x).toBeCloseTo(0);
    const half = interpolator.sample(150)[0]!;
    expect(half.world.x).toBeCloseTo(0.5);
    expect(half.heading).toBeCloseTo(0.5);
    // Holds at the newest pose when the next snapshot is late (e.g. paused).
    expect(interpolator.sample(1000)[0]!.world.x).toBeCloseTo(1);
  });

  it("snaps creatures that just spawned or moved further than a teleport", () => {
    const interpolator = new SnapshotInterpolator(100);
    interpolator.push(snapshot(1, [at(0)]), 0);
    interpolator.push(snapshot(2, [at(10), creature("b", { x: 5, y: 0, z: 0 })]), 100);
    const [a, b] = interpolator.sample(110);
    expect(a!.world.x).toBe(10);
    expect(b!.world.x).toBe(5);
  });

  it("ignores repeated ticks and drops creatures missing from the newest snapshot", () => {
    const interpolator = new SnapshotInterpolator(100);
    interpolator.push(snapshot(1, [at(0)]), 0);
    interpolator.push(snapshot(2, [at(1)]), 100);
    interpolator.push(snapshot(2, []), 120); // e.g. the snapshot sent on pause
    expect(interpolator.sample(150)).toHaveLength(1);
    interpolator.push(snapshot(3, []), 200);
    expect(interpolator.sample(250)).toHaveLength(0);
  });

  it("learns the real interval between snapshots, e.g. at double speed", () => {
    const interpolator = new SnapshotInterpolator(100);
    for (let tick = 0; tick < 40; tick++) interpolator.push(snapshot(tick, [at(tick)]), tick * 50);
    // Snapshot 39 arrived at 1950; halfway to the next one is 25 ms later.
    expect(interpolator.sample(1975)[0]!.world.x).toBeCloseTo(38.5, 1);
  });

  it("treats a wait of over a second as a break, e.g. after sleep", () => {
    const interpolator = new SnapshotInterpolator(100);
    for (let tick = 0; tick < 10; tick++)
      interpolator.push(snapshot(tick, [at(tick * 0.1)]), tick * 100);
    // An hour later the clock catches up a second at once; that snapshot is drawn as it is...
    const resumed = 3_600_000;
    interpolator.push(snapshot(20, [at(2)]), resumed);
    expect(interpolator.sample(resumed)[0]!.world.x).toBe(2);
    // ...and the interval is still 100 ms, so the next snapshot blends at the usual pace.
    interpolator.push(snapshot(21, [at(2.1)]), resumed + 100);
    expect(interpolator.sample(resumed + 150)[0]!.world.x).toBeCloseTo(2.05);
  });
});

/** 10 × 10 m terrain sloping up to the east: height = x + 5 at x ∈ [-5, 5]. */
const slope = {
  bounds: { min: { x: -5, y: 0, z: -5 }, max: { x: 5, y: 10, z: 5 } },
  terrain: {
    columns: 11,
    rows: 11,
    cellSize: 1,
    heights: Array.from({ length: 121 }, (_, k) => k % 11),
    colors: [],
  },
} as unknown as SceneData;

describe("camera limits", () => {
  it("interpolates terrain height and clamps to the grid's edge", () => {
    expect(terrainHeightAt(slope, 0.5, 0)).toBeCloseTo(5.5);
    expect(terrainHeightAt(slope, 50, 0)).toBeCloseTo(10);
  });

  it("keeps the camera above the terrain and the target over the world", () => {
    const position = new THREE.Vector3(4, 2, 0);
    const target = new THREE.Vector3(8, 1, 0);
    expect(limitCamera(slope, position, target)).toBe(true);
    expect(target.x).toBe(5);
    // Moved back 3 m with the target, to x = 1 where the terrain is 6 m high.
    expect(position.x).toBe(1);
    expect(position.y).toBeCloseTo(6 + MIN_CAMERA_CLEARANCE);
    expect(limitCamera(slope, position, target)).toBe(false);
  });
});

describe("CreatureBodies", () => {
  /** A 20 × 40 px green rectangle filling its image. */
  const drawing = {
    width: 20,
    height: 40,
    data: new Uint8Array(20 * 40 * 4).fill(255),
  };
  const make = (readImage = vi.fn(async () => drawing)) => {
    const layer = new SceneLayer("creatures");
    const bodies = new CreatureBodies(layer, {
      resolveSpecies: (id) =>
        id === "test:critter"
          ? { appearance: "test:img", sizeClass: "medium", body: { thickness: 0.25 } }
          : undefined,
      resolveAsset: (ref) =>
        ref === "test:img" ? { kind: "image", url: "critter.png" } : undefined,
      readImage,
    });
    return { layer, bodies, readImage };
  };
  const bodyOf = (layer: SceneLayer, id: string) => layer.group.getObjectByName(id) as THREE.Mesh;
  const boxOf = (mesh: THREE.Mesh) => {
    mesh.geometry.computeBoundingBox();
    return mesh.geometry.boundingBox!;
  };

  it("shows a block until the drawing loads, then the body built once per species, as thick as the species says", async () => {
    const { layer, bodies, readImage } = make();
    const poses = [creature("a", { x: 0, y: 0, z: 0 }), creature("b", { x: 1, y: 0, z: 0 })];
    bodies.update(poses);
    const block = bodyOf(layer, "a").geometry;
    expect(block.type).toBe("RoundedBoxGeometry");
    expect(boxOf(bodyOf(layer, "a")).max.z * 2).toBeCloseTo(0.8 * 0.25);
    await bodies.ready;
    bodies.update(poses);
    expect(readImage).toHaveBeenCalledTimes(1);
    expect(bodies.count).toBe(2);
    const body = bodyOf(layer, "a");
    expect(body.geometry.type).toBe("ExtrudeGeometry");
    expect(bodyOf(layer, "b").geometry).toBe(body.geometry);
    expect(bodyOf(layer, "b").position.toArray()).toEqual([1, 0, 0]);
    expect(boxOf(body).max.y).toBeCloseTo(0.8); // a medium creature is 0.8 m tall
    expect(boxOf(body).max.z - boxOf(body).min.z).toBeCloseTo(0.8 * 0.25);
    expect(body.material).toBeInstanceOf(THREE.MeshStandardMaterial); // faces and walls share it
  });

  it("turns the drawing's facing (+X) to the creature's heading", () => {
    const { layer, bodies } = make();
    const facing = (heading: number) => {
      bodies.update([creature("a", { x: 0, y: 0, z: 0 }, heading)]);
      return new THREE.Vector3(1, 0, 0).applyEuler(bodyOf(layer, "a").rotation);
    };
    for (const heading of [0, Math.PI / 2, -2]) {
      const forward = facing(heading);
      expect(forward.x).toBeCloseTo(Math.sin(heading));
      expect(forward.z).toBeCloseTo(Math.cos(heading));
    }
  });

  it("removes departed creatures", () => {
    const { layer, bodies } = make();
    bodies.update([creature("a", { x: 0, y: 0, z: 0 })]);
    bodies.update([]);
    expect(bodies.count).toBe(0);
    expect(layer.group.children).toHaveLength(0);
  });

  it("makes bodies cast shadows from their faces towards the sun", async () => {
    const { layer, bodies } = make();
    bodies.update([creature("a", { x: 0, y: 0, z: 0 })]);
    const sides = (mesh: THREE.Mesh) =>
      [mesh.material].flat().map((material) => material.shadowSide);
    expect(bodyOf(layer, "a").castShadow).toBe(true);
    expect(sides(bodyOf(layer, "a"))).toEqual([THREE.FrontSide]); // the block
    await bodies.ready;
    bodies.update([creature("a", { x: 0, y: 0, z: 0 })]);
    expect(sides(bodyOf(layer, "a"))).toEqual([THREE.FrontSide]); // the body
  });

  it("draws nothing for an unknown species and keeps the block if the drawing fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { layer, bodies } = make(vi.fn(() => Promise.reject(new Error("missing"))));
    bodies.update([{ ...creature("a", { x: 0, y: 0, z: 0 }), speciesId: "test:other" }]);
    expect(bodies.count).toBe(0);
    bodies.update([creature("b", { x: 0, y: 0, z: 0 })]);
    await bodies.ready;
    bodies.update([creature("b", { x: 0, y: 0, z: 0 })]);
    expect(bodies.count).toBe(1);
    expect(bodyOf(layer, "b").geometry.type).toBe("RoundedBoxGeometry");
    expect(warn).toHaveBeenCalledWith("No species test:other to draw");
  });

  it("keeps the block for a drawing with no opaque shape", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const empty = { width: 4, height: 4, data: new Uint8Array(64) };
    const { layer, bodies } = make(vi.fn(async () => empty));
    bodies.update([creature("a", { x: 0, y: 0, z: 0 })]);
    await bodies.ready;
    bodies.update([creature("a", { x: 0, y: 0, z: 0 })]);
    expect(bodyOf(layer, "a").geometry.type).toBe("RoundedBoxGeometry");
    expect(warn).toHaveBeenCalledWith("No opaque shape in test:img");
  });
});

import { defaultBody, type BodyShape, type Vec3 } from "@living-diorama/content-schema";
import type { CreatureSnapshot, SceneData, SimulationSnapshot } from "@living-diorama/simulation";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { CreatureBodies } from "./creatures";
import type { CreaturePose } from "./interpolation";
import {
  MIN_CAMERA_CLEARANCE,
  SnapshotInterpolator,
  lerpHeading,
  limitCamera,
  terrainHeightAt,
} from "./index";
import { SceneLayer } from "./layers";

/** A creature body's placement, read from its matrix (it composes more than position, rotation, scale). */
const placed = (mesh: THREE.Object3D) => {
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  mesh.matrix.decompose(position, quaternion, scale);
  return { position, quaternion, scale };
};

const creature = (id: string, world: Vec3, heading = 0): CreatureSnapshot => ({
  id,
  speciesId: "test:critter",
  position: { regionId: "r", x: world.x, z: world.z },
  world,
  heading,
  animation: undefined,
  submersion: 0,
  cues: [],
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

  it("carries the cues of the snapshot the pose blends from, so they don't lead the body", () => {
    const interpolator = new SnapshotInterpolator(100);
    interpolator.push(snapshot(1, [at(0)]), 0);
    interpolator.push(snapshot(2, [{ ...at(1), cues: ["eating", "hungry"] }]), 100);
    expect(interpolator.sample(150)[0]!.cues).toEqual([]);
    // Once the pose arrives (also when the next snapshot is late, e.g. paused) it shows them.
    expect(interpolator.sample(200)[0]!.cues).toEqual(["eating", "hungry"]);
    expect(interpolator.sample(5000)[0]!.cues).toEqual(["eating", "hungry"]);
    interpolator.push(snapshot(3, [{ ...at(10), cues: ["sleeping"] }]), 200); // snapped
    expect(interpolator.sample(210)[0]!.cues).toEqual(["sleeping"]);
  });

  it("blends cue progress between snapshots that both have it", () => {
    const interpolator = new SnapshotInterpolator(100);
    interpolator.push(snapshot(1, [{ ...at(0), cues: ["eating"], cueProgress: 0.2 }]), 0);
    interpolator.push(snapshot(2, [{ ...at(0.1), cues: ["eating"], cueProgress: 0.4 }]), 100);
    expect(interpolator.sample(150)[0]!.cueProgress).toBeCloseTo(0.3);
    // A lower progress is a new meal: no sweeping back.
    interpolator.push(snapshot(3, [{ ...at(0.2), cues: ["eating"], cueProgress: 0.05 }]), 200);
    expect(interpolator.sample(200)[0]!.cueProgress).toBe(0.05);
    // Without it in the previous snapshot, it comes with the cues it belongs to.
    interpolator.push(snapshot(4, [at(0.3)]), 300);
    interpolator.push(snapshot(5, [{ ...at(0.4), cues: ["eating"], cueProgress: 0.1 }]), 400);
    expect(interpolator.sample(450)[0]!.cueProgress).toBeUndefined();
    expect(interpolator.sample(500)[0]!.cueProgress).toBe(0.1);
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

  it("carries the animation profile like the cues and blends the submersion", () => {
    const animated = (x: number, animation: string, submersion: number): CreatureSnapshot => ({
      ...at(x),
      animation,
      submersion,
    });
    const interpolator = new SnapshotInterpolator(100);
    interpolator.push(snapshot(1, [at(0)]), 0);
    expect(interpolator.sample(0)[0]).toMatchObject({ animation: undefined, submersion: 0 });
    interpolator.push(snapshot(2, [animated(0.1, "swim", 0.4)]), 100);
    const half = interpolator.sample(150)[0]!;
    expect(half.animation).toBeUndefined();
    expect(half.submersion).toBeCloseTo(0.2);
    expect(interpolator.sample(200)[0]).toMatchObject({ animation: "swim", submersion: 0.4 });
    interpolator.push(snapshot(3, [animated(10, "walk", 0)]), 200); // snapped
    expect(interpolator.sample(210)[0]).toMatchObject({ animation: "walk", submersion: 0 });
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
  const make = (readImage = vi.fn(async () => drawing), body: Partial<BodyShape> = {}) => {
    const layer = new SceneLayer("creatures");
    const bodies = new CreatureBodies(layer, {
      resolveSpecies: (id) =>
        id === "test:critter"
          ? {
              appearance: "test:img",
              sizeClass: "medium",
              body: { ...defaultBody(), thickness: 0.25, ...body },
            }
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
    expect(placed(bodyOf(layer, "b")).position.toArray()).toEqual([1, 0, 0]);
    expect(boxOf(body).max.y).toBeCloseTo(0.8); // a medium creature is 0.8 m tall
    expect(boxOf(body).max.z - boxOf(body).min.z).toBeCloseTo(0.8 * 0.25);
    expect(body.material).toBeInstanceOf(THREE.MeshStandardMaterial); // faces and walls share it
  });

  it("turns the drawing's facing (+X) to the creature's heading", () => {
    const { layer, bodies } = make();
    const facing = (heading: number) => {
      bodies.update([creature("a", { x: 0, y: 0, z: 0 }, heading)]);
      return new THREE.Vector3(1, 0, 0).transformDirection(bodyOf(layer, "a").matrix);
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
    expect(layer.group.getObjectByName("a")).toBeUndefined();
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
  describe("animation", () => {
    /** A creature walking along +X at 0.6 m/s, sampled each 1/60 s. */
    const moving = (
      frames: number,
      pose: Partial<CreaturePose>,
      bodies: CreatureBodies,
      each?: (frame: number) => void,
    ) => {
      for (let frame = 0; frame <= frames; frame++) {
        const time = frame / 60;
        const world = { x: 0.6 * time, y: 0, z: 0 };
        bodies.update([{ ...creature("a", world, Math.PI / 2), ...pose }], {
          time,
          realTime: time,
        });
        each?.(frame);
      }
    };
    /** Builds the drawing's body before the creature moves. */
    const loaded = async (bodies: CreatureBodies) => {
      bodies.update([creature("a", { x: 0, y: 0, z: 0 })]);
      await bodies.ready;
      bodies.update([]);
    };
    const box = (layer: SceneLayer) => new THREE.Box3().setFromObject(bodyOf(layer, "a"));

    it("stands still at rest and for an unknown profile, and moves as it walks", async () => {
      const { layer, bodies } = make();
      await loaded(bodies);
      const plain = new THREE.Matrix4().compose(
        new THREE.Vector3(1, 0, 0),
        new THREE.Quaternion(),
        new THREE.Vector3(1, 1, 1),
      );
      for (const animation of ["walk", "fly", undefined]) {
        bodies.update([{ ...creature("a", { x: 1, y: 0, z: 0 }, Math.PI / 2), animation }]);
        bodies.update([{ ...creature("a", { x: 1, y: 0, z: 0 }, Math.PI / 2), animation }]);
        expect(bodyOf(layer, "a").matrix.equals(plain)).toBe(true);
      }
      bodies.update([]);
      const unknown: number[] = [];
      moving(60, { animation: "fly" }, bodies, () => unknown.push(box(layer).max.y));
      expect(Math.max(...unknown) - Math.min(...unknown)).toBeLessThan(1e-9);
      const walking: number[] = [];
      moving(60, { animation: "walk" }, bodies, () => walking.push(box(layer).max.y));
      expect(Math.max(...walking) - Math.min(...walking)).toBeGreaterThan(0.02);
    });

    it("keeps a walking and a hopping body on the ground as it tilts and squashes", async () => {
      // The default center of gravity, and one placed off-centre and high on the body: the body
      // tilts about the ground below it, so it neither dips below the ground nor floats above it.
      for (const anchors of [{}, { centerOfGravity: { x: 4, y: 30 } }]) {
        for (const animation of ["walk", "hop"]) {
          const { layer, bodies } = make(undefined, { anchors });
          await loaded(bodies);
          const lowest: number[] = [];
          moving(240, { animation }, bodies, () => lowest.push(box(layer).min.y));
          expect(Math.min(...lowest)).toBeGreaterThanOrEqual(-1e-6);
          // On the ground at each landing: within a millimetre, many frames of the run.
          expect(lowest.filter((y) => y < 1e-3).length).toBeGreaterThan(10);
        }
      }
    });

    it("draws the leap in the air on a bank jump, and walks on at pace after landing", async () => {
      const { layer, bodies } = make();
      await loaded(bodies);
      moving(30, { animation: "walk" }, bodies);
      // Halfway through the leap the body is plain: no waddle or bob, the arc is in the pose.
      const apex = { x: 0.6 * (31 / 60) + 1.5, y: 0.9, z: 0 };
      bodies.update([{ ...creature("a", apex, Math.PI / 2), animation: "walk", jump: 0.5 }], {
        time: 31 / 60,
        realTime: 31 / 60,
      });
      const { position, quaternion, scale } = placed(bodyOf(layer, "a"));
      expect(position.y).toBeCloseTo(0.9);
      expect(quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6);
      expect(scale.y).toBeCloseTo(1);
      // Landed a frame later: still walking at pace, so the gait shows at once.
      const landed = { x: apex.x + 0.01, y: apex.y, z: 0 };
      bodies.update([{ ...creature("a", landed, Math.PI / 2), animation: "walk" }], {
        time: 32 / 60,
        realTime: 32 / 60,
      });
      const after = placed(bodyOf(layer, "a"));
      expect(after.quaternion.angleTo(new THREE.Quaternion())).toBeGreaterThan(0.01);
    });

    it("lowers the body by its submersion, a share of its height", async () => {
      const { layer, bodies } = make();
      await loaded(bodies);
      bodies.update([{ ...creature("a", { x: 0, y: 2, z: 0 }), submersion: 0.25 }]);
      expect(placed(bodyOf(layer, "a")).position.y).toBeCloseTo(2 - 0.25 * 0.8);
      expect(box(layer).max.y).toBeCloseTo(2 + 0.75 * 0.8);
    });

    it("sways a swimmer about a point near its front, so its tail sweeps", async () => {
      // The tail placed at the drawing's top-left corner: the line through the body runs along
      // its top, and the pivot sits on it a quarter of the way back from the front.
      const swimmer = { anchors: { tail: { x: 0, y: 0 } } };
      const { layer, bodies } = make(undefined, swimmer);
      await loaded(bodies);
      const tails: number[] = [];
      const heads: number[] = [];
      moving(120, { animation: "swim" }, bodies, (frame) => {
        const mesh = bodyOf(layer, "a");
        const x = (0.6 * frame) / 60;
        // The body is 0.4 m long (20 px at 0.02 m/px): front at 0.2 m, pivot at 0.1 m, 0.8 m up.
        const pivot = new THREE.Vector3(0.1, 0.8, 0).applyMatrix4(mesh.matrix);
        // Facing +X, the pivot stays put whichever way the body sways...
        expect(pivot.x).toBeCloseTo(x + 0.1, 6);
        expect(pivot.z).toBeCloseTo(0, 6);
        // ...while the tail sweeps from side to side, much further than the front.
        tails.push(new THREE.Vector3(-0.2, 0.8, 0).applyMatrix4(mesh.matrix).z);
        heads.push(new THREE.Vector3(0.2, 0.8, 0).applyMatrix4(mesh.matrix).z);
      });
      const sweep = (zs: number[]) => Math.max(...zs) - Math.min(...zs);
      expect(sweep(tails)).toBeGreaterThan(0.08);
      expect(sweep(tails)).toBeGreaterThan(2.5 * sweep(heads));
    });

    it("keeps a resting swimmer bobbing gently in the water, without swaying", async () => {
      const { layer, bodies } = make();
      await loaded(bodies);
      const tops: number[] = [];
      const forwards: number[] = [];
      for (let frame = 0; frame <= 180; frame++) {
        const time = frame / 60;
        const pose = { ...creature("a", { x: 0, y: 0, z: 0 }, Math.PI / 2), animation: "swim" };
        bodies.update([{ ...pose, submersion: 0.4 }], { time, realTime: time });
        tops.push(box(layer).max.y);
        forwards.push(new THREE.Vector3(1, 0, 0).transformDirection(bodyOf(layer, "a").matrix).z);
      }
      // 0.8 m tall, 40% under: the top at 0.48 m, give or take a 3% bob.
      expect(Math.min(...tops)).toBeGreaterThan(0.48 - 0.03 * 0.8 - 1e-6);
      expect(Math.max(...tops)).toBeLessThan(0.48 + 0.03 * 0.8 + 1e-6);
      expect(Math.max(...tops) - Math.min(...tops)).toBeGreaterThan(0.03);
      expect(Math.max(...forwards.map(Math.abs))).toBeLessThan(1e-9);
    });
  });
});

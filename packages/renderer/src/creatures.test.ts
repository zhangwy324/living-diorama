import type { Vec3 } from "@living-diorama/content-schema";
import type { CreatureSnapshot, SceneData, SimulationSnapshot } from "@living-diorama/simulation";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { CreatureSprites } from "./creatures";
import {
  MIN_CAMERA_CLEARANCE,
  MIN_SPRITE_PX,
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

describe("CreatureSprites", () => {
  const camera = () => {
    const c = new THREE.PerspectiveCamera(30, 2, 0.1, 1000);
    c.position.set(0, 0, 20);
    c.lookAt(0, 0, 0);
    return c;
  };
  const make = (loadImage = vi.fn(async () => new THREE.Texture({ width: 50, height: 100 }))) => {
    const layer = new SceneLayer("creatures");
    const sprites = new CreatureSprites(
      layer,
      (id) => (id === "test:critter" ? { appearance: "test:img", sizeClass: "medium" } : undefined),
      (ref) => (ref === "test:img" ? { kind: "image", url: "critter.png" } : undefined),
      loadImage,
    );
    return { layer, sprites, loadImage };
  };
  const spriteOf = (layer: SceneLayer, id: string) =>
    layer.group.getObjectByName(id)!.children[1] as THREE.Mesh;

  it("loads each species image once and sizes sprites from it", async () => {
    const { layer, sprites, loadImage } = make();
    const poses = [creature("a", { x: 0, y: 0, z: 0 }), creature("b", { x: 1, y: 0, z: 0 })];
    sprites.update(poses, camera(), 2000);
    await sprites.ready;
    sprites.update(poses, camera(), 2000);
    expect(loadImage).toHaveBeenCalledTimes(1);
    expect(sprites.count).toBe(2);
    const sprite = spriteOf(layer, "a");
    expect(sprite.scale.y).toBeCloseTo(0.8); // a medium creature is 0.8 m tall
    expect(sprite.scale.x).toBeCloseTo(0.4); // the image is half as wide as it is tall
    expect((sprite.material as THREE.MeshBasicMaterial).map).not.toBeNull();
  });

  it("mirrors the sprite when the creature heads left on screen", () => {
    const { layer, sprites } = make();
    const facing = (heading: number) => {
      sprites.update([creature("a", { x: 0, y: 0, z: 0 }, heading)], camera(), 2000);
      return Math.sign(spriteOf(layer, "a").scale.x);
    };
    expect(facing(Math.PI / 2)).toBe(1); // +X, screen right
    expect(facing(-Math.PI / 2)).toBe(-1);
    expect(facing(0)).toBe(-1); // straight at the camera: keeps its last facing
  });

  it("scales sprites up to the minimum on-screen height, and removes departed creatures", () => {
    const { layer, sprites } = make();
    const viewport = 200;
    sprites.update([creature("a", { x: 0, y: 0, z: 0 })], camera(), viewport);
    const pxPerMetre = viewport / (2 * 20 * Math.tan(THREE.MathUtils.degToRad(15)));
    expect(spriteOf(layer, "a").scale.y * pxPerMetre).toBeCloseTo(MIN_SPRITE_PX);
    sprites.update([], camera(), viewport);
    expect(sprites.count).toBe(0);
    expect(layer.group.children).toHaveLength(0);
  });

  it("draws nothing for an unknown species and a plain sprite for a missing image", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { sprites } = make(vi.fn(() => Promise.reject(new Error("missing"))));
    sprites.update(
      [{ ...creature("a", { x: 0, y: 0, z: 0 }), speciesId: "test:other" }],
      camera(),
      2000,
    );
    expect(sprites.count).toBe(0);
    sprites.update([creature("b", { x: 0, y: 0, z: 0 })], camera(), 2000);
    expect(sprites.count).toBe(1);
    expect(warn).toHaveBeenCalledWith("No species test:other to draw");
  });
});

import { defaultBody } from "@living-diorama/content-schema";
import type { CreatureSnapshot, SceneData } from "@living-diorama/simulation";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { CreatureBodies } from "./creatures";
import {
  CHECK_SECONDS,
  CueVisibility,
  HYSTERESIS_CHECKS,
  SLOPE_TOLERANCE,
  visibleState,
} from "./cue-visibility";
import { CUE_OCCLUDER_LAYER, SceneLayer } from "./layers";
import { structureMeshes } from "./world-meshes";

const COLUMNS = 41; // x −10…10
const ROWS = 21; // z −5…5
const CELL = 0.5;

/**
 * A flat 20 × 10 m world at height 0 with a ridge `ridge` metres high along z = 0.5–1 (between the
 * creatures behind it, at z < 0, and the camera, far off at +z), and an optional deck.
 */
const world = (ridge: number, surfaces: SceneData["surfaces"] = []): SceneData => {
  const heights = Array.from({ length: COLUMNS * ROWS }, (_, k) => {
    const z = -5 + Math.floor(k / COLUMNS) * CELL;
    return z >= 0.5 && z <= 1 ? ridge : 0;
  });
  return {
    bounds: { min: { x: -10, y: -1, z: -5 }, max: { x: 10, y: 10, z: 5 } },
    terrain: {
      columns: COLUMNS,
      rows: ROWS,
      cellSize: CELL,
      heights,
      colors: heights.map(() => "#7fae5a"),
    },
    surfaces,
    edgeWater: { north: [], south: [], west: [], east: [] },
    props: [],
    spawnPoints: [],
  };
};

/** A deck 2 m up over x −3…3, z −2…6, with a railing along its west side. */
const deck: SceneData["surfaces"][number] = {
  regionId: "deck",
  kind: "land",
  structureId: "bridge",
  mesh: {
    positions: [-3, 2, -2, 3, 2, -2, 3, 2, 6, -3, 2, 6],
    indices: [0, 2, 1, 0, 3, 2],
  },
  openEdges: [
    [
      { x: -3, y: 2, z: -2 },
      { x: -3, y: 2, z: 6 },
    ],
  ],
};

const make = (scene: SceneData) => {
  const layers = {
    terrain: new SceneLayer("terrain"),
    structures: new SceneLayer("structures"),
    creatures: new SceneLayer("creatures"),
    props: new SceneLayer("props"),
  };
  if (scene.surfaces.length > 0) layers.structures.add(structureMeshes(scene));
  return { layers, visibility: new CueVisibility(scene, layers) };
};

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
/** A 0.4 m creature's head top and middle, standing at (x, y, z). */
const creatureAt = (x: number, y: number, z: number) => [v(x, y + 0.4, z), v(x, y + 0.2, z)];
/** Low and far off, like the strip's default view. */
const CAMERA = v(0, 4, 25);

describe("CueVisibility", () => {
  it("hides a creature behind a ridge of terrain, not one in front of it", () => {
    const { visibility } = make(world(3));
    expect(visibility.hidden(creatureAt(0, 0, -3), CAMERA)).toBe(true);
    expect(visibility.hidden(creatureAt(0, 0, 3), CAMERA)).toBe(false);
    // Seen from high above, the ridge no longer hides it.
    expect(visibility.hidden(creatureAt(0, 0, -3), v(0, 60, 25))).toBe(false);
  });

  it("lets the ground rise a little above the ray, so a slope doesn't hide a creature on it", () => {
    const level = v(0, 0.05, 25);
    const low = world(SLOPE_TOLERANCE * 0.5);
    expect(make(low).visibility.hidden([v(0, 0.02, -1), v(0, 0.01, -1)], level)).toBe(false);
    const high = world(SLOPE_TOLERANCE * 3);
    expect(make(high).visibility.hidden([v(0, 0.02, -1), v(0, 0.01, -1)], level)).toBe(true);
  });

  it("shows the cues while any point is in view", () => {
    const { visibility } = make(world(1));
    // The head's top looks over the ridge, the middle doesn't.
    const [top, middle] = [v(0, 1.6, -0.5), v(0, 0.2, -0.5)];
    expect(visibility.hidden([middle!], CAMERA)).toBe(true);
    expect(visibility.hidden([top!, middle!], CAMERA)).toBe(false);
  });

  it("hides a creature under a deck, but not one standing on it", () => {
    const { visibility } = make(world(0, [deck]));
    const above = v(0, 12, 25);
    expect(visibility.hidden(creatureAt(0, 0, 1), above)).toBe(true);
    expect(visibility.hidden(creatureAt(0, 2, 1), above)).toBe(false);
    expect(visibility.hidden(creatureAt(6, 0, 1), above)).toBe(false); // beside it
  });

  it("is never hidden by props or railings", () => {
    const { layers, visibility } = make(world(0));
    const wall = () =>
      new THREE.Mesh(new THREE.BoxGeometry(20, 20, 1), new THREE.MeshBasicMaterial());
    layers.props.add(wall()); // a tree would be in the props layer
    expect(visibility.hidden(creatureAt(0, 0, -3), CAMERA)).toBe(false);
    // Railings are in the structures layer but too thin to hide anything; decks hide.
    const [slab, ...railings] = structureMeshes(world(0, [deck])).children;
    expect(railings.length).toBeGreaterThan(0);
    for (const mesh of railings) expect(mesh.layers.isEnabled(CUE_OCCLUDER_LAYER)).toBe(false);
    expect(slab!.layers.isEnabled(CUE_OCCLUDER_LAYER)).toBe(true);
    expect(slab!.layers.isEnabled(0)).toBe(true); // still drawn and casting shadows
  });

  it("hides the cues of a creature whose head is clipped away", () => {
    const { layers, visibility } = make(world(0));
    expect(visibility.hidden(creatureAt(0, 0, 3), CAMERA)).toBe(false);
    // Keep only z < 2 of the creatures.
    layers.creatures.setClipping([{ normal: { x: 0, y: 0, z: -1 }, constant: 2 }]);
    expect(visibility.hidden(creatureAt(0, 0, 3), CAMERA)).toBe(true);
    expect(visibility.hidden(creatureAt(0, 0, 1), CAMERA)).toBe(false);
  });

  it("isn't hidden by terrain or a deck that a cutaway clips", () => {
    const ridge = make(world(3));
    // Cut away the terrain in front of z = 0, ridge included.
    ridge.layers.terrain.setClipping([{ normal: { x: 0, y: 0, z: -1 }, constant: 0 }]);
    expect(ridge.visibility.hidden(creatureAt(0, 0, -3), CAMERA)).toBe(false);
    ridge.layers.terrain.setClipping([]);
    expect(ridge.visibility.hidden(creatureAt(0, 0, -3), CAMERA)).toBe(true);

    const bridge = make(world(0, [deck]));
    const above = v(0, 12, 25);
    // Cut away everything above y = 1.
    bridge.layers.structures.setClipping([{ normal: { x: 0, y: -1, z: 0 }, constant: 1 }]);
    expect(bridge.visibility.hidden(creatureAt(0, 0, 1), above)).toBe(false);
  });

  it("checks on its own schedule, waits out a flicker and fades", () => {
    const { visibility } = make(world(3));
    const behind = creatureAt(0, 0, -3);
    const front = creatureAt(0, 0, 3);
    const state = visibleState(0.5);
    // The first check takes effect at once.
    visibility.update(state, behind, CAMERA, 0, 0);
    expect(state.hidden).toBe(true);
    expect(state.weight).toBe(0);
    const spy = vi.spyOn(visibility, "hidden");
    let t = 0;
    const step = (points: THREE.Vector3[]) =>
      visibility.update(state, points, CAMERA, (t += 0.05), 0.05);
    // Not due yet: no check.
    step(front);
    expect(spy).not.toHaveBeenCalled();
    // One check in view isn't enough...
    while (spy.mock.calls.length < 1) step(front);
    expect(state.hidden).toBe(true);
    // ...and a check that agrees again resets the count.
    while (spy.mock.calls.length < 2) step(behind);
    while (spy.mock.calls.length < 3) step(front);
    expect(state.hidden).toBe(true);
    while (spy.mock.calls.length < 2 + HYSTERESIS_CHECKS) step(front);
    expect(state.hidden).toBe(false);
    expect(state.weight).toBeLessThan(1);
    // Checks are about CHECK_SECONDS apart.
    const before = spy.mock.calls.length;
    const start = t;
    while (t - start < CHECK_SECONDS * 10 - 1e-9) step(front);
    expect(spy.mock.calls.length - before).toBeGreaterThanOrEqual(9);
    expect(spy.mock.calls.length - before).toBeLessThanOrEqual(11);
    expect(state.weight).toBe(1);
  });

  it("fades a creature's cues out behind the ridge and back in front of it", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { layers, visibility } = make(world(3));
    const bodies = new CreatureBodies(layers.creatures, {
      resolveSpecies: () => ({
        appearance: "x",
        sizeClass: "small",
        body: { ...defaultBody(), thickness: 0.25 },
      }),
      resolveAsset: () => undefined,
      visibility,
    });
    const camera = new THREE.PerspectiveCamera(30, 4, 0.5, 400);
    camera.position.copy(CAMERA);
    camera.lookAt(0, 0, 0);
    const view = { camera, heightPx: 220 };
    // A hungry creature: once its cue has faded in, the bubble's opacity is the visibility weight.
    const hungry = (z: number): CreatureSnapshot => ({
      id: "a",
      speciesId: "test:critter",
      position: { regionId: "r", x: 0, z },
      world: { x: 0, y: 0, z },
      heading: 0,
      cues: ["hungry"],
    });
    const bubble = () => {
      let found: THREE.Sprite | undefined;
      layers.creatures.group.traverse((o) => {
        if (o instanceof THREE.Sprite && o.visible && o.name === "cue:bubble") found = o;
      });
      return found;
    };
    let t = 0;
    /** Runs frames 0.05 s apart for `seconds` with the creature at `z`, noting the bubble's opacity. */
    const run = (z: number, seconds: number) => {
      const opacities: number[] = [];
      for (const end = t + seconds; t < end - 1e-9;) {
        t += 0.05;
        bodies.update([hungry(z)], { time: t, realTime: t, view });
        opacities.push(bubble()?.material.opacity ?? 0);
      }
      return opacities;
    };
    const between = (values: number[]) => values.some((o) => o > 0.05 && o < 0.95);

    run(3, 2);
    expect(bubble()?.material.opacity).toBe(1);
    expect(bodies.cueSprites).toBe(1);

    const out = run(-3, 2);
    expect(between(out)).toBe(true); // fades rather than pops
    expect(out.at(-1)).toBe(0);
    expect(bubble()).toBeUndefined();
    expect(bodies.cueSprites).toBe(0); // back in the pool

    const back = run(3, 2);
    expect(between(back)).toBe(true);
    expect(bodies.cueSprites).toBe(1);
    expect(bubble()?.material.opacity).toBe(1);
  });
});

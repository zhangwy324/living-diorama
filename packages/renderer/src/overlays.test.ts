import type { Vec3 } from "@living-diorama/content-schema";
import type {
  CreatureSnapshot,
  NavigationCell,
  NavigationOverlay,
  SceneData,
} from "@living-diorama/simulation";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { formatStats } from "./debug-stats";
import type { CreaturePose } from "./interpolation";
import { createDebugOverlays, regionGraph, walkabilityMesh } from "./overlays";
import { FrameThrottle } from "./throttle";

const cell = (x: number, z: number, walkable: boolean): NavigationCell => ({
  walkable,
  corners: [
    { x, y: 0, z },
    { x: x + 1, y: 0, z },
    { x: x + 1, y: 0, z: z + 1 },
    { x, y: 0, z: z + 1 },
  ],
});

const navigation: NavigationOverlay = {
  profileKey: "test",
  regions: [
    {
      regionId: "west",
      anchor: { x: -2, y: 0, z: 0 },
      cells: [cell(-3, 0, true), cell(-2, 0, false)],
    },
    { regionId: "east", anchor: { x: 2, y: 0, z: 0 }, cells: [cell(2, 0, true)] },
    { regionId: "island", anchor: { x: 0, y: 0, z: 5 }, cells: [] },
  ],
  portals: [
    {
      connectionId: "bridge",
      from: "west",
      to: "east",
      bidirectional: true,
      a: { x: 0, y: 0, z: -1 },
      b: { x: 0, y: 0, z: 1 },
      usable: true,
    },
    {
      connectionId: "ford",
      from: "east",
      to: "island",
      bidirectional: true,
      a: { x: 1, y: 0, z: 4 },
      b: { x: 2, y: 0, z: 4 },
      usable: false,
      reason: "missing_capability: needs swim",
    },
  ],
};

const scene = {
  props: [],
  surfaces: [
    {
      regionId: "river",
      kind: "water",
      mesh: { positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], indices: [0, 2, 1] },
    },
    {
      regionId: "deck",
      kind: "land",
      structureId: "bridge",
      mesh: { positions: [0, 1, 0, 1, 1, 0, 0, 1, 1], indices: [0, 2, 1] },
    },
  ],
} as unknown as SceneData;

const lineColors = (group: THREE.Group) =>
  group.children
    .filter((o): o is THREE.LineSegments => o instanceof THREE.LineSegments)
    .map((o) => ({
      color: `#${(o.material as THREE.LineBasicMaterial).color.getHexString()}`,
      vertices: o.geometry.getAttribute("position")?.count ?? 0,
    }));

describe("debug overlays", () => {
  it("draws two triangles per cell, coloured by walkability", () => {
    const mesh = walkabilityMesh(navigation);
    const colors = mesh.geometry.getAttribute("color");
    expect(mesh.geometry.getAttribute("position").count).toBe(3 * 6);
    expect(colors.getX(0)).toBeLessThan(colors.getY(0)); // walkable: green
    expect(colors.getX(6)).toBeGreaterThan(colors.getY(6)); // blocked: red
  });

  it("joins graph nodes only through usable portals", () => {
    const graph = regionGraph(navigation);
    expect(lineColors(graph)).toEqual([
      { color: "#ffd84a", vertices: 4 }, // west → bridge middle → east
      { color: "#38c9f2", vertices: 2 },
      { color: "#ff3b8d", vertices: 2 },
    ]);
    expect(graph.children.filter((o) => o instanceof THREE.Mesh)).toHaveLength(3);
  });

  it("starts hidden and wireframes only structure surfaces", () => {
    const overlays = createDebugOverlays(scene, navigation);
    expect(overlays.group.visible).toBe(false);
    const decks = overlays.group.getObjectByName("deck-surfaces")!;
    expect(decks.children).toHaveLength(1);
    expect(
      createDebugOverlays(scene, undefined).group.getObjectByName("walkability"),
    ).toBeUndefined();
  });

  it("draws routes from the drawn position and drops them when the walk ends", () => {
    const { routes } = createDebugOverlays(scene, undefined);
    const world: Vec3 = { x: 0, y: 0, z: 0 };
    const creature = (route?: CreatureSnapshot["route"]): CreatureSnapshot => ({
      id: "a",
      speciesId: "s",
      position: { regionId: "west", ...world },
      world,
      heading: 0,
      animation: undefined,
      submersion: 0,
      cues: [],
      ...(route ? { route } : {}),
    });
    const poses: CreaturePose[] = [
      {
        id: "a",
        speciesId: "s",
        world: { x: 0.5, y: 0, z: 0 },
        heading: 0,
        cues: [],
        animation: undefined,
        submersion: 0,
      },
    ];
    const legs = [
      { regionId: "west", points: [{ x: 1, y: 0, z: 0 }] },
      {
        regionId: "east",
        points: [
          { x: 2, y: 0, z: 0 },
          { x: 3, y: 0, z: 1 },
        ],
      },
    ];
    routes.setRoutes({
      tick: 1,
      timeMs: 100,
      paused: false,
      timeOfDay: 720,
      creatures: [creature(legs)],
    });
    routes.update(poses);
    const line = routes.group.children[0] as THREE.Line;
    const positions = line.geometry.getAttribute("position");
    expect(positions.count).toBe(4);
    expect(positions.getX(0)).toBe(0.5);

    routes.setRoutes({
      tick: 2,
      timeMs: 200,
      paused: false,
      timeOfDay: 720,
      creatures: [creature()],
    });
    routes.update(poses);
    expect(routes.count).toBe(0);
    expect(routes.group.children).toHaveLength(0);
  });
});

describe("FrameThrottle", () => {
  const rendered = (timestamps: number[], fullRate: boolean) => {
    const throttle = new FrameThrottle();
    return timestamps.filter((t) => throttle.due(t, fullRate)).length;
  };
  const frames = (count: number, step: (n: number) => number) =>
    Array.from({ length: count }, (_, n) => step(n));

  it("renders every frame at full rate", () => {
    expect(
      rendered(
        frames(60, (n) => n * (1000 / 60)),
        true,
      ),
    ).toBe(60);
  });

  it("renders about 30 fps when idle, even with timestamps rounded to 10 ms", () => {
    expect(
      rendered(
        frames(60, (n) => n * (1000 / 60)),
        false,
      ),
    ).toBe(30);
    expect(
      rendered(
        frames(60, (n) => Math.round((n * (1000 / 60)) / 10) * 10),
        false,
      ),
    ).toBe(30);
    expect(
      rendered(
        frames(144, (n) => n * (1000 / 144)),
        false,
      ),
    ).toBeCloseTo(30, -1);
  });

  it("restarts after a long gap instead of catching up", () => {
    const throttle = new FrameThrottle();
    throttle.due(0, false);
    expect(throttle.due(5000, false)).toBe(true);
    expect(throttle.due(5016, false)).toBe(false);
  });

  it("renders an idle frame within one interval after full rate ends", () => {
    const throttle = new FrameThrottle();
    const hovered = frames(600, (n) => n * (1000 / 60));
    for (const t of hovered) throttle.due(t, true);
    const last = hovered.at(-1) ?? 0;
    const idle = frames(10, (n) => last + (n + 1) * (1000 / 60));
    const first = idle.find((t) => throttle.due(t, false));
    expect(first).toBeDefined();
    expect((first ?? Infinity) - last).toBeLessThanOrEqual(throttle.idleIntervalMs + 1);
  });
});

it("formats the stats panel", () => {
  expect(
    formatStats({
      fps: 29.6,
      fullRate: false,
      tick: 42,
      ticksPerSecond: 10,
      creatures: 3,
      walking: 1,
    }),
  ).toBe("30 fps (idle)\ntick 42 · 10.0/s\n3 creatures · 1 walking");
});

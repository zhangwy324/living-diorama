import { createRegistries, type Registries } from "@living-diorama/extension-api";
import { describe, expect, it } from "vitest";
import {
  buildRegionMask,
  buildWorldModel,
  CellState,
  coreSurfaces,
  profileForSpecies,
  registerCoreEngine,
  Terrain,
  triangulate,
  type WorldModel,
} from "../index";

describe("Terrain", () => {
  // A single cell whose four corners differ, so the diagonal choice is visible.
  const terrain = new Terrain(2, 2, 1, 0, 0, [0, 1, 2, 4]);

  it("interpolates on the fixed (i, j)–(i+1, j+1) diagonal, not bilinearly", () => {
    expect(terrain.heightAt(0, 0)).toBe(0);
    expect(terrain.heightAt(1, 1)).toBe(4);
    // Upper triangle (fx ≥ fz): h00 + fx·(h10 − h00) + fz·(h11 − h10).
    expect(terrain.heightAt(0.75, 0.25)).toBeCloseTo(0.75 + 0.25 * 3);
    // Lower triangle: h00 + fz·(h01 − h00) + fx·(h11 − h01).
    expect(terrain.heightAt(0.25, 0.75)).toBeCloseTo(0.75 * 2 + 0.25 * 2);
    // Bilinear would give 1.75 at the centre; the diagonal gives the mean of h00 and h11.
    expect(terrain.heightAt(0.5, 0.5)).toBeCloseTo(2);
  });

  it("clamps queries outside the grid to its edge", () => {
    expect(terrain.heightAt(-5, 0)).toBe(0);
    expect(terrain.heightAt(5, 5)).toBe(4);
  });

  it("reports the slope of the containing triangle", () => {
    expect(terrain.slopeAt(0.75, 0.25)).toBeCloseTo(Math.atan(Math.hypot(1, 3)));
    expect(terrain.slopeAt(0.25, 0.75)).toBeCloseTo(Math.atan(Math.hypot(2, 2)));
  });
});

describe("surfaces", () => {
  const terrain = new Terrain(2, 2, 1, 0, 0, [0, 0, 0, 0]);
  const create = (id: string, params: unknown) =>
    coreSurfaces.find((s) => s.id === id)!.create(params, { terrain });

  it("deck: linear along the centerline, flat across, cut off at its ends and sides", () => {
    const deck = create("core:deck", {
      centerline: [
        { x: 0, y: 1, z: 0 },
        { x: 4, y: 2, z: 0 },
      ],
      width: 1,
    });
    expect(deck.heightAt(2, 0.4)).toBeCloseTo(1.5);
    expect(deck.heightAt(2, 0.6)).toBeUndefined();
    expect(deck.heightAt(-0.1, 0)).toBeUndefined();
    expect(deck.heightAt(4.1, 0)).toBeUndefined();
    expect(deck.edgeDistance(2, 0.2)).toBeCloseTo(0.3);
    expect(deck.slopeAt(1, 0)).toBeCloseTo(Math.atan(1 / 4));
  });

  it("flat: one height everywhere and a triangulated mesh over the footprint", () => {
    const flat = create("core:flat", { y: 0.5 });
    expect(flat.heightAt(123, -4)).toBe(0.5);
    const mesh = flat.mesh([
      { x: 0, z: 0 },
      { x: 2, z: 0 },
      { x: 2, z: 2 },
      { x: 1, z: 1 },
      { x: 0, z: 2 },
    ]);
    expect(mesh?.indices).toHaveLength(9);
  });
});

it("triangulates concave polygons of either winding", () => {
  const notch = [
    { x: 0, z: 0 },
    { x: 4, z: 0 },
    { x: 4, z: 4 },
    { x: 2, z: 1 },
    { x: 0, z: 4 },
  ];
  expect(triangulate(notch)).toHaveLength(9);
  expect(triangulate([...notch].reverse())).toHaveLength(9);
  // The reflex corner (2, 1) must not be the tip of an ear that covers the notch.
  expect(triangulate(notch).join()).not.toContain("2,3,4");
});

describe("walkability", () => {
  // 8 × 4 m, 0.5 m cells. West half flat at 1 m with a 3 m cliff step at x = 2; a water region
  // at y = 1.5 covers a dip in the north-west; one prop sits in the flat part.
  function setup(): { registries: Registries; model: WorldModel } {
    const columns = 17;
    const rows = 9;
    const heights = Array.from({ length: columns * rows }, (_, k) => {
      const x = -4 + (k % columns) * 0.5;
      const z = -2 + Math.floor(k / columns) * 0.5;
      if (x >= 2) return 4;
      if (x <= -2.5 && z <= -1) return 0.5;
      return 1;
    });
    const registries = createRegistries();
    registerCoreEngine(registries);
    registries.species.register({
      schemaVersion: 1,
      id: "test:walker",
      version: "1.0.0",
      name: "Walker",
      appearance: "test:walker.png",
      sizeClass: "medium",
      capabilities: { "core:walk": 1 },
      baseSpeed: 1,
      behaviors: ["core:wander"],
    });
    const world = registries.worlds.register({
      schemaVersion: 1,
      id: "test:plain",
      version: "1.0.0",
      name: "Plain",
      bounds: { min: { x: -4, y: -1, z: -2 }, max: { x: 4, y: 5, z: 2 } },
      terrain: {
        heightfield: { source: "inline", columns, rows, cellSize: 0.5, heights },
        materials: {
          palette: [{ name: "grass", color: "#00ff00" }],
          indices: { source: "inline", values: heights.map(() => 0) },
        },
      },
      regions: [
        {
          id: "ground",
          kind: "land",
          surface: { type: "core:heightfield" },
          footprint: [
            { x: -4, z: -2 },
            { x: 4, z: -2 },
            { x: 4, z: 2 },
            { x: -4, z: 2 },
          ],
        },
        {
          id: "pond",
          kind: "water",
          surface: { type: "core:flat", params: { y: 0.8 } },
          footprint: [
            { x: -4, z: -2 },
            { x: -1, z: -2 },
            { x: -1, z: 0 },
            { x: -4, z: 0 },
          ],
        },
      ],
      props: [
        {
          id: "rock",
          model: "test:rock.glb",
          transform: { position: { x: 0, y: 1, z: 1 } },
          blockRadius: 0.3,
        },
      ],
      spawnPoints: [{ id: "s", position: { regionId: "ground", x: 0, z: 0 } }],
    });
    if (!world.ok) throw new Error(JSON.stringify(world.diagnostics));
    const model = buildWorldModel(world.value, registries);
    if (!model.ok) throw new Error(JSON.stringify(model.diagnostics));
    return { registries, model: model.value };
  }

  it("derives steep, submerged, prop, edge and clearance blocks from the definition", () => {
    const { registries, model } = setup();
    const profile = profileForSpecies(registries.species.get("test:walker")!, registries);
    const mask = buildRegionMask(model, model.regions.get("ground")!, profile);
    const stateAt = (x: number, z: number) => mask.state(mask.cellAt(x, z));

    expect(stateAt(0.25, -0.25)).toBe(CellState.walkable);
    expect(stateAt(1.75, 0.25)).toBe(CellState.steep);
    expect(stateAt(1.25, 0.25)).toBe(CellState.tooClose);
    expect(stateAt(-3.25, -1.75)).toBe(CellState.submerged);
    expect(stateAt(0.25, 1.25)).toBe(CellState.prop);
    expect(stateAt(-3.75, 1.25)).toBe(CellState.worldEdge);
    expect(stateAt(3, 0.25)).toBe(CellState.walkable);
    // The cliff splits the ground into two walkable areas.
    expect(mask.components()).toHaveLength(2);
  });

  it("uses the most permissive locomotion rule a species has", () => {
    const { registries } = setup();
    registries.capabilities.register({
      id: "test:climb",
      version: "1.0.0",
      locomotion: { regionKinds: ["land"] },
    });
    const climber = {
      ...registries.species.get("test:walker")!,
      capabilities: { "core:walk": 1, "test:climb": 0.5 },
    };
    const profile = profileForSpecies(climber, registries);
    expect(profile.maxSlopeByKind.get("land")).toBe(Infinity);
    expect(profile.maxSlopeByKind.get("cave")).toBeCloseTo((35 * Math.PI) / 180);
    expect(profile.maxSlopeByKind.has("water")).toBe(false);
  });
});

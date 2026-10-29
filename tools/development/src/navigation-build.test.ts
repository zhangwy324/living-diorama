import { formatDiagnostic, SIZE_CLASSES, type SizeClass } from "@living-diorama/content-schema";
import {
  createRegistries,
  resolveReferences,
  type Registries,
} from "@living-diorama/extension-api";
import {
  buildNavigation,
  buildWorldModel,
  CellState,
  navProfile,
  raisedSurfaces,
  registerCoreEngine,
  speciesProfiles,
  type NavProfile,
  type RegionMask,
} from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import { registerFarShelter } from "./fixtures/far-shelter";
import { registerNavBoundaries } from "./fixtures/nav-boundaries";
import { registerHollowCreatures, registerPond, registerRiverCrossing } from "./index";
import { referenceBanks, referenceRaisedSurfaces, referenceRegionMask } from "./navigation-oracle";

// Navigation building shares profile-independent cell facts across profiles and tests footprints a
// row at a time. It must give exactly what the plain per-cell build (the oracle) gives, bit for
// bit, for every profile.

function load(register: (registries: Registries) => unknown): Registries {
  const registries = createRegistries();
  registerCoreEngine(registries);
  register(registries);
  const resolution = resolveReferences(registries);
  expect(resolution.diagnostics.map(formatDiagnostic)).toEqual([]);
  return registries;
}

/** The registered species' profiles, then every size class with land, water or both. */
function profiles(registries: Registries): NavProfile[] {
  const sets = [["core:land"], ["core:swim"], ["core:land", "core:swim"]];
  return [
    ...speciesProfiles(registries),
    ...(Object.keys(SIZE_CLASSES) as SizeClass[]).flatMap((size) =>
      sets.map((set) => navProfile(size, set, registries)),
    ),
  ];
}

function expectSameMask(actual: RegionMask, expected: RegionMask) {
  const { i0, j0, columns, rows, cellSize, originX, originZ } = expected;
  expect(actual).toMatchObject({ i0, j0, columns, rows, cellSize, originX, originZ });
  expect(actual.states).toEqual(expected.states);
  // Bit for bit, NaN included.
  expect(new Uint8Array(actual.heights.buffer)).toEqual(new Uint8Array(expected.heights.buffer));
}

describe.each([
  ["Woodland Hollow with the soak's species", registerHollowCreatures, "hollow:woodland-hollow"],
  ["the pond fixture", registerPond, "fixture:pond"],
  ["the river-crossing fixture", registerRiverCrossing, "fixture:river-crossing"],
  ["the far-shelter fixture", registerFarShelter, "fixture:far-shelter"],
  ["the boundaries fixture", registerNavBoundaries, "fixture:nav-boundaries"],
] as const)("navigation building on %s", (_, register, worldId) => {
  const registries = load(register);
  const world = registries.worlds.get(worldId)!;
  const built = buildWorldModel(world, registries);
  if (!built.ok) throw new Error(built.diagnostics.map(formatDiagnostic).join("\n"));
  const model = built.value;

  it("finds the same raised surfaces", () => {
    expect(raisedSurfaces(model)).toEqual(referenceRaisedSurfaces(model));
  });

  it.each(profiles(registries).map((p) => [p.key, p] as const))(
    "gives the oracle's masks and banks for %s",
    (_key, profile) => {
      const nav = buildNavigation(model, profile);
      const masks = new Map(
        [...model.regions.values()].map((r) => [r.id, referenceRegionMask(model, r, profile)]),
      );
      expect([...nav.masks.keys()]).toEqual([...masks.keys()]);
      for (const [id, expected] of masks) expectSameMask(nav.masks.get(id)!, expected);
      expect(nav.banks).toEqual(referenceBanks(model, masks, profile));
    },
  );
});

describe("the boundaries fixture", () => {
  const registries = load(registerNavBoundaries);
  const built = buildWorldModel(registries.worlds.get("fixture:nav-boundaries")!, registries);
  if (!built.ok) throw new Error(built.diagnostics.map(formatDiagnostic).join("\n"));
  const model = built.value;
  const land = (size: SizeClass) => navProfile(size, ["core:land"], registries);
  const stateAt = (size: SizeClass, x: number, z: number) => {
    const mask = buildNavigation(model, land(size)).masks.get("ground")!;
    return mask.state(mask.cellAt(x, z));
  };

  it.each(Object.keys(SIZE_CLASSES) as SizeClass[])(
    "has a prop exactly the reach of size class %s from a cell centre",
    (size) => {
      const { radius } = land(size);
      const mask = buildNavigation(model, land(size)).masks.get("ground")!;
      const exact = model.props.some((p) =>
        mask.states.some((_, cell) => {
          const c = mask.center(cell);
          const { x, z } = p.transform.position;
          return Math.hypot(x - c.x, z - c.z) === p.blockRadius + radius;
        }),
      );
      expect(exact).toBe(true);
    },
  );

  it("has surfaces exactly epsilon, a step and a creature's height above the ground", () => {
    // Epsilon above is the same surface; a step above is the pad's (covered).
    expect(stateAt("tiny", -4.75, -2.75)).toBe(CellState.walkable);
    expect(stateAt("tiny", -3.25, -2.75)).toBe(CellState.covered);
    // The small pad lies exactly a small creature's height up: room for it, not for a medium one.
    expect(stateAt("small", 0.25, -2.75)).toBe(CellState.walkable);
    expect(stateAt("medium", 0.25, -2.75)).toBe(CellState.noHeadroom);
    expect(stateAt("medium", 1.75, -2.75)).toBe(CellState.walkable);
  });
});

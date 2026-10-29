import { formatDiagnostic, SIZE_CLASSES, type SizeClass } from "@living-diorama/content-schema";
import {
  createRegistries,
  resolveReferences,
  type Registries,
} from "@living-diorama/extension-api";
import {
  buildNavigation,
  buildWorldModel,
  navProfile,
  raisedSurfaces,
  registerCoreEngine,
  speciesProfiles,
  type NavProfile,
  type RegionMask,
} from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import { registerFarShelter } from "./fixtures/far-shelter";
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

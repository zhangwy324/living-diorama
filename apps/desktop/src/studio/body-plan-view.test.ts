import { registerCoreEngine } from "@living-diorama/simulation";
import { createRegistries, type LocomotionRule } from "@living-diorama/extension-api";
import { describe, expect, it } from "vitest";
import { planVoxelBody, type LocomotionChoice } from "../body-plan";
import { chosenMode, planHeading, previewModes } from "./body-plan-view";

const LAND: LocomotionChoice = { land: true, gait: "walk", swim: false };
const SWIM: LocomotionChoice = { land: false, gait: "walk", swim: true };
const BOTH: LocomotionChoice = { land: true, gait: "walk", swim: true };

/** The engine's own locomotion rules, as the worker's limits answer carries them. */
function coreRules(): Record<string, LocomotionRule> {
  const registries = createRegistries();
  registerCoreEngine(registries);
  const rules: Record<string, LocomotionRule> = {};
  for (const id of ["core:land", "core:swim"]) {
    const rule = registries.capabilities.get(id)?.locomotion;
    if (rule) rules[id] = rule;
  }
  return rules;
}

/** The preview's ways of moving for `locomotion`, with a body planned from it. */
const modesOf = (locomotion: LocomotionChoice, rules: Record<string, LocomotionRule>) =>
  previewModes(locomotion, planVoxelBody({ locomotion }), rules);

describe("the preview's ways of moving", () => {
  it("plays the land gait's profile on land and the swim lowered into the water", () => {
    const rules = coreRules();
    expect(modesOf({ land: true, gait: "walk", swim: false }, rules)).toEqual([
      { key: "land", label: "Walking", motion: { profile: "walk", submersion: 0, speed: 0.6 } },
    ]);
    expect(modesOf({ land: true, gait: "hop", swim: true }, rules)).toEqual([
      { key: "land", label: "Hopping", motion: { profile: "hop", submersion: 0, speed: 0.6 } },
      { key: "swim", label: "Swimming", motion: { profile: "swim", submersion: 0.5, speed: 0.6 } },
    ]);
    expect(modesOf({ land: false, gait: "hop", swim: false }, rules)).toEqual([]);
  });

  it("moves as the capabilities' rules say, so changing a rule in content changes the preview", () => {
    const rules = {
      ...coreRules(),
      "core:swim": { regionKinds: ["water"], animation: "paddle", submersion: 0.8 },
      "core:land": { regionKinds: ["land"], animation: "waddle" },
    } satisfies Record<string, LocomotionRule>;
    expect(modesOf(BOTH, rules).map((mode) => mode.motion)).toEqual([
      { profile: "waddle", submersion: 0, speed: 0.6 },
      { profile: "paddle", submersion: 0.8, speed: 0.6 },
    ]);
    // A rule with no animation sits at its submersion with no motion, as in the diorama.
    expect(modesOf(SWIM, { "core:swim": { regionKinds: ["water"], submersion: 0.3 } })).toEqual([
      {
        key: "swim",
        label: "Swimming",
        motion: { profile: undefined, submersion: 0.3, speed: 0.6 },
      },
    ]);
  });

  it("stands still in a way of moving until its rule has come", () => {
    const { "core:land": land } = coreRules();
    expect(modesOf(BOTH, land ? { "core:land": land } : {})).toEqual([
      { key: "land", label: "Walking", motion: { profile: "walk", submersion: 0, speed: 0.6 } },
      { key: "swim", label: "Swimming", motion: undefined },
    ]);
  });

  it("keeps the mode picked while it is offered, else plays the first", () => {
    const both = modesOf(BOTH, coreRules());
    expect(chosenMode(both, "swim")?.key).toBe("swim");
    expect(chosenMode(both, undefined)?.key).toBe("land");
    expect(chosenMode(modesOf(LAND, coreRules()), "swim")?.key).toBe("land");
  });
});

it("names the creature in the reveal's heading when it has a name", () => {
  expect(planHeading("  Mossy Pebble ")).toBe("How does Mossy Pebble move?");
  expect(planHeading("  ")).toBe("How does it move?");
});

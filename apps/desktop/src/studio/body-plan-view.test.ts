import { registerCoreEngine } from "@living-diorama/simulation";
import { createRegistries, type LocomotionRule } from "@living-diorama/extension-api";
import { describe, expect, it } from "vitest";
import { defaultPlan, planBody, type BodyPlanChoice, type LocomotionChoice } from "../body-plan";
import {
  afterDrawingEdit,
  anchorNote,
  chosenMode,
  drawingPoint,
  placeAnchor,
  placingAnchor,
  planHeading,
  previewModes,
  resetAnchors,
} from "./body-plan-view";

const LAND: LocomotionChoice = { land: true, gait: "walk", swim: false };
const SWIM: LocomotionChoice = { land: false, gait: "walk", swim: true };
const BOTH: LocomotionChoice = { land: true, gait: "walk", swim: true };
const moving = (locomotion: LocomotionChoice): BodyPlanChoice => ({ locomotion, anchors: {} });

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
  previewModes(locomotion, planBody(moving(locomotion), 0.4), rules);

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

describe("placing anchors", () => {
  it("turns a click into whole drawing pixels, kept on the drawing", () => {
    const box = { left: 100, top: 50, width: 512, height: 512 };
    expect(drawingPoint(100, 50, box)).toEqual({ x: 0, y: 0 });
    expect(drawingPoint(356, 306, box)).toEqual({ x: 128, y: 128 });
    expect(drawingPoint(357, 307, box)).toEqual({ x: 129, y: 129 });
    expect(drawingPoint(0, 1000, box)).toEqual({ x: 0, y: 256 });
  });

  it("places only the points its ways of moving use, and resets to the defaults", () => {
    const walker = placeAnchor(moving(LAND), "centerOfGravity", { x: 90, y: 110 });
    expect(walker.anchors).toEqual({ centerOfGravity: { x: 90, y: 110 } });
    expect(placeAnchor(walker, "tail", { x: 1, y: 1 })).toBe(walker);
    const swimmer = moving(SWIM);
    expect(placeAnchor(swimmer, "centerOfGravity", { x: 1, y: 1 })).toBe(swimmer);
    const both = placeAnchor(placeAnchor(moving(BOTH), "tail", { x: 5, y: 6 }), "centerOfGravity", {
      x: 7,
      y: 8,
    });
    expect(both.anchors).toEqual({ tail: { x: 5, y: 6 }, centerOfGravity: { x: 7, y: 8 } });
    expect(resetAnchors(both).anchors).toEqual({});
    expect(resetAnchors(both).locomotion).toEqual(both.locomotion);
  });

  it("resets only the points shown, keeping a placed one hidden by a way of moving that is off", () => {
    const placed = {
      locomotion: SWIM,
      anchors: { centerOfGravity: { x: 7, y: 8 }, tail: { x: 5, y: 6 } },
    };
    expect(resetAnchors(placed).anchors).toEqual({ centerOfGravity: { x: 7, y: 8 } });
    expect(resetAnchors({ ...placed, locomotion: LAND }).anchors).toEqual({ tail: { x: 5, y: 6 } });
    // A drawing edit still drops every placed point, shown or not.
    expect(afterDrawingEdit(placed).anchors).toEqual({});
  });

  it("places the point chosen while it is shown, else the first, and none with no way of moving", () => {
    expect(placingAnchor(["centerOfGravity", "tail"], "tail")).toBe("tail");
    expect(placingAnchor(["centerOfGravity", "tail"], undefined)).toBe("centerOfGravity");
    expect(placingAnchor(["tail"], "centerOfGravity")).toBe("tail");
    expect(placingAnchor([], "tail")).toBeUndefined();
  });
});

it("names the creature in the reveal's heading when it has a name", () => {
  expect(planHeading("  Mossy Pebble ")).toBe("How does Mossy Pebble move?");
  expect(planHeading("  ")).toBe("How does it move?");
});

describe("after the drawing changes", () => {
  it("drops placed anchors, back to their defaults, and keeps every other choice", () => {
    const plan = {
      locomotion: { land: true, gait: "hop" as const, swim: true },
      anchors: { centerOfGravity: { x: 90, y: 110 } },
    };
    expect(afterDrawingEdit(plan)).toEqual({ ...plan, anchors: {} });
  });

  it("leaves a plan with nothing placed as it is", () => {
    const plan = defaultPlan();
    expect(afterDrawingEdit(plan)).toBe(plan);
  });
});

describe("the anchor layer's note for screen readers", () => {
  it("says whether each point is placed or at its default", () => {
    expect(anchorNote(moving(LAND), "centerOfGravity")).toBe(
      "Center of gravity not placed, so the default position is used. Click the drawing to place the center of gravity.",
    );
    expect(anchorNote(placeAnchor(moving(SWIM), "tail", { x: 1, y: 2 }), "tail")).toBe(
      "Tail placed. Click the drawing to move the tail.",
    );
    expect(anchorNote(placeAnchor(moving(BOTH), "tail", { x: 1, y: 2 }), "tail")).toBe(
      "Center of gravity not placed, so the default position is used. Tail placed. Click the drawing to move the tail.",
    );
    expect(anchorNote(moving({ ...BOTH, land: false, swim: false }), undefined)).toBe("");
  });
});

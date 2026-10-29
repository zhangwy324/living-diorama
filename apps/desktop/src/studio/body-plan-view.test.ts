import { describe, expect, it } from "vitest";
import { templatePlan } from "../body-plan";
import {
  afterDrawingEdit,
  anchorNote,
  chosenMode,
  drawingPoint,
  placeAnchor,
  planHeading,
  previewModes,
  resetAnchors,
} from "./body-plan-view";

describe("the preview's ways of moving", () => {
  it("plays the land gait's profile on land and the swim lowered into the water", () => {
    expect(previewModes({ land: true, gait: "walk", swim: false })).toEqual([
      { key: "land", label: "Walking", motion: { profile: "walk", submersion: 0, speed: 0.6 } },
    ]);
    expect(previewModes({ land: true, gait: "hop", swim: true })).toEqual([
      { key: "land", label: "Hopping", motion: { profile: "hop", submersion: 0, speed: 0.6 } },
      { key: "swim", label: "Swimming", motion: { profile: "swim", submersion: 0.5, speed: 0.6 } },
    ]);
    expect(previewModes({ land: false, gait: "hop", swim: false })).toEqual([]);
  });

  it("keeps the mode picked while it is offered, else plays the first", () => {
    const both = previewModes({ land: true, gait: "walk", swim: true });
    expect(chosenMode(both, "swim")?.key).toBe("swim");
    expect(chosenMode(both, undefined)?.key).toBe("land");
    expect(chosenMode(previewModes({ land: true, gait: "walk", swim: false }), "swim")?.key).toBe(
      "land",
    );
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

  it("places only the template's anchors, and resets to the defaults", () => {
    const walker = placeAnchor(templatePlan("walker"), "feet", { x: 90, y: 210 });
    expect(walker.anchors).toEqual({ feet: { x: 90, y: 210 } });
    expect(placeAnchor(walker, "tail", { x: 1, y: 1 })).toBe(walker);
    const hopper = templatePlan("hopper");
    expect(placeAnchor(hopper, "feet", { x: 1, y: 1 })).toBe(hopper);
    expect(resetAnchors(walker).anchors).toEqual({});
    expect(resetAnchors(walker).locomotion).toEqual(walker.locomotion);
  });
});

it("names the creature in the reveal's heading when it has a name", () => {
  expect(planHeading("  Mossy Pebble ")).toBe("How does Mossy Pebble move?");
  expect(planHeading("  ")).toBe("How does it move?");
});

describe("after the drawing changes", () => {
  it("drops placed anchors, back to their defaults, and keeps every other choice", () => {
    const plan = {
      template: "walker" as const,
      locomotion: { land: true, gait: "hop" as const, swim: true },
      anchors: { feet: { x: 90, y: 210 } },
    };
    expect(afterDrawingEdit(plan)).toEqual({ ...plan, anchors: {} });
  });

  it("leaves a plan with nothing placed as it is", () => {
    const plan = templatePlan("swimmer");
    expect(afterDrawingEdit(plan)).toBe(plan);
  });
});

describe("the anchor layer's note for screen readers", () => {
  it("says whether each point is placed or at its default", () => {
    expect(anchorNote(templatePlan("walker"))).toBe(
      "Feet not placed, so the default position is used. Click the drawing to place them.",
    );
    expect(anchorNote(placeAnchor(templatePlan("swimmer"), "tail", { x: 1, y: 2 }))).toBe(
      "Tail placed. Click the drawing to move it.",
    );
    expect(anchorNote(templatePlan("hopper"))).toBe("A hopper has no points to place.");
  });
});

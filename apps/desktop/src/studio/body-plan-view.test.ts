import { describe, expect, it } from "vitest";
import { defaultPlan, type BodyPlanChoice, type LocomotionChoice } from "../body-plan";
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

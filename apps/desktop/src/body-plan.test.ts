import { BodyShapeSchema } from "@living-diorama/content-schema";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCOMOTION,
  activeAnchors,
  canMove,
  defaultPlan,
  locomotionCapabilities,
  planAnchors,
  planBody,
  type BodyPlanChoice,
} from "./body-plan";

describe("a new creature's plan", () => {
  it("starts on land, walking, with no points placed, fresh each time", () => {
    expect(DEFAULT_LOCOMOTION).toEqual({ land: true, gait: "walk", swim: false });
    const plan = defaultPlan();
    expect(plan).toEqual({ locomotion: DEFAULT_LOCOMOTION, anchors: {} });
    plan.locomotion.swim = true;
    expect(defaultPlan().locomotion.swim).toBe(false);
  });
});

describe("locomotion choices", () => {
  it("need at least one way of moving", () => {
    expect(canMove({ land: true, swim: false })).toBe(true);
    expect(canMove({ land: false, swim: true })).toBe(true);
    expect(canMove({ land: true, swim: true })).toBe(true);
    expect(canMove({ land: false, swim: false })).toBe(false);
  });

  it("give the capabilities it moves with, a speed factor of 1 each; the gait gives none", () => {
    expect(locomotionCapabilities({ land: true, swim: false })).toEqual({ "core:land": 1 });
    expect(locomotionCapabilities({ land: false, swim: true })).toEqual({ "core:swim": 1 });
    expect(locomotionCapabilities({ land: true, swim: true })).toEqual({
      "core:land": 1,
      "core:swim": 1,
    });
    expect(locomotionCapabilities({ land: false, swim: false })).toEqual({});
  });

  it("decide the points: the center of gravity on land, the tail swimming, land first", () => {
    expect(planAnchors({ land: true, swim: false })).toEqual(["centerOfGravity"]);
    expect(planAnchors({ land: false, swim: true })).toEqual(["tail"]);
    expect(planAnchors({ land: true, swim: true })).toEqual(["centerOfGravity", "tail"]);
    expect(planAnchors({ land: false, swim: false })).toEqual([]);
  });
});

describe("the species' body", () => {
  it("carries the land gait, the anchors and the thickness", () => {
    expect(planBody(both(), 0.3)).toEqual({
      thickness: 0.3,
      locomotion: { land: { gait: "hop" } },
      anchors: { centerOfGravity: { x: 100, y: 120 }, tail: { x: 20, y: 110 } },
    });
  });

  it("keeps the gait for a creature that doesn't move on land, so it comes back", () => {
    const plan = { ...both(), locomotion: { land: false, gait: "hop" as const, swim: true } };
    expect(planBody(plan, 0.4).locomotion).toEqual({ land: { gait: "hop" } });
  });

  it("leaves out a placed point whose way of moving is off, as copies", () => {
    const swimmer = { ...both(), locomotion: { land: false, gait: "walk" as const, swim: true } };
    expect(planBody(swimmer, 0.4).anchors).toEqual({ tail: { x: 20, y: 110 } });
    const walker = { ...both(), locomotion: DEFAULT_LOCOMOTION };
    expect(activeAnchors(walker)).toEqual({ centerOfGravity: { x: 100, y: 120 } });
    expect(activeAnchors(walker).centerOfGravity).not.toBe(walker.anchors.centerOfGravity);
  });

  it("is always one the schema accepts", () => {
    for (const land of [true, false]) {
      for (const swim of [true, false]) {
        const plan = { ...both(), locomotion: { land, gait: "walk" as const, swim } };
        expect(BodyShapeSchema.safeParse(planBody(plan, 0.4)).success).toBe(true);
      }
    }
  });
});

function both(): BodyPlanChoice {
  return {
    locomotion: { land: true, gait: "hop", swim: true },
    anchors: { centerOfGravity: { x: 100, y: 120 }, tail: { x: 20, y: 110 } },
  };
}

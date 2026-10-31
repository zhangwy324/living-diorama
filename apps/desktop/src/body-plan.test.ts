import { BodyShapeSchema } from "@living-diorama/content-schema";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCOMOTION,
  canMove,
  defaultPlan,
  locomotionCapabilities,
  planVoxelBody,
} from "./body-plan";

describe("a new creature's plan", () => {
  it("starts on land, walking, fresh each time", () => {
    expect(DEFAULT_LOCOMOTION).toEqual({ land: true, gait: "walk", swim: false });
    const plan = defaultPlan();
    expect(plan).toEqual({ locomotion: DEFAULT_LOCOMOTION });
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
});

describe("the species' body", () => {
  it("carries the land gait alone", () => {
    const plan = { locomotion: { land: true, gait: "hop" as const, swim: true } };
    expect(planVoxelBody(plan)).toEqual({ locomotion: { land: { gait: "hop" } } });
  });

  it("keeps the gait for a creature that doesn't move on land, so it comes back", () => {
    const plan = { locomotion: { land: false, gait: "hop" as const, swim: true } };
    expect(planVoxelBody(plan).locomotion).toEqual({ land: { gait: "hop" } });
  });

  it("is always one the schema accepts", () => {
    for (const land of [true, false]) {
      for (const swim of [true, false]) {
        const plan = { locomotion: { land, gait: "walk" as const, swim } };
        expect(BodyShapeSchema.safeParse(planVoxelBody(plan)).success).toBe(true);
      }
    }
  });
});

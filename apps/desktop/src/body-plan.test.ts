import { BODY_TEMPLATES, BodyShapeSchema } from "@living-diorama/content-schema";
import { describe, expect, it } from "vitest";
import {
  TEMPLATE_LOCOMOTION,
  canMove,
  changeTemplate,
  locomotionCapabilities,
  planBody,
  templatePlan,
  type BodyPlanChoice,
} from "./body-plan";

describe("the template map", () => {
  it("starts a walker walking, a hopper hopping and a swimmer in the water only", () => {
    expect(TEMPLATE_LOCOMOTION).toEqual({
      walker: { land: true, gait: "walk", swim: false },
      hopper: { land: true, gait: "hop", swim: false },
      swimmer: { land: false, gait: "walk", swim: true },
    });
    expect(Object.keys(TEMPLATE_LOCOMOTION).sort()).toEqual([...BODY_TEMPLATES].sort());
  });

  it("gives each template's plan the capabilities it moves with, a speed factor of 1 each", () => {
    expect(locomotionCapabilities(templatePlan("walker").locomotion)).toEqual({ "core:land": 1 });
    expect(locomotionCapabilities(templatePlan("hopper").locomotion)).toEqual({ "core:land": 1 });
    expect(locomotionCapabilities(templatePlan("swimmer").locomotion)).toEqual({ "core:swim": 1 });
    expect(locomotionCapabilities({ land: true, swim: true })).toEqual({
      "core:land": 1,
      "core:swim": 1,
    });
  });

  it("gives a fresh plan each time, a walker by default", () => {
    const plan = templatePlan();
    expect(plan).toEqual({
      template: "walker",
      locomotion: TEMPLATE_LOCOMOTION.walker,
      anchors: {},
    });
    plan.locomotion.swim = true;
    expect(templatePlan().locomotion.swim).toBe(false);
  });
});

describe("locomotion choices", () => {
  it("need at least one way of moving", () => {
    expect(canMove({ land: true, swim: false })).toBe(true);
    expect(canMove({ land: false, swim: true })).toBe(true);
    expect(canMove({ land: true, swim: true })).toBe(true);
    expect(canMove({ land: false, swim: false })).toBe(false);
    expect(locomotionCapabilities({ land: false, swim: false })).toEqual({});
  });
});

describe("changing the template", () => {
  const walker: BodyPlanChoice = {
    template: "walker",
    locomotion: { land: true, gait: "hop", swim: true },
    anchors: { feet: { x: 100, y: 220 } },
  };

  it("drops the anchors the new template doesn't have", () => {
    expect(changeTemplate(walker, "swimmer").anchors).toEqual({});
    expect(changeTemplate(walker, "hopper").anchors).toEqual({});
    const swimmer = { ...templatePlan("swimmer"), anchors: { tail: { x: 20, y: 120 } } };
    expect(changeTemplate(swimmer, "walker").anchors).toEqual({});
  });

  it("keeps the anchors it shares, as copies", () => {
    const kept = changeTemplate(walker, "walker");
    expect(kept.anchors).toEqual({ feet: { x: 100, y: 220 } });
    expect(kept.anchors.feet).not.toBe(walker.anchors.feet);
  });

  it("starts from the new template's locomotion", () => {
    expect(changeTemplate(walker, "swimmer").locomotion).toEqual(TEMPLATE_LOCOMOTION.swimmer);
    expect(changeTemplate(walker, "hopper").locomotion).toEqual(TEMPLATE_LOCOMOTION.hopper);
  });

  it("always leaves a body plan the schema accepts", () => {
    for (const from of BODY_TEMPLATES) {
      for (const to of BODY_TEMPLATES) {
        const placed: BodyPlanChoice = {
          ...templatePlan(from),
          anchors:
            from === "walker"
              ? { feet: { x: 1, y: 2 } }
              : from === "swimmer"
                ? { tail: { x: 3, y: 4 } }
                : {},
        };
        expect(BodyShapeSchema.safeParse(planBody(changeTemplate(placed, to), 0.4)).success).toBe(
          true,
        );
      }
    }
  });
});

describe("the species' body", () => {
  it("carries the template, the land gait, the anchors and the thickness", () => {
    expect(planBody(walker(), 0.3)).toEqual({
      thickness: 0.3,
      template: "walker",
      locomotion: { land: { gait: "hop" } },
      anchors: { feet: { x: 100, y: 220 } },
    });
  });

  it("keeps the gait for a swimmer that doesn't move on land, so it comes back", () => {
    const plan = {
      ...templatePlan("swimmer"),
      locomotion: { land: false, gait: "hop" as const, swim: true },
    };
    expect(planBody(plan, 0.4).locomotion).toEqual({ land: { gait: "hop" } });
  });
});

function walker(): BodyPlanChoice {
  return {
    template: "walker",
    locomotion: { land: true, gait: "hop", swim: false },
    anchors: { feet: { x: 100, y: 220 } },
  };
}

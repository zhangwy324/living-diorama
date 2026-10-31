import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_LOCOMOTION, planVoxelBody, type LocomotionChoice } from "../body-plan";
import { BodyPlanPanel } from "./BodyPlanPanel";
import { previewModes } from "./body-plan-view";

const SWIM: LocomotionChoice = { land: false, gait: "walk", swim: true };
const BOTH: LocomotionChoice = { land: true, gait: "walk", swim: true };
const NONE: LocomotionChoice = { land: false, gait: "hop", swim: false };

const panel = (locomotion: LocomotionChoice, mode?: "land" | "swim") =>
  renderToStaticMarkup(
    <BodyPlanPanel
      name="Mossy Pebble"
      locomotion={locomotion}
      onLocomotion={() => {}}
      modes={previewModes(locomotion, planVoxelBody({ locomotion }), {})}
      mode={mode}
      onMode={() => {}}
      hints={["Could get stuck in the water: some banks are too high to climb out."]}
    />,
  );

/** Each input of a kind as `value` or `value*` when checked, `!` added when disabled. */
const inputs = (html: string, type: string, name: string) =>
  [...html.matchAll(new RegExp(`<input type="${type}"[^>]*>`, "g"))]
    .map(([input]) => input)
    .filter((input) => type === "checkbox" || input.includes(`name="${name}"`))
    .map((input) => {
      const value = /value="(\w+)"/.exec(input)?.[1] ?? "";
      return `${value}${input.includes("checked") ? "*" : ""}${input.includes("disabled") ? "!" : ""}`;
    });

describe("the confirm panel", () => {
  it("names the creature and starts on land, walking", () => {
    const html = panel(DEFAULT_LOCOMOTION);
    expect(html).toContain('<h2 tabindex="-1">How does Mossy Pebble move?</h2>');
    expect(inputs(html, "checkbox", "")).toEqual(["*", ""]);
    expect(inputs(html, "radio", "gait")).toEqual(["walk*", "hop"]);
    // A voxel body's points come from its cubes: none to place.
    expect(html).not.toContain("Points");
    expect(html).toContain(
      "<li>Could get stuck in the water: some banks are too high to climb out.</li>",
    );
  });

  it("disables the gait for a swimmer", () => {
    const html = panel(SWIM);
    expect(inputs(html, "checkbox", "")).toEqual(["", "*"]);
    expect(inputs(html, "radio", "gait")).toEqual(["walk*!", "hop!"]);
    // One way of moving: nothing to choose in the preview.
    expect(html).not.toContain("preview-mode");
  });

  it("offers each way of moving in the preview when it moves both ways", () => {
    const html = panel(BOTH, "swim");
    expect(inputs(html, "radio", "preview-mode")).toEqual(["land", "swim*"]);
    expect(html).toContain("Walking");
    expect(html).toContain("Swimming");
  });

  it("has nothing checked with no way of moving", () => {
    expect(inputs(panel(NONE), "checkbox", "")).toEqual(["", ""]);
  });
});

import type { AnchorName } from "@living-diorama/content-schema";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { defaultPlan, type BodyPlanChoice, type LocomotionChoice } from "../body-plan";
import { AnchorLayer, BodyPlanPanel } from "./BodyPlanPanel";
import { previewModes } from "./body-plan-view";

const SWIM: LocomotionChoice = { land: false, gait: "walk", swim: true };
const BOTH: LocomotionChoice = { land: true, gait: "walk", swim: true };
const NONE: LocomotionChoice = { land: false, gait: "hop", swim: false };
const moving = (locomotion: LocomotionChoice): BodyPlanChoice => ({ locomotion, anchors: {} });

const panel = (plan: BodyPlanChoice, mode?: "land" | "swim", placing?: AnchorName) =>
  renderToStaticMarkup(
    <BodyPlanPanel
      name="Mossy Pebble"
      plan={plan}
      onLocomotion={() => {}}
      placing={placing}
      onPlacing={() => {}}
      onResetAnchors={() => {}}
      modes={previewModes(plan.locomotion)}
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
  it("names the creature and starts on land, walking, with its center of gravity", () => {
    const html = panel(defaultPlan(), undefined, "centerOfGravity");
    expect(html).toContain('<h2 tabindex="-1">How does Mossy Pebble move?</h2>');
    expect(html).not.toContain("template");
    expect(inputs(html, "checkbox", "")).toEqual(["*", ""]);
    expect(inputs(html, "radio", "gait")).toEqual(["walk*", "hop"]);
    expect(html).toContain("<strong>Center of gravity</strong>: where the body balances.");
    expect(html).toContain("At its default; click the drawing to place it.");
    expect(html).not.toContain("<strong>Tail</strong>");
    // One point: nothing to choose about what a click places.
    expect(inputs(html, "radio", "placing")).toEqual([]);
    expect(/<button[^>]*class="reset-anchors"[^>]*>/.exec(html)?.[0]).toContain("disabled");
    expect(html).toContain(
      "<li>Could get stuck in the water: some banks are too high to climb out.</li>",
    );
  });

  it("shows the tail alone for a swimmer, and disables the gait", () => {
    const html = panel(moving(SWIM), undefined, "tail");
    expect(inputs(html, "checkbox", "")).toEqual(["", "*"]);
    expect(inputs(html, "radio", "gait")).toEqual(["walk*!", "hop!"]);
    expect(html).toContain("<strong>Tail</strong>");
    expect(html).not.toContain("Center of gravity");
    // One way of moving: nothing to choose in the preview.
    expect(html).not.toContain("preview-mode");
  });

  it("shows both points when it moves both ways, with a choice of which a click places", () => {
    const plan = { ...moving(BOTH), anchors: { centerOfGravity: { x: 100, y: 100 } } };
    const html = panel(plan, "swim", "tail");
    expect(inputs(html, "radio", "placing")).toEqual(["centerOfGravity", "tail*"]);
    expect(html).toContain("<strong>Center of gravity</strong>");
    expect(html).toContain("Placed.");
    expect(html).toContain(
      "<strong>Tail</strong>: the end that swishes as it swims. At its default.",
    );
    expect(inputs(html, "radio", "preview-mode")).toEqual(["land", "swim*"]);
    expect(html).toContain("Walking");
    expect(html).toContain("Swimming");
    expect(/<button[^>]*class="reset-anchors"[^>]*>/.exec(html)?.[0]).not.toContain("disabled");
  });

  it("shows no points with no way of moving", () => {
    const html = panel(moving(NONE));
    expect(inputs(html, "checkbox", "")).toEqual(["", ""]);
    expect(html).not.toContain("Points");
    expect(html).not.toContain("reset-anchors");
  });
});

describe("the anchor layer", () => {
  const bounds = { left: 64, top: 32, right: 192, bottom: 224 };
  const layer = (plan: BodyPlanChoice, placing: AnchorName | undefined) =>
    renderToStaticMarkup(
      <AnchorLayer plan={plan} bounds={bounds} placing={placing} onPlace={() => {}} />,
    );

  it("shows a default anchor where defaultAnchor puts it, and a placed one where it was put", () => {
    const html = layer(defaultPlan(), "centerOfGravity");
    // The center of gravity: the middle of the bounds, at (128, 128) of 256.
    expect(html).toContain('class="anchor-marker" style="left:50%;top:50%"');
    expect(html).toContain("Center of gravity (default)");
    expect(html).not.toContain("Tail");
    expect(html).toContain(
      'role="group" aria-label="Points on the drawing" aria-describedby="anchor-note"',
    );
    expect(html).toContain("the default position is used");
    expect(html).toContain("Click to place the center of gravity");
    const placed = layer({ ...moving(SWIM), anchors: { tail: { x: 32, y: 128 } } }, "tail");
    expect(placed).toContain('class="anchor-marker placed" style="left:12.5%;top:50%"');
    expect(placed).toContain("Click to move the tail");
  });

  it("shows both points when it moves both ways, dimming the one a click doesn't place", () => {
    const html = layer(moving(BOTH), "tail");
    expect(html).toContain('class="anchor-marker inactive" style="left:50%;top:50%"');
    expect(html).toContain('class="anchor-marker" style="left:25%;top:50%"');
    expect(html).toContain("Click to place the tail");
  });

  it("places nothing with no way of moving", () => {
    const html = layer(moving(NONE), undefined);
    expect(html).toContain('class="anchor-layer"');
    expect(html).not.toContain("anchor-marker");
    expect(html).toContain("Drawing locked while you choose how it moves");
  });
});

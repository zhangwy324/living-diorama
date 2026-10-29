import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { templatePlan, type BodyPlanChoice } from "../body-plan";
import { AnchorLayer, BodyPlanPanel } from "./BodyPlanPanel";
import { previewModes } from "./body-plan-view";

const panel = (plan: BodyPlanChoice, mode?: "land" | "swim") =>
  renderToStaticMarkup(
    <BodyPlanPanel
      name="Mossy Pebble"
      plan={plan}
      onTemplate={() => {}}
      onLocomotion={() => {}}
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
  it("names the creature and offers the three templates, one chosen", () => {
    const html = panel(templatePlan("hopper"));
    expect(html).toContain('<h2 tabindex="-1">How does Mossy Pebble move?</h2>');
    expect(inputs(html, "radio", "template")).toEqual(["walker", "hopper*", "swimmer"]);
    expect(inputs(html, "radio", "gait")).toEqual(["walk", "hop*"]);
    // A hopper squashes and arcs about its center of gravity, so it has one to place too.
    expect(html).toContain("<strong>Center of gravity</strong>: where the body balances.");
    expect(html).toContain("Click the drawing to place it.");
    expect(/<button[^>]*class="reset-anchors"[^>]*>/.exec(html)?.[0]).toContain("disabled");
    expect(html).toContain(
      "<li>Could get stuck in the water: some banks are too high to climb out.</li>",
    );
  });

  it("disables the gait when it doesn't move on land, and shows which ways it moves", () => {
    const html = panel(templatePlan("swimmer"));
    expect(inputs(html, "checkbox", "")).toEqual(["", "*"]);
    expect(inputs(html, "radio", "gait")).toEqual(["walk*!", "hop!"]);
    expect(html).toContain("<strong>Tail</strong>");
    expect(html).toContain("Click the drawing to place it.");
    // One way of moving: nothing to choose in the preview.
    expect(html).not.toContain("preview-mode");
  });

  it("offers a preview of each way it moves, and a reset once a point is placed", () => {
    const plan: BodyPlanChoice = {
      template: "walker",
      locomotion: { land: true, gait: "walk", swim: true },
      anchors: { centerOfGravity: { x: 100, y: 100 } },
    };
    const html = panel(plan, "swim");
    expect(inputs(html, "radio", "preview-mode")).toEqual(["land", "swim*"]);
    expect(html).toContain("Walking");
    expect(html).toContain("Swimming");
    expect(html).toContain("Placed.");
    expect(/<button[^>]*class="reset-anchors"[^>]*>/.exec(html)?.[0]).not.toContain("disabled");
  });
});

describe("the anchor layer", () => {
  const bounds = { left: 64, top: 32, right: 192, bottom: 224 };

  it("shows a default anchor where defaultAnchor puts it, and a placed one where it was put", () => {
    const html = renderToStaticMarkup(
      <AnchorLayer plan={templatePlan("walker")} bounds={bounds} onPlace={() => {}} />,
    );
    // The center of gravity: the middle of the bounds, at (128, 128) of 256.
    expect(html).toContain('class="anchor-marker" style="left:50%;top:50%"');
    expect(html).toContain("Center of gravity (default)");
    expect(html).toContain(
      'role="group" aria-label="Points on the drawing" aria-describedby="anchor-note"',
    );
    expect(html).toContain("the default position is used");
    expect(html).toContain("Click to place the center of gravity");
    const placed = renderToStaticMarkup(
      <AnchorLayer
        plan={{ ...templatePlan("swimmer"), anchors: { tail: { x: 32, y: 128 } } }}
        bounds={bounds}
        onPlace={() => {}}
      />,
    );
    expect(placed).toContain('class="anchor-marker placed" style="left:12.5%;top:50%"');
  });

  it("lets a hopper place its center of gravity", () => {
    const html = renderToStaticMarkup(
      <AnchorLayer plan={templatePlan("hopper")} bounds={bounds} onPlace={() => {}} />,
    );
    expect(html).toContain("Center of gravity (default)");
    expect(html).toContain('class="anchor-layer placing"');
  });
});

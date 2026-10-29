import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { BODY_THICKNESS, type SizeClass } from "@living-diorama/content-schema";
import { CreatureDetails, DEFAULT_SIZE_CLASS, thicknessLabel } from "./CreatureDetails";

it("starts a new creature at medium, the mossling's size", () => {
  expect(DEFAULT_SIZE_CLASS).toBe("medium");
});

it("shows the name, the four sizes with one chosen, the thickness and the hints", () => {
  const html = renderToStaticMarkup(
    <CreatureDetails
      name="Creature 2"
      placeholder="Creature"
      onName={() => {}}
      onSuggestName={() => {}}
      sizeClass={DEFAULT_SIZE_CLASS}
      onSizeClass={() => {}}
      thickness={BODY_THICKNESS.default}
      onThickness={() => {}}
      hints={["Nothing drawn yet."]}
    />,
  );
  expect(html).toContain('value="Creature 2"');
  // The reroll button beside the name says what it does, aloud and as a tooltip.
  const reroll = /<button[^>]*class="suggest-name"[^>]*>/.exec(html)?.[0] ?? "";
  expect(reroll).toContain('type="button"');
  expect(reroll).toContain('aria-label="Suggest another name"');
  expect(reroll).toContain('title="Suggest another name"');
  const sizes = [...html.matchAll(/<input type="radio"[^>]*>/g)].map(([input]) => {
    const size = /value="(\w+)"/.exec(input)?.[1];
    return input.includes("checked") ? `${size}*` : size;
  });
  expect(sizes).toEqual(["tiny", "small", "medium*", "large"]);
  // The slider runs from 10% to 80% of the height in steps of 5, starting at 40%.
  const slider = /<input type="range"[^>]*>/.exec(html)?.[0] ?? "";
  expect(slider).toContain('min="10"');
  expect(slider).toContain('max="80"');
  expect(slider).toContain('step="5"');
  expect(slider).toContain('value="40"');
  expect(slider).toContain('aria-label="Thickness"');
  expect(slider).toContain('aria-valuetext="40% of the height"');
  expect(html).toContain("<output>40%</output>");
  expect(html).toContain("<li>Nothing drawn yet.</li>");
});

it("marks the suggested size, whichever size is chosen", () => {
  const marks = (suggestedSize?: SizeClass) => {
    const html = renderToStaticMarkup(
      <CreatureDetails
        name="Mossy Pebble"
        placeholder="Creature"
        onName={() => {}}
        onSuggestName={() => {}}
        sizeClass="large"
        suggestedSize={suggestedSize}
        onSizeClass={() => {}}
        thickness={BODY_THICKNESS.default}
        onThickness={() => {}}
        hints={[]}
      />,
    );
    // Every option keeps its line for the mark, filled or not.
    return [...html.matchAll(/value="(\w+)".*?<small class="suggested">([^<]*)<\/small>/g)].map(
      ([, size, mark]) => (mark ? `${size}: ${mark}` : size),
    );
  };
  expect(marks("small")).toEqual(["tiny", "small: suggested", "medium", "large"]);
  expect(marks()).toEqual(["tiny", "small", "medium", "large"]);
});

it("says the thickness in whole percent of the height", () => {
  expect(thicknessLabel(0.1)).toBe("10% of the height");
  expect(thicknessLabel(0.35000000000000003)).toBe("35% of the height");
});

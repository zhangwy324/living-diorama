import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CreatureDetails, DEFAULT_SIZE_CLASS, defaultName } from "./CreatureDetails";

it("starts a new creature at medium, the mossling's size", () => {
  expect(DEFAULT_SIZE_CLASS).toBe("medium");
});

it("names a new creature after the species already in the library", () => {
  expect(defaultName(0)).toBe("Creature 1");
  expect(defaultName(3)).toBe("Creature 4");
});

it("shows the name, the four sizes with one chosen, and the hints", () => {
  const html = renderToStaticMarkup(
    <CreatureDetails
      name="Creature 2"
      placeholder="Creature"
      onName={() => {}}
      sizeClass={DEFAULT_SIZE_CLASS}
      onSizeClass={() => {}}
      hints={["Nothing drawn yet."]}
    />,
  );
  expect(html).toContain('value="Creature 2"');
  const sizes = [...html.matchAll(/<input type="radio"[^>]*>/g)].map(([input]) => {
    const size = /value="(\w+)"/.exec(input)?.[1];
    return input.includes("checked") ? `${size}*` : size;
  });
  expect(sizes).toEqual(["tiny", "small", "medium*", "large"]);
  expect(html).toContain("<li>Nothing drawn yet.</li>");
});

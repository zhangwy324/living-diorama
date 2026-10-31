import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { SizeClass } from "@living-diorama/content-schema";
import { CreatureDetails, TOO_BIG_SIZE } from "./CreatureDetails";

const details = (sizeClass: SizeClass | undefined, hints: string[] = []) =>
  renderToStaticMarkup(
    <CreatureDetails
      name="Pip"
      placeholder="Creature"
      onName={() => {}}
      onSuggestName={() => {}}
      sizeClass={sizeClass}
      measured="85 cm tall"
      hints={hints}
    />,
  );

it("shows the name, with a reroll button, and the hints", () => {
  const html = details("large", ["Can't go everywhere at this size."]);
  expect(html).toContain('value="Pip"');
  // The reroll button beside the name says what it does, aloud and as a tooltip.
  const reroll = /<button[^>]*class="suggest-name"[^>]*>/.exec(html)?.[0] ?? "";
  expect(reroll).toContain('type="button"');
  expect(reroll).toContain('aria-label="Suggest another name"');
  expect(reroll).toContain('title="Suggest another name"');
  expect(html).toContain("<li>Can&#x27;t go everywhere at this size.</li>");
});

it("shows the measured size as text, with nothing to pick", () => {
  const large = details("large");
  expect(large).not.toContain('type="radio"');
  expect(large).not.toContain('type="range"');
  expect(large).toContain("<strong>Large</strong>");
  expect(large).toContain("85 cm tall");
  expect(details(undefined)).toContain(`<strong>${TOO_BIG_SIZE}</strong>`);
});

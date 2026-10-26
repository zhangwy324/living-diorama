import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ErrorScreen } from "./ErrorScreen";

const failure = { summary: "The world failed to load", details: ["first problem", "second"] };
const render = (expanded: boolean) =>
  renderToStaticMarkup(
    <ErrorScreen failure={failure} expanded={expanded} onShowDetails={() => {}} />,
  );

it("shows only the summary and a Details button in the strip", () => {
  const html = render(false);
  expect(html).toContain("The world failed to load");
  expect(html).toContain("Details</button>");
  expect(html).not.toContain("first problem");
});

it("lists every detail when expanded", () => {
  const html = render(true);
  expect(html).toContain("<li>first problem</li><li>second</li>");
  expect(html).not.toContain("<button");
});

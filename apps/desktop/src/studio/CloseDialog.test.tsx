import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CloseDialog } from "./CloseDialog";

it("offers Discard, a disabled Save draft and Cancel", () => {
  const html = renderToStaticMarkup(<CloseDialog onDiscard={() => {}} onCancel={() => {}} />);
  const buttons = [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].map(
    ([, attributes, text]) => ({
      text: text!.replace(/<[^>]+>/g, ""),
      disabled: attributes!.includes("disabled"),
    }),
  );
  expect(buttons).toEqual([
    { text: "Discard", disabled: false },
    { text: "Save draft (coming later)", disabled: true },
    { text: "Cancel", disabled: false },
  ]);
});

it("asks its own question, e.g. before Edit a copy replaces a creature", () => {
  const html = renderToStaticMarkup(
    <CloseDialog
      title="Discard your creature?"
      message="Editing a copy of Pebble replaces it."
      onDiscard={() => {}}
      onCancel={() => {}}
    />,
  );
  expect(html).toContain(">Discard your creature?</h2>");
  expect(html).toContain("<p>Editing a copy of Pebble replaces it.</p>");
  expect(html).not.toContain("Close the Studio?");
});

it("leaves Save draft out where there is no draft to save", () => {
  const html = renderToStaticMarkup(
    <CloseDialog drafts={false} onDiscard={() => {}} onCancel={() => {}} />,
  );
  expect(html).not.toContain("Save draft");
  expect(html).toContain("Discard");
});

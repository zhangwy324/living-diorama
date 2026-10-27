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

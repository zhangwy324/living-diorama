import { checkBody } from "@living-diorama/renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { hasWarningTint, WarningToggle } from "./WarningToggle";

const toggle = (available: boolean, shown: boolean) => {
  const html = renderToStaticMarkup(
    <WarningToggle available={available} shown={shown} onToggle={() => {}} />,
  );
  return /<button[^>]*>/.exec(html)?.[0] ?? "";
};

describe("WarningToggle", () => {
  it("is a labelled button, off by default", () => {
    const html = renderToStaticMarkup(
      <WarningToggle available={true} shown={false} onToggle={() => {}} />,
    );
    // A real button, so it is reached by Tab and pressed with Enter or Space.
    expect(html).toMatch(/^<button type="button"/);
    expect(html.replace(/<[^>]*>/g, "")).toBe("Show warnings");
    expect(toggle(true, false)).toContain('aria-pressed="false"');
    expect(toggle(true, false)).not.toContain("disabled");
  });

  it("says it is pressed while the tint shows", () => {
    expect(toggle(true, true)).toContain('aria-pressed="true"');
  });

  it("is disabled, and reads as off, with nothing to tint", () => {
    for (const shown of [false, true]) {
      const button = toggle(false, shown);
      expect(button).toContain("disabled");
      expect(button).toContain('aria-pressed="false"');
      expect(button).toContain('title="No warnings to show"');
    }
  });
});

describe("hasWarningTint", () => {
  /** A `width` × `height` image with the given opaque rectangles. */
  const image = (width: number, height: number, ...rects: [number, number, number, number][]) => {
    const data = new Uint8Array(width * height * 4);
    for (const [left, top, w, h] of rects) {
      for (let y = top; y < top + h; y++) {
        for (let x = left; x < left + w; x++) data.set([0, 200, 0, 255], (y * width + x) * 4);
      }
    }
    return { width, height, data };
  };

  it("is false for nothing drawn and for one solid shape", () => {
    expect(hasWarningTint(checkBody(image(60, 60)))).toBe(false);
    expect(hasWarningTint(checkBody(image(60, 60, [10, 10, 40, 40])))).toBe(false);
  });

  it("is true for shapes that aren't joined", () => {
    const check = checkBody(image(60, 60, [5, 10, 20, 40], [35, 10, 20, 40]));
    expect(check.shapes).toBe(2);
    expect(hasWarningTint(check)).toBe(true);
  });

  it("is true for a thin part", () => {
    // A body 200 px tall with a 1 px wide stalk sticking out of it.
    const check = checkBody(image(240, 240, [20, 20, 100, 200], [120, 100, 100, 1]));
    expect(check.thinParts).toBeGreaterThan(0);
    expect(hasWarningTint(check)).toBe(true);
  });
});

import { expect, it } from "vitest";
import { nearest } from "./distance";

it("finds the nearest marked pixel in straight-line distance", () => {
  const [width, height] = [23, 17];
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const mask = Uint8Array.from({ length: width * height }, () => (random() < 0.04 ? 1 : 0));
  const { distance2, index } = nearest(mask, width, height);
  for (let i = 0; i < mask.length; i++) {
    let best = Infinity;
    for (let j = 0; j < mask.length; j++) {
      if (!mask[j]) continue;
      best = Math.min(
        best,
        ((i % width) - (j % width)) ** 2 + (Math.floor(i / width) - Math.floor(j / width)) ** 2,
      );
    }
    expect(distance2[i]).toBe(best);
    const j = index[i]!;
    expect(mask[j]).toBe(1);
    expect(
      ((i % width) - (j % width)) ** 2 + (Math.floor(i / width) - Math.floor(j / width)) ** 2,
    ).toBe(best);
  }
});

it("reports no nearest pixel when nothing is marked", () => {
  const { index } = nearest(new Uint8Array(6), 3, 2);
  expect([...index]).toEqual([-1, -1, -1, -1, -1, -1]);
});

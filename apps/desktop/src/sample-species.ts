import type { Drawing, SizeClass, Stroke } from "@living-diorama/content-schema";
import { CANVAS_SIZE, toDrawing } from "./drawing";

// Twenty drawn species for measuring the app with many different bodies (ADR 0016 §11). Each is
// built from strokes, as a player's drawing is, from a few body plans varied in shape, colour,
// size, outline and separate parts. Development only: the console hook saves them to the library.

type Point = readonly [number, number];

/** A part filled with the body or accent colour, outlined first when the species has an outline. */
interface Part {
  fill: "body" | "accent";
  width: number;
  points: Point[];
}

/** A body plan: its filled parts, then details (eyes, spots) and eraser cuts drawn over them. */
interface Plan {
  parts: Part[];
  details: (palette: Palette) => Stroke[];
}

interface Palette {
  body: string;
  accent: string;
  detail: string;
}

export interface SampleSpecies {
  name: string;
  sizeClass: SizeClass;
  drawing: Drawing;
}

/** Where feet touch the ground; the drawing faces right (+x), as the Studio's guide shows. */
const GROUND = 244;
const MIDDLE = CANVAS_SIZE / 2;
const OUTLINE_COLOR = "#20201c";
const OUTLINE_WIDTH = 10;

const stroke = (tool: Stroke["tool"], color: string, width: number, points: Point[]): Stroke => ({
  tool,
  color,
  width,
  points: points.flatMap(([x, y]) => [x, y, 1]),
});
const part = (fill: Part["fill"], width: number, ...points: Point[]): Part => ({
  fill,
  width,
  points,
});
const dot = (color: string, width: number, at: Point) => stroke("pen", color, width, [at]);
const cut = (width: number, ...points: Point[]) => stroke("eraser", "#000000", width, points);

/** A rounded lump, on its belly or on two legs. */
function blob(width: number, height: number, legs: boolean): Plan {
  const bottom = legs ? GROUND - 34 : GROUND;
  const y = bottom - height / 2;
  const half = (width - height) / 2;
  const legX = width / 4;
  return {
    parts: [
      ...(legs
        ? [
            part("accent", 24, [MIDDLE - legX, y], [MIDDLE - legX, GROUND - 12]),
            part("accent", 24, [MIDDLE + legX, y], [MIDDLE + legX, GROUND - 12]),
          ]
        : []),
      part("body", height, [MIDDLE - half, y], [MIDDLE + half, y]),
    ],
    details: ({ detail }) => [
      dot(detail, Math.max(12, height / 8), [MIDDLE + width / 2 - height / 3, y - height / 5]),
    ],
  };
}

/** A long body on four legs, with a head in front and a tail behind. */
function quadruped(bodyHeight: number, legLength: number): Plan {
  const y = GROUND - legLength - bodyHeight / 2;
  const head: Point = [192, y - bodyHeight / 2];
  return {
    parts: [
      ...[78, 104, 148, 172].map((x) => part("accent", 18, [x, y], [x, GROUND - 9])),
      part("accent", 14, [70, y], [34, y - 46]),
      part("body", bodyHeight, [82, y], [168, y]),
      part("body", bodyHeight * 0.85, head),
    ],
    details: ({ detail }) => [dot(detail, 12, [head[0] + 12, head[1] - 6])],
  };
}

/** Tall and upright on short legs, with arms. */
function upright(height: number, width: number): Plan {
  const top = GROUND - 30 - height;
  const legTop = GROUND - 30 - width / 3;
  const shoulder = width / 2 - 10;
  return {
    parts: [
      part("accent", 22, [MIDDLE - 18, legTop], [MIDDLE - 18, GROUND - 11]),
      part("accent", 22, [MIDDLE + 18, legTop], [MIDDLE + 18, GROUND - 11]),
      part(
        "accent",
        16,
        [MIDDLE - shoulder, top + height / 2],
        [MIDDLE - shoulder - 36, top + height * 0.75],
      ),
      part(
        "accent",
        16,
        [MIDDLE + shoulder, top + height / 2],
        [MIDDLE + shoulder + 36, top + height * 0.3],
      ),
      part("body", width, [MIDDLE, top + width / 2], [MIDDLE, GROUND - 30 - width / 2]),
    ],
    details: ({ detail }) => [
      dot(detail, 12, [MIDDLE + 4, top + width / 2]),
      dot(detail, 12, [MIDDLE + 24, top + width / 2]),
    ],
  };
}

/** A round bird on thin legs, with a beak. */
function bird(size: number): Plan {
  const y = GROUND - 40 - size / 2;
  return {
    parts: [
      part("accent", 12, [MIDDLE - 14, y], [MIDDLE - 14, GROUND - 6]),
      part("accent", 12, [MIDDLE + 14, y], [MIDDLE + 14, GROUND - 6]),
      part("accent", 22, [MIDDLE + size / 2 - 6, y - 8], [MIDDLE + size / 2 + 26, y]),
      part("body", size, [MIDDLE, y]),
    ],
    details: ({ detail }) => [dot(detail, 14, [MIDDLE + size / 4, y - size / 5])],
  };
}

/** A round body with a halo and a moon that don't touch it: three separate shapes. */
function floater(size: number): Plan {
  const y = GROUND - size / 2;
  const top = y - size / 2;
  return {
    parts: [
      part("body", size, [MIDDLE, y]),
      part("accent", 18, [MIDDLE - 46, top - 24], [MIDDLE, top - 40], [MIDDLE + 46, top - 24]),
      part("accent", 30, [MIDDLE + size / 2 + 34, top + 10]),
    ],
    details: ({ detail }) => [
      dot(detail, 14, [MIDDLE + size / 5, y - size / 6]),
      dot(detail, 14, [MIDDLE + size / 5 + 28, y - size / 6]),
    ],
  };
}

/** A round body with spikes all around. */
function spiky(size: number, spikes: number): Plan {
  const y = GROUND - size / 2 - 22;
  const reach = size / 2 + 22;
  const points = Array.from({ length: spikes }, (_, i): Point => {
    const angle = Math.PI * (0.15 + (1.7 * i) / (spikes - 1));
    return [MIDDLE - Math.cos(angle) * reach, y - Math.sin(angle) * reach];
  });
  return {
    parts: [
      ...points.map((tip) => part("accent", 20, [MIDDLE, y], tip)),
      part("body", size, [MIDDLE, y]),
    ],
    details: ({ detail }) => [dot(detail, 14, [MIDDLE + size / 4, y - size / 8])],
  };
}

/** A row of round segments, head in front, with antennae. */
function caterpillar(segments: number, size: number): Plan {
  const y = GROUND - size / 2;
  const step = (CANVAS_SIZE - 60 - size) / segments;
  const head: Point = [30 + size / 2 + step * segments, y - 10];
  return {
    parts: [
      ...Array.from({ length: segments }, (_, i) =>
        part(i % 2 ? "accent" : "body", size, [30 + size / 2 + step * i, y]),
      ),
      part("body", size * 1.2, head),
    ],
    details: ({ detail }) => [
      stroke("pen", detail, 10, [
        [head[0] - 8, head[1] - size / 2],
        [head[0] - 20, head[1] - size / 2 - 34],
      ]),
      stroke("pen", detail, 10, [
        [head[0] + 8, head[1] - size / 2],
        [head[0] + 16, head[1] - size / 2 - 34],
      ]),
      dot(detail, 12, [head[0] + size / 4, head[1]]),
    ],
  };
}

/** A cap on a stem, with spots on the cap. */
function mushroom(capWidth: number): Plan {
  const capY = GROUND - 110;
  const half = capWidth / 2;
  return {
    parts: [
      part("accent", 62, [MIDDLE, GROUND - 31], [MIDDLE, capY]),
      part("body", 64, [MIDDLE - half + 32, capY], [MIDDLE, capY - 40], [MIDDLE + half - 32, capY]),
    ],
    details: ({ accent, detail }) => [
      dot(accent, 22, [MIDDLE - half / 2, capY - 14]),
      dot(accent, 18, [MIDDLE + 8, capY - 46]),
      dot(accent, 20, [MIDDLE + half / 2, capY - 10]),
      dot(detail, 12, [MIDDLE + 14, GROUND - 60]),
    ],
  };
}

/** A lump with a tail cut off by the eraser, so the tail is a shape of its own. */
function cutTail(size: number): Plan {
  const y = GROUND - size / 2;
  const root: Point = [MIDDLE - size / 2 + 10, y];
  // Across the tail, a third of the way along it.
  const across: Point = [root[0] - 20, y - 16];
  return {
    parts: [part("accent", 30, root, [root[0] - 60, y - 50]), part("body", size, [MIDDLE + 10, y])],
    details: ({ detail }) => [
      cut(14, [across[0] + 20, across[1] - 24], [across[0] - 20, across[1] + 24]),
      dot(detail, 14, [MIDDLE + size / 3, y - size / 5]),
    ],
  };
}

function draw(plan: Plan, palette: Palette, outline: boolean): Drawing {
  const outlines = outline
    ? plan.parts.map(({ width, points }) =>
        stroke("pen", OUTLINE_COLOR, width + OUTLINE_WIDTH, points),
      )
    : [];
  const fills = plan.parts.map(({ fill, width, points }) =>
    stroke("pen", palette[fill], width, points),
  );
  return toDrawing([...outlines, ...fills, ...plan.details(palette)]);
}

const sample = (
  name: string,
  sizeClass: SizeClass,
  plan: Plan,
  [body, accent, detail]: [string, string, string],
  outline = false,
): SampleSpecies => ({ name, sizeClass, drawing: draw(plan, { body, accent, detail }, outline) });

/**
 * Twenty species that look clearly different from each other, oldest first when saved in order.
 * Built on call, so the release bundle, which never calls it, leaves them out.
 */
export const sampleSpecies = (): SampleSpecies[] => [
  sample("Bramble", "small", blob(190, 130, false), ["#6b8e23", "#3d5a12", "#1b2410"]),
  sample("Pip", "tiny", blob(120, 110, true), ["#f4a259", "#b5651d", "#2b1a0c"], true),
  sample("Dewdrop", "medium", blob(220, 90, true), ["#5bc0eb", "#2a7fa8", "#0b2533"]),
  sample("Thistle", "large", quadruped(70, 70), ["#8e7cc3", "#4b3a82", "#1c1530"]),
  sample("Cobble", "medium", quadruped(90, 40), ["#9e9e8e", "#5f5f52", "#1f1f1a"], true),
  sample("Fennel", "small", quadruped(56, 90), ["#e9c46a", "#a37d1f", "#2e2306"]),
  sample("Wisp", "small", upright(170, 70), ["#e8e8f0", "#9aa0c8", "#262840"], true),
  sample("Marrow", "large", upright(130, 110), ["#c0504d", "#7a2523", "#260b0a"]),
  sample("Tumble", "tiny", upright(150, 50), ["#3cb371", "#1f6e43", "#0a2416"]),
  sample("Quill", "medium", bird(130), ["#2a9d8f", "#e76f51", "#0d2421"]),
  sample("Ember", "small", bird(100), ["#ff6b35", "#ffd23f", "#2b0f04"], true),
  sample("Sorrel", "medium", floater(130), ["#f28482", "#84a59d", "#2e1414"]),
  sample("Pebble", "tiny", floater(110), ["#577590", "#f9c74f", "#0f1a24"], true),
  sample("Juniper", "large", spiky(120, 7), ["#264653", "#8ab17d", "#e9f5db"]),
  sample("Nettle", "small", spiky(100, 11), ["#bc4749", "#f2e8cf", "#1a0a0a"], true),
  sample("Clover", "medium", caterpillar(4, 56), ["#80b918", "#d4e09b", "#1a2605"]),
  sample("Saffron", "small", caterpillar(6, 40), ["#ffb703", "#fb8500", "#2a1a00"], true),
  sample("Burdock", "large", mushroom(200), ["#9d0208", "#fefae0", "#1a0001"]),
  sample("Tansy", "medium", mushroom(150), ["#6d597a", "#eaac8b", "#1d1721"], true),
  sample("Hazel", "tiny", cutTail(130), ["#a0522d", "#deb887", "#1e0f06"]),
];

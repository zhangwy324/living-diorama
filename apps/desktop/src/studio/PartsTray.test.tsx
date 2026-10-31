// @vitest-environment jsdom
import type { PartSummary } from "@living-diorama/simulation";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { builtInParts } from "./fixtures/built-in-parts";
import { drawnPartEntry } from "./fixtures/player-parts";
import { partThumbnailKey, type PartThumbnails } from "./part-thumbnails";
import { partsKit, withPlayerParts } from "./parts-kit";
import { PartsTray, TRAY_THUMBNAIL_SIZE } from "./PartsTray";
import { playerPartSummary } from "./player-parts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const studioParts = builtInParts();
const packKit = partsKit(studioParts);
if (!packKit) throw new Error("No kit");
const UUID = "00000000-0000-4000-8000-0000000000aa";
const stilt = (version: number) =>
  playerPartSummary(
    drawnPartEntry(studioParts, { uuid: UUID, type: "hollow:leg", name: "Stilt", version }),
  );

let root: Root | undefined;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

/** Thumbnails that answer with the key they were asked for, recording each ask. */
function fakeThumbnails() {
  const asked: string[] = [];
  const thumbnails: PartThumbnails = {
    part: (source, size) => {
      expect(size).toBe(TRAY_THUMBNAIL_SIZE);
      const key = partThumbnailKey(source);
      asked.push(key);
      return Promise.resolve(`blob:${key}`);
    },
  };
  return { asked, thumbnails };
}

it("keys a part's thumbnail by its ID and version", () => {
  expect(partThumbnailKey({ id: "user-part:a", version: "3" })).toBe("user-part:a@3");
});

it("draws an edited player part anew, by its new version", async () => {
  const { asked, thumbnails } = fakeThumbnails();
  root = createRoot(container);
  const render = (mine: PartSummary) =>
    act(async () =>
      root?.render(
        <PartsTray
          sections={withPlayerParts(packKit, [mine]).sections}
          picked={undefined}
          onPick={() => {}}
          thumbnails={thumbnails}
        />,
      ),
    );
  const image = () =>
    container.querySelector<HTMLImageElement>(".tray-part.mine img")?.getAttribute("src");
  await render(stilt(1));
  expect(asked).toContain(`user-part:${UUID}@1`);
  expect(image()).toBe(`blob:user-part:${UUID}@1`);
  await render(stilt(2));
  expect(asked).toContain(`user-part:${UUID}@2`);
  expect(image()).toBe(`blob:user-part:${UUID}@2`);
  // Every pack part was asked for too, by its own version.
  expect(asked).toContain(partThumbnailKey(packKit.parts[0]!));
});

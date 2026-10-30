// @vitest-environment jsdom
import type { AssemblyPick, AssemblyView } from "@living-diorama/renderer";
import type { CheckedLimits } from "@living-diorama/simulation";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LibrarySnapshot, ReleaseVoxelParams, Released } from "../studio-protocol";
import { AssemblyEditor, type BuildClient } from "./AssemblyEditor";
import { TOO_BIG_HINT } from "./assembly-state";
import { builtInParts } from "./fixtures/built-in-parts";
import type { AskLimits } from "./limits";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The view draws with WebGL, which jsdom lacks: a stand-in that records what it is asked to show,
// with `pick` answering what the test says is under the pointer.
const view = vi.hoisted(() => ({
  under: undefined as AssemblyPick | undefined,
  assembly: undefined as unknown,
  highlighted: [] as unknown[],
  selection: [] as string[],
  walking: false,
}));
vi.mock("@living-diorama/renderer", () => ({
  createAssemblyView: (): Partial<AssemblyView> => ({
    setAssembly: (assembly) => {
      view.assembly = assembly;
    },
    setHighlightedSockets: (sockets) => {
      view.highlighted = [...sockets];
    },
    setSelection: (ids) => {
      view.selection = [...ids];
    },
    setGhost: () => {},
    setTestWalk: (motion) => {
      view.walking = motion !== undefined;
    },
    pick: () => view.under,
    dispose: () => {},
    thumbnails: {
      part: () => Promise.resolve("data:image/png;base64,"),
    } as unknown as AssemblyView["thumbnails"],
  }),
}));

const LIBRARY: LibrarySnapshot = { species: [], creatures: 3, maxCreatures: 20 };
// The land rule, so the confirm step's preview has a motion to play.
const NO_LIMITS: CheckedLimits = {
  limits: [],
  locomotion: { "core:land": { animation: "walk" } as never },
};

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  view.under = undefined;
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList;
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

async function setup(askLimits: AskLimits = () => Promise.resolve(NO_LIMITS)) {
  const releaseVoxel = vi.fn<(params: ReleaseVoxelParams) => Promise<Released>>();
  const client: BuildClient = {
    parts: () => Promise.resolve(builtInParts()),
    releaseVoxel,
  };
  const onReleased = vi.fn();
  const onReleaseStart = vi.fn();
  const onUnsaved = vi.fn();
  root = createRoot(container);
  const render = (active: boolean) =>
    root?.render(
      <AssemblyEditor
        active={active}
        keysEnabled={active}
        library={LIBRARY}
        modeSwitch={null}
        askLimits={askLimits}
        client={client}
        onReleaseStart={onReleaseStart}
        onReleased={onReleased}
        onUnsaved={onUnsaved}
      />,
    );
  await act(async () => render(true));
  return {
    releaseVoxel,
    onReleased,
    onReleaseStart,
    onUnsaved,
    /** Shows or hides Build mode, as the Studio's switch does. */
    show: (active: boolean) => act(async () => render(active)),
  };
}

const button = (text: string) => {
  const found = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(text),
  );
  if (!found) throw new Error(`No button "${text}"`);
  return found;
};
const trayPart = (name: string) => button(name);
const clickStage = async () => {
  const stage = container.querySelector(".assembly-stage");
  await act(async () => stage?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
};
const click = async (target: HTMLElement) => act(async () => target.click());
const key = (init: KeyboardEventInit) =>
  act(async () => window.dispatchEvent(new KeyboardEvent("keydown", init)));
const sentIds = (release: ReturnType<typeof vi.fn>) =>
  release.mock.calls.map(([params]) => (params as ReleaseVoxelParams).releaseId);

it("opens on the default torso with the tray by part type, Mirror on", async () => {
  const { onUnsaved } = await setup();
  const headings = [...container.querySelectorAll(".parts-tray h3")].map((h) => h.textContent);
  expect(headings.slice(0, 3)).toEqual(["Torso", "Arm", "Fin"]);
  expect(button("Mirror").getAttribute("aria-pressed")).toBe("true");
  expect(view.assembly).toMatchObject({ instances: [{ id: "fish-torso" }] });
  expect(onUnsaved).toHaveBeenLastCalledWith(false);
  // The tray's thumbnails came from the view.
  expect(container.querySelector(".tray-part img")).not.toBeNull();
});

it("places a picked part on a clicked socket, then selects it and asks before closing", async () => {
  const { onUnsaved } = await setup();
  // Four-legged torso first, then legs: two places, so they stay picked with four marked sockets.
  await click(trayPart("Four-legged torso"));
  await click(trayPart("Paw leg"));
  expect(trayPart("Paw leg").getAttribute("aria-pressed")).toBe("true");
  expect(view.highlighted).toHaveLength(4);
  view.under = { kind: "socket", instance: "fish-torso", socket: "back-left" };
  await clickStage();
  expect(view.selection).toEqual(["back-left", "back-right"]);
  expect(view.highlighted).toEqual([]);
  expect(onUnsaved).toHaveBeenLastCalledWith(true);
  // Delete removes both; Ctrl+Z brings them back.
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" })));
  expect(view.selection).toEqual([]);
  await act(async () =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true })),
  );
  expect((view.assembly as { instances: unknown[] }).instances).toHaveLength(3);
});

it("keeps the release ID across retries and makes a new one after an edit", async () => {
  const { releaseVoxel, onReleased, onReleaseStart } = await setup();
  releaseVoxel.mockRejectedValueOnce(new Error("The world didn't answer."));
  await click(button("Next"));
  await click(button("Release"));
  expect(container.textContent).toContain("The world didn't answer.");
  releaseVoxel.mockRejectedValueOnce(new Error("Again."));
  await click(button("Release"));
  const [first, second] = sentIds(releaseVoxel);
  expect(second).toBe(first);

  // A change of plan is a different release.
  releaseVoxel.mockRejectedValueOnce(new Error("Once more."));
  const swims = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1];
  if (!swims) throw new Error("No Swims box");
  await click(swims);
  await click(button("Release"));
  expect(sentIds(releaseVoxel)[2]).not.toBe(first);

  // An edit to the assembly too.
  await click(button("Back"));
  await click(trayPart("Side fin"));
  await click(button("Next"));
  releaseVoxel.mockResolvedValueOnce({ speciesId: "user:x", name: "Fin" });
  await click(button("Release"));
  const ids = sentIds(releaseVoxel);
  expect(new Set(ids).size).toBe(3);
  expect(releaseVoxel.mock.calls[3]?.[0].assembly.instances).toHaveLength(3);

  // Each try first clears the last release's celebration.
  expect(onReleaseStart).toHaveBeenCalledTimes(4);
  // Released: back to Build mode at the default torso.
  expect(onReleased).toHaveBeenCalledWith({ speciesId: "user:x", name: "Fin" });
  expect(button("Next")).toBeDefined();
  expect(view.assembly).toMatchObject({ instances: [{ id: "fish-torso" }] });
});

it("blocks Release for a limit error, and says why", async () => {
  const error: CheckedLimits = {
    limits: [{ severity: "error", code: "no_spawn_point", message: "x", path: [] }],
    locomotion: {},
  };
  await setup(() => Promise.resolve(error));
  await click(button("Next"));
  expect(button("Release").disabled).toBe(true);
  expect(container.querySelector(".release-hint.blocking")?.textContent).toBe(
    "Has nowhere to appear in this world at this size, moving this way.",
  );
  expect(container.textContent).not.toContain(TOO_BIG_HINT);
});

it("drops the pick and the selection on Escape", async () => {
  await setup();
  await click(trayPart("Four-legged torso"));
  await click(trayPart("Paw leg"));
  expect(view.highlighted).toHaveLength(4);
  await key({ key: "Escape" });
  expect(view.highlighted).toEqual([]);
  expect(trayPart("Paw leg").getAttribute("aria-pressed")).toBe("false");
  await click(trayPart("Round head"));
  expect(view.selection).toEqual(["neck"]);
  await key({ key: "Escape" });
  expect(view.selection).toEqual([]);
});

it("walks the creature in the confirm step only while Build mode is shown", async () => {
  const { show } = await setup();
  await click(button("Next"));
  expect(view.walking).toBe(true);
  await show(false);
  expect(view.walking).toBe(false);
  await show(true);
  expect(view.walking).toBe(true);
});

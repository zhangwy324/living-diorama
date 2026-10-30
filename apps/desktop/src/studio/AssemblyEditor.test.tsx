// @vitest-environment jsdom
import { scoreSockets, type VoxelAssembly } from "@living-diorama/content-schema";
import type { AssemblyGhost, AssemblyPick, AssemblyView } from "@living-diorama/renderer";
import type { CheckedLimits } from "@living-diorama/simulation";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LibrarySnapshot, ReleaseVoxelParams, Released } from "../studio-protocol";
import { AssemblyEditor, type BuildClient, type LoadRequest } from "./AssemblyEditor";
import {
  NOTHING_TO_FILL,
  randomize,
  startBuild,
  STEP_SPREAD_HINT,
  TOO_BIG_HINT,
} from "./assembly-state";
import { builtInParts } from "./fixtures/built-in-parts";
import type { AskLimits } from "./limits";
import { partsKit } from "./parts-kit";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The view draws with WebGL, which jsdom lacks: a stand-in that records what it is asked to show,
// with `pick` answering what the test says is under the pointer.
const view = vi.hoisted(() => ({
  under: undefined as AssemblyPick | undefined,
  assembly: undefined as unknown,
  highlighted: [] as unknown[],
  selection: [] as string[],
  ghost: undefined as AssemblyGhost | undefined,
  walking: false,
  probe: undefined as AssemblyView["probe"] | undefined,
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
    setGhost: (ghost) => {
      view.ghost = ghost;
    },
    setTestWalk: (motion) => {
      view.walking = motion !== undefined;
    },
    pick: () => view.under,
    probe: (x, y) => view.probe?.(x, y),
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
  view.ghost = undefined;
  view.probe = undefined;
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

async function setup(
  askLimits: AskLimits = () => Promise.resolve(NO_LIMITS),
  firstLoad?: LoadRequest,
) {
  const releaseVoxel = vi.fn<(params: ReleaseVoxelParams) => Promise<Released>>();
  const client: BuildClient = {
    parts: () => Promise.resolve(builtInParts()),
    releaseVoxel,
  };
  const onReleased = vi.fn();
  const onReleaseStart = vi.fn();
  const onUnsaved = vi.fn();
  root = createRoot(container);
  let loadRequest = firstLoad;
  let shown = true;
  const render = () =>
    root?.render(
      <AssemblyEditor
        active={shown}
        keysEnabled={shown}
        library={LIBRARY}
        modeSwitch={null}
        askLimits={askLimits}
        client={client}
        loadRequest={loadRequest}
        onReleaseStart={onReleaseStart}
        onReleased={onReleased}
        onUnsaved={onUnsaved}
      />,
    );
  await act(async () => render());
  return {
    releaseVoxel,
    onReleased,
    onReleaseStart,
    onUnsaved,
    /** Shows or hides Build mode, as the Studio's switch does. */
    show: (active: boolean) => {
      shown = active;
      return act(async () => render());
    },
    /** Asks the editor to load a creature, as Edit a copy will. */
    load: (request: LoadRequest) => {
      loadRequest = request;
      return act(async () => render());
    },
  };
}

const shown = () => view.assembly as VoxelAssembly;
const nameField = () => {
  const input = container.querySelector<HTMLInputElement>('input[type="text"]');
  if (!input) throw new Error("No name field");
  return input;
};
const labelled = (label: string) => {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`No button "${label}"`);
  return found;
};

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
  expect(view.assembly).toMatchObject({ instances: [{ id: "four-legged-torso" }] });
  expect(onUnsaved).toHaveBeenLastCalledWith(false);
  // The tray's thumbnails came from the view.
  expect(container.querySelector(".tray-part img")).not.toBeNull();
});

it("places a picked part on a clicked socket, then selects it and asks before closing", async () => {
  const { onUnsaved } = await setup();
  // Legs have two places, so they stay picked with four marked sockets.
  await click(trayPart("Paw leg"));
  expect(trayPart("Paw leg").getAttribute("aria-pressed")).toBe("true");
  expect(view.highlighted).toHaveLength(4);
  view.under = { kind: "socket", instance: "four-legged-torso", socket: "back-left" };
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
  await click(trayPart("Round head"));
  await click(button("Next"));
  releaseVoxel.mockResolvedValueOnce({ speciesId: "user:x", name: "Fin" });
  await click(button("Release"));
  const ids = sentIds(releaseVoxel);
  expect(new Set(ids).size).toBe(3);
  expect(releaseVoxel.mock.calls[3]?.[0].assembly.instances).toHaveLength(2);

  // Each try first clears the last release's celebration.
  expect(onReleaseStart).toHaveBeenCalledTimes(4);
  // Released: back to Build mode at the default torso.
  expect(onReleased).toHaveBeenCalledWith({ speciesId: "user:x", name: "Fin" });
  expect(button("Next")).toBeDefined();
  expect(view.assembly).toMatchObject({ instances: [{ id: "four-legged-torso" }] });
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

it("recolours the selected part from the suggested colours, as one undo step", async () => {
  await setup();
  await click(trayPart("Round head"));
  expect(container.querySelector(".part-colours")).not.toBeNull();
  const neckColor = () => {
    const neck = shown().instances.find((instance) => instance.id === "neck");
    return neck && shown().parts[neck.part]?.colors[1];
  };
  const before = neckColor();
  // The second colour slot, then a suggested colour.
  await click(labelled(`Colour 2, ${before ?? ""}`));
  const suggested = container.querySelectorAll<HTMLButtonElement>(".suggested-colours .swatch");
  expect(suggested.length).toBe(partsKit(builtInParts())?.suggestedColors.length);
  const swatch = [...suggested].find((b) => b.title !== before);
  if (!swatch) throw new Error("No other colour");
  await click(swatch);
  expect(neckColor()).toBe(swatch.title);
  expect(swatch.getAttribute("aria-pressed")).toBe("true");
  await key({ key: "z", ctrlKey: true });
  expect(neckColor()).toBe(before);
  // No part selected: no colours.
  await key({ key: "Escape" });
  expect(container.querySelector(".part-colours")).toBeNull();
});

it("turns with R, steps a part with − and hints at a spread of steps", async () => {
  await setup();
  await click(trayPart("Paw leg"));
  view.under = { kind: "socket", instance: "four-legged-torso", socket: "back-left" };
  await clickStage();
  await key({ key: "r" });
  const leg = () => shown().instances.find((instance) => instance.id === "back-left");
  expect(leg()?.rotation).not.toEqual([0, 0, 0, 1]);
  // Eyes on a head, then one step finer: two steps from the torso's.
  await click(trayPart("Round head"));
  await click(trayPart("Bead eye"));
  expect(container.textContent).not.toContain(STEP_SPREAD_HINT);
  await key({ key: "-" });
  expect(container.querySelector(".hints")?.textContent).toContain(STEP_SPREAD_HINT);
  // As small as they go: said over the view.
  await key({ key: "-" });
  expect(container.querySelector(".stage-notice")?.textContent).toBe(
    "Its cubes are as small as they go.",
  );
  // Never while typing.
  const turned = leg()?.rotation;
  await act(async () =>
    nameField().dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true })),
  );
  expect(leg()?.rotation).toEqual(turned);
});

it("grows the whole creature, and says when it can't grow more", async () => {
  await setup();
  const height = () => container.querySelector(".size-readout .measured")?.textContent;
  const before = height();
  await click(labelled("Bigger creature"));
  expect(height()).not.toBe(before);
  await click(labelled("Bigger creature"));
  expect(container.querySelector(".stage-notice")?.textContent).toContain("can't grow any more");
  await click(labelled("Smaller creature"));
  expect(height()).toBe(before);
});

it("randomizes, fills empty places and resets, each one undo step", async () => {
  const { onUnsaved } = await setup();
  expect(button("Reset").disabled).toBe(true);
  await click(button("Randomize"));
  const random = shown();
  expect(random.instances.length).toBeGreaterThan(1);
  expect(onUnsaved).toHaveBeenLastCalledWith(true);
  await click(button("Fill empty"));
  expect(shown()).toBe(random);
  expect(container.querySelector(".stage-notice")?.textContent).toBe(NOTHING_TO_FILL);
  await click(button("Reset"));
  expect(shown()).toMatchObject({ instances: [{ id: "four-legged-torso" }] });
  expect(onUnsaved).toHaveBeenLastCalledWith(false);
  await key({ key: "z", ctrlKey: true });
  expect(shown()).toBe(random);
  // Fill empty keeps what is there.
  await click(button("Reset"));
  await click(trayPart("Round head"));
  await click(button("Fill empty"));
  expect(
    shown()
      .instances.map((i) => i.id)
      .slice(0, 2),
  ).toEqual(["four-legged-torso", "neck"]);
  expect(shown().instances.length).toBeGreaterThan(2);
});

it("loads a creature to edit afresh, and Reset and closing compare against it", async () => {
  const kit = partsKit(builtInParts());
  if (!kit) throw new Error("No kit");
  const loaded = randomize(startBuild(kit), kit, 2).history.present;
  const { onUnsaved, load } = await setup(undefined, {
    key: 1,
    assembly: loaded,
    name: "Bramble copy",
  });
  expect(shown()).toBe(loaded);
  expect(nameField().value).toBe("Bramble copy");
  expect(onUnsaved).toHaveBeenLastCalledWith(false);
  expect(labelled("Undo (Ctrl+Z)").disabled).toBe(true);
  expect(button("Reset").disabled).toBe(true);

  await click(labelled("Bigger creature"));
  expect(onUnsaved).toHaveBeenLastCalledWith(true);
  await click(button("Reset"));
  expect(shown()).toBe(loaded);
  expect(onUnsaved).toHaveBeenLastCalledWith(false);

  // The same key again loads nothing anew; a new key does, from the confirm step too.
  await click(labelled("Bigger creature"));
  await load({ key: 1, assembly: loaded, name: "Bramble copy" });
  expect(shown()).not.toBe(loaded);
  await click(button("Next"));
  const other = randomize(startBuild(kit), kit, 3).history.present;
  await load({ key: 2, assembly: other, name: "Moss copy" });
  expect(shown()).toBe(other);
  expect(nameField().value).toBe("Moss copy");
  expect(button("Next")).toBeDefined();
  expect(labelled("Undo (Ctrl+Z)").disabled).toBe(true);
});

it("drags a tray part onto the socket it points at, showing the ghost there first", async () => {
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) =>
    setTimeout(() => run(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  try {
    await setup();
    const stage = container.querySelector<HTMLDivElement>(".assembly-stage");
    if (!stage) throw new Error("No stage");
    stage.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 400 }) as DOMRect;
    // The pointer at (100, 100) points straight at the back-left hip; each pixel turns it a little.
    const [backLeft] = scoreSockets(
      shown(),
      [{ instance: "four-legged-torso", socket: "back-left" }],
      { origin: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } },
    );
    if (!backLeft) throw new Error("No back-left");
    const from = { x: 0, y: 2, z: 2 };
    view.probe = (x, y) => ({
      origin: from,
      direction: {
        x: backLeft.position.x - from.x + (x - 100) * 0.002,
        y: backLeft.position.y - from.y - (y - 100) * 0.002,
        z: backLeft.position.z - from.z,
      },
    });
    const pointer = (type: string, x: number, y: number, target: EventTarget = window) =>
      act(async () => {
        target.dispatchEvent(
          // jsdom has no PointerEvent; a mouse event carries what the drag reads.
          new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }),
        );
        await new Promise((resolve) => setTimeout(resolve, 1));
      });
    await pointer("pointerdown", 20, 300, trayPart("Paw leg"));
    // Not yet a drag: nothing marked.
    await pointer("pointermove", 22, 300);
    expect(view.highlighted).toEqual([]);
    await pointer("pointermove", 100, 101);
    expect(view.highlighted).toHaveLength(4);
    expect(container.querySelector(".drag-token")?.textContent).toBe("Paw leg");
    expect(view.ghost?.sockets).toEqual([
      { instance: "four-legged-torso", socket: "back-left" },
      { instance: "four-legged-torso", socket: "back-right" },
    ]);
    await pointer("pointerup", 100, 101);
    expect(shown().instances.map((i) => i.id)).toEqual([
      "four-legged-torso",
      "back-left",
      "back-right",
    ]);
    expect(view.ghost).toBeUndefined();
    expect(container.querySelector(".drag-token")).toBeNull();

    // Dropped away from every socket: nothing placed.
    await pointer("pointerdown", 20, 300, trayPart("Round head"));
    await pointer("pointermove", 380, 20);
    await pointer("pointerup", 380, 20);
    expect(shown().instances).toHaveLength(3);
  } finally {
    vi.unstubAllGlobals();
  }
});

// @vitest-environment jsdom
import type { VoxelAssembly } from "@living-diorama/content-schema";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { StudioSpecies } from "../studio-protocol";
import { copyName, copyRequest, useEditCopy } from "./edit-copy";
import type { StudioMode } from "./modes";
import { MyCreatures } from "./MyCreatures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ASSEMBLY = { parts: {}, instances: [] } as unknown as VoxelAssembly;

const species = (n: number): StudioSpecies => ({
  speciesId: `user:${n}`,
  libraryId: String(n),
  name: `Creature ${n}`,
  sizeClass: "medium",
  createdAt: "2026-10-30T12:00:00.000Z",
  available: true,
  limits: [],
  inWorld: 1,
});

describe("Edit a copy", () => {
  it("names the copy after the original, within the name field's 40 characters", () => {
    expect(copyName("Pebble")).toBe("Pebble copy");
    expect(copyName("  Mossy Pebble ")).toBe("Mossy Pebble copy");
    const long = copyName("A".repeat(40));
    expect(long).toHaveLength(40);
    expect(long.endsWith(" copy")).toBe(true);
  });

  it("fetches the species' assembly and makes a load request under the given key", async () => {
    const fetch = vi.fn(() => Promise.resolve({ assembly: ASSEMBLY }));
    const request = await copyRequest(fetch, { speciesId: "user:1", name: "Pebble" }, 7);
    expect(fetch).toHaveBeenCalledWith("user:1");
    expect(request).toEqual({ key: 7, assembly: ASSEMBLY, name: "Pebble copy" });
  });

  it("passes a failed fetch on, so the Studio can say what went wrong", async () => {
    const fetch = () => Promise.reject(new Error("unknown_species"));
    await expect(copyRequest(fetch, { speciesId: "user:9", name: "Gone" }, 1)).rejects.toThrow(
      "unknown_species",
    );
  });

  it("is offered for each species, and asks for the species pressed", async () => {
    const onEditCopy = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <MyCreatures
          library={{
            species: [species(1), species(2)],
            creatures: 2,
            maxCreatures: 20,
          }}
          thumbnail={() => undefined}
          open={true}
          onToggle={() => {}}
          onAdd={() => {}}
          onRemove={() => {}}
          onDelete={() => {}}
          onEditCopy={onEditCopy}
        />,
      ),
    );
    const buttons = [...container.querySelectorAll("button[title='Edit a copy']")];
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Edit a copy of Creature 1",
      "Edit a copy of Creature 2",
    ]);
    await act(async () => (buttons[1] as HTMLButtonElement).click());
    expect(onEditCopy).toHaveBeenCalledWith(expect.objectContaining({ speciesId: "user:2" }));
    await act(async () => root.unmount());
  });
});

/** A fetch whose answers the test gives, one species at a time. */
function deferredFetch() {
  const waiting = new Map<string, (assembly: VoxelAssembly) => void>();
  const fetch = (speciesId: string) =>
    new Promise<{ assembly: VoxelAssembly }>((resolve) =>
      waiting.set(speciesId, (assembly) => resolve({ assembly })),
    );
  const answer = (speciesId: string, assembly: VoxelAssembly) =>
    act(async () => waiting.get(speciesId)!(assembly));
  return { fetch, answer };
}

type EditCopy = ReturnType<typeof useEditCopy>;

async function mountHook(fetch: (id: string) => Promise<{ assembly: VoxelAssembly }>) {
  const onMode = vi.fn();
  const state = { unsaved: false };
  const loads: Promise<void>[] = [];
  let current: EditCopy | undefined;
  function Harness({ mode }: { mode: StudioMode }) {
    current = useEditCopy({
      fetch,
      mode,
      onMode,
      unsaved: () => state.unsaved,
      run: (_species, load) => void loads.push(load()),
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const render = (mode: StudioMode) => act(async () => root.render(<Harness mode={mode} />));
  await render("build");
  return {
    onMode,
    state,
    loads,
    render,
    /** Presses Edit a copy; the load it started, if it didn't ask first. */
    press: (species: { speciesId: string; name: string }) => {
      const before = loads.length;
      current!.press(species);
      return loads.length > before ? loads.at(-1)! : undefined;
    },
    get: () => current!,
    unmount: () => act(async () => root.unmount()),
  };
}

const OTHER = { parts: { x: {} }, instances: [] } as unknown as VoxelAssembly;

describe("Edit a copy in the Studio", () => {
  it("loads only the latest press, dropping an earlier fetch that answers late", async () => {
    const { fetch, answer } = deferredFetch();
    const hook = await mountHook(fetch);
    let first!: Promise<void>, second!: Promise<void>;
    await act(async () => {
      first = hook.press({ speciesId: "user:1", name: "Pebble" })!;
      second = hook.press({ speciesId: "user:2", name: "Twig" })!;
    });
    await answer("user:2", OTHER);
    await answer("user:1", ASSEMBLY);
    await act(async () => Promise.all([first, second]).then(() => undefined));
    expect(hook.get().loadRequest).toMatchObject({ name: "Twig copy", assembly: OTHER });
    expect(hook.onMode).toHaveBeenCalledTimes(1);
    await hook.unmount();
  });

  it("gives each press a new key, so the same species loads again", async () => {
    const fetch = () => Promise.resolve({ assembly: ASSEMBLY });
    const hook = await mountHook(fetch);
    await act(async () => hook.press({ speciesId: "user:1", name: "Pebble" }));
    const firstKey = hook.get().loadRequest?.key;
    await act(async () => hook.press({ speciesId: "user:1", name: "Pebble" }));
    expect(hook.get().loadRequest?.key).not.toBe(firstKey);
    await hook.unmount();
  });

  it("switches to Build when the copy arrives, unless the mode changed meanwhile", async () => {
    const { fetch, answer } = deferredFetch();
    const hook = await mountHook(fetch);
    await hook.render("draw");
    let pressed!: Promise<void>;
    await act(async () => {
      pressed = hook.press({ speciesId: "user:1", name: "Pebble" })!;
    });
    await answer("user:1", ASSEMBLY);
    await act(() => pressed);
    expect(hook.onMode).toHaveBeenCalledWith("build");

    hook.onMode.mockClear();
    await act(async () => {
      pressed = hook.press({ speciesId: "user:2", name: "Twig" })!;
    });
    await hook.render("build");
    await answer("user:2", OTHER);
    await act(() => pressed);
    expect(hook.onMode).not.toHaveBeenCalled();
    expect(hook.get().loadRequest).toMatchObject({ name: "Twig copy" });
    await hook.unmount();
  });

  it("rejects when the fetch fails, and loads nothing", async () => {
    const hook = await mountHook(() => Promise.reject(new Error("unknown_species")));
    await act(async () => {
      await expect(hook.press({ speciesId: "user:9", name: "Gone" })!).rejects.toThrow();
    });
    expect(hook.get().loadRequest).toBeUndefined();
    expect(hook.onMode).not.toHaveBeenCalled();
    await hook.unmount();
  });

  it("asks first when Build has a creature that wasn't released", async () => {
    const fetch = vi.fn(() => Promise.resolve({ assembly: ASSEMBLY }));
    const hook = await mountHook(fetch);
    hook.state.unsaved = true;
    await act(async () => void hook.press({ speciesId: "user:1", name: "Pebble" }));
    expect(hook.get().confirming).toMatchObject({ speciesId: "user:1" });
    expect(fetch).not.toHaveBeenCalled();
    // Cancel keeps the creature.
    await act(async () => hook.get().cancel());
    expect(hook.get().confirming).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(hook.get().loadRequest).toBeUndefined();
    // Discard loads the copy.
    await act(async () => void hook.press({ speciesId: "user:1", name: "Pebble" }));
    await act(async () => hook.get().confirm());
    await act(() => hook.loads.at(-1)!);
    expect(hook.get().confirming).toBeUndefined();
    expect(hook.get().loadRequest).toMatchObject({ name: "Pebble copy" });
    // With nothing to lose, it loads straight away.
    hook.state.unsaved = false;
    await act(async () => void hook.press({ speciesId: "user:2", name: "Twig" }));
    expect(hook.get().confirming).toBeUndefined();
    await act(() => hook.loads.at(-1)!);
    expect(hook.get().loadRequest).toMatchObject({ name: "Twig copy" });
    await hook.unmount();
  });
});

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

const species = (n: number, body: "voxel" | "drawn"): StudioSpecies => ({
  speciesId: `user:${n}`,
  libraryId: String(n),
  name: `Creature ${n}`,
  sizeClass: "medium",
  createdAt: "2026-10-30T12:00:00.000Z",
  body,
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

  it("is offered for voxel species only, and asks for the species pressed", async () => {
    const onEditCopy = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <MyCreatures
          library={{
            species: [species(1, "drawn"), species(2, "voxel")],
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
      "Edit a copy of Creature 2",
    ]);
    await act(async () => (buttons[0] as HTMLButtonElement).click());
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
  let current: EditCopy | undefined;
  function Harness({ mode }: { mode: StudioMode }) {
    current = useEditCopy(fetch, mode, onMode);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const render = (mode: StudioMode) => act(async () => root.render(<Harness mode={mode} />));
  await render("build");
  return {
    onMode,
    render,
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
      first = hook.get().start({ speciesId: "user:1", name: "Pebble" });
      second = hook.get().start({ speciesId: "user:2", name: "Twig" });
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
    await act(async () => hook.get().start({ speciesId: "user:1", name: "Pebble" }));
    const firstKey = hook.get().loadRequest?.key;
    await act(async () => hook.get().start({ speciesId: "user:1", name: "Pebble" }));
    expect(hook.get().loadRequest?.key).not.toBe(firstKey);
    await hook.unmount();
  });

  it("switches to Build when the copy arrives, unless the mode changed meanwhile", async () => {
    const { fetch, answer } = deferredFetch();
    const hook = await mountHook(fetch);
    await hook.render("draw");
    let pressed!: Promise<void>;
    await act(async () => {
      pressed = hook.get().start({ speciesId: "user:1", name: "Pebble" });
    });
    await answer("user:1", ASSEMBLY);
    await act(() => pressed);
    expect(hook.onMode).toHaveBeenCalledWith("build");

    hook.onMode.mockClear();
    await act(async () => {
      pressed = hook.get().start({ speciesId: "user:2", name: "Twig" });
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
      await expect(hook.get().start({ speciesId: "user:9", name: "Gone" })).rejects.toThrow();
    });
    expect(hook.get().loadRequest).toBeUndefined();
    expect(hook.onMode).not.toHaveBeenCalled();
    await hook.unmount();
  });
});

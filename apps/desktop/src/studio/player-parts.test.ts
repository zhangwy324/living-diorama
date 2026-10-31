// @vitest-environment jsdom
import { MAX_PLAYER_PART_NAME_LENGTH, playerPartId } from "@living-diorama/content-schema";
import { createMemoryPartsStore, type PartsStore } from "@living-diorama/desktop-integration";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtInParts } from "./fixtures/built-in-parts";
import { drawnPartEntry } from "./fixtures/player-parts";
import {
  checkPlayerPart,
  loadPlayerParts,
  NOT_READ_YET,
  playerPartSummary,
  renamedEntry,
  usePlayerParts,
  validPartName,
  type PlayerPartsState,
} from "./player-parts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const studioParts = builtInParts();
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";

const leg = (uuid = A, createdAt?: string) =>
  drawnPartEntry(studioParts, {
    uuid,
    type: "hollow:leg",
    name: "Stilt",
    ...(createdAt ? { createdAt } : {}),
  });

async function storeWith(...entries: [string, unknown][]) {
  const store = createMemoryPartsStore();
  for (const [uuid, entry] of entries) await store.save(uuid, entry);
  return store;
}

describe("loading the player's parts", () => {
  it("keeps valid parts, oldest first, as the tray lists them", async () => {
    const store = await storeWith(
      [A, leg(A, "2026-10-30T13:00:00.000Z")],
      [B, leg(B, "2026-10-30T12:00:00.000Z")],
    );
    const parts = await loadPlayerParts(store);
    expect(parts.map((part) => part.uuid)).toEqual([B, A]);
    expect(parts[0]?.summary).toEqual({
      id: playerPartId(B),
      name: "Stilt",
      version: "1",
      part: parts[0]?.entry.part,
    });
  });

  it("skips, with a log line, an entry that fails its schema or holds another part's ID", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = await storeWith(
      [A, leg(A)],
      [B, { ...leg(B), version: 0 }],
      // Stored as C, but holding A's ID.
      [C, leg(A)],
    );
    const parts = await loadPlayerParts(store);
    expect(parts.map((part) => part.uuid)).toEqual([A]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toContain(`Skipped player part ${B}`);
    expect(String(warn.mock.calls[1]?.[0])).toContain(
      `Skipped player part ${C}: it holds ${playerPartId(A)}`,
    );
    expect(checkPlayerPart(A, "not a part")).toBeUndefined();
    warn.mockRestore();
  });

  it("gives a pack-like summary, its version a string", () => {
    expect(playerPartSummary({ ...leg(), version: 3 }).version).toBe("3");
  });
});

describe("renaming", () => {
  it("saves the trimmed name as the next version", () => {
    const entry = leg();
    const renamed = renamedEntry(entry, "  Long leg ", new Date("2026-10-31T09:00:00.000Z"));
    expect(renamed).toEqual({
      ...entry,
      name: "Long leg",
      version: 2,
      updatedAt: "2026-10-31T09:00:00.000Z",
    });
  });

  it("takes a name that isn't blank or too long", () => {
    expect(validPartName("Stilt")).toBe(true);
    expect(validPartName("   ")).toBe(false);
    expect(validPartName("x".repeat(MAX_PLAYER_PART_NAME_LENGTH + 1))).toBe(false);
  });
});

describe("usePlayerParts", () => {
  let root: Root | undefined;
  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
  });

  async function mount(store: PartsStore | undefined) {
    const seen: { current: PlayerPartsState | undefined } = { current: undefined };
    function Probe() {
      seen.current = usePlayerParts(store, () => new Date("2026-10-31T09:00:00.000Z"));
      return null;
    }
    root = createRoot(document.createElement("div"));
    await act(async () => root?.render(createElement(Probe)));
    const state = () => {
      if (!seen.current) throw new Error("Not rendered");
      return seen.current;
    };
    return state;
  }

  it("reads the store, and again on reload", async () => {
    const store = await storeWith([A, leg(A)]);
    const state = await mount(store);
    expect(state().parts?.map((part) => part.uuid)).toEqual([A]);
    await store.save(B, leg(B, "2026-10-30T14:00:00.000Z"));
    let read: boolean | undefined;
    await act(async () => {
      read = await state().reload();
    });
    expect(read).toBe(true);
    expect(state().parts?.map((part) => part.uuid)).toEqual([A, B]);
  });

  it("says so when a part is renamed or deleted before the parts are read", async () => {
    const state = await mount({
      list: () => new Promise(() => {}),
      save: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    });
    let ok: boolean | undefined;
    await act(async () => {
      ok = await state().rename(A, "Long leg");
    });
    expect(ok).toBe(false);
    expect(state().error).toBe(NOT_READ_YET);
  });

  it("reads nothing with no store", async () => {
    const state = await mount(undefined);
    expect(state().parts).toBeUndefined();
  });

  it("renames a part in place as its next version, and keeps a refused name out", async () => {
    const store = await storeWith([A, leg(A)]);
    const state = await mount(store);
    let ok: boolean | undefined;
    await act(async () => {
      ok = await state().rename(A, "Long leg");
    });
    expect(ok).toBe(true);
    expect(state().parts?.[0]?.summary).toMatchObject({ name: "Long leg", version: "2" });
    const [stored] = await store.list();
    expect(stored?.entry).toMatchObject({
      id: playerPartId(A),
      name: "Long leg",
      version: 2,
      updatedAt: "2026-10-31T09:00:00.000Z",
    });
    await act(async () => {
      ok = await state().rename(A, "  ");
    });
    expect(ok).toBe(false);
    expect(state().parts?.[0]?.entry.name).toBe("Long leg");
  });

  it("deletes a part", async () => {
    const store = await storeWith([A, leg(A)], [B, leg(B)]);
    const state = await mount(store);
    await act(async () => {
      await state().remove(A);
    });
    expect(state().parts?.map((part) => part.uuid)).toEqual([B]);
    expect((await store.list()).map(({ id }) => id)).toEqual([B]);
  });

  it("says what went wrong when the store refuses, with a string as Tauri rejects", async () => {
    const memory = await storeWith([A, leg(A)]);
    const store: PartsStore = {
      list: () => memory.list(),
      save: () => Promise.reject("The disk is full"),
      delete: () => Promise.reject(new Error("Access is denied")),
    };
    const state = await mount(store);
    let ok: boolean | undefined;
    await act(async () => {
      ok = await state().rename(A, "Long leg");
    });
    expect(ok).toBe(false);
    expect(state().error).toBe("Could not rename Stilt: The disk is full");
    expect(state().parts?.[0]?.entry.version).toBe(1);
    await act(async () => {
      await state().remove(A);
    });
    expect(state().error).toBe("Could not delete Stilt: Access is denied");
    expect(state().parts).toHaveLength(1);
  });

  it("says when the store can't be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = await mount({
      list: () => Promise.reject("No parts folder"),
      save: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    });
    expect(state().error).toBe("Could not read your parts: No parts folder");
    // So Use in Build can drop its pick.
    let read: boolean | undefined;
    await act(async () => {
      read = await state().reload();
    });
    expect(read).toBe(false);
    warn.mockRestore();
  });
});

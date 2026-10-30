import type { Result } from "@living-diorama/content-schema";
import { createMemoryWorldStore, type WorldStore } from "@living-diorama/desktop-integration";
import type { RestoreReport } from "@living-diorama/simulation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installWorldDevHook } from "./dev-world";
import { EditHistory } from "./edit-history";
import { AUTOSAVE_MS, describeRestore, worldSaving, type SavedWorld } from "./world-saving";

const report = (overrides: Partial<RestoreReport> = {}): RestoreReport => ({
  gapMs: 30_000,
  droppedCreatures: [],
  prunedPlacements: [],
  droppedActions: [],
  catchUp: { applied: false, skipped: "short_gap", gapMs: 0, failures: [] },
  ...overrides,
});

/**
 * A world that records what it is asked, in order. Saves answer `save-1`, `save-2`… when
 * `answerSave` is called, so tests choose when each lands.
 */
function fakeWorld(restoreResult: Result<RestoreReport> = { ok: true, value: report() }) {
  const calls: string[] = [];
  const saves: ((json: string) => void)[] = [];
  let saved = 0;
  const world: SavedWorld = {
    save: vi.fn(() => {
      calls.push("save");
      return new Promise<Result<string>>((resolve) =>
        saves.push((json) => resolve({ ok: true, value: json })),
      );
    }),
    restore: vi.fn((json: string) => {
      calls.push(`restore ${json}`);
      return Promise.resolve(restoreResult);
    }),
    spawnStartingCreatures: vi.fn(() => {
      calls.push("spawn starting");
      return Promise.resolve();
    }),
    despawn: vi.fn((id: string) => {
      calls.push(`despawn ${id}`);
      return Promise.resolve<Result<string>>({ ok: true, value: id });
    }),
  };
  return {
    world,
    calls,
    /** Answers the oldest unanswered save. */
    async answerSave() {
      await vi.waitFor(() => expect(saves.length).toBeGreaterThan(0));
      saves.shift()?.(`save-${++saved}`);
      await flush();
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A store that records what it keeps. */
function recordingStore(json: string | null) {
  const memory = createMemoryWorldStore(json);
  const written: string[] = [];
  const store: WorldStore = {
    load: vi.fn(() => memory.load()),
    save: vi.fn(async (next: string) => {
      written.push(next);
      await memory.save(next);
    }),
  };
  return { store, written };
}

/** A wall clock the test moves on, and a page the test hides. */
const manualPage = () => {
  let time = 1_000_000;
  let hidden: (() => void) | undefined;
  return {
    options: {
      now: () => time,
      onHidden: (fn: () => void) => ((hidden = fn), () => (hidden = undefined)),
    },
    advance: (ms: number) => (time += ms),
    hide: () => hidden?.(),
    watching: () => hidden !== undefined,
  };
};

/** Opens `saving`, answering the save it makes once open. */
async function open(saving: ReturnType<typeof worldSaving>, fake: ReturnType<typeof fakeWorld>) {
  const opening = saving.open();
  await fake.answerSave();
  await opening;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("worldSaving startup", () => {
  it("restores the saved world and spawns nothing", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const fake = fakeWorld();
    const { store, written } = recordingStore('{"saved":true}');
    const saving = worldSaving(fake.world, {
      store,
      creatures: () => [],
      ...manualPage().options,
    });
    await open(saving, fake);
    expect(fake.calls).toEqual(['restore {"saved":true}', "save"]);
    expect(written).toEqual(["save-1"]);
  });

  it("spawns the starting creatures only after the restore was rejected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = fakeWorld({
      ok: false,
      diagnostics: [{ severity: "error", code: "save_world_mismatch", message: "x", path: [] }],
    });
    const { store } = recordingStore('{"other":true}');
    const saving = worldSaving(fake.world, {
      store,
      creatures: () => [],
      ...manualPage().options,
    });
    await open(saving, fake);
    expect(fake.calls).toEqual(['restore {"other":true}', "spawn starting", "save"]);
    expect(warn.mock.calls[0]?.[0]).toContain("save_world_mismatch");
  });

  it("spawns the starting creatures when nothing is saved", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const fake = fakeWorld();
    const saving = worldSaving(fake.world, {
      store: recordingStore(null).store,
      creatures: () => [],
      ...manualPage().options,
    });
    await open(saving, fake);
    expect(fake.calls).toEqual(["spawn starting", "save"]);
  });

  it("starts fresh but never saves this session when the save can't be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = fakeWorld();
    const page = manualPage();
    const store: WorldStore = {
      load: () => Promise.reject(new Error("world.json is locked")),
      save: vi.fn(() => Promise.resolve()),
    };
    const saving = worldSaving(fake.world, { store, creatures: () => [], ...page.options });
    await saving.open();
    await saving.save(); // as on quit
    expect(fake.calls).toEqual(["spawn starting"]);
    expect(store.save).not.toHaveBeenCalled();
    expect(page.watching()).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("without saving"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("world.json is locked"));
  });

  it("neither loads nor saves without a store, as under a count override", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const fake = fakeWorld();
    const page = manualPage();
    const saving = worldSaving(fake.world, {
      store: undefined,
      creatures: () => [],
      ...page.options,
    });
    await saving.open();
    await saving.save();
    expect(fake.calls).toEqual(["spawn starting"]);
    expect(page.watching()).toBe(false);
  });

  it("logs what a restore left out or caught up as a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = fakeWorld({
      ok: true,
      value: report({
        gapMs: 3 * 3_600_000,
        droppedCreatures: [
          {
            creatureId: "creature-2",
            speciesId: "user:gone",
            speciesVersion: "1.0.0",
            reason: "species_missing",
          },
        ],
        catchUp: { applied: true, gapMs: 3 * 3_600_000, failures: [] },
      }),
    });
    const saving = worldSaving(fake.world, {
      store: recordingStore("{}").store,
      creatures: () => [],
      ...manualPage().options,
    });
    await open(saving, fake);
    const logged = String(warn.mock.calls[0]?.[0]);
    expect(logged).toContain("creature-2 (user:gone 1.0.0): species_missing");
    expect(logged).toContain("Caught up 180 min");
  });
});

describe("worldSaving saves", () => {
  async function opened(json: string | null = null) {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const fake = fakeWorld();
    const recording = recordingStore(json);
    const page = manualPage();
    const saving = worldSaving(fake.world, {
      store: recording.store,
      creatures: () => [{ id: "creature-1" }, { id: "creature-2" }],
      ...page.options,
    });
    await open(saving, fake);
    fake.calls.length = 0;
    recording.written.length = 0;
    return { fake, saving, page, ...recording };
  }

  it("does nothing before the world is open", async () => {
    const fake = fakeWorld();
    const saving = worldSaving(fake.world, {
      store: recordingStore(null).store,
      creatures: () => [],
    });
    await saving.save();
    expect(fake.calls).toEqual([]);
  });

  it("asks for the next save only once the one before is stored", async () => {
    const { fake, saving, written } = await opened();
    const first = saving.save();
    await fake.answerSave();
    const second = saving.save();
    expect(fake.calls).toEqual(["save"]);
    await first;
    await fake.answerSave();
    await second;
    expect(fake.calls).toEqual(["save", "save"]);
    expect(written).toEqual(["save-2", "save-3"]);
  });

  it("stores saves in the order they were asked for, sharing one that waits", async () => {
    const { fake, saving, written } = await opened();
    const autosave = saving.save(); // in flight
    await flush();
    const afterSpawn = saving.save(); // waits for the autosave
    const onQuit = saving.save(); // shares the waiting save
    expect(onQuit).toBe(afterSpawn);
    await fake.answerSave();
    await autosave;
    await fake.answerSave();
    await onQuit;
    expect(written).toEqual(["save-2", "save-3"]);
  });

  it("saves when due, a minute after the last save was asked for", async () => {
    const { fake, saving, page } = await opened();
    expect(AUTOSAVE_MS).toBe(60_000);
    page.advance(AUTOSAVE_MS - 1);
    await saving.saveIfDue();
    expect(fake.calls).toEqual([]);
    page.advance(1);
    const due = saving.saveIfDue();
    await fake.answerSave();
    await due;
    expect(fake.calls).toEqual(["save"]);
    // Any save, such as one after a spawn, puts the next autosave off a minute.
    page.advance(AUTOSAVE_MS / 2);
    const afterSpawn = saving.save();
    await fake.answerSave();
    await afterSpawn;
    page.advance(AUTOSAVE_MS / 2);
    await saving.saveIfDue();
    expect(fake.calls).toEqual(["save", "save"]);
  });

  it("does nothing when due before open or without a store, and starts counting only once open", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const fake = fakeWorld();
    const page = manualPage();
    const saving = worldSaving(fake.world, {
      store: recordingStore(null).store,
      creatures: () => [],
      ...page.options,
    });
    await saving.saveIfDue();
    expect(fake.calls).toEqual([]);
    const unstored = worldSaving(fake.world, { store: undefined, creatures: () => [] });
    await unstored.open();
    await unstored.saveIfDue();
    expect(fake.calls).toEqual(["spawn starting"]);
    fake.calls.length = 0;
    // The save on open is the first one asked for, so the autosave counts from it.
    await open(saving, fake);
    page.advance(AUTOSAVE_MS - 1);
    await saving.saveIfDue();
    expect(fake.calls).toEqual(["spawn starting", "save"]);
  });

  it("shares a save that waits when due", async () => {
    const { fake, saving, page } = await opened();
    const inFlight = saving.save();
    await flush();
    const waiting = saving.save();
    page.advance(AUTOSAVE_MS);
    expect(saving.saveIfDue()).toBe(waiting);
    await fake.answerSave();
    await inFlight;
    await fake.answerSave();
    await waiting;
    expect(fake.calls).toEqual(["save", "save"]);
  });

  it("saves when the page is hidden until stopped", async () => {
    const { fake, saving, page, written } = await opened();
    expect(page.watching()).toBe(true);
    page.hide();
    await fake.answerSave();
    expect(written).toEqual(["save-2"]);
    saving.stop();
    expect(page.watching()).toBe(false);
    page.advance(AUTOSAVE_MS);
    await saving.saveIfDue();
    await saving.save();
    expect(fake.calls).toEqual(["save"]);
  });

  it("keeps saving after a store failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fake, saving, store, written } = await opened();
    vi.mocked(store.save).mockRejectedValueOnce(new Error("disk full"));
    const failing = saving.save();
    await fake.answerSave();
    await failing;
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("disk full"));
    const next = saving.save();
    await fake.answerSave();
    await next;
    expect(written).toEqual(["save-3"]);
  });

  it("keeps saving after a save that throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fake, saving, written } = await opened();
    vi.mocked(fake.world.save).mockRejectedValueOnce(new Error("worker gone"));
    await saving.save();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("worker gone"));
    const next = saving.save();
    await fake.answerSave();
    await next;
    expect(written).toEqual(["save-2"]);
  });

  it("logs a creature the reset couldn't take out", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fake, saving } = await opened();
    vi.mocked(fake.world.despawn).mockResolvedValueOnce({
      ok: false,
      diagnostics: [{ severity: "error", code: "unknown_creature", message: "gone", path: [] }],
    });
    const resetting = saving.reset();
    await fake.answerSave();
    await resetting;
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown_creature"));
  });

  it("resets the world from the dev hook: creatures out, starting ones in, then saved", async () => {
    const { fake, saving, written } = await opened('{"saved":true}');
    vi.stubGlobal("window", {});
    const clear = vi.fn();
    const uninstall = installWorldDevHook(saving, {
      history: new EditHistory(() => Promise.reject(new Error("no edits"))),
      validateEdit: () => Promise.reject(new Error("no edits")),
      clear,
    });
    const resetting = window.livingDiorama?.world?.reset();
    await fake.answerSave();
    await resetting;
    expect(fake.calls).toEqual([
      "despawn creature-1",
      "despawn creature-2",
      "spawn starting",
      "save",
    ]);
    expect(written).toEqual(["save-2"]);
    // The undo history and the selection are forgotten too.
    expect(clear).toHaveBeenCalledOnce();
    uninstall();
    expect(window.livingDiorama?.world).toBeUndefined();
  });

  it("refuses a reset before the world is open", async () => {
    const saving = worldSaving(fakeWorld().world, { store: undefined, creatures: () => [] });
    await expect(saving.reset()).rejects.toThrow("still starting");
  });
});

describe("describeRestore", () => {
  it("is not notable for a short gap with nothing left out", () => {
    expect(describeRestore(report())).toEqual({
      lines: ["Restored the saved world, saved 30 s ago", "No catch-up: short_gap"],
      notable: false,
    });
  });
});

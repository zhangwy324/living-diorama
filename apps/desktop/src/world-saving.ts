import { formatDiagnostic } from "@living-diorama/content-schema";
import type { WorldStore } from "@living-diorama/desktop-integration";
import type { RestoreReport } from "@living-diorama/simulation";
import type { SimulationClient } from "./simulation-client";

// Keeping the world across launches (ADR 0019): restoring it at startup, then saving it every
// minute, after creatures come and go, when the strip is hidden and on quit.

/**
 * How often the running world is saved (ADR 0019 §4). Checked on every snapshot rather than by a
 * main-thread timer, which WebView2 throttles while the strip is hidden (issue #117).
 */
export const AUTOSAVE_MS = 60_000;

/** What saving needs of the running world. */
export type SavedWorld = Pick<
  SimulationClient,
  "save" | "restore" | "spawnStartingCreatures" | "despawn"
>;

export interface WorldSavingOptions {
  /**
   * Where the world is kept, or undefined to neither load nor save it, as when the creature count
   * is overridden for measuring (ADR 0019 §11).
   */
  store: WorldStore | undefined;
  /** The creatures in the world now, from the latest snapshot. */
  creatures(): readonly { id: string }[];
  /** Wall-clock time in milliseconds; injectable for tests. */
  now?(): number;
  /**
   * Calls `callback` whenever the page becomes hidden, until the returned function is called;
   * injectable for tests.
   */
  onHidden?(callback: () => void): () => void;
}

export interface WorldSaving {
  /**
   * Restores the saved world, or spawns the starting creatures when there is no usable save
   * (ADR 0019 §3, §7), then saves it and starts saving whenever the page is hidden. Call once,
   * after the library has registered its species. Never rejects: whatever goes wrong is logged and the world starts
   * fresh. If the store fails to load, nothing is saved this session, so a save that is there but
   * unreadable for now is never overwritten.
   */
  open(): Promise<void>;
  /**
   * Saves the world after any save in flight, so an older save never lands after a newer one. A
   * save asked for while another waits to start shares it. Does nothing before `open` has
   * finished, once stopped, without a store, or after the save could not be read at startup.
   * Never rejects: a failure is logged.
   */
  save(): Promise<void>;
  /**
   * Saves the world if the last save was asked for at least `AUTOSAVE_MS` ago. Call often, e.g.
   * on every snapshot: the worker keeps sending them while the strip is hidden, unlike a
   * main-thread timer, which WebView2 throttles then (issue #117).
   */
  saveIfDue(): Promise<void>;
  /**
   * Takes every creature out and spawns the starting ones, as in a fresh world, then saves
   * (ADR 0019 §9). For development only. Rejects before `open` has finished.
   */
  reset(): Promise<void>;
  /** Stops saving for good. */
  stop(): void;
}

const describeGap = (ms: number) =>
  ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;

const describeError = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * Lines for the log saying what a restore did. `notable` is true when it left something out or
 * caught up, which the diagnostics log should keep.
 */
export function describeRestore(report: RestoreReport): { lines: string[]; notable: boolean } {
  const { catchUp } = report;
  const lines = [
    `Restored the saved world, saved ${describeGap(report.gapMs)} ago`,
    ...report.droppedCreatures.map(
      (c) =>
        `Left out ${c.creatureId} (${c.speciesId} ${c.speciesVersion}): ${c.reason}` +
        (c.registeredVersion ? `, ${c.registeredVersion} is registered` : ""),
    ),
    ...report.prunedPlacements.map(
      (p) => `Forgot ${p.placementId} in ${p.creatureId}'s ${p.where}: no longer in the world`,
    ),
    ...report.droppedActions.map(
      (a) => `Dropped ${a.creatureId}'s running ${a.actionId}: ${a.reason}`,
    ),
    catchUp.applied
      ? `Caught up ${describeGap(catchUp.gapMs)}`
      : `No catch-up: ${catchUp.skipped ?? "not needed"}`,
    ...catchUp.failures.map(
      (f) =>
        `Catch-up of ${f.behavior} had no effect on ${f.creatureId}: ${f.reason}` +
        (f.need ? ` (${f.need})` : ""),
    ),
  ];
  const notable =
    report.droppedCreatures.length > 0 ||
    report.prunedPlacements.length > 0 ||
    report.droppedActions.length > 0 ||
    catchUp.applied ||
    catchUp.failures.length > 0;
  return { lines, notable };
}

/** Keeps `world` in `store` (ADR 0019). Nothing happens until `open`. */
export function worldSaving(
  world: SavedWorld,
  { store, creatures, now = Date.now, onHidden = onPageHidden }: WorldSavingOptions,
): WorldSaving {
  let opened = false;
  let stopped = false;
  /**
   * Where saves go: the store, until a load fails. A save that can't be read may still be good
   * (e.g. a file another program holds), so this session then never saves over it.
   */
  let target = store;
  let stopSavingOnHide = () => {};
  /** When the last save was asked for, which the autosave counts from. */
  let lastAsked = -Infinity;
  /** The last save asked for; the next one starts after it. */
  let tail = Promise.resolve();
  /** A save asked for that hasn't started yet, which later requests share. */
  let waiting: Promise<void> | undefined;

  const writeSave = async (into: WorldStore) => {
    const saved = await world.save();
    if (!saved.ok) {
      console.warn(
        ["Could not save the world", ...saved.diagnostics.map(formatDiagnostic)].join("\n  "),
      );
      return;
    }
    try {
      await into.save(saved.value);
    } catch (cause) {
      console.warn(`Could not save the world: ${describeError(cause)}`);
    }
  };

  const save = () => {
    const into = target;
    if (!opened || stopped || !into) return Promise.resolve();
    if (waiting) return waiting;
    lastAsked = now();
    // Never rejects, so one failed save can't stop the ones after it.
    const next = tail
      .then(() => {
        waiting = undefined;
        return writeSave(into);
      })
      .catch((cause: unknown) => console.warn(`Could not save the world: ${describeError(cause)}`));
    waiting = next;
    tail = next;
    return next;
  };

  /** Restores the save in `from`; true if the world is now the saved one. */
  const restore = async (from: WorldStore) => {
    let json;
    try {
      json = await from.load();
    } catch (cause) {
      target = undefined;
      console.warn(
        `Could not read the saved world, starting fresh without saving until the next launch: ${describeError(cause)}`,
      );
      return false;
    }
    if (json === null) {
      console.info("No saved world, starting fresh");
      return false;
    }
    const restored = await world.restore(json);
    if (!restored.ok) {
      console.warn(
        [
          "The saved world can't be used, starting fresh",
          ...restored.diagnostics.map(formatDiagnostic),
        ].join("\n  "),
      );
      return false;
    }
    const { lines, notable } = describeRestore(restored.value);
    (notable ? console.warn : console.info)(lines.join("\n  "));
    return true;
  };

  return {
    async open() {
      if (!store) console.info("Creature count overridden: the world is neither loaded nor saved");
      // The starting creatures spawn only once the restore has answered (ADR 0019 §3).
      const restored = store ? await restore(store) : false;
      if (!restored) await world.spawnStartingCreatures();
      if (stopped) return;
      opened = true;
      await save();
      if (!stopped && target) stopSavingOnHide = onHidden(() => void save());
    },
    save,
    saveIfDue() {
      return now() - lastAsked >= AUTOSAVE_MS ? save() : Promise.resolve();
    },
    async reset() {
      if (!opened) throw new Error("The world is still starting");
      const despawned = await Promise.all(
        creatures().map((creature) => world.despawn(creature.id)),
      );
      for (const result of despawned) {
        if (!result.ok) {
          console.warn(
            [
              "Reset could not take a creature out",
              ...result.diagnostics.map(formatDiagnostic),
            ].join("\n  "),
          );
        }
      }
      await world.spawnStartingCreatures();
      await save();
    },
    stop() {
      stopped = true;
      stopSavingOnHide();
    },
  };
}

function onPageHidden(callback: () => void) {
  const onChange = () => {
    if (document.visibilityState === "hidden") callback();
  };
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

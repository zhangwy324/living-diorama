import {
  formatDiagnostic,
  SIZE_CLASSES,
  type Drawing,
  type Result,
  type SizeClass,
} from "@living-diorama/content-schema";
import { createMemoryLibraryStore } from "@living-diorama/desktop-integration";
import {
  minutesAfter,
  Simulation,
  type CreatureState,
  type SimulationEvent,
} from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import { loadContent } from "./content";
import { openSpeciesLibrary, type LibraryWorld } from "./species-library";
import { STARTUP } from "./startup";

// Drawn species live like the mossling (ADR 0018 §4, PR 5b): saved and released through the
// species library as the Studio does, into a headless simulation of the startup world.

const HUNGER = "core:hunger";
const TIRED = "core:tiredness";
const HZ = 2;
const MINUTE = 60 * HZ;
const PNG = new Uint8Array([137, 80, 78, 71]);
const DRAWING: Drawing = {
  schemaVersion: 2,
  canvas: { width: 256, height: 256 },
  history: [{ kind: "stroke", tool: "pen", color: "#336633", width: 12, points: [10, 10, 1] }],
};

/** The startup world, run headless from `startMinutes`, behind the library's view of a world. */
function headlessWorld(startMinutes: number) {
  const content = loadContent();
  if (!content.ok) throw new Error(content.diagnostics.map(formatDiagnostic).join("\n"));
  const created = Simulation.create(content.value, {
    worldId: STARTUP.worldId,
    seed: 5,
    tickRateHz: HZ,
    minutes: startMinutes,
  });
  if (!created.ok) throw new Error(created.diagnostics.map(formatDiagnostic).join("\n"));
  const simulation = created.value;
  const events: SimulationEvent[] = [];
  const world: LibraryWorld = {
    registerSpecies: (species, url, kind) => {
      const registered = simulation.registerSpecies(species, url, kind);
      return Promise.resolve(
        registered.ok
          ? {
              ok: true as const,
              value: { speciesId: registered.value.species.id, limits: registered.value.limits },
            }
          : registered,
      );
    },
    spawn: (speciesId, { released = false } = {}) => {
      const spawned = simulation.spawn(speciesId, undefined, { released });
      return Promise.resolve(spawned.ok ? { ok: true as const, value: spawned.value.id } : spawned);
    },
    despawn: (creatureId) => {
      const despawned = simulation.despawn(creatureId);
      return Promise.resolve(despawned.ok ? { ok: true as const, value: creatureId } : despawned);
    },
    creatures: () => [...simulation.state.creatures.values()],
  };
  const run = (ticks: number, until?: () => boolean) => {
    for (let t = 0; t < ticks && !until?.(); t++) {
      simulation.setTimeOfDay(minutesAfter(startMinutes, (simulation.tick * 1000) / HZ));
      events.push(...simulation.step());
    }
  };
  const of = (creature: CreatureState, type: SimulationEvent["type"]) =>
    events.filter((e) => e.type === type && "creatureId" in e && e.creatureId === creature.id);
  return { simulation, world, events, run, of };
}

const value = <T>(result: Result<T>) => {
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.value;
};

describe("drawn creatures released from the Studio", () => {
  it(
    "wait out the release grace, sleep at a shelter that becomes home, wake to eat and go home",
    { timeout: 60_000 },
    async () => {
      const { simulation, world, run, of } = headlessWorld(21 * 60 + 45);
      const library = await openSpeciesLibrary(createMemoryLibraryStore(), world);
      const sizes = Object.keys(SIZE_CLASSES) as SizeClass[];
      const creatures: [SizeClass, CreatureState][] = [];
      for (const size of sizes) {
        const { speciesId } = value(await library.save(DRAWING, PNG, `Drawn ${size}`, size));
        const id = value(await library.addCreature(speciesId));
        const creature = simulation.state.creatures.get(id)!;
        expect(creature.releasedAtTick).toBe(0);
        expect(Object.keys(creature.needs).sort()).toEqual([HUNGER, TIRED]);
        creatures.push([size, creature]);
      }
      const all = (check: (c: CreatureState) => boolean) => () =>
        creatures.every(([, c]) => check(c));

      // Night, but the first 10 minutes after release are awake.
      run(10 * MINUTE - 1);
      for (const [, c] of creatures) expect(of(c, "fell_asleep")).toEqual([]);

      // Then to bed at a shelter, which becomes home.
      run(
        60 * MINUTE,
        all((c) => c.asleep),
      );
      const homes = new Map<string, string>();
      for (const [size, c] of creatures) {
        expect({ size, asleep: c.asleep }).toEqual({ size, asleep: true });
        const [fell] = of(c, "fell_asleep") as { placementId: string | null; tick: number }[];
        // Within a minute of the grace ending.
        expect({ size, tick: fell!.tick, inTime: fell!.tick <= 11 * MINUTE }).toMatchObject({
          size,
          inTime: true,
        });
        expect({ size, home: c.home }).toEqual({ size, home: fell!.placementId });
        expect(c.home).not.toBeNull();
        homes.set(c.id, c.home!);
        const prop = simulation.state.model.propsById.get(c.home!)!;
        expect(Object.keys(prop.affordances)).toContain("core:shelter");
        const { x, z } = prop.transform.position;
        // At its spot: reach plus the fallback's 1.5 m at most.
        const reach = prop.blockRadius + SIZE_CLASSES[size].radius + 0.3 + 1.5;
        expect(Math.hypot(c.position.x - x, c.position.z - z)).toBeLessThanOrEqual(reach);
      }
      const drawn = new Set(creatures.map(([, c]) => c.id));
      const snapshots = simulation.snapshot().creatures.filter((s) => drawn.has(s.id));
      expect(snapshots).toHaveLength(creatures.length);
      for (const snapshot of snapshots) expect(snapshot.cues).toContain("sleeping");

      // Hunger at 0.9 wakes each to eat; then it goes back to sleep at home. Hunger is set just
      // below the trigger rather than left to rise asleep (about 9 hours), to keep the test short.
      for (const [, c] of creatures) c.needs[HUNGER] = 0.8999;
      run(
        120 * MINUTE,
        all((c) => of(c, "fell_asleep").length >= 2),
      );
      for (const [size, c] of creatures) {
        const woke = of(c, "woke_up");
        expect({ size, woke: woke[0] }).toMatchObject({ size, woke: { reason: "interrupted" } });
        expect({ size, ate: of(c, "ate").length > 0 }).toEqual({ size, ate: true });
        const again = of(c, "fell_asleep")[1] as { placementId: string | null } | undefined;
        expect({ size, slept: again?.placementId }).toEqual({ size, slept: homes.get(c.id) });
        expect(c.home).toBe(homes.get(c.id));
      }
    },
  );
});

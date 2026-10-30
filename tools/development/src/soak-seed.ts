import { emptyEditReport, randomEdits, type EditReport } from "./edit-cycles";
import { beaver, carp, otter, registerHollowCreatures } from "./fixtures/hollow-creatures";
import { VOXEL_SPECIES } from "./fixtures/voxel-creatures";
import { LIVING_BEHAVIOR_CHECKS, runWithInvariants } from "./simulation-run";
import { spread } from "./time-spread";

// One seed of `pnpm soak` (`soak.ts`), run on the soak's own thread or in a worker
// (`soak-worker.ts`). Everything in and out is plain data, so it crosses to and from a worker as is.

export const MOSSLING = "hollow:mossling";

/** The amphibian species reported on, by the name the report gives them. */
export const AMPHIBIANS = [
  { name: "amphibian", id: otter.id },
  { name: "water-loving amphibian", id: beaver.id },
  { name: "voxel amphibian", id: VOXEL_SPECIES["land+swim"].input.id },
];

/**
 * The voxel species each seed adds a creature of (ADR 0022, M19): the sample voxel creature as an
 * amphibian and as a hopper, so between them they walk, hop and swim. Registered while the world
 * runs and again before each restore, as the app registers library species.
 */
export const SOAK_VOXEL_SPECIES = [VOXEL_SPECIES["land+swim"], VOXEL_SPECIES.hop];

/** What every seed of a soak runs with. */
export interface SoakConfig {
  ticks: number;
  tickRateHz: number;
  /** Mosslings per run. */
  creatures: number;
  /** Leave out the amphibians, the swimmer and the voxel creatures. */
  mosslingsOnly: boolean;
  saveRestore: { cycles: number; compareTicks: number; longGap: boolean };
  /** Random prop edits per run, some of them undos (ADR 0021). */
  edits: number;
}

/** One seed's outcome: what to print for it and what the summary adds up. */
export interface SeedResult {
  seed: number;
  /** The seed's line, then one indented line per problem. */
  lines: string[];
  failed: boolean;
  restores: number;
  /** Restores of a world edited earlier in the run. */
  editedRestores: number;
  comparedTicks: number;
  largestSaveBytes: number;
  /** Creatures put to bed by catch-up away from a full home (issue #158). */
  fullHomes: number;
  /**
   * Per species of `AMPHIBIANS`, in that order: bank jumps, ticks in water and out of it summed
   * over its creatures, and the share of time in water. Empty when the run never finished.
   */
  amphibians: { jumps: number; water: number; land: number; share: number }[];
  /** The random edits: counts by outcome and `applyEdit` times. */
  edits: EditReport;
  /** How many minutes apart the earliest and latest bedtimes, and wake times; none if no times. */
  bedSpread?: number;
  wakeSpread?: number;
}

export function runSoakSeed(seed: number, config: SoakConfig): SeedResult {
  /** Creatures that used a structure, and each creature's jumps across a bank, by ID. */
  const structureUsers = new Set<string>();
  const jumpsBy = new Map<string, number>();
  /** Per amphibian species, ticks in water and out of it, summed over its creatures. */
  const amphibianTicks = new Map(AMPHIBIANS.map(({ id }) => [id, { water: 0, land: 0 }]));
  const report = runWithInvariants({
    register: registerHollowCreatures,
    worldId: "hollow:woodland-hollow",
    speciesId: MOSSLING,
    seed,
    ticks: config.ticks,
    tickRateHz: config.tickRateHz,
    creatures: config.creatures,
    ...(config.mosslingsOnly
      ? {}
      : {
          alsoSpawn: {
            [otter.id]: 1,
            [beaver.id]: 1,
            [carp.id]: 1,
            ...Object.fromEntries(SOAK_VOXEL_SPECIES.map((s) => [s.input.id, 1])),
          },
          runtimeSpecies: SOAK_VOXEL_SPECIES,
        }),
    ...LIVING_BEHAVIOR_CHECKS,
    saveRestore: config.saveRestore,
    edits: randomEdits(seed, config.ticks, { count: config.edits }),
    onTick: (simulation, events) => {
      for (const e of events) {
        if (e.type === "first_use_of_structure") structureUsers.add(e.creatureId);
        if (e.type === "entered_region" && e.connectionId === undefined) {
          jumpsBy.set(e.creatureId, (jumpsBy.get(e.creatureId) ?? 0) + 1);
        }
      }
      const { creatures, model } = simulation.state;
      for (const c of creatures.values()) {
        const ticksOf = amphibianTicks.get(c.speciesId);
        if (!ticksOf) continue;
        const kind = model.regions.get(c.position.regionId)?.kind;
        ticksOf[kind === "water" ? "water" : "land"]++;
      }
    },
  });
  const counts = report.eventCounts;
  const of = (speciesId: string) =>
    Object.entries(report.creatures).flatMap(([id, c]) => (c.speciesId === speciesId ? [id] : []));
  // Every mossling finds the bridge; the amphibian may cross by the banks instead.
  const mosslings = of(MOSSLING);
  const { cycles } = config.saveRestore;
  const problems = [
    ...report.violations,
    ...(counts.creature_stuck ? [`${counts.creature_stuck} creature_stuck events`] : []),
    ...(counts.path_failed ? [`${counts.path_failed} path_failed events`] : []),
    ...(mosslings.every((id) => structureUsers.has(id))
      ? []
      : ["not every mossling crossed the bridge"]),
    ...(report.saveRestore.restores === cycles
      ? []
      : [`${report.saveRestore.restores} of ${cycles} restores done`]),
  ];
  const amphibians: SeedResult["amphibians"] = [];
  const swims: string[] = [];
  for (const { name, id: speciesId } of AMPHIBIANS) {
    const { water, land } = amphibianTicks.get(speciesId) ?? { water: 0, land: 0 };
    const jumps = of(speciesId).reduce((n, id) => n + (jumpsBy.get(id) ?? 0), 0);
    const share = water / Math.max(1, water + land);
    amphibians.push({ jumps, water, land, share });
    swims.push(`${name} ${jumps} bank jumps, ${percent(share)} of time in water`);
  }
  // A restore after a long gap may skip a night's events, so a seed may have no times at all.
  const sleepers = Object.entries(report.creatures).filter(([, c]) => c.sleepChecked);
  const bedtimes = sleepers.flatMap(([, c]) => c.bedtimes);
  const wakeTimes = sleepers.flatMap(([, c]) => c.wakeTimes);
  const swam = config.mosslingsOnly ? "" : `, ${swims.join(", ")}`;
  const line =
    `seed ${seed}: ${problems.length === 0 ? "ok" : "FAILED"}, ${report.decisions} decisions, ` +
    `first bridge use at tick ${report.firstStructureUse ?? "never"}${swam}, ` +
    `bed ${spread(bedtimes, "n/a")}, woke ${spread(wakeTimes, "n/a")} across ${sleepers.length} ` +
    `sleepers, ${report.saveRestore.restores} restores (${report.saveRestore.editedRestores} of an edited world)${describeLongGap(report.saveRestore.longGap)}, ` +
    `${describeSeedEdits(report.edits)}` +
    `${Math.round(report.elapsedMs)} ms`;
  return {
    seed,
    lines: [line, ...problems.map((problem) => `  ${problem}`)],
    failed: problems.length > 0,
    restores: report.saveRestore.restores,
    editedRestores: report.saveRestore.editedRestores,
    comparedTicks: report.saveRestore.comparedTicks,
    largestSaveBytes: report.saveRestore.largestSaveBytes,
    fullHomes: report.saveRestore.fullHomes,
    edits: report.edits,
    amphibians,
    ...(bedtimes.length > 0 ? { bedSpread: Math.max(...bedtimes) - Math.min(...bedtimes) } : {}),
    ...(wakeTimes.length > 0
      ? { wakeSpread: Math.max(...wakeTimes) - Math.min(...wakeTimes) }
      : {}),
  };
}

/** A seed whose run threw or whose worker died: a failure with nothing to add up. */
export function crashedSeed(seed: number, error: unknown): SeedResult {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  return {
    seed,
    lines: [`seed ${seed}: FAILED, the run crashed`, ...message.split("\n").map((l) => `  ${l}`)],
    failed: true,
    restores: 0,
    editedRestores: 0,
    comparedTicks: 0,
    largestSaveBytes: 0,
    fullHomes: 0,
    edits: emptyEditReport(),
    amphibians: [],
  };
}

export function percent(share: number): string {
  return `${(share * 100).toFixed(0)}%`;
}

function describeLongGap(longGap: { gapMs: number; at: string } | undefined): string {
  return longGap
    ? ` (one after ${(longGap.gapMs / 3_600_000).toFixed(1)} h away, back at ${longGap.at})`
    : "";
}

/** A seed's edits in brief: applied (undos), rejected and creatures relocated. */
function describeSeedEdits(edits: EditReport): string {
  const rejected = Object.values(edits.rejected).reduce((a, b) => a + b, 0);
  return (
    `${edits.applied} edits (${edits.undos} undos, ${rejected} rejected, ` +
    `${edits.relocated} relocated), `
  );
}

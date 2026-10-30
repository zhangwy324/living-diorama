import {
  formatDiagnostic,
  parseWorldEdit,
  type Vec2,
  type WorldEdit,
  type WorldEditOpInput,
} from "@living-diorama/content-schema";
import { pointInPolygon, Rng, type Simulation, type WorldModel } from "@living-diorama/simulation";

// World edits in the long runs (ADR 0021, M17 PR 5): edit scripts for `pnpm sim --edits` and
// random prop edits for `pnpm soak`. Both hand `runWithInvariants` the edits to apply before a
// step; the runner applies them, keeps the undo history and checks the world after each.

/** An edit to apply, or `undo`: the inverse of the last edit applied and not yet undone. */
export type EditRequest = { edit: WorldEdit } | { undo: true };

/**
 * The edits to apply before step `step` of a run (0-based, counted from the run's start, so 0 is
 * before the first step), in order. Called once per step, between steps, with the world as it is.
 */
export type EditSource = (step: number, simulation: Simulation) => readonly EditRequest[];

/** An edit script entry, as `pnpm sim --edits <file>` reads it. */
export interface ScriptedEdit {
  /** Steps since the run's start; the edit applies before that step. */
  step: number;
  request: EditRequest;
}

/**
 * Reads an edit script: a JSON array of `{ "tick": n, "edit": { "ops": [...] } }` or
 * `{ "tick": n, "undo": true }`, where `tick` counts steps from the run's start. Edits go through
 * `parseWorldEdit`, as the app's worker reads them. Throws with every problem found.
 */
export function parseEditScript(json: unknown): ScriptedEdit[] {
  if (!Array.isArray(json)) {
    throw new Error('An edit script is a JSON array of { "tick", "edit" } or { "tick", "undo" }');
  }
  const problems: string[] = [];
  const script = json.flatMap((entry: unknown, i): ScriptedEdit[] => {
    const at = `[${i}]`;
    if (typeof entry !== "object" || entry === null) {
      problems.push(`${at}: not an object`);
      return [];
    }
    const { tick, edit, undo, ...rest } = entry as Record<string, unknown>;
    if (Object.keys(rest).length > 0) {
      problems.push(`${at}: unknown keys ${Object.keys(rest).join(", ")}`);
    }
    if (typeof tick !== "number" || !Number.isInteger(tick) || tick < 0) {
      problems.push(`${at}.tick: a whole number ≥ 0`);
      return [];
    }
    if (undo !== undefined) {
      if (undo !== true || edit !== undefined) {
        problems.push(`${at}: "undo" must be true, with no "edit"`);
        return [];
      }
      return [{ step: tick, request: { undo: true } }];
    }
    const parsed = parseWorldEdit(edit);
    if (!parsed.ok) {
      problems.push(...parsed.diagnostics.map((d) => `${at}.edit: ${formatDiagnostic(d)}`));
      return [];
    }
    return [{ step: tick, request: { edit: parsed.value } }];
  });
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return script.toSorted((a, b) => a.step - b.step);
}

/** The requests of a script, step by step. */
export function scriptedEdits(script: readonly ScriptedEdit[]): EditSource {
  return (step) => script.filter((e) => e.step === step).map((e) => e.request);
}

/** Random prop edits in a run, drawn from its seed (`pnpm soak`). */
export interface RandomEditOptions {
  /** Edit requests per run, at random steps. */
  count: number;
  /** The chance that a request is an undo instead of a new edit; default `UNDO_CHANCE`. */
  undoChance?: number;
}

/** About one request in five is an undo. */
export const UNDO_CHANCE = 0.2;
/** About one new edit in five has two or three ops, applied all or nothing. */
const COMPOUND_CHANCE = 0.2;
/**
 * Room kept between a drawn footprint and every connection portal, structure region and spawn
 * point, so random edits don't close the bridge or a spawn point. Closing the bridge would make
 * the soak's "every mossling crosses the bridge" fail for a reason that is no bug; blocking a bank
 * stays possible, and gives the water-exit warning.
 */
const CLEARANCE = 1.5;
/** Tries to find a place for an add, move or scale before falling back to a turn. */
const TRIES = 20;
const SCALES = { add: [0.7, 1.5], scale: [0.6, 1.8] } as const;
/**
 * The kinds of random op, equally likely: `cover` adds a prop where a creature stands on land,
 * so that edits relocate creatures, and `turn` is a move with a rotation alone.
 */
const KINDS = ["add", "cover", "remove", "move", "scale", "turn"] as const;

/**
 * `options.count` requests at steps drawn from `seed` over a run of `ticks` steps: adds, removes,
 * moves, scales and turns of props, sometimes several in one edit, and sometimes an undo. Every
 * drawn edit passes `parseWorldEdit`; whether it fits the world is the simulation's to decide, so
 * some are rejected, and the runner counts them.
 */
export function randomEdits(seed: number, ticks: number, options: RandomEditOptions): EditSource {
  const rng = Rng.fromSeed(seed).fork("dev:world-edits");
  const steps = Array.from({ length: Math.max(0, Math.floor(options.count)) }, () =>
    rng.int(0, Math.max(1, ticks)),
  ).sort((a, b) => a - b);
  const undoChance = options.undoChance ?? UNDO_CHANCE;
  let next = 0;
  return (step, simulation) => {
    const requests: EditRequest[] = [];
    for (; next < steps.length && (steps[next] ?? Infinity) <= step; next++) {
      requests.push(
        rng.chance(undoChance) ? { undo: true } : { edit: randomEdit(rng, simulation) },
      );
    }
    return requests;
  };
}

/** One random edit of the props of `simulation`'s world, one op or, sometimes, two or three. */
export function randomEdit(rng: Rng, simulation: Simulation): WorldEdit {
  const count = rng.chance(COMPOUND_CHANCE) ? rng.int(2, 4) : 1;
  const ops = Array.from({ length: count }, () => randomOp(rng, simulation));
  const parsed = parseWorldEdit({ ops });
  if (!parsed.ok) throw new Error(parsed.diagnostics.map(formatDiagnostic).join("\n"));
  return parsed.value;
}

function randomOp(rng: Rng, simulation: Simulation): WorldEditOpInput {
  const { model, registries, creatures } = simulation.state;
  const typeRadius = (prop: string) => registries.props.get(prop)?.blockRadius ?? 0;
  const placed = rng.pick(model.props);
  const kind = placed ? rng.pick(KINDS) : "add";
  const turn = (id: string): WorldEditOpInput => ({
    op: "prop.move",
    id,
    rotationY: rng.range(0, 2 * Math.PI),
  });
  switch (kind) {
    case "remove":
      if (placed) return { op: "prop.remove", id: placed.id };
      break;
    case "turn":
      if (placed) return turn(placed.id);
      break;
    case "scale":
      if (!placed) break;
      for (let n = 0; n < TRIES; n++) {
        const scale = rng.range(...SCALES.scale);
        const center = { x: placed.transform.position.x, z: placed.transform.position.z };
        if (isClear(model, center, typeRadius(placed.prop) * scale)) {
          return { op: "prop.scale", id: placed.id, scale };
        }
      }
      return turn(placed.id);
    case "move":
      if (!placed) break;
      for (let n = 0; n < TRIES; n++) {
        const position = onLand(model, randomPoint(rng, model));
        if (position && isClear(model, position, placed.blockRadius)) {
          return { op: "prop.move", id: placed.id, position, rotationY: rng.range(0, 2 * Math.PI) };
        }
      }
      return turn(placed.id);
    case "add":
    case "cover":
      break;
  }
  // An add: anywhere on land, or, to cover a creature, where one stands.
  const props = registries.props
    .values()
    .map((p) => p.id)
    .sort();
  const standing = [...creatures.values()].map((c) => ({ x: c.position.x, z: c.position.z }));
  for (let n = 0; n < TRIES; n++) {
    const prop = rng.pick(props);
    const scale = rng.range(...SCALES.add);
    const position = onLand(model, kind === "cover" ? rng.pick(standing) : randomPoint(rng, model));
    if (prop && position && isClear(model, position, typeRadius(prop) * scale)) {
      return { op: "prop.add", prop, position, rotationY: rng.range(0, 2 * Math.PI), scale };
    }
  }
  // Nowhere clear to add one: turn a prop instead, or, in a world without props, add one anyway.
  return placed
    ? turn(placed.id)
    : { op: "prop.add", prop: props[0] ?? "", position: { x: 0, z: 0 } };
}

function randomPoint(rng: Rng, model: WorldModel): Vec2 {
  const { min, max } = model.bounds;
  return { x: rng.range(min.x, max.x), z: rng.range(min.z, max.z) };
}

/** `point` if it lies on land outside every structure's regions. */
function onLand(model: WorldModel, point: Vec2 | undefined): Vec2 | undefined {
  if (!point) return undefined;
  const land = [...model.regions.values()].some(
    (r) => r.kind === "land" && !r.structureId && pointInPolygon(point.x, point.z, r.footprint),
  );
  return land ? point : undefined;
}

/**
 * Whether a footprint at `center` of `radius` stays `CLEARANCE` away from the world's edge, every
 * connection's portal, every structure region and every spawn point.
 */
function isClear(model: WorldModel, center: Vec2, radius: number): boolean {
  const room = radius + CLEARANCE;
  const { min, max } = model.bounds;
  if (
    center.x - room < min.x ||
    center.x + room > max.x ||
    center.z - room < min.z ||
    center.z + room > max.z
  ) {
    return false;
  }
  for (const c of model.connections) {
    if (distanceToSegment(center, c.portal.a, c.portal.b) < room) return false;
  }
  for (const r of model.regions.values()) {
    if (!r.structureId) continue;
    const { minX, minZ, maxX, maxZ } = r.box;
    if (
      center.x > minX - room &&
      center.x < maxX + room &&
      center.z > minZ - room &&
      center.z < maxZ + room
    ) {
      return false;
    }
  }
  return model.definition.spawnPoints.every(
    ({ position: p }) => Math.hypot(p.x - center.x, p.z - center.z) >= room,
  );
}

function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length2 = dx * dx + dz * dz;
  const t =
    length2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / length2));
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}

/** What the edits of a run did (`RunReport.edits`). */
export interface EditReport {
  /** Edits applied, undos included. */
  applied: number;
  /** Undos applied. */
  undos: number;
  /** Requests refused, by the first diagnostic's code (`nothing_to_undo` for an empty history). */
  rejected: Record<string, number>;
  /** Creatures moved off a covered cell. */
  relocated: number;
  /**
   * Times an edit left a creature the meal check held with no food in reach (its only food
   * removed, or the creature cut off from all food), so the check stopped holding it.
   */
  foodCutOff: number;
  /** Warnings of applied edits, by code. */
  warnings: Record<string, number>;
  /** Milliseconds each `applyEdit` took, applied or refused, in order. */
  applyMs: number[];
}

export function emptyEditReport(): EditReport {
  return {
    applied: 0,
    undos: 0,
    rejected: {},
    relocated: 0,
    foodCutOff: 0,
    warnings: {},
    applyMs: [],
  };
}

/** Adds `b` into `a`. */
export function addEditReports(a: EditReport, b: EditReport): EditReport {
  const add = (x: Record<string, number>, y: Record<string, number>) => {
    const sum = { ...x };
    for (const [k, n] of Object.entries(y)) sum[k] = (sum[k] ?? 0) + n;
    return sum;
  };
  return {
    applied: a.applied + b.applied,
    undos: a.undos + b.undos,
    rejected: add(a.rejected, b.rejected),
    relocated: a.relocated + b.relocated,
    foodCutOff: a.foodCutOff + b.foodCutOff,
    warnings: add(a.warnings, b.warnings),
    applyMs: [...a.applyMs, ...b.applyMs],
  };
}

/** One line on a run's edits: counts, refusals and warnings by code, and `applyEdit` times. */
export function describeEdits(report: EditReport): string {
  const codes = (counts: Record<string, number>) =>
    Object.entries(counts)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([code, n]) => `${code} ${n}`)
      .join(", ");
  const rejected = Object.values(report.rejected).reduce((a, b) => a + b, 0);
  const warned = Object.values(report.warnings).reduce((a, b) => a + b, 0);
  return (
    `${report.applied} edits applied (${report.undos} undos), ` +
    `${rejected} rejected${rejected ? ` (${codes(report.rejected)})` : ""}, ` +
    `${report.relocated} creatures relocated, ` +
    `${report.foodCutOff} times a creature was cut off from food, ` +
    `${warned} warnings${warned ? ` (${codes(report.warnings)})` : ""}, ` +
    `applyEdit ${describeTimes(report.applyMs)}`
  );
}

/** Median, 95th percentile and maximum of `ms`, or `n/a`. */
export function describeTimes(ms: readonly number[]): string {
  if (ms.length === 0) return "n/a";
  const sorted = ms.toSorted((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return `median ${at(0.5).toFixed(1)} ms, p95 ${at(0.95).toFixed(1)} ms, max ${at(1).toFixed(1)} ms`;
}

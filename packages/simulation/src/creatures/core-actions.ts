import type { RegionPosition } from "@living-diorama/content-schema";
import type { ActionProvider, PathPoint, PathState } from "./contracts";

// `core:idle` and `core:follow_path` (roadmap M3 task 6). Preconditions are checked in `start`,
// progress in `step`; completion is a `done` status. An interrupted action's state is dropped.

interface IdleState {
  remainingTicks: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isPosition = (value: unknown): value is RegionPosition =>
  isRecord(value) &&
  typeof value.regionId === "string" &&
  Number.isFinite(value.x) &&
  Number.isFinite(value.z);

/** Stands still for `params.seconds`, rounded to whole ticks (at least one). */
export const idleAction: ActionProvider = {
  id: "core:idle",
  version: "1.0.0",
  start(params, { tickSeconds }) {
    const seconds = isRecord(params) ? params.seconds : undefined;
    if (typeof seconds !== "number" || !(seconds > 0) || !Number.isFinite(seconds)) {
      return { ok: false, reason: "invalid_params", detail: { expected: "{ seconds > 0 }" } };
    }
    const state: IdleState = { remainingTicks: Math.max(1, Math.round(seconds / tickSeconds)) };
    return { ok: true, state };
  },
  step(state) {
    const idle = state as IdleState;
    idle.remainingTicks--;
    return idle.remainingTicks > 0 ? { status: "running" } : { status: "done" };
  },
};

/** Walks to `params.destination` along a route the engine plans. */
export const followPathAction: ActionProvider = {
  id: "core:follow_path",
  version: "1.0.0",
  start(params, context) {
    const destination = isRecord(params) ? params.destination : undefined;
    if (!isPosition(destination)) {
      return { ok: false, reason: "invalid_params", detail: { expected: "{ destination }" } };
    }
    const result = context.planRoute(destination);
    if (!result.ok) return { ok: false, reason: result.reason, detail: { detail: result.detail } };
    const { legs, length } = result.route;
    const points: PathPoint[] = [];
    legs.forEach((leg, k) => {
      const entry = legs[k - 1]?.exit;
      leg.points.forEach((p, n) => {
        // The first leg starts where the creature stands; later legs start at the crossing.
        if (n === 0 && !entry) return;
        points.push(
          n === 0 && entry
            ? { regionId: leg.regionId, x: p.x, z: p.z, connectionId: entry.connectionId }
            : { regionId: leg.regionId, x: p.x, z: p.z },
        );
      });
    });
    const state: PathState = { points, next: 0 };
    return {
      ok: true,
      state,
      detail: { length, regions: legs.map((l) => l.regionId) },
    };
  },
  step(state, context) {
    return context.walk(state as PathState) === "arrived"
      ? { status: "done" }
      : { status: "running" };
  },
};

export const coreActions: readonly ActionProvider[] = [idleAction, followPathAction];

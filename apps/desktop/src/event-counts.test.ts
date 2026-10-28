import type {
  CreatureSnapshot,
  SimulationEvent,
  SimulationSnapshot,
} from "@living-diorama/simulation";
import { expect, it } from "vitest";
import { EventCounter } from "./event-counts";

const at = (x: number, regionId = "meadow"): CreatureSnapshot => ({
  id: "c1",
  speciesId: "hollow:mossling",
  position: { regionId, x, z: 0 },
  world: { x, y: 0, z: 0 },
  heading: 0,
  cues: [],
});
const snapshot = (...creatures: CreatureSnapshot[]): SimulationSnapshot => ({
  tick: 0,
  timeMs: 0,
  paused: false,
  timeOfDay: 720,
  creatures,
});
const stuck = (x: number): SimulationEvent => ({
  type: "creature_stuck",
  tick: 0,
  creatureId: "c1",
  position: { regionId: "meadow", x, z: 0 },
  ticksStuck: 50,
});

it("counts a stuck event as recovered once the creature moves away", () => {
  const counter = new EventCounter();
  expect(counter.observe(snapshot(at(0)), [stuck(0)])).toBe(true);
  expect(counter.observe(snapshot(at(0.2)), [])).toBe(false);
  expect(counter.counts).toEqual({ stuck: 1, recovered: 0, pathFailed: 0 });
  expect(counter.observe(snapshot(at(0.6)), [])).toBe(true);
  expect(counter.counts).toEqual({ stuck: 1, recovered: 1, pathFailed: 0 });
});

it("recovers every stuck event of a creature at once", () => {
  const counter = new EventCounter();
  counter.observe(snapshot(at(0)), [stuck(0)]);
  counter.observe(snapshot(at(0.1)), [stuck(0.1)]);
  counter.observe(snapshot(at(0, "bridge")), []);
  expect(counter.counts).toEqual({ stuck: 2, recovered: 2, pathFailed: 0 });
});

it("counts failed paths", () => {
  const counter = new EventCounter();
  const failed: SimulationEvent = {
    type: "path_failed",
    tick: 0,
    creatureId: "c1",
    from: { regionId: "meadow", x: 0, z: 0 },
    to: { regionId: "meadow", x: 5, z: 0 },
    reason: "no route",
  };
  expect(counter.observe(snapshot(at(0)), [failed])).toBe(true);
  expect(counter.counts.pathFailed).toBe(1);
});

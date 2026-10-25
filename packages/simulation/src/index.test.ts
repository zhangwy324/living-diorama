import { expect, it } from "vitest";
import { envelope, openEnvelope, PROTOCOL_VERSION, type SimulationCommand } from "./index";

it("round-trips messages through a versioned envelope", () => {
  const command: SimulationCommand = { type: "set_speed", multiplier: 2 };
  // JSON round-trip stands in for postMessage; simulation has no DOM or Node globals.
  const sent = JSON.parse(JSON.stringify(envelope(command))) as unknown;
  expect(sent).toMatchObject({ protocolVersion: PROTOCOL_VERSION });
  expect(openEnvelope<SimulationCommand>(sent)).toEqual(command);
});

it("rejects envelopes from another protocol version or malformed data", () => {
  expect(openEnvelope({ protocolVersion: PROTOCOL_VERSION + 1, message: { type: "pause" } })).toBe(
    undefined,
  );
  expect(openEnvelope({ type: "pause" })).toBeUndefined();
  expect(openEnvelope(null)).toBeUndefined();
});

import { RequestTimeoutError } from "@living-diorama/desktop-integration";
import { describe, expect, it } from "vitest";
import { canRelease, describeFailure, keptMessage, releasedMessage } from "./release";

describe("the Release button", () => {
  it("needs a name that isn't only spaces", () => {
    expect(canRelease({ name: "Creature 1", empty: false, releasing: false })).toBe(true);
    expect(canRelease({ name: "", empty: false, releasing: false })).toBe(false);
    expect(canRelease({ name: "   ", empty: false, releasing: false })).toBe(false);
  });

  it("needs something drawn and waits for a release on its way", () => {
    expect(canRelease({ name: "Puddle", empty: true, releasing: false })).toBe(false);
    expect(canRelease({ name: "Puddle", empty: false, releasing: true })).toBe(false);
  });
});

describe("what the Studio says", () => {
  it("cheers a release and says when the creature couldn't join", () => {
    expect(releasedMessage("Puddle")).toBe("Puddle is off into the world!");
    expect(keptMessage("Puddle", "The world is full (20 creatures).")).toBe(
      "Puddle is saved in My creatures, but couldn't join the world: The world is full (20 creatures).",
    );
  });

  it("passes the strip's words on, and says a timeout can be tried again", () => {
    expect(describeFailure(new Error("The world is full (20 creatures)."))).toBe(
      "The world is full (20 creatures).",
    );
    expect(describeFailure(new RequestTimeoutError("release"))).toBe(
      "The world didn't answer in time. Try again in a moment.",
    );
  });
});

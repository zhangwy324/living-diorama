import { RequestTimeoutError } from "@living-diorama/desktop-integration";
import { describe, expect, it } from "vitest";
import { NO_NAME, describeFailure, keptMessage, releasedMessage } from "./release";

it("says to go back for a name", () => {
  expect(NO_NAME).toBe("Give your creature a name first: go back to name it.");
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

import { expect, it } from "vitest";
import { packageName } from "./index";

it("exposes its package name", () => {
  expect(packageName).toBe("@living-diorama/simulation");
});

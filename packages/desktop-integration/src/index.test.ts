import { expect, it } from "vitest";
import { connectDesktopShell, noopShell, packageName } from "./index";

it("exposes its package name", () => {
  expect(packageName).toBe("@living-diorama/desktop-integration");
});

it("falls back to the no-op shell outside Tauri", async () => {
  const shell = connectDesktopShell();
  expect(shell).toBe(noopShell);
  await expect(shell.setStripHeight(200)).resolves.toBeUndefined();
});

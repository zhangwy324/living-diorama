import { expect, it } from "vitest";
import { shortcutFor } from "./shortcuts";

const key = (key: string, extra: Partial<KeyboardEvent> = {}) => ({
  key,
  repeat: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...extra,
});

it("toggles full screen with F11 and resets the camera with Home", () => {
  for (const fullScreen of [false, true]) {
    expect(shortcutFor(key("F11"), fullScreen)).toBe("toggle-full-screen");
    expect(shortcutFor(key("Home"), fullScreen)).toBe("reset-camera");
  }
});

it("leaves full screen with Esc, and does nothing with it otherwise", () => {
  expect(shortcutFor(key("Escape"), true)).toBe("leave-full-screen");
  expect(shortcutFor(key("Escape"), false)).toBeUndefined();
});

it("ignores other keys, held keys and modifiers", () => {
  expect(shortcutFor(key("d"), false)).toBeUndefined();
  expect(shortcutFor(key("F11", { repeat: true }), false)).toBeUndefined();
  expect(shortcutFor(key("Home", { ctrlKey: true }), false)).toBeUndefined();
  expect(shortcutFor(key("Escape", { altKey: true }), true)).toBeUndefined();
});

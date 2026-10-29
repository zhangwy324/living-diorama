import { expect, it } from "vitest";
import { connectWorldStore, createMemoryWorldStore } from "./index";

it("keeps a saved world in memory outside Tauri", async () => {
  const store = connectWorldStore();
  expect(await store.load()).toBeNull();

  await store.save('{"tick":1}');
  await store.save('{"tick":2}');
  expect(await store.load()).toBe('{"tick":2}');
});

it("can start with a saved world", async () => {
  expect(await createMemoryWorldStore('{"tick":7}').load()).toBe('{"tick":7}');
});

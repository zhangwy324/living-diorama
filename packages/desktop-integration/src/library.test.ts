import { expect, it } from "vitest";
import { connectLibraryStore } from "./index";

const ID = "3f9c2a1e-8b4d-4c6f-9a2e-1d5b7c9e0f13";

it("keeps a library in memory outside Tauri", async () => {
  const store = connectLibraryStore();
  const image = new Uint8Array([137, 80, 78, 71]);
  await store.save(ID, { name: "Puddle" }, { strokes: [] }, image);
  image[0] = 0;

  expect(await store.list()).toEqual([{ id: ID, entry: { name: "Puddle" } }]);
  expect(await store.loadDrawing(ID)).toEqual({ strokes: [] });
  expect(await store.loadImage(ID)).toEqual(new Uint8Array([137, 80, 78, 71]));
  await expect(store.save(ID, {}, {}, image)).rejects.toThrow("already exists");

  await store.delete(ID);
  expect(await store.list()).toEqual([]);
  await expect(store.loadImage(ID)).rejects.toThrow("No library entry");
  await expect(store.delete(ID)).rejects.toThrow("No library entry");
});

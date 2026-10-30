import { expect, it } from "vitest";
import { connectLibraryStore } from "./index";

const ID = "3f9c2a1e-8b4d-4c6f-9a2e-1d5b7c9e0f13";
const VOXEL_ID = "0a1b2c3d-8b4d-4c6f-9a2e-1d5b7c9e0f13";

it("keeps a library in memory outside Tauri", async () => {
  const store = connectLibraryStore();
  const image = new Uint8Array([137, 80, 78, 71]);
  await store.save(ID, { name: "Puddle" }, { drawing: { strokes: [] }, image });
  image[0] = 0;

  expect(await store.list()).toEqual([{ id: ID, entry: { name: "Puddle" } }]);
  expect(await store.loadDrawing(ID)).toEqual({ strokes: [] });
  expect(await store.loadImage(ID)).toEqual(new Uint8Array([137, 80, 78, 71]));
  await expect(store.save(ID, {})).rejects.toThrow("already exists");

  await store.delete(ID);
  expect(await store.list()).toEqual([]);
  await expect(store.loadImage(ID)).rejects.toThrow("No library entry");
  await expect(store.delete(ID)).rejects.toThrow("No library entry");
});

it("keeps a voxel entry without a drawing or an image", async () => {
  const store = connectLibraryStore();
  const entry = { name: "Cube", body: { kind: "voxel", assembly: { voxels: [8, 1] } } };
  await store.save(VOXEL_ID, entry);

  expect(await store.list()).toEqual([{ id: VOXEL_ID, entry }]);
  await expect(store.loadDrawing(VOXEL_ID)).rejects.toThrow("has no drawing");
  await expect(store.loadImage(VOXEL_ID)).rejects.toThrow("has no drawing");
  await store.delete(VOXEL_ID);
  expect(await store.list()).toEqual([]);
});

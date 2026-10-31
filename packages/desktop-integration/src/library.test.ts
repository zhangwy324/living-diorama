import { expect, it } from "vitest";
import { connectLibraryStore } from "./index";

const ID = "3f9c2a1e-8b4d-4c6f-9a2e-1d5b7c9e0f13";

it("keeps a library in memory outside Tauri", async () => {
  const store = connectLibraryStore();
  const entry = { schemaVersion: 6, name: "Cube", assembly: { voxels: [8, 1] } };
  await store.save(ID, entry);
  entry.name = "Changed";

  expect(await store.list()).toEqual([{ id: ID, entry: { ...entry, name: "Cube" } }]);
  await expect(store.save(ID, {})).rejects.toThrow("already exists");

  await store.delete(ID);
  expect(await store.list()).toEqual([]);
  await expect(store.delete(ID)).resolves.toBeUndefined(); // already gone
});

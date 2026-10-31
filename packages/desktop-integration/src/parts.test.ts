import { expect, it } from "vitest";
import { connectPartsStore, createMemoryPartsStore } from "./index";

const ID = "3f9c2a1e-8b4d-4c6f-9a2e-1d5b7c9e0f13";
const OTHER_ID = "0a1b2c3d-8b4d-4c6f-9a2e-1d5b7c9e0f13";

it("keeps parts in memory outside Tauri", async () => {
  const store = connectPartsStore();
  const entry = { schemaVersion: 1, name: "Tail", version: 1 };
  await store.save(ID, entry);
  await store.save(OTHER_ID, { name: "Ear" });
  entry.name = "Changed";

  expect(await store.list()).toEqual([
    { id: OTHER_ID, entry: { name: "Ear" } },
    { id: ID, entry: { schemaVersion: 1, name: "Tail", version: 1 } },
  ]);

  await store.delete(OTHER_ID);
  await store.delete(OTHER_ID); // already gone
  expect((await store.list()).map((part) => part.id)).toEqual([ID]);
});

it("replaces a part saved again under its ID", async () => {
  const store = createMemoryPartsStore();
  await store.save(ID, { version: 1 });
  await store.save(ID, { version: 2 });
  expect(await store.list()).toEqual([{ id: ID, entry: { version: 2 } }]);
});

it("hands out copies", async () => {
  const store = createMemoryPartsStore();
  await store.save(ID, { name: "Tail" });
  const [listed] = await store.list();
  (listed?.entry as { name: string }).name = "Changed";
  expect((await store.list())[0]?.entry).toEqual({ name: "Tail" });
});

it.each(["", "../escape", ID.toUpperCase(), `user-part:${ID}`])(
  "refuses the ID %j, as the app's store does",
  async (id) => {
    const store = createMemoryPartsStore();
    await expect(store.save(id, {})).rejects.toThrow("is not a part ID");
    await expect(store.delete(id)).rejects.toThrow("is not a part ID");
    expect(await store.list()).toEqual([]);
  },
);

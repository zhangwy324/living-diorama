import { describe, expect, it, vi } from "vitest";
import { Thumbnails } from "./thumbnails";

const species = (n: number) => ({ speciesId: `user:${n}`, libraryId: String(n) });

function setUp() {
  const revoked: string[] = [];
  const load = vi.fn((libraryId: string) =>
    libraryId === "bad"
      ? Promise.reject(new Error("unreadable"))
      : Promise.resolve(new Uint8Array([Number(libraryId)])),
  );
  const thumbnails = new Thumbnails({
    load,
    onChange: () => {},
    createUrl: (bytes) => `blob:${bytes[0]}`,
    revokeUrl: (url) => void revoked.push(url),
  });
  return { thumbnails, load, revoked };
}

const settle = () => new Promise((resolve) => setTimeout(resolve));

describe("thumbnails", () => {
  it("loads each species' image once", async () => {
    const { thumbnails, load } = setUp();
    thumbnails.sync([species(1)]);
    thumbnails.sync([species(1), species(2)]);
    await settle();
    expect(load.mock.calls.map(([id]) => id)).toEqual(["1", "2"]);
    expect(thumbnails.get("user:2")).toBe("blob:2");
  });

  it("revokes the image of a species that left the list", async () => {
    const { thumbnails, revoked } = setUp();
    thumbnails.sync([species(1), species(2)]);
    await settle();
    thumbnails.sync([species(2)]);
    expect(revoked).toEqual(["blob:1"]);
    expect(thumbnails.get("user:1")).toBeUndefined();
    thumbnails.dispose();
    expect(revoked).toEqual(["blob:1", "blob:2"]);
  });

  it("drops an image that arrives after its species left, and survives one that fails", async () => {
    const { thumbnails } = setUp();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    thumbnails.sync([species(1), { speciesId: "user:bad", libraryId: "bad" }]);
    thumbnails.sync([]);
    await settle();
    expect(thumbnails.get("user:1")).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

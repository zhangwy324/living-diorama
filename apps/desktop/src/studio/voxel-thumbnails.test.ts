import type { VoxelAssembly } from "@living-diorama/content-schema";
import { describe, expect, it, vi } from "vitest";
import { CREATURE_THUMBNAIL_SIZE, VoxelCreatureThumbnails } from "./voxel-thumbnails";

const ASSEMBLY = { parts: {}, instances: [] } as unknown as VoxelAssembly;

const voxel = (n: number) => ({ speciesId: `user:${n}` });

function setUp(options: { failFetch?: Set<string>; noRenderer?: boolean } = {}) {
  const fetch = vi.fn((speciesId: string) =>
    options.failFetch?.has(speciesId)
      ? Promise.reject(new Error("timed out"))
      : Promise.resolve({ speciesId, version: "v1", assembly: ASSEMBLY }),
  );
  const draw = vi.fn((source: { id: string; version: string }, size: number) =>
    Promise.resolve(`data:${source.id}@${source.version}:${size}`),
  );
  const disposeRenderer = vi.fn();
  const createRenderer = vi.fn(() => {
    if (options.noRenderer) throw new Error("no WebGL");
    return { thumbnails: { assembly: draw }, dispose: disposeRenderer };
  });
  const onChange = vi.fn();
  const thumbnails = new VoxelCreatureThumbnails({ fetch, createRenderer, onChange });
  return { thumbnails, fetch, draw, createRenderer, disposeRenderer, onChange };
}

const settle = () => new Promise((resolve) => setTimeout(resolve));

describe("voxel creature thumbnails", () => {
  it("fetches and draws each species, keyed by id and version", async () => {
    const { thumbnails, fetch, draw, onChange } = setUp();
    thumbnails.sync([voxel(2)]);
    await settle();
    expect(fetch.mock.calls).toEqual([["user:2"]]);
    expect(draw.mock.calls).toEqual([
      [{ id: "user:2", version: "v1", assembly: ASSEMBLY }, CREATURE_THUMBNAIL_SIZE],
    ]);
    expect(thumbnails.get("user:2")).toBe(`data:user:2@v1:${CREATURE_THUMBNAIL_SIZE}`);
    expect(thumbnails.get("user:1")).toBeUndefined();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("makes no renderer until a species is listed, and one for all of them", async () => {
    const { thumbnails, createRenderer } = setUp();
    thumbnails.sync([]);
    await settle();
    expect(createRenderer).not.toHaveBeenCalled();
    thumbnails.sync([voxel(2), voxel(3)]);
    await settle();
    expect(createRenderer).toHaveBeenCalledTimes(1);
  });

  it("fetches each species once, however often the list changes", async () => {
    const { thumbnails, fetch } = setUp();
    thumbnails.sync([voxel(1)]);
    thumbnails.sync([voxel(1)]);
    await settle();
    thumbnails.sync([voxel(1), voxel(2)]);
    await settle();
    expect(fetch.mock.calls.map(([id]) => id)).toEqual(["user:1", "user:2"]);
  });

  it("keeps a placeholder when a fetch fails, and tries again at the next change", async () => {
    const failFetch = new Set(["user:1"]);
    const { thumbnails, fetch, onChange } = setUp({ failFetch });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    thumbnails.sync([voxel(1)]);
    await settle();
    expect(thumbnails.get("user:1")).toBeUndefined();
    expect(onChange).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    failFetch.clear();
    thumbnails.sync([voxel(1)]);
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(thumbnails.get("user:1")).toBeDefined();
    warn.mockRestore();
  });

  it("draws nothing, and stops asking, when no renderer can be made", async () => {
    const { thumbnails, fetch, createRenderer } = setUp({ noRenderer: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    thumbnails.sync([voxel(1)]);
    await settle();
    thumbnails.sync([voxel(1), voxel(2)]);
    await settle();
    expect(createRenderer).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(thumbnails.get("user:1")).toBeUndefined();
    warn.mockRestore();
  });

  it("forgets a species that left the list, and drops its late answer", async () => {
    const { thumbnails, onChange } = setUp();
    thumbnails.sync([voxel(1)]);
    thumbnails.sync([]);
    await settle();
    expect(thumbnails.get("user:1")).toBeUndefined();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("frees the renderer on dispose and ignores answers after it", async () => {
    const { thumbnails, disposeRenderer, onChange } = setUp();
    thumbnails.sync([voxel(1)]);
    await settle();
    thumbnails.sync([voxel(1), voxel(2)]);
    thumbnails.dispose();
    await settle();
    expect(disposeRenderer).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(thumbnails.get("user:1")).toBeUndefined();
  });
});

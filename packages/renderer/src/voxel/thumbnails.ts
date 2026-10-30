import {
  IDENTITY_QUATERNION,
  type VoxelAssembly,
  type VoxelPart,
} from "@living-diorama/content-schema";
import type * as THREE from "three";
import {
  drawThumbnail,
  thumbnailSize,
  type ThumbnailEncoder,
  type ThumbnailRenderer,
} from "../prop-thumbnails";
import { buildVoxelBody, createVoxelMaterial, skinVoxelBody } from "./body";

// Thumbnails of voxel parts and assemblies (ADR 0022, M20 decisions; ADR 0023 §20), e.g. for the
// Studio's parts tray and My creatures: drawn at run time like prop thumbnails
// (`prop-thumbnails.ts`), in the same three-quarter view and plain daylight, with the material
// creatures are drawn with in the world, so a part's colours, occlusion and glow read as they do
// on a creature. Drawn a few a frame, so a tray of them doesn't stall one.

/** The key of a lone part's one instance and its part, in the assembly it is drawn as. */
const LONE = "part";

/** A part alone, as an assembly of one instance: at rest, unmirrored, its own root. */
function loneAssembly(part: VoxelPart): VoxelAssembly {
  return {
    parts: { [LONE]: part },
    instances: [{ id: LONE, part: LONE, rotation: IDENTITY_QUATERNION, mirrored: false }],
  };
}

/** A registered part by ID and version, as the protocol's `PartSummary` holds it. */
export interface PartThumbnailSource {
  id: string;
  version: string;
  part: VoxelPart;
}

/** A saved assembly by ID and version, e.g. a species' in the library. */
export interface AssemblyThumbnailSource {
  id: string;
  version: string;
  assembly: VoxelAssembly;
}

/** Runs `draw` soon, e.g. at the next animation frame. */
export type ThumbnailScheduler = (draw: () => void) => void;

export interface VoxelThumbnailOptions {
  /** When queued thumbnails are drawn; by default at the next animation frame. */
  schedule?: ThumbnailScheduler;
  /** A clock in milliseconds, for the time budget; by default `performance.now`. */
  now?: () => number;
}

/**
 * Thumbnails are drawn until this many milliseconds of a turn have gone, then the rest wait for
 * the next one; at least one is drawn each turn.
 */
export const THUMBNAIL_BUDGET_MS = 6;

/** The cache key of a thumbnail: its kind, `id@version` and size in pixels. */
export const thumbnailKey = (
  kind: "part" | "assembly",
  source: { id: string; version: string },
  pixels: number,
): string => `${kind}:${source.id}@${source.version}:${pixels}`;

interface Job {
  key: string;
  pixels: number;
  assembly: () => VoxelAssembly;
  resolve: (url: string | undefined) => void;
  reject: (cause: unknown) => void;
}

/**
 * Thumbnails of voxel parts and assemblies by `id@version` and size (ADR 0023 §20), drawn with a
 * renderer when first asked for and kept as image URLs, so each is drawn once per size. A part or
 * assembly is taken to be the same as long as its ID and version are: another object with the same
 * pair is not drawn again, and a changed one needs a new version to be drawn anew. A part is drawn
 * alone at rest; an assembly as a creature stands, in its rest pose. Parts and assemblies must be
 * valid (`VoxelPartSchema`, `VoxelAssemblySchema`).
 *
 * Scheduled: asking queues the drawing and returns a promise; the queue is drawn at the next
 * scheduled turn (an animation frame by default) for up to `THUMBNAIL_BUDGET_MS`, the rest at the
 * turns after. A thumbnail that fails to draw rejects and is forgotten, so it can be asked for
 * again. The cache grows only with the sources and sizes asked for, an image URL each.
 *
 * GPU resources: each thumbnail's body (geometry and skeleton) and render target are freed as
 * soon as it is read back, so only the image URLs are kept. `dispose` forgets the thumbnails and
 * frees the material; thumbnails still queued, and any asked for after it, resolve to undefined.
 */
export class VoxelThumbnails {
  readonly #renderer: ThumbnailRenderer;
  readonly #encode: ThumbnailEncoder;
  readonly #schedule: ThumbnailScheduler;
  readonly #now: () => number;
  readonly #cache = new Map<string, Promise<string | undefined>>();
  #queue: Job[] = [];
  #scheduled = false;
  /** Shared by every thumbnail; `drawIcon` draws with copies of it. */
  #material: THREE.MeshStandardMaterial | undefined;
  #disposed = false;

  constructor(
    renderer: ThumbnailRenderer,
    encode: ThumbnailEncoder,
    options: VoxelThumbnailOptions = {},
  ) {
    this.#renderer = renderer;
    this.#encode = encode;
    this.#schedule = options.schedule ?? ((draw) => void requestAnimationFrame(() => draw()));
    this.#now = options.now ?? (() => performance.now());
  }

  /**
   * An image URL of the part alone, `size` pixels square (rounded, at most `MAX_THUMBNAIL_SIZE`),
   * on a transparent background; undefined once disposed. Rejects with a `RangeError` for a size
   * below a pixel.
   */
  part(source: PartThumbnailSource, size: number): Promise<string | undefined> {
    return this.#thumbnail("part", source, size, () => loneAssembly(source.part));
  }

  /** As `part`, of a whole assembly in its rest pose, e.g. a creature in a library. */
  assembly(source: AssemblyThumbnailSource, size: number): Promise<string | undefined> {
    return this.#thumbnail("assembly", source, size, () => source.assembly);
  }

  #thumbnail(
    kind: "part" | "assembly",
    source: { id: string; version: string },
    size: number,
    assembly: () => VoxelAssembly,
  ): Promise<string | undefined> {
    let pixels: number;
    try {
      pixels = thumbnailSize(size);
    } catch (cause) {
      return Promise.reject(cause as Error);
    }
    if (this.#disposed) return Promise.resolve(undefined);
    const key = thumbnailKey(kind, source, pixels);
    let thumbnail = this.#cache.get(key);
    if (!thumbnail) {
      thumbnail = new Promise((resolve, reject) =>
        this.#queue.push({ key, pixels, assembly, resolve, reject }),
      );
      this.#cache.set(key, thumbnail);
      this.#wake();
    }
    return thumbnail;
  }

  #wake(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    this.#schedule(() => this.#drawQueued());
  }

  /** Draws queued thumbnails until the budget is spent, at least one, and schedules the rest. */
  #drawQueued(): void {
    this.#scheduled = false;
    if (this.#disposed) return;
    const start = this.#now();
    let job: Job | undefined;
    while ((job = this.#queue.shift())) {
      this.#draw(job);
      if (this.#now() - start >= THUMBNAIL_BUDGET_MS) break;
    }
    if (this.#queue.length > 0) this.#wake();
  }

  #draw({ key, pixels, assembly, resolve, reject }: Job): void {
    try {
      const body = buildVoxelBody(assembly());
      const mesh = skinVoxelBody(body, (this.#material ??= createVoxelMaterial()));
      try {
        resolve(drawThumbnail(this.#renderer, mesh, pixels, this.#encode));
      } finally {
        mesh.skeleton.dispose();
        body.dispose();
      }
    } catch (cause) {
      this.#cache.delete(key);
      reject(cause);
    }
  }

  dispose(): void {
    this.#disposed = true;
    for (const job of this.#queue) job.resolve(undefined);
    this.#queue = [];
    this.#cache.clear();
    this.#material?.dispose();
    this.#material = undefined;
  }
}

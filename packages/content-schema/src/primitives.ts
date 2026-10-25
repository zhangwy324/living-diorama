import { z } from "zod";

// See docs/world-coordinates.md for units, axes and conventions.

const CONTENT_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*:[a-z0-9]+(?:[._/-][a-z0-9]+)*$/;
const LOCAL_ID = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;
// semver.org's recommended pattern.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** Namespaced ID of registered content, e.g. `core:wander`. */
export const ContentIdSchema = z
  .string()
  .regex(CONTENT_ID, { error: 'Expected a namespaced content ID like "core:bridge"' });
export type ContentId = z.output<typeof ContentIdSchema>;

/** ID that is unique within one world, e.g. `north-bank`. */
export const LocalIdSchema = z
  .string()
  .regex(LOCAL_ID, { error: 'Expected a local ID like "north-bank" (lowercase, digits, - or _)' });
export type LocalId = z.output<typeof LocalIdSchema>;

/** Reference to a pack asset, e.g. `core:models/pine.glb`. */
export const AssetRefSchema = z
  .string()
  .regex(CONTENT_ID, { error: 'Expected an asset reference like "core:models/pine.glb"' });
export type AssetRef = z.output<typeof AssetRefSchema>;

export const SemverSchema = z
  .string()
  .regex(SEMVER, { error: 'Expected a semantic version like "1.0.0"' });

export function isContentId(value: string): boolean {
  return CONTENT_ID.test(value);
}

/** Splits `namespace:name`; returns undefined for malformed IDs. */
export function parseContentId(value: string): { namespace: string; name: string } | undefined {
  if (!isContentId(value)) return undefined;
  const colon = value.indexOf(":");
  return { namespace: value.slice(0, colon), name: value.slice(colon + 1) };
}

const finite = z.number();

/** Horizontal world position in metres. */
export const Vec2Schema = z.strictObject({ x: finite, z: finite });
export type Vec2 = z.output<typeof Vec2Schema>;

export const Vec3Schema = z.strictObject({ x: finite, y: finite, z: finite });
export type Vec3 = z.output<typeof Vec3Schema>;

/** Simple polygon in the XZ plane, either winding. */
export const PolygonSchema = z
  .array(Vec2Schema)
  .min(3, { error: "A polygon needs at least 3 points" });

/** Yaw-only transform: `rotationY` uses the heading convention, `scale` is uniform. */
export const TransformSchema = z.strictObject({
  position: Vec3Schema,
  rotationY: finite.default(0),
  scale: z.number().positive().default(1),
});
export type Transform = z.output<typeof TransformSchema>;

/** A position on a region's surface; world Y is resolved from that surface, never stored. */
export const RegionPositionSchema = z.strictObject({
  regionId: LocalIdSchema,
  x: finite,
  z: finite,
});
export type RegionPosition = z.output<typeof RegionPositionSchema>;

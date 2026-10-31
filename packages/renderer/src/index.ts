export const packageName = "@living-diorama/renderer";

export * from "./diorama-view";
export { MIN_CAMERA_CLEARANCE, limitCamera, terrainHeightAt } from "./camera";
export { DEBUG_CELL_SIZE } from "./creature-labels";
export { type AssemblyReader, type RenderSpecies, type SpeciesResolver } from "./creatures";
export type { PartMotionResolver, PartRoleResolver } from "./voxel/body";
export { SnapshotInterpolator, lerpHeading, type CreaturePose } from "./interpolation";
export { LAYER_NAMES, type ClipPlane, type LayerName } from "./layers";
export type { AssetResolver, ModelLoader, RenderAsset } from "./props";
export type { PropPick, PropPreview } from "./prop-editing";
export {
  MAX_THUMBNAIL_SIZE,
  canvasEncoder,
  type ThumbnailEncoder,
  type ThumbnailRenderer,
} from "./prop-thumbnails";
export {
  VoxelThumbnails,
  type AssemblyThumbnailSource,
  type PartThumbnailSource,
  type VoxelThumbnailOptions,
} from "./voxel/thumbnails";
export {
  createStandaloneVoxelThumbnails,
  type StandaloneVoxelThumbnails,
} from "./voxel/standalone-thumbnails";
export {
  createAssemblyView,
  type AssemblyGhost,
  type AssemblyPick,
  type AssemblyView,
  type AssemblyViewOptions,
  type PreviewMotion,
} from "./voxel/assembly-view";

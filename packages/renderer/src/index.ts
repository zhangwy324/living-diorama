export const packageName = "@living-diorama/renderer";

export * from "./diorama-view";
export { MIN_CAMERA_CLEARANCE, limitCamera, terrainHeightAt } from "./camera";
export { DEBUG_CELL_SIZE } from "./creature-labels";
export { checkBody, type BodyCheck } from "./body/check";
export type { ImageReader, Pixels } from "./body/pixels";
export {
  createBodyPreview,
  type BodyHighlights,
  type BodyPreview,
  type PreviewMotion,
} from "./body/preview";
export { type RenderSpecies, type SpeciesResolver } from "./creatures";
export { SnapshotInterpolator, lerpHeading, type CreaturePose } from "./interpolation";
export { LAYER_NAMES, type ClipPlane, type LayerName } from "./layers";
export type { AssetResolver, ModelLoader, RenderAsset } from "./props";

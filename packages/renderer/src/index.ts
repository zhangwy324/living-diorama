export const packageName = "@living-diorama/renderer";

export * from "./diorama-view";
export { MIN_CAMERA_CLEARANCE, limitCamera, terrainHeightAt } from "./camera";
export type { ImageReader, Pixels } from "./body/pixels";
export { type RenderSpecies, type SpeciesResolver } from "./creatures";
export { SnapshotInterpolator, lerpHeading, type CreaturePose } from "./interpolation";
export { LAYER_NAMES, type ClipPlane, type LayerName } from "./layers";
export type { AssetResolver, ModelLoader, RenderAsset } from "./props";

import * as THREE from "three";
import { canvasEncoder } from "../prop-thumbnails";
import { VoxelThumbnails } from "./thumbnails";

// Voxel thumbnails for a page with no view whose renderer they could share, e.g. the Studio's
// My creatures (ADR 0023 §19).

/** `VoxelThumbnails` drawn with a WebGL renderer of their own. */
export interface StandaloneVoxelThumbnails {
  readonly thumbnails: VoxelThumbnails;
  /** Disposes of the thumbnails and frees the renderer's WebGL context. */
  dispose(): void;
}

/**
 * Makes `VoxelThumbnails` with a renderer of their own, on a canvas that is never shown: they draw
 * into render targets of their own size. Prefer a view's `thumbnails` when one is running, as each
 * of these holds a WebGL context until disposed.
 */
export function createStandaloneVoxelThumbnails(document: Document): StandaloneVoxelThumbnails {
  const renderer = new THREE.WebGLRenderer({
    canvas: document.createElement("canvas"),
    antialias: false,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const thumbnails = new VoxelThumbnails(renderer, canvasEncoder(document));
  let disposed = false;
  return {
    thumbnails,
    dispose() {
      if (disposed) return;
      disposed = true;
      thumbnails.dispose();
      renderer.dispose();
      // Frees the context now rather than whenever the canvas is collected.
      renderer.forceContextLoss();
    },
  };
}

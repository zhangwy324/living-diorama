import {
  VOXEL_UNIT,
  boneTransform,
  decodeVoxels,
  instanceInset,
  measureAssembly,
  placeInstances,
  stepUnits,
  type AssemblyMeasure,
  type InstancePlacement,
  type PartRole,
  type VoxelAssembly,
  type VoxelPart,
} from "@living-diorama/content-schema";
import * as THREE from "three";
import { meshVoxelParts, type VoxelMesh, type VoxelPartGrid } from "./mesher";

// An assembled voxel creature (ADR 0022 §18, §20, §21): one geometry per species holding every
// part's cubes in its own cube units, and one bone per part instance whose rest transform puts
// the part in the body frame. A creature is a skinned mesh of that geometry with a skeleton of
// its own, every vertex weighted 1 to its part's bone, so the whole body is one draw call and
// each part moves rigidly (M22 animates the bones).

/** Gives a part type's role, e.g. `tail`, or undefined for none or an unknown type. */
export type PartRoleResolver = (partType: string) => PartRole | undefined;

/** How much of its colour a voxel body glows with (ADR 0022 §6); drawn bodies glow 0.35. */
export const VOXEL_EMISSIVE_INTENSITY = 0.15;
const ROUGHNESS = 0.9;

/** A species' voxel body: its geometry and its bones' rest transforms, shared by its creatures. */
export interface VoxelBody {
  geometry: THREE.BufferGeometry;
  /**
   * Per part instance, in the assembly's order: its bone's rest transform, from a vertex of its
   * part (cube units from the part's corner, as the mesher writes them) to the body frame (metres,
   * feet at y = 0, middle of the X and Z bounds at the origin, facing +X).
   */
  bones: readonly THREE.Matrix4[];
  /** The body measured in its rest pose, in the same frame. */
  measure: AssemblyMeasure;
  vertexCount: number;
  dispose(): void;
}

/**
 * The bone rest transform of a part placed by `placeInstances`: its mesh's cube units to the body
 * frame's metres. `boneTransform` gives the rotation and offset in `VOXEL_UNIT`s (with the
 * mesher's reflection of a mirrored part), the part's step scales its cubes to units, and the
 * body frame's `origin` and `VOXEL_UNIT` take units to metres. First the part shrinks toward its
 * own centre by `inset` metres on every side (ADR 0022 §14 as amended in M19), so its faces move
 * in by exactly that much along each axis.
 */
export function boneMatrix(
  part: VoxelPart,
  placement: InstancePlacement,
  origin: readonly number[],
  inset: number = instanceInset(placement.depth),
  out: THREE.Matrix4 = new THREE.Matrix4(),
): THREE.Matrix4 {
  const { rotation: r, offset } = boneTransform(placement, part);
  const units = stepUnits(part.step);
  const at = (i: number) => r[i] ?? 0;
  const from = (i: number) => origin[i] ?? 0;
  // Units to metres, after the part's rotation, step and offset.
  out.set(
    at(0) * units,
    at(1) * units,
    at(2) * units,
    offset[0] - from(0),
    at(3) * units,
    at(4) * units,
    at(5) * units,
    offset[1] - from(1),
    at(6) * units,
    at(7) * units,
    at(8) * units,
    offset[2] - from(2),
    0,
    0,
    0,
    1,
  );
  out.premultiply(scaleToMetres);
  if (inset === 0) return out;
  // The shrink, in the part's cube units about its centre. Mirroring keeps the centre in place.
  const { x, y, z } = part.size;
  const k = (cubes: number) => 1 - (2 * inset) / (cubes * part.step);
  const [kx, ky, kz] = [k(x), k(y), k(z)];
  shrink
    .makeScale(kx, ky, kz)
    .setPosition((x / 2) * (1 - kx), (y / 2) * (1 - ky), (z / 2) * (1 - kz));
  return out.multiply(shrink);
}

const scaleToMetres = new THREE.Matrix4().makeScale(VOXEL_UNIT, VOXEL_UNIT, VOXEL_UNIT);
const shrink = new THREE.Matrix4();

/** The part of an instance, in an assembly `VoxelAssemblySchema` accepted. */
function partOf(assembly: VoxelAssembly, key: string): VoxelPart {
  const part = assembly.parts[key];
  if (!part) throw new Error(`Unknown part "${key}"`);
  return part;
}

/**
 * Meshes and measures a valid assembly (one `VoxelAssemblySchema` accepts) into the body its
 * creatures share. `roleOf` gives part types' roles, for the tail anchor. Pure apart from the
 * three.js objects it returns: it neither reads nor draws anything.
 */
export function buildVoxelBody(
  assembly: VoxelAssembly,
  roleOf: PartRoleResolver = () => undefined,
): VoxelBody {
  const measure = measureAssembly(assembly, roleOf);
  const placements = placeInstances(assembly);
  const grids = new Map<string, Uint8Array>();
  const parts: VoxelPartGrid[] = [];
  const bones: THREE.Matrix4[] = [];
  assembly.instances.forEach((instance, i) => {
    const part = partOf(assembly, instance.part);
    const placement = placements[i];
    if (!placement) throw new Error(`Instance "${instance.id}" was not placed`);
    let voxels = grids.get(instance.part);
    if (!voxels) grids.set(instance.part, (voxels = decodeVoxels(part.voxels, part.size)));
    // Reflected after its parents' mirroring, not by its own flag alone (ADR 0022 As built).
    parts.push({
      size: [part.size.x, part.size.y, part.size.z],
      voxels,
      colors: part.colors,
      mirrored: placement.mirrored,
    });
    bones.push(boneMatrix(part, placement, measure.origin));
  });
  const mesh = meshVoxelParts(parts);
  const geometry = voxelGeometry(mesh);
  return {
    geometry,
    bones,
    measure,
    vertexCount: mesh.vertexCount,
    dispose: () => geometry.dispose(),
  };
}

/**
 * The mesher's arrays as a skinnable geometry, kept in their small types: `Uint8` positions in
 * cube units, normalized `Int8` normals, `Uint8` sRGB colour (decoded in the shader), `Uint8`
 * ambient occlusion and the part index as the skin index. The skin index has one component, so
 * the shader reads it as (part, 0, 0, 1); the weights (1, 0, 0, 0) give the part's bone alone.
 */
export function voxelGeometry(mesh: VoxelMesh): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3, true));
  geometry.setAttribute("color", new THREE.BufferAttribute(mesh.colors, 3, true));
  geometry.setAttribute("ao", new THREE.BufferAttribute(mesh.ao, 1, true));
  geometry.setAttribute("skinIndex", new THREE.BufferAttribute(mesh.parts, 1));
  const weights = new Uint8Array(mesh.vertexCount * 4);
  for (let i = 0; i < weights.length; i += 4) weights[i] = 255;
  geometry.setAttribute("skinWeight", new THREE.BufferAttribute(weights, 4, true));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  return geometry;
}

/** sRGB to linear, per channel, in GLSL: the vertex colours are stored as sRGB bytes. */
const SRGB_TO_LINEAR = `
vec3 voxelSrgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}`;

/**
 * The material every voxel body shares: lit like the world, its colour from the vertex colours
 * decoded to linear, darkened by the ambient occlusion, and glowing at
 * `VOXEL_EMISSIVE_INTENSITY` of that colour (ADR 0022 §6, §7). The glow is taken after the
 * occlusion, so corners stay darker at night too, when the glow is most of the light. Bodies cast
 * shadows from their faces towards the sun but receive none (ADR 0011 §10).
 */
export function createVoxelMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    emissive: "#ffffff",
    emissiveIntensity: VOXEL_EMISSIVE_INTENSITY,
    roughness: ROUGHNESS,
    shadowSide: THREE.FrontSide,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = patch(shader.vertexShader, {
      "#include <common>": `#include <common>\nattribute float ao;\nvarying float vVoxelAo;${SRGB_TO_LINEAR}`,
      "#include <color_vertex>": `#include <color_vertex>\nvColor.rgb = voxelSrgbToLinear(vColor.rgb);\nvVoxelAo = ao;`,
    });
    shader.fragmentShader = patch(shader.fragmentShader, {
      "#include <common>": "#include <common>\nvarying float vVoxelAo;",
      "#include <color_fragment>": "#include <color_fragment>\ndiffuseColor.rgb *= vVoxelAo;",
      "#include <emissivemap_fragment>":
        "#include <emissivemap_fragment>\ntotalEmissiveRadiance *= diffuseColor.rgb;",
    });
  };
  // Every voxel body shares one compiled program.
  material.customProgramCacheKey = () => "living-diorama-voxel";
  return material;
}

/** Replaces each chunk include once, failing loudly if three.js no longer has it. */
function patch(source: string, replacements: Record<string, string>): string {
  let out = source;
  for (const [include, replacement] of Object.entries(replacements)) {
    if (!out.includes(include)) throw new Error(`Voxel material: no ${include} in the shader`);
    out = out.replace(include, replacement);
  }
  return out;
}

/**
 * A creature of a voxel body: a skinned mesh of the shared geometry with a skeleton of its own,
 * its bones at their rest transforms. The bones are outside the scene graph (detached bind mode,
 * identity bind matrix), so a bone's world matrix is its transform in the body frame and nothing
 * updates it but its owner. Frustum culling is off since the parts move away from the rest bounds
 * (ADR 0022 §18). `skeleton.dispose()` frees its bone texture.
 */
export function skinVoxelBody(body: VoxelBody, material: THREE.Material): THREE.SkinnedMesh {
  const bones = body.bones.map((rest) => {
    const bone = new THREE.Bone();
    bone.matrixAutoUpdate = false;
    bone.matrix.copy(rest);
    bone.matrixWorld.copy(rest);
    return bone;
  });
  const skeleton = new THREE.Skeleton(
    bones,
    bones.map(() => new THREE.Matrix4()),
  );
  const mesh = new THREE.SkinnedMesh(body.geometry, material);
  mesh.bindMode = THREE.DetachedBindMode;
  mesh.bind(skeleton, new THREE.Matrix4());
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  return mesh;
}

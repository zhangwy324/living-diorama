import {
  CHILD_PART_INSET,
  VOXEL_UNIT,
  VoxelAssemblySchema,
  decodeVoxels,
  placeInstances,
  stepUnits,
  validate,
  visibleFaces,
  type VoxelAssembly,
  type VoxelAssemblyInput,
} from "@living-diorama/content-schema";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { boneMatrix, buildVoxelBody, createVoxelMaterial, skinVoxelBody } from "./body";
import { meshVoxelParts } from "./mesher";
import { creature } from "../body/fixtures/voxel-creature";

function parsed(input: VoxelAssemblyInput = creature()): VoxelAssembly {
  const result = validate(VoxelAssemblySchema, input);
  if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
  return result.value;
}

/** A point in whole `VOXEL_UNIT`s, as a key. */
const key = (p: readonly number[]) => p.map((v) => Math.round(v)).join(",");

describe("bone transforms", () => {
  it("put every mesh face of a mirrored grid exactly on a cube placeInstances places", () => {
    const assembly = parsed();
    const placements = placeInstances(assembly);
    // The fixture reaches the cases a turn about Z alone would hide: a mirrored part turned about
    // another axis, and a mirrored part below a turned parent.
    const MIRROR = [1, 0, 0, 0, 1, 0, 0, 0, -1];
    const product = (a: readonly number[], b: readonly number[]) =>
      [0, 1, 2].flatMap((r) =>
        [0, 1, 2].map((c) => [0, 1, 2].reduce((sum, k) => sum + a[r * 3 + k]! * b[k * 3 + c]!, 0)),
      );
    const commutes = (m: readonly number[]) =>
      product(m, MIRROR).every((v, i) => v === product(MIRROR, m)[i]);
    expect(placements.some((p) => p.mirrored && !commutes(p.linear))).toBe(true);
    const finB = assembly.instances.findIndex((i) => i.id === "fin-b");
    expect(commutes(placements[assembly.instances.findIndex((i) => i.id === "tail")]!.linear)).toBe(
      false,
    );
    expect(placements[finB]!.mirrored).toBe(true);
    const origin = [0, 0, 0];
    const instances = assembly.instances.map((instance, i) => {
      const part = assembly.parts[instance.part]!;
      const placement = placements[i]!;
      const voxels = decodeVoxels(part.voxels, part.size);
      // The cubes as placeInstances places them, in units: the unmirrored grid through `linear`.
      const cubes = new Set<string>();
      const units = stepUnits(part.step);
      const { linear, offset } = placement;
      const at = (p: readonly number[]) =>
        [0, 1, 2].map(
          (r) =>
            linear[r * 3]! * p[0]! +
            linear[r * 3 + 1]! * p[1]! +
            linear[r * 3 + 2]! * p[2]! +
            offset[r]!,
        );
      for (let z = 0, i = 0; z < part.size.z; z++) {
        for (let y = 0; y < part.size.y; y++) {
          for (let x = 0; x < part.size.x; x++, i++) {
            if (voxels[i])
              cubes.add(key(at([(x + 0.5) * units, (y + 0.5) * units, (z + 0.5) * units])));
          }
        }
      }
      return {
        cubes,
        units,
        grid: {
          size: [part.size.x, part.size.y, part.size.z] as const,
          voxels,
          colors: part.colors,
          mirrored: placement.mirrored,
        },
        // No inset, so the check is exact.
        bone: boneMatrix(part, placement, origin, 0),
        faces: visibleFaces(voxels, part.size),
      };
    });
    const mesh = meshVoxelParts(instances.map((i) => i.grid));
    expect(mesh.vertexCount).toBe(instances.reduce((sum, i) => sum + i.faces * 4, 0));

    const corner = (v: number) => {
      const bone = instances[mesh.parts[v]!]!.bone;
      const p = new THREE.Vector3(
        mesh.positions[v * 3]!,
        mesh.positions[v * 3 + 1]!,
        mesh.positions[v * 3 + 2]!,
      ).applyMatrix4(bone);
      return p.divideScalar(VOXEL_UNIT); // back to units, the origin at the root's attach point
    };
    for (let v = 0; v < mesh.vertexCount; v += 4) {
      const { cubes, units, bone } = instances[mesh.parts[v]!]!;
      const corners = [0, 1, 2, 3].map((k) => corner(v + k));
      // Every corner lands on the whole-unit grid: no rounding hides an off-by-half.
      for (const c of corners) {
        for (const value of c.toArray())
          expect(Math.abs(value - Math.round(value))).toBeLessThan(1e-6);
      }
      const centre = corners.reduce((sum, c) => sum.add(c), new THREE.Vector3()).divideScalar(4);
      const normal = new THREE.Vector3(
        mesh.normals[v * 3]!,
        mesh.normals[v * 3 + 1]!,
        mesh.normals[v * 3 + 2]!,
      )
        .transformDirection(bone)
        .round();
      // The cube behind the face is one of the part's; the one in front isn't.
      const inside = centre
        .clone()
        .addScaledVector(normal, -units / 2)
        .toArray();
      const outside = centre
        .clone()
        .addScaledVector(normal, units / 2)
        .toArray();
      expect(cubes.has(key(inside)), `face ${v / 4} behind`).toBe(true);
      expect(cubes.has(key(outside)), `face ${v / 4} in front`).toBe(false);
    }

    // And its triangles still face out after the bone: counter-clockwise seen from outside.
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => corner(mesh.indices[t + k]!));
      const v = mesh.indices[t]!;
      const normal = new THREE.Vector3(
        mesh.normals[v * 3]!,
        mesh.normals[v * 3 + 1]!,
        mesh.normals[v * 3 + 2]!,
      ).transformDirection(instances[mesh.parts[v]!]!.bone);
      const facing = b!.clone().sub(a!).cross(c!.clone().sub(a!)).dot(normal);
      expect(facing).toBeGreaterThan(0);
    }
  });

  it("shrink a part toward its own centre by its depth's inset on every side", () => {
    const assembly = parsed();
    const placements = placeInstances(assembly);
    const hand = assembly.instances.findIndex((i) => i.id === "right-hand");
    const part = assembly.parts.hand!;
    const placement = placements[hand]!;
    expect(placement.depth).toBe(2);
    const exact = boneMatrix(part, placement, [0, 0, 0], 0);
    const shrunk = boneMatrix(part, placement, [0, 0, 0]);
    const inset = 2 * CHILD_PART_INSET;
    const at = (m: THREE.Matrix4, x: number, y: number, z: number) =>
      new THREE.Vector3(x, y, z).applyMatrix4(m);
    const centre = at(exact, 1, 0.5, 1.5);
    expect(at(shrunk, 1, 0.5, 1.5).distanceTo(centre)).toBeLessThan(1e-12);
    // Each corner moves in by the inset along each axis.
    const corner = at(exact, 0, 0, 0);
    const moved = at(shrunk, 0, 0, 0);
    for (const axis of ["x", "y", "z"] as const) {
      expect(Math.abs(moved[axis] - corner[axis])).toBeCloseTo(inset, 12);
      expect(Math.abs(moved[axis] - centre[axis])).toBeLessThan(
        Math.abs(corner[axis] - centre[axis]),
      );
    }
    // The root isn't shrunk.
    const root = boneMatrix(assembly.parts.torso!, placements[0]!, [0, 0, 0]);
    expect(root.equals(boneMatrix(assembly.parts.torso!, placements[0]!, [0, 0, 0], 0))).toBe(true);
  });
});

describe("buildVoxelBody", () => {
  it("puts the body on its lowest cube, centred across X and Z, facing +X, as measured", () => {
    const body = buildVoxelBody(parsed());
    const { geometry, bones, measure } = body;
    expect(bones).toHaveLength(8);
    const position = geometry.getAttribute("position");
    const parts = geometry.getAttribute("skinIndex");
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    const p = new THREE.Vector3();
    for (let v = 0; v < position.count; v++) {
      p.fromBufferAttribute(position, v).applyMatrix4(bones[parts.getX(v)]!);
      min.min(p);
      max.max(p);
    }
    // Up to the insets of child parts, which measuring ignores.
    const slack = 3 * CHILD_PART_INSET;
    for (const axis of ["x", "y", "z"] as const) {
      expect(Math.abs(min[axis] - measure.bounds.min[axis])).toBeLessThanOrEqual(slack);
      expect(Math.abs(max[axis] - measure.bounds.max[axis])).toBeLessThanOrEqual(slack);
    }
    expect(measure.bounds.min.y).toBe(0);
    expect(measure.bounds.min.x + measure.bounds.max.x).toBeCloseTo(0, 12);
    expect(measure.bounds.min.z + measure.bounds.max.z).toBeCloseTo(0, 12);
    body.dispose();
  });

  it("keeps the mesher's small attribute types", () => {
    const { geometry } = buildVoxelBody(parsed());
    expect(geometry.getAttribute("position").array).toBeInstanceOf(Uint8Array);
    expect(geometry.getAttribute("normal").array).toBeInstanceOf(Int8Array);
    expect(geometry.getAttribute("color").array).toBeInstanceOf(Uint8Array);
    expect(geometry.getAttribute("ao").array).toBeInstanceOf(Uint8Array);
    expect(geometry.getAttribute("skinIndex").itemSize).toBe(1);
    const weights = geometry.getAttribute("skinWeight");
    expect([weights.getX(0), weights.getY(0), weights.getZ(0), weights.getW(0)]).toEqual([
      1, 0, 0, 0,
    ]);
  });

  it("anchors the tail at a tail-role part's attach point when roles are given", () => {
    const assembly = parsed();
    const without = buildVoxelBody(assembly).measure.tail;
    const withRole = buildVoxelBody(assembly, (type) => (type === "test:tail" ? "tail" : undefined))
      .measure.tail;
    expect(without.x).toBeCloseTo(buildVoxelBody(assembly).measure.bounds.min.x);
    expect(withRole.x).toBeGreaterThan(without.x);
  });
});

describe("rest joints", () => {
  it("are rigid, sit at each part's attach point, and compose with the shapes into the bones", () => {
    const assembly = parsed();
    const body = buildVoxelBody(assembly);
    const placements = placeInstances(assembly);
    const { origin } = body.measure;
    expect(body.parents).toEqual([-1, 0, 0, 1, 2, 0, 5, 5]);
    assembly.instances.forEach((instance, i) => {
      const joint = body.joints[i]!;
      const part = assembly.parts[instance.part]!;
      const { linear, offset } = placements[i]!;
      // A proper rotation, no scale: M22 composes them down the tree without carrying a shrink.
      const rotation = new THREE.Matrix3().setFromMatrix4(joint);
      expect(rotation.determinant()).toBeCloseTo(1, 12);
      const e = rotation.elements;
      for (let c = 0; c < 3; c++) {
        const length = Math.hypot(e[c * 3]!, e[c * 3 + 1]!, e[c * 3 + 2]!);
        expect(length).toBeCloseTo(1, 12);
      }
      // Its origin is the attach point where placeInstances puts it, in the body frame.
      const units = stepUnits(part.step);
      const a = [part.attach.x * units, part.attach.y * units, part.attach.z * units];
      const expected = [0, 1, 2].map(
        (r) =>
          (linear[r * 3]! * a[0]! +
            linear[r * 3 + 1]! * a[1]! +
            linear[r * 3 + 2]! * a[2]! +
            offset[r]! -
            origin[r]!) *
          VOXEL_UNIT,
      );
      const at = new THREE.Vector3().setFromMatrixPosition(joint).toArray();
      at.forEach((v, k) => expect(v, `${instance.id} ${k}`).toBeCloseTo(expected[k]!, 12));
      const composed = joint.clone().multiply(body.shapes[i]!);
      composed.elements.forEach((v, k) => expect(v).toBeCloseTo(body.bones[i]!.elements[k]!, 12));
    });
  });
});

describe("skinVoxelBody", () => {
  it("gives each creature its own skeleton over the species' geometry, culling off", () => {
    const body = buildVoxelBody(parsed());
    const material = createVoxelMaterial();
    const a = skinVoxelBody(body, material);
    const b = skinVoxelBody(body, material);
    expect(a.geometry).toBe(b.geometry);
    expect(a.skeleton).not.toBe(b.skeleton);
    expect(a.skeleton.bones).toHaveLength(8);
    expect(a.frustumCulled).toBe(false);
    expect(a.castShadow).toBe(true);
    expect(a.receiveShadow).toBe(false);
    // The bone matrices are the rest transforms: the bind and inverse matrices are identities.
    a.skeleton.update();
    // As 32-bit floats, as the bone texture holds them.
    const first = Array.from(a.skeleton.boneMatrices!.subarray(0, 16));
    expect(first).toEqual(Array.from(new Float32Array(body.bones[0]!.elements)));
    expect(a.bindMatrix.equals(new THREE.Matrix4())).toBe(true);
  });
});

describe("createVoxelMaterial", () => {
  it("patches the standard shader's chunks it relies on", () => {
    const material = createVoxelMaterial();
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    };
    material.onBeforeCompile(shader as never, undefined as never);
    expect(shader.vertexShader).toContain("voxelSrgbToLinear(vColor.rgb)");
    expect(shader.vertexShader).toContain("vVoxelAo = ao");
    expect(shader.fragmentShader).toContain("diffuseColor.rgb *= vVoxelAo");
    expect(shader.fragmentShader).toContain("totalEmissiveRadiance *= diffuseColor.rgb");
    expect(material.emissiveIntensity).toBe(0.15);
    expect(material.vertexColors).toBe(true);
    expect(material.shadowSide).toBe(THREE.FrontSide);
  });
});

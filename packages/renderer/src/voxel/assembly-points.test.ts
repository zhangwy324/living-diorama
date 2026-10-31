import {
  VoxelAssemblySchema,
  VoxelPartSchema,
  type VoxelAssembly,
} from "@living-diorama/content-schema";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { ghostPlacement, partGeometry, socketKey, socketPoints } from "./assembly-points";
import { pickAssembly } from "./assembly-view";
import { buildVoxelBody, createVoxelMaterial, skinVoxelBody } from "./body";
import { creature } from "./fixtures/voxel-creature";

const parsed = (): VoxelAssembly => VoxelAssemblySchema.parse(creature());

/** The translation of a matrix: a joint's origin. */
const origin = (m: THREE.Matrix4) => new THREE.Vector3().setFromMatrixPosition(m);

describe("socket points", () => {
  it("puts every socket where a part hung from it has its attach point", () => {
    const assembly = parsed();
    const body = buildVoxelBody(assembly);
    const points = new Map(socketPoints(assembly, body).map((p) => [socketKey(p), p]));
    // Torso 3, arms 1 each, tail 2.
    expect(points.size).toBe(7);
    assembly.instances.forEach((instance, i) => {
      if (!instance.parent) return;
      const point = points.get(socketKey(instance.parent));
      expect(point, instance.id).toBeDefined();
      const joint = origin(body.joints[i]!);
      expect(point!.position.distanceTo(joint), instance.id).toBeLessThan(1e-9);
    });
  });

  it("reflects the mirrored socket of a pair and says it mirrors", () => {
    const assembly = parsed();
    const body = buildVoxelBody(assembly);
    const points = socketPoints(assembly, body);
    const left = points.find((p) => p.instance === "torso" && p.socket === "left")!;
    const right = points.find((p) => p.instance === "torso" && p.socket === "right")!;
    expect([left.mirrors, right.mirrors]).toEqual([false, true]);
    expect(right.type).toBe("test:shoulder");
    expect(right.position.x).toBeCloseTo(left.position.x, 9);
    expect(right.position.y).toBeCloseTo(left.position.y, 9);
    expect(right.position.z).toBeCloseTo(-left.position.z, 9);
    expect(left.position.z).not.toBeCloseTo(0, 3);
    // The hands' sockets on the arms, the right one reflected through its arm.
    const hands = points.filter((p) => p.socket === "hand").map((p) => p.position);
    expect(hands[1]!.z).toBeCloseTo(-hands[0]!.z, 9);
  });
});

describe("ghost placement", () => {
  it("places a part where the same part attached there is drawn, mirrored on a mirrored socket", () => {
    const assembly = parsed();
    const body = buildVoxelBody(assembly);
    assembly.instances.forEach((instance, i) => {
      if (!instance.parent) return;
      const ghost = ghostPlacement(
        assembly,
        body,
        assembly.parts[instance.part]!,
        instance.parent,
        instance.rotation,
      );
      expect(ghost, instance.id).toBeDefined();
      const expected = body.bones[i]!.elements;
      ghost!.matrix.elements.forEach((value, k) =>
        expect(value, `${instance.id}[${k}]`).toBeCloseTo(expected[k]!, 9),
      );
    });
    const right = ghostPlacement(assembly, body, assembly.parts.arm!, {
      instance: "torso",
      socket: "right",
    });
    expect(right?.placement.mirrored).toBe(true);
  });

  it("is undefined for a socket the assembly doesn't have", () => {
    const assembly = parsed();
    const body = buildVoxelBody(assembly);
    const arm = assembly.parts.arm!;
    expect(ghostPlacement(assembly, body, arm, { instance: "torso", socket: "nope" })).toBe(
      undefined,
    );
    expect(ghostPlacement(assembly, body, arm, { instance: "nobody", socket: "left" })).toBe(
      undefined,
    );
  });

  it("meshes a lone part, reflected or not", () => {
    const arm = VoxelPartSchema.parse(creature().parts.arm);
    const plain = partGeometry(arm, false);
    const mirrored = partGeometry(arm, true);
    const count = plain.getAttribute("position").count;
    expect(count).toBeGreaterThan(0);
    expect(mirrored.getAttribute("position").count).toBe(count);
    plain.computeBoundingBox();
    mirrored.computeBoundingBox();
    expect(mirrored.boundingBox!.equals(plain.boundingBox!)).toBe(true);
  });
});

describe("picking", () => {
  /** The creature's skinned body, ready to raycast, and empty markers. */
  function scene() {
    const assembly = parsed();
    const body = buildVoxelBody(assembly);
    const mesh = skinVoxelBody(body, createVoxelMaterial());
    mesh.skeleton.update();
    const markers = new THREE.Group();
    const root = new THREE.Group();
    root.add(mesh, markers);
    root.updateMatrixWorld(true);
    return { assembly, body, mesh, markers, root };
  }

  /** A ray straight down onto the centre of an instance's cube `(x, y, z)` (cube units). */
  function rayOnto(body: ReturnType<typeof buildVoxelBody>, i: number, cube: THREE.Vector3) {
    const at = cube.clone().addScalar(0.5).applyMatrix4(body.bones[i]!);
    return new THREE.Raycaster(new THREE.Vector3(at.x, 10, at.z), new THREE.Vector3(0, -1, 0));
  }

  it("picks the part whose face the ray hits first", () => {
    const { assembly, body, mesh, markers } = scene();
    // The middle of the torso's top row, from above.
    const torso = rayOnto(body, 0, new THREE.Vector3(3, 3, 3));
    expect(pickAssembly(torso, mesh, assembly, markers)).toEqual({
      kind: "part",
      instance: "torso",
    });
    // Beside the creature: nothing.
    const miss = new THREE.Raycaster(new THREE.Vector3(5, 10, 5), new THREE.Vector3(0, -1, 0));
    expect(pickAssembly(miss, mesh, assembly, markers)).toBeUndefined();
  });

  it("finds a part moved by its bones, not where its geometry holds it", () => {
    const { assembly, body, mesh, markers } = scene();
    const index = assembly.instances.findIndex((instance) => instance.id === "tail");
    // The tail's lowest row is over nothing but the ground.
    const hits = new Set<string | undefined>();
    for (let x = 0; x < 3; x++) {
      for (let z = 0; z < 4; z++) {
        const ray = rayOnto(body, index, new THREE.Vector3(x, 1, z));
        hits.add(pickAssembly(ray, mesh, assembly, markers)?.instance);
      }
    }
    expect(hits.has("tail")).toBe(true);
    expect(hits.has(undefined)).toBe(false);
  });

  it("picks a marked socket before the part behind it", () => {
    const { assembly, body, mesh, markers, root } = scene();
    const point = socketPoints(assembly, body).find((p) => p.socket === "tail")!;
    const marker = new THREE.Mesh(new THREE.SphereGeometry(0.01), new THREE.MeshBasicMaterial());
    marker.position.copy(point.position);
    marker.userData = { instance: "torso", socket: "tail" };
    markers.add(marker);
    root.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(
      new THREE.Vector3(point.position.x, 10, point.position.z),
      new THREE.Vector3(0, -1, 0),
    );
    expect(pickAssembly(ray, mesh, assembly, markers)).toEqual({
      kind: "socket",
      instance: "torso",
      socket: "tail",
    });
  });
});

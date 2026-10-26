import * as THREE from "three";

// One stylized water material for every water mesh: river surfaces and the cross-sections on the
// diorama's sides (ADR 0007 §5). Slowly drifting light bands in world space; no textures and no
// reflections. Content gives no flow direction, so the bands drift the same way everywhere.

const WATER = "#4f8fc9";

export interface WaterMaterial {
  material: THREE.MeshStandardMaterial;
  /** Advances the animation to `seconds` of render time. */
  update(seconds: number): void;
}

export function createWaterMaterial(): WaterMaterial {
  const time = { value: 0 };
  const material = new THREE.MeshStandardMaterial({
    color: WATER,
    transparent: true,
    opacity: 0.8,
    roughness: 0.3,
    side: THREE.DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWaterTime = time;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWaterPosition;")
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvWaterPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vWaterPosition;\nuniform float uWaterTime;",
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        {
          vec2 p = vWaterPosition.xz;
          float a = sin(dot(p, vec2(0.83, 0.55)) * 1.7 + uWaterTime * 0.9);
          float b = sin(dot(p, vec2(-0.42, 0.91)) * 2.3 - uWaterTime * 0.7);
          float glint = smoothstep(0.55, 1.0, a * b);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.94, 1.0), glint * 0.35);
          diffuseColor.rgb *= 0.94 + 0.06 * a;
        }`,
      );
  };
  // Every water mesh shares one compiled program.
  material.customProgramCacheKey = () => "living-diorama-water";
  return {
    material,
    update(seconds) {
      time.value = seconds;
    },
  };
}

import * as THREE from "three";

// The diorama's light, shared with the Creation Studio's preview so a body looks the same in both.

/** Direction the sunlight comes from: high, from the front left. */
export const SUN_DIRECTION = new THREE.Vector3(-30, 45, 28).normalize();

export const createSunLight = () => new THREE.DirectionalLight("#fff3dc", 2.2);

export const createSkyLight = () => new THREE.HemisphereLight("#f4f7ff", "#5b6b3a", 1.1);

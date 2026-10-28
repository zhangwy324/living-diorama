import * as THREE from "three";

// The diorama's light, shared with the Creation Studio's preview so a body looks the same in both.
// The diorama blends it through the day (ADR 0018 §6); the preview always keeps daylight.

/** How the diorama is lit at one time of day. */
export interface Lighting {
  /** Colour of the key light: the sun by day, the moon at night. */
  keyColor: THREE.Color;
  keyIntensity: number;
  /** Unit vector towards the key light. */
  keyDirection: THREE.Vector3;
  /** How dark the key light's shadows are, from 0 (none) to 1 (full). */
  shadowIntensity: number;
  skyColor: THREE.Color;
  groundColor: THREE.Color;
  skyIntensity: number;
  background: THREE.Color;
}

interface Key {
  /** Minutes since local midnight. */
  at: number;
  key: string;
  keyIntensity: number;
  keyDirection: readonly [number, number, number];
  shadowIntensity: number;
  sky: string;
  ground: string;
  skyIntensity: number;
  background: string;
}

const DAY: Omit<Key, "at"> = {
  key: "#fff3dc",
  keyIntensity: 2.2,
  // High, from the front left.
  keyDirection: [-30, 45, 28],
  shadowIntensity: 1,
  sky: "#f4f7ff",
  ground: "#5b6b3a",
  skyIntensity: 1.1,
  background: "#cfe3ea",
};

// Moonlit blue-grey: a dim moon from the front right, opposite the sun, and a sky light kept
// bright enough that creatures stay readable.
const NIGHT: Omit<Key, "at"> = {
  key: "#b4c4ec",
  keyIntensity: 0.9,
  keyDirection: [30, 40, 22],
  shadowIntensity: 0.6,
  sky: "#7d8db4",
  ground: "#363d4a",
  skyIntensity: 1.25,
  background: "#3a4a66",
};

// A low warm sun from the left at dawn and from the right at dusk.
const DAWN: Omit<Key, "at"> = {
  key: "#ffc9a3",
  keyIntensity: 1.6,
  keyDirection: [-40, 14, 26],
  shadowIntensity: 0.85,
  sky: "#e9d6dc",
  ground: "#4f5a3c",
  skyIntensity: 1,
  background: "#e6cdc6",
};

const DUSK: Omit<Key, "at"> = {
  key: "#ffab73",
  keyIntensity: 1.5,
  keyDirection: [40, 14, 26],
  shadowIntensity: 0.85,
  sky: "#d9b9c4",
  ground: "#4a4a3c",
  skyIntensity: 0.95,
  background: "#d9a993",
};

const hours = (h: number) => h * 60;

/** Keyed times of day, in order; the light blends linearly between neighbours. */
const KEYS: readonly Key[] = [
  { at: hours(5), ...NIGHT },
  { at: hours(7), ...DAWN },
  { at: hours(8.5), ...DAY },
  { at: hours(17.5), ...DAY },
  { at: hours(19), ...DUSK },
  { at: hours(20.5), ...NIGHT },
];

const DAY_MINUTES = 1440;

/** The keyed times, for tests and tuning. */
export const LIGHTING_KEYS: readonly number[] = KEYS.map((k) => k.at);

const toLighting = (k: Omit<Key, "at">): Lighting => ({
  keyColor: new THREE.Color(k.key),
  keyIntensity: k.keyIntensity,
  keyDirection: new THREE.Vector3(...k.keyDirection).normalize(),
  shadowIntensity: k.shadowIntensity,
  skyColor: new THREE.Color(k.sky),
  groundColor: new THREE.Color(k.ground),
  skyIntensity: k.skyIntensity,
  background: new THREE.Color(k.background),
});

const lerp = THREE.MathUtils.lerp;

const blend = (a: Lighting, b: Lighting, t: number): Lighting => ({
  keyColor: a.keyColor.clone().lerp(b.keyColor, t),
  keyIntensity: lerp(a.keyIntensity, b.keyIntensity, t),
  keyDirection: a.keyDirection.clone().lerp(b.keyDirection, t).normalize(),
  shadowIntensity: lerp(a.shadowIntensity, b.shadowIntensity, t),
  skyColor: a.skyColor.clone().lerp(b.skyColor, t),
  groundColor: a.groundColor.clone().lerp(b.groundColor, t),
  skyIntensity: lerp(a.skyIntensity, b.skyIntensity, t),
  background: a.background.clone().lerp(b.background, t),
});

/** Daylight: the diorama's look when no time of day is set, and the Studio preview's always. */
export const daylight = (): Lighting => toLighting(DAY);

/**
 * The light at `minutes` since local midnight; any finite value wraps into one day, and a
 * non-finite one gives daylight.
 */
export function lightingAt(minutes: number): Lighting {
  if (!Number.isFinite(minutes)) return daylight();
  const m = ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  // Before the first key or after the last, blend across midnight from the last key to the first.
  let a = KEYS[KEYS.length - 1] as Key;
  let b = KEYS[0] as Key;
  for (const k of KEYS) {
    if (k.at > m) {
      b = k;
      break;
    }
    a = k;
  }
  const span = (b.at - a.at + DAY_MINUTES) % DAY_MINUTES;
  const t = ((m - a.at + DAY_MINUTES) % DAY_MINUTES) / span;
  return blend(toLighting(a), toLighting(b), t);
}

/** Direction the sunlight comes from in daylight. */
export const SUN_DIRECTION = daylight().keyDirection;

export const createSunLight = () => new THREE.DirectionalLight(DAY.key, DAY.keyIntensity);

export const createSkyLight = () =>
  new THREE.HemisphereLight(DAY.sky, DAY.ground, DAY.skyIntensity);

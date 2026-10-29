import type { SceneData } from "@living-diorama/simulation";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { buildDioramaScene } from "./diorama-view";
import {
  createSkyLight,
  createSunLight,
  daylight,
  LIGHTING_KEYS,
  lightingAt,
  SUN_DIRECTION,
  type Lighting,
} from "./lighting";

/** Largest difference between two lightings over every channel. */
const distance = (a: Lighting, b: Lighting) =>
  Math.max(
    ...[
      [a.keyColor, b.keyColor],
      [a.skyColor, b.skyColor],
      [a.groundColor, b.groundColor],
      [a.background, b.background],
    ].flatMap(([x, y]) => [x!.r - y!.r, x!.g - y!.g, x!.b - y!.b].map(Math.abs)),
    Math.abs(a.keyIntensity - b.keyIntensity),
    Math.abs(a.skyIntensity - b.skyIntensity),
    Math.abs(a.shadowIntensity - b.shadowIntensity),
    a.keyDirection.distanceTo(b.keyDirection),
  );

const NOON = 12 * 60;
const MIDNIGHT = 0;

describe("lightingAt", () => {
  it("is today's daylight during the day", () => {
    const noon = lightingAt(NOON);
    expect(distance(noon, daylight())).toBe(0);
    const sun = createSunLight();
    const sky = createSkyLight();
    expect(noon.keyColor.getHex()).toBe(sun.color.getHex());
    expect(noon.keyColor.getHexString()).toBe("fff3dc");
    expect(noon.keyIntensity).toBe(2.2);
    expect(noon.skyColor.getHexString()).toBe("f4f7ff");
    expect(noon.groundColor.getHexString()).toBe("5b6b3a");
    expect(noon.skyIntensity).toBe(sky.intensity);
    expect(noon.background.getHexString()).toBe("cfe3ea");
    expect(noon.keyDirection.distanceTo(new THREE.Vector3(-30, 45, 28).normalize())).toBe(0);
    expect(noon.keyDirection.distanceTo(SUN_DIRECTION)).toBe(0);
  });

  it("reaches every key without a jump", () => {
    for (const at of LIGHTING_KEYS) {
      // Just before a key the light is still blending towards it.
      expect(distance(lightingAt(at), lightingAt(at - 1e-9))).toBeLessThan(1e-6);
    }
  });

  it.each([
    ["dawn", 7 * 60, "ffc9a3", 1.6, [-40, 14, 26], 0.85, "e9d6dc", "4f5a3c", 1, "e6cdc6"],
    ["dusk", 19 * 60, "ffab73", 1.5, [40, 14, 26], 0.85, "d9b9c4", "4a4a3c", 0.95, "d9a993"],
    ["night", 5 * 60, "b4c4ec", 0.9, [30, 40, 22], 0.6, "7d8db4", "363d4a", 1.25, "3a4a66"],
    ["night", 20.5 * 60, "b4c4ec", 0.9, [30, 40, 22], 0.6, "7d8db4", "363d4a", 1.25, "3a4a66"],
  ] as const)(
    "hits the %s key at minute %d exactly",
    (_, at, key, keyIntensity, direction, shadow, sky, ground, skyIntensity, background) => {
      const light = lightingAt(at);
      expect(light.keyColor.getHexString()).toBe(key);
      expect(light.keyIntensity).toBe(keyIntensity);
      expect(light.keyDirection.distanceTo(new THREE.Vector3(...direction).normalize())).toBe(0);
      expect(light.shadowIntensity).toBe(shadow);
      expect(light.skyColor.getHexString()).toBe(sky);
      expect(light.groundColor.getHexString()).toBe(ground);
      expect(light.skyIntensity).toBe(skyIntensity);
      expect(light.background.getHexString()).toBe(background);
    },
  );

  it("gives daylight for a non-finite time", () => {
    for (const m of [NaN, Infinity, -Infinity]) expect(distance(lightingAt(m), daylight())).toBe(0);
  });

  it("changes continuously through the whole day", () => {
    for (let m = 0; m < 1440; m += 0.5) {
      expect(distance(lightingAt(m), lightingAt(m + 0.5))).toBeLessThan(0.02);
    }
  });

  it("wraps at midnight", () => {
    expect(distance(lightingAt(1440), lightingAt(0))).toBe(0);
    expect(distance(lightingAt(-60), lightingAt(23 * 60))).toBeLessThan(1e-12);
    expect(distance(lightingAt(1440 + NOON), lightingAt(NOON))).toBe(0);
    expect(distance(lightingAt(1439.999), lightingAt(0))).toBeLessThan(1e-4);
  });

  it("lights the night with a dimmer moon from the other side, never near-black", () => {
    const night = lightingAt(MIDNIGHT);
    const day = daylight();
    expect(night.keyIntensity).toBeLessThan(day.keyIntensity);
    expect(night.keyIntensity).toBeGreaterThan(0.5);
    expect(night.shadowIntensity).toBeGreaterThan(0);
    expect(Math.sign(night.keyDirection.x)).toBe(-Math.sign(day.keyDirection.x));
    expect(night.keyDirection.y).toBeGreaterThan(0);
    // The sky light still carries most of the readability.
    expect(night.skyIntensity * night.skyColor.getHSL({ h: 0, s: 0, l: 0 }).l).toBeGreaterThan(0.1);
  });

  it("is night only at night, switching halfway through dusk and dawn", () => {
    expect(lightingAt(NOON).night).toBe(0);
    expect(lightingAt(MIDNIGHT).night).toBe(1);
    expect(lightingAt(19 * 60).night).toBe(0); // dusk
    expect(lightingAt(7 * 60).night).toBe(0); // dawn
    expect(lightingAt(19.75 * 60).night).toBeCloseTo(0.5);
    expect(lightingAt(6 * 60).night).toBeCloseTo(0.5);
    expect(lightingAt(21.5 * 60).night).toBe(1);
  });

  it("keeps the key light above the horizon all day", () => {
    for (let m = 0; m < 1440; m += 5) expect(lightingAt(m).keyDirection.y).toBeGreaterThan(0.2);
  });
});

const scene: SceneData = {
  bounds: { min: { x: -2, y: -1, z: -1 }, max: { x: 2, y: 3, z: 1 } },
  terrain: {
    columns: 2,
    rows: 2,
    cellSize: 1,
    heights: [1, 1, 1, 1],
    colors: Array<string>(4).fill("#7fae5a"),
  },
  surfaces: [],
  edgeWater: {
    north: [NaN, NaN],
    south: [NaN, NaN],
    west: [NaN, NaN],
    east: [NaN, NaN],
  },
  props: [],
  spawnPoints: [],
};

describe("buildDioramaScene time of day", () => {
  const lights = (built: ReturnType<typeof buildDioramaScene>) => {
    const sun = built.world.children.find((c) => c instanceof THREE.DirectionalLight)!;
    const sky = built.world.children.find((c) => c instanceof THREE.HemisphereLight)!;
    return { sun, sky, background: built.world.background as THREE.Color };
  };

  it("starts in daylight and noon changes nothing", () => {
    const built = buildDioramaScene(scene);
    const before = lights(built);
    const snapshot = {
      sun: before.sun.position.clone(),
      color: before.sun.color.getHex(),
      intensity: before.sun.intensity,
      background: before.background.getHex(),
      sky: before.sky.color.getHex(),
      ground: before.sky.groundColor.getHex(),
      skyIntensity: before.sky.intensity,
      shadow: before.sun.shadow.intensity,
    };
    expect(snapshot.background).toBe(0xcfe3ea);
    built.setTimeOfDay(NOON);
    const after = lights(built);
    expect(after.sun.position.distanceTo(snapshot.sun)).toBeLessThan(1e-12);
    expect(after.sun.color.getHex()).toBe(snapshot.color);
    expect(after.sun.intensity).toBe(snapshot.intensity);
    expect(after.background.getHex()).toBe(snapshot.background);
    expect(after.sky.color.getHex()).toBe(snapshot.sky);
    expect(after.sky.groundColor.getHex()).toBe(snapshot.ground);
    expect(after.sky.intensity).toBe(snapshot.skyIntensity);
    expect(after.sun.shadow.intensity).toBe(snapshot.shadow);
  });

  it("ignores non-finite times and repeats within the same minute", () => {
    const built = buildDioramaScene(scene);
    expect(built.setTimeOfDay(NaN)).toBe(false);
    expect(lights(built).background.getHex()).toBe(0xcfe3ea);
    expect(built.setTimeOfDay(MIDNIGHT + 0.2)).toBe(true);
    expect(built.setTimeOfDay(MIDNIGHT + 0.9)).toBe(false);
    expect(built.setTimeOfDay(Infinity)).toBe(false);
    expect(lights(built).background.getHex()).toBe(lightingAt(MIDNIGHT).background.getHex());
    expect(built.setTimeOfDay(MIDNIGHT + 1)).toBe(true);
  });

  it("moves the key light and darkens the background at night", () => {
    const built = buildDioramaScene(scene);
    built.setTimeOfDay(MIDNIGHT);
    const { sun, background } = lights(built);
    const toSun = sun.position.clone().sub(sun.target.position).normalize();
    expect(toSun.distanceTo(lightingAt(MIDNIGHT).keyDirection)).toBeLessThan(1e-9);
    expect(background.getHex()).toBe(lightingAt(MIDNIGHT).background.getHex());
    expect(sun.shadow.intensity).toBe(lightingAt(MIDNIGHT).shadowIntensity);
  });

  it("gives the cues their night look at night and their day look by day", () => {
    const built = buildDioramaScene(scene);
    const setNight = vi.spyOn(built.creatures, "setNight");
    built.setTimeOfDay(21.5 * 60);
    expect(setNight).toHaveBeenLastCalledWith(true);
    built.setTimeOfDay(19.5 * 60);
    expect(setNight).toHaveBeenLastCalledWith(false);
    built.setTimeOfDay(NOON);
    expect(setNight).toHaveBeenLastCalledWith(false);
  });
});

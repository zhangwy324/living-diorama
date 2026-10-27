// What the app runs at launch (ADR 0010): the only place world and species IDs are chosen. Kept
// free of content imports, so the main thread's bundle doesn't pull in the content packs.

export interface StartingCreatures {
  speciesId: string;
  count: number;
}

export interface StartupConfig {
  worldId: string;
  tickRateHz: number;
  /** Most creatures the world holds at once (roadmap §2.2). */
  maxCreatures: number;
  /** Creatures spawned once the world is ready, at random spawn points. */
  creatures: StartingCreatures[];
}

/** Three mosslings in the Woodland Hollow (roadmap §1.9 Q3). */
export const STARTUP: StartupConfig = {
  worldId: "hollow:woodland-hollow",
  tickRateHz: 10,
  maxCreatures: 20,
  creatures: [{ speciesId: "hollow:mossling", count: 3 }],
};

/** What a drawn species is given besides its name, size and image (ADR 0014 §11): the mossling's. */
export const DRAWN_SPECIES_DEFAULTS = {
  capabilities: { "core:walk": 1 },
  baseSpeed: 0.6,
  behaviors: ["core:wander"],
};

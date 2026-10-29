# ADR 0019: World saving

- **Status:** Accepted
- **Date:** 2026-10-28
- **Context:** Roadmap §3.2 step 6, planned as M15. Since step 5 ([ADR 0018](0018-living-behavior.md)) creatures carry individual state (needs, home, knowledge, variation) that is lost on every launch: the world starts fresh with three mosslings, and drawn creatures must be added back from the library (ADR 0009 §12, ADR 0014 §8). Step 6 saves the world and its individuals and restores them on the next launch, including the real-time catch-up that ADR 0018 §19 left for this step. The decisions below were agreed with the owner on 2026-10-28. Step 6 lands as a series of PRs: **0** this ADR; **1** the world save schema (§2); **2** engine save and restore (§7, §8); **3** catch-up (§5, §6); **4** the save and restore protocol messages; **5** the Rust world store (§1); **6** app wiring (§3, §4, §9, §11); **7** tools, soak and the manual checklist. Each PR adds an "as built" note below where it departs from this ADR.

This ADR amends ADR 0018 §19 (short gaps, §6) and, once PR 6 lands, ADR 0008 §14 (the quit timeout, §4) and ADR 0009 §12 (no world persistence). It departs from the spec's persistence suggestion (spec §10.1, §13.2 and §14 question 20; see §1).

## Decisions

### Storage

1. **One JSON file, stored by Rust, checked by TypeScript.** The world is saved as `world.json` in the app data directory, with the previous save kept as `world.prev.json`. Rust writes it atomically, as `settings.rs::write_json` does (a temporary file, then a rename), and doesn't interpret its contents, like the species library (ADR 0014 §3). TypeScript validates it. In development builds `LIVING_DIORAMA_DEV_DATA_DIR` moves it, as it moves the library, so manual checks never touch the player's world.

   **Departure from the spec.** The spec proposes SQLite plus an asset directory, not final (spec §10.1, §13.2, §14 question 20), and the roadmap's backlog lists a `persistence` package for it. Step 6 needs neither: there is one world, its save is small, and it is written whole. A JSON file reuses the atomic write and the Rust-stores/TypeScript-validates split the settings and the library already have. There is no SQLite and no `persistence` package now; the question is revisited with step 7, when the world becomes a base world plus edits. Backups are the one previous save. Checksums and migrations are not adopted: a torn or corrupt file fails validation and falls back as §7 says, and backward compatibility is not required (AGENTS.md).

2. **The save schema lives in `content-schema`.** It replaces the stale `CreatureInstanceSchema` (which ADR 0018 §16 said would be widened in step 6) with a strict world save schema matching `CreatureState`. A creature's action state and each behavior's memory stay `unknown` in the schema; the code that owns them validates them.

### Save contents

At least:

- the save version;
- when it was saved (`savedAt`, milliseconds since the epoch);
- the world's ID and version;
- the seed (§8), the tick, the time of day (`minutes`) and the day phase (`dayPhase`; both are needed, or loading a save would emit a spurious phase change, ADR 0018 PRs 3a and 3b);
- the world RNG state and the creature ID counter;
- the world's `introducedSpecies` set, kept so `species_introduced` doesn't fire again for a species after a restore, and the species dependencies (ID and version);
- the creatures, each with its full `CreatureState` (species ID and version, position, needs, home, knowledge, variation, action and behavior memory).

### Lifecycle

3. **Startup order.** `init` creates an empty world. The library then opens and registers drawn species as today (ADR 0014 §8). Then a new `restore` command loads the save. It carries the current wall-clock time, from which the gap is computed, because the simulation never reads a clock (ADR 0006 §1). The three starting mosslings spawn only when there is no usable save. So a restored world never gains extra mosslings, and every drawn species a save names is registered before the save is read.

4. **When to save.** On quit, every 60 seconds, and after a creature is spawned, despawned or released from the Studio. The quit timeout (ADR 0008 §14) rises from 1 second to about 3, so a save on quit can finish; PR 6 measures how long a save takes and records it.

### Catch-up

5. **A `catchUp` hook on behaviors.** `BehaviorProvider` gains an optional `catchUp(observation, gap)` hook, like the `interrupted` hook on actions (ADR 0018, PR 5a). `core:feed` resets hunger (to a random value below `actAt`, ADR 0018 §19). `core:rest` sets tiredness and can ask for the creature to start sleeping at home, already arrived and asleep. The engine owns the rest: the 12-hour cap, computing the gap, dropping the action in progress, placing awake creatures and suppressing per-creature events. The engine never branches on content IDs; it calls whichever behaviors declare the hook.

6. **Short gaps are no gap (amends ADR 0018 §19).** ADR 0018 §19 said a gap under 2 minutes "runs as ordinary ticks". The clock drops time beyond `maxCatchUpTicks` (ADR 0006 §1), so those ticks would never run. Instead, a gap under 2 minutes is treated as no gap: the world is restored exactly, and only the time of day jumps to the present. A clock that went backwards still counts as no gap, and custom day mode still has no catch-up.

### Compatibility

7. **A save that doesn't match.** The whole save is discarded, with a logged warning, and the world starts fresh when its world ID or world version differs from the running world's, or its save version isn't the current one. Within a save that is kept, a creature whose species is missing, or registered with a different major version, is dropped (ADR 0003 §5: the same major version is compatible). Home and knowledge entries naming placements no longer in the world are pruned; behavior memory that names placements is pruned by its owning code. Pruning runs before catch-up (§5) places creatures. What was dropped is reported. A corrupt, unreadable or incompatible save never crashes the app.

   An exact version match is not required beyond this. ADR 0003 §5 already accepts any species with the same major version, and backward compatibility is not required yet (AGENTS.md), so there are no migrations and no shims: a save from an older build either passes these checks or is discarded.

8. **The seed is kept.** A restored world keeps its saved seed across launches, so restoring and carrying on gives the same run as an unbroken one, given the same later commands and time of day (ADR 0006 §2). PR 2's round-trip test checks this headless: it restores at a tick boundary and takes `minutes` from the save.

### Development and scope

9. **Reset is a dev console hook only.** Development builds get `livingDiorama.world.reset()`, which discards the save and starts a fresh world. There is no player-facing reset (owner's decision).

10. **OS sleep while running is not caught up.** A wall-clock jump within a session (the machine sleeping with the app open) still drops time as today (ADR 0008 §13); only the time of day jumps. Catching up for it is deferred to an issue.

11. **The creature-count override skips the save.** When the count override is set (`VITE_CREATURE_COUNT`, as `pnpm measure` does), the app neither loads nor writes the save, so measuring never overwrites the player's world. `docs/development.md` says so.

12. **No release.** M14 plus world saving is not v0.3 (owner's decision). This milestone does no release work.

## Exit

Step 6 is done when:

- quitting and relaunching brings back the same creatures, drawn ones included, with their needs, home and knowledge;
- a short gap resumes exactly where the world stopped;
- a long gap applies ADR 0018 §19's catch-up: rested if the night passed, fed, asleep at home at night, and no per-creature events;
- restoring and carrying on gives the same result as an unbroken run, given the same later commands and time of day (checked headless, §8);
- a corrupt or incompatible save falls back to a fresh world with a logged warning, never a crash;
- `pnpm check` and `pnpm soak` pass with save and restore checks;
- a manual checklist entry is added and run by the owner;
- this ADR records the decisions and every departure from them.

## As built

## Consequences

- Creatures and their individual state survive a relaunch, so behavior that shows over hours (sleep, homes, knowledge) is no longer lost each launch.
- Saves are written whole. That is cheap at one world and about 20 creatures, but a larger world or a world with edits may need incremental saving; step 7 revisits storage.
- Any change to `CreatureState` or the save format makes old saves fail validation and start fresh. That is accepted until backward compatibility is required.
- Catch-up stays content-driven: a new need's behavior adds a `catchUp` hook rather than engine code.

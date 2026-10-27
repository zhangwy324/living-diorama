# ADR 0010: Content startup

- **Status:** Accepted
- **Date:** 2026-10-26
- **Context:** Roadmap M7 (cleanup before runtime species), issues #24 and #25. In v1 the main thread and the simulation worker each registered the engine and the built-in pack, resolved references and checked the world: the main thread to build the scene data, the navigation overlay and the renderer's asset and species lookups, the worker to run the simulation. Two copies of the registries could in principle disagree, and M9 adds species while the app runs, which would have to reach both. The app also hard-coded the world it runs and the one species it spawns in `load-world.ts`.

## Decisions

1. **The worker is the only place content is registered and checked.** The worker can't receive registries from the main thread, since they hold engine code (actions, behaviours, surfaces), so the main thread no longer loads content at all. `apps/desktop/src/content.ts` registers the engine and the packs, and only `simulation.worker.ts` imports it.

2. **`ready` describes the world to the main thread** (protocol version 3). Alongside the world ID it carries, as plain data that survives `postMessage`:
   - the scene data (`describeScene`);
   - one navigation overlay per navigation profile the world was checked for;
   - every registered asset (kind, URL, scale) and species (appearance, size class), by ID: what the renderer resolves.

   The main thread creates the `DioramaView` when `ready` arrives, then spawns the starting creatures. M9 keeps these lookups in step when a species is registered at runtime.

3. **A failed `init` is a content failure.** Until `ready`, `init` is the only command in flight, so an `error` before it shows "The world failed to load" with the diagnostics, as the main thread's own check did before. After `ready` the summary stays "The simulation stopped" (ADR 0009 §2).

4. **One startup config chooses the world and its first creatures.** `apps/desktop/src/startup.ts` holds the world ID, the tick rate and a list of starting creatures (species and count). It is the only place outside tests and the development tools that names content IDs, and it imports no content, so the main thread's bundle doesn't pull in the packs. In development builds `VITE_CREATURE_COUNT` overrides every entry's count (ADR 0009 §4).

5. **The debug overlay shows the first navigation profile.** v1 and v0.2 have one profile (`core:walk`). Before, the app picked the spawned species' profile; with several starting species there is no single one, and choosing which to show is left until a second profile exists.

## Consequences

- Startup does the work once. The view starts slightly later, after the worker has loaded and checked the world, so the strip shows its background for that moment.
- The worker builds and sends the overlay for every profile, though only one is drawn. It is a one-off message.
- Content warnings are still not logged anywhere: neither the old main-thread check nor the worker reports them. They can travel with `ready` when a pack first produces one.
- `docs/adding-content.md` points pack authors at `content.ts` (registration) and `startup.ts` (what the app runs).

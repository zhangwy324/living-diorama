# ADR 0018: Living behavior

- **Status:** Accepted
- **Date:** 2026-10-28
- **Context:** Roadmap §3.2 step 5. Creatures today only wander (ADR 0006 §9): props block movement and offer nothing, behaviors see the whole world, and there is no time of day. Step 5 gives creatures needs they meet in the world, so that later work (drawn senses and needs, structures, saves, the Chronicle, the inspector) has a shared vocabulary: needs, affordances, senses and traits, events, individual state and time. The decisions build on the existing decision framework (ADR 0006 §7–§8: behaviors propose scored actions, the engine validates) and are taken against the fixed built-in world. Step 5 lands as a series of PRs: **1** this ADR; **2** schema and registries (§1–§4); **3** time, night lighting and the needs engine (§5–§9); **4** food, perception and memory (§10–§12); **5** shelter, sleep and home (§13–§14); **6** tuning, long-run tests and the hand check (§18). Each PR updates this ADR where it departs from it. All numbers are starting values, to tune in PR 6.

This ADR amends ADR 0002 (prop placements and the new `prop` kind), ADR 0004 §7 (traits and senses arrive) and ADR 0006 §8 (triggers and interruption).

## Decisions

### Vocabulary

1. **Needs are registry entries holding data.** A new `needs` registry in `extension-api`. A need's value runs from 0 (met) to 1 (pressing), the same way round for every need, so utilities compare directly. A need declares how fast it rises per hour of simulation time while awake and while asleep, and the value at which a creature starts to act on it (`actAt`). Step 5 registers two, in the core pack beside the core actions:
   - `core:hunger`: rises from 0 to 1 in 90 minutes; `actAt` 0.4. With travel and eating that is a meal every 30–60 minutes. It rises at half speed while asleep.
   - `core:tiredness`: rises from 0 to 1 in 16 hours awake, falls to 0 in 8 hours asleep; `actAt` 0.7. The day phase adds to it (§13), so creatures sleep at night and nap when tired by day.

   Comfort and curiosity are left out: comfort needs environment fields and weather, and `core:wander` keeps playing curiosity's part. A creature has the needs its behaviors depend on (a `needs` dependency in the behavior's `dependencies`), so a species with only `core:wander` has none and behaves as today.

2. **Affordances carry parameters.** An affordance on a structure or prop type is a map from affordance ID to its parameters, checked against a parameter schema the affordance type registers (`AffordanceType` gains `params`). Structure types change from a list to the same map (`{ "core:crossable": {} }`). Step 5 adds:
   - `core:food` `{ eatSeconds }`: a creature may eat here. A source never runs out (§12).
   - `core:shelter` `{}`: a creature may sleep beside it.

   The engine finds food and shelter by affordance, never by prop or model ID.

3. **Prop types.** A new definition kind `prop` (schema version 1): `id`, `version`, `name`, `model`, `blockRadius` and `affordances`. A prop placement names its type (`prop: ContentId`) and keeps only its `id` and `transform`; `blockRadius` moves to the type. The 108 Woodland Hollow placements share five types. Mushrooms and bushes are food, round trees are shelter, pines and rocks offer nothing. Structures stay the concept for anything that adds regions or connections.

4. **Senses and traits are species maps** (ADR 0004 §7), registered in new `senses` and `traits` registries.
   - `senses: Record<ContentId, number>`. As with capabilities, a missing sense means the creature lacks it. Step 5 has one sense, `core:vision`: its range in metres.
   - `traits: Record<ContentId, number>`. A trait left out takes the default its registry entry declares. Step 5 has `core:nocturnal` (0 sleeps at night, 1 sleeps by day; default 0) and `core:appetite` (scales hunger's rise; default 1).
   - The mossling gets `core:vision: 8`. Drawn species get the same defaults (ADR 0014 §11's `DRAWN_SPECIES_DEFAULTS`), plus `core:feed` and `core:rest` in their behaviors. Step 8 reads these from the drawing instead.

### Time and decisions

5. **Time of day is an input, not a clock read.** The main thread sends `set_time_of_day { minutes }` (local minutes since midnight) once a minute and on resume, queued and applied at a tick boundary like any other command (ADR 0006 §11), so a run stays replayable from its command log. The simulation maps it to four phases: dawn 06:00–08:00, day 08:00–18:00, dusk 18:00–20:00, night 20:00–06:00. A dev setting fixes the time of day so night can be tested at noon. Needs run on simulation time, so the speed multiplier speeds them up. The phase stays with the input time.
   - **Two clock modes, one built now.** _Real time_ (step 5): the time of day is the OS clock, as above. _Custom day_ (later, with a settings control): the player sets a day length, and the time of day is simulation state advanced by ticks and saved with the world, so the main thread sends nothing. Everything downstream reads only the time of day, so the custom mode adds a clock source and changes no behavior. Which need rates then scale with the day length (tiredness surely, hunger perhaps not) is decided when it is built.

6. **Night lighting.** The snapshot carries the time of day. The renderer blends the sun's colour, intensity and height and the sky light between a few keyed times, so dusk and dawn are gradual. The Studio's preview keeps today's daylight.

7. **Two new decision triggers.** Behaviors are still evaluated only on triggers (ADR 0006 §8). Step 5 adds a need crossing its `actAt` upwards and the day phase changing.

8. **Interruption by utility, with a margin.** A running action remembers the utility it was chosen with. On a new trigger the behaviors are evaluated. A proposal replaces the running action only if its utility is at least 0.15 higher, and the interrupted action fails with `interrupted`, as from the watchdog. With no action running, the highest proposal wins as before. The margin, and needs that act only above `actAt`, keep goals from flickering.

9. **Utilities.** `core:wander` stays at 0.1. `core:feed` proposes with `0.2 + hunger`, `core:rest` with `0.2 + tiredness + night bonus` (§13). Proposals start only above `actAt`, apart from the night bonus. A creature that is both hungry and tired goes for the more pressing need.

### Food

10. **Vision and memory.** Once a second, a creature with `core:vision` looks for props with affordances within its range. Range is a straight-line distance with no line-of-sight test (terrain occlusion is later). It remembers what it has seen: up to 8 food and 4 shelter placements, each with the tick it was last seen. The oldest entry is forgotten first. A creature without vision learns about a place only by bumping into it, within 1 m. Pathfinding still knows the real geometry (spec §8.3). Only knowledge is partial.

11. **`core:feed` (behavior) and `core:eat` (action).** When hungry, `core:feed` picks the remembered food with the shortest route. `core:eat` takes the placement ID: it walks to the nearest walkable spot within reach of the prop (`blockRadius + creature radius + 0.3 m`), eats for `eatSeconds` and lowers hunger by 0.8. Knowing no food, `core:feed` proposes `core:follow_path` to a random point, preferring regions the creature hasn't visited recently (a short list in its memory), which is how it discovers food.

12. **Food never runs out.** Any number of creatures may eat at a source, any number of times, so food adds no world state. Portions, depletion and regrowth (and their events) are later, when there is a reason for creatures to compete or move on; adding them then means a `portions` parameter on `core:food` and per-placement state in `WorldState`.

### Shelter and sleep

13. **`core:rest` (behavior) and `core:sleep` (action).** The night bonus is 0.5 in the creature's sleeping phase (night, or day for `core:nocturnal` 1) and 0.2 at the edges of that phase (dusk and dawn). The bonus alone can start sleep, so creatures go to bed at night even when not very tired. `core:sleep` walks to a shelter spot (as in §11), then stays still until tiredness is below 0.1 and the creature's waking phase has begun, or tiredness reaches 0 during a nap. Hunger can wake a sleeper only above 0.9. A creature that knows no shelter sleeps where it stands.

14. **Home.** The first shelter a creature sleeps at becomes its home (`new_home_selected`). `core:rest` prefers home over closer shelters unless home is more than twice the route length of the nearest one, and then it naps there without changing home. Home is a placement ID in the creature's state.

15. **Visible cues, no need readouts.** An action type may declare a `cue` (`"eating"` or `"sleeping"`), and a need may declare one with the value it shows from (`core:hunger`: `"hungry"` from 0.8). The snapshot carries each creature's cues. The renderer shows a small bob while eating, a still, slightly lowered body with rising "z" sprites while sleeping, and a small bobbing food bubble above a very hungry creature, without knowing action or need IDs. Need values, memory and home go into the snapshot only with debug on, for the dev overlay. The inspector comes later.

### Individuals, events and catch-up

16. **Individual state and variation.** Creature state gains `needs` (ID → value), `memory` (seen food and shelter, recent regions), `home` and `variation`. Variation is drawn once at spawn from the creature's own RNG stream and stored: hunger and tiredness rates and vision range each scaled by 0.85–1.15. Everything stays plain data (ADR 0006 §4), and `CreatureInstance` is widened to match in step 6. Spawned creatures start with random needs below their `actAt`, so they don't all eat at once.

17. **Events.** New events: `ate`, `fell_asleep`, `woke_up` and `new_home_selected` (per creature), and `day_phase_changed` (a world event, with no `creatureId`; the event base is split into creature and world events). The decision trace gains the need values and each proposal's reason.

18. **Sanctuary.** No deaths and no harm. A creature whose hunger reaches 1 walks at 80% speed and doesn't wander until it eats. That is the only consequence.

19. **Catch-up in real time mode, built in step 6.** Step 5 changes nothing within a session: the clock still drops time beyond `maxCatchUpTicks` (ADR 0006 §1), and only the time of day jumps on resume. When step 6 restores a saved world in real time mode, the gap is not simulated; the world is set to a plausible state for the present:
    - the gap is wall-clock time since the save, capped at 12 hours. A clock that went backwards counts as no gap, and a gap under 2 minutes runs as ordinary ticks;
    - tiredness: if the gap covered the creature's sleeping phase, it is rested (0); otherwise it rises by the hours spent awake;
    - hunger: the creature is assumed to have eaten, so it gets a random value below `actAt` (integrating the gap would leave every creature starving after a long absence);
    - the action in progress is dropped. A creature is placed asleep at home if it is now its sleeping phase, otherwise at a random reachable point in its home's region (its current region if it has no home);
    - catch-up emits no per-creature events. The Chronicle gets one summary later.

    In custom day mode there is no catch-up: the world carries on exactly from the state it was saved in.

### Testing

20. **Long-run checks.** The randomized invariant runs (ADR 0006 §12) also check that needs stay in [0, 1], that every creature with reachable food eats at least once per simulated 3 hours, that creatures spend most of the night asleep, and that decisions per creature stay under a bound (no flicker). A headless runner option prints, per creature, meals, sleep hours and time spent hungry.

## Consequences

- Behaviors stay data-light code, and needs, affordances, senses and traits are data, so step 8 can set senses and traits from a drawing without new engine code.
- Prop placements break (`blockRadius` moves to the type). No migration is needed (AGENTS.md: backward compatibility).
- The worker protocol version goes up (new command, snapshot fields and events).
- Perception is a linear scan of about 100 props per creature per second, which is cheap at 20 creatures. A spatial index waits until worlds grow.
- Some behavior only shows over hours of real time (sleep and the day cycle). The fixed time-of-day setting and the speed multiplier make it testable by hand.

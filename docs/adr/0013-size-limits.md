# ADR 0013: Size limits

- **Status:** Accepted
- **Date:** 2026-10-27
- **Context:** Follow-up to ADR 0012 (roadmap M9). Building navigation for new profiles at registration showed that the Woodland Hollow failed the world checks for every size class but medium:
  - tiny and small: a few dry cells in the outermost row, where the river meets the world's edge, are walkable but cut off (`disconnected_region`). Medium never stands in that row;
  - large: the bridge deck (1.4 m) leaves no room for a 0.8 m radius (`portal_unusable`), and a rock cuts 163 cells off the east meadow.

  The checks treated any of these as an error, so a drawn species of those sizes would be rejected, and so would a pack species. Separately, navigation assumed each region is one connected piece: wander chose destinations anywhere in a reachable region, which for a split region could be somewhere the creature can't get to.

## Decisions

1. **A creature only goes where it fits, and that is a game mechanic.** A creature drawn too big for the bridge stays on its bank. The player sees why (decision 4) and can draw a smaller one. Creatures reacting to a limit, like walking up to the bridge and turning back, belongs to living behaviour later; for now wander never picks a place the creature can't reach.

2. **Navigation works with areas.** For each profile, a region's walkable cells split into connected areas (`RegionMask.components`). `Pathfinder.reachableCells(position)` floods from the creature's area through the crossings routes already use, so it returns exactly what `findRoute` can reach, and caches the result per area. Wander's queries (`reachableRegions`, `randomWalkablePoint`) only offer those cells; their contract is unchanged, only "reachable" now means from where the creature stands. Cells are kept in cell order, so a seed reproduces the same choices. `Navigation.reachableRegions` stays region-level, for the world tests and overlays.

3. **Not fitting is a warning; broken geometry stays an error.** Per profile:
   - warnings (limits): a region that splits into areas (`disconnected_region`), a portal with no room on one side (`portal_unusable`, naming the structure it belongs to), a spawn point with no room (`spawn_not_walkable`), a region with nowhere to stand (`no_walkable_area`);
   - errors: a portal whose surfaces don't meet within the step height (`portal_unusable`), since no size can use it; two regions walkable at the same place and height (`ambiguous_overlap`);
   - new error `no_spawn_point`: the profile can't stand on any spawn point, so its creatures can't appear.

   This holds at startup for pack species too, so drawn species aren't treated differently. The built-in world's test still asserts no diagnostics at all for the mossling.

4. **Limits go back with the species.** `checkWorld` and `checkNavigation` return each profile's limits; the world state keeps them per profile. `species_registered` carries them (`limits`, as warnings), and `SimulationClient.registerSpecies` resolves with `{ speciesId, limits }`, so the Studio (M11) can tell the player "too big to cross the bridge". A species whose profile is already known gets the limits found when that profile was built. `PROTOCOL_VERSION` stays 4: v4 hasn't been released.

## Consequences

- In the Woodland Hollow, tiny and small creatures wander everywhere except the edge pockets, over the bridge too, with no failed paths. Large creatures stay on the bank they appear on, and on their side of the rock. Tests run all three sizes through the invariant checks.
- A world author gets warnings instead of errors for sizes that don't fit, so a real mistake for a pack's own species can slip through as a warning. `docs/adding-content.md` says to check warnings for species that should go everywhere.
- Limits are developer diagnostics. Turning them into the player's words is M11's job.
- Spawning still picks any spawn point the creature can stand on. One in a small area would keep its creatures there.

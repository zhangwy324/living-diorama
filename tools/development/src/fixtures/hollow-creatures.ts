import { registerBuiltInContent } from "@living-diorama/built-in-content";
import type { Registries } from "@living-diorama/extension-api";

// Test-only species for Woodland Hollow's swim and hop scenarios (ADR 0020, M16 PR 7): an
// amphibian that walks and swims, a second one that prefers the water (#163), a water-only
// swimmer and a land-only hopper, each living like
// the mossling (wander, feed, rest, vision). The built-in pack ships only the mossling; these
// stand in for creatures drawn in the Studio, so they live here and not in built-in content.
// Used by tests, `pnpm sim --species` and `pnpm soak`.

const species = (
  id: string,
  name: string,
  capabilities: Record<string, number>,
  body: { locomotion: { land: { gait: string } } },
  traits: Record<string, number> = {},
) => ({
  schemaVersion: 1,
  id,
  version: "1.0.0",
  name,
  appearance: `${id}.png`,
  sizeClass: "medium",
  capabilities,
  baseSpeed: 0.6,
  behaviors: ["core:wander", "core:feed", "core:rest"],
  senses: { "core:vision": 8 },
  traits,
  body,
});

/** Walks and swims, at a speed factor of 1 in both, as a drawn species does. */
export const otter = species(
  "fixture:otter",
  "Otter",
  { "core:land": 1, "core:swim": 1 },
  { locomotion: { land: { gait: "walk" } } },
);
/**
 * Like the otter, but keeps to the water (#163): wander takes it in twice as often and never out,
 * so it leaves the water only to eat or sleep.
 */
export const beaver = species(
  "fixture:beaver",
  "Beaver",
  { "core:land": 1, "core:swim": 1 },
  { locomotion: { land: { gait: "walk" } } },
  { "core:water_preference": 1 },
);
/** Only swims, so it appears at the river's spawn point and never leaves the water. */
export const carp = species(
  "fixture:carp",
  "Carp",
  { "core:swim": 1 },
  { locomotion: { land: { gait: "walk" } } },
);
/** Only moves on land, hopping. */
export const toad = species(
  "fixture:toad",
  "Toad",
  { "core:land": 1 },
  { locomotion: { land: { gait: "hop" } } },
);

export const HOLLOW_CREATURES = [otter, beaver, carp, toad] as const;

/** The built-in pack, then the test species above, as a second pack would register them. */
export function registerHollowCreatures(registries: Registries) {
  return [
    ...registerBuiltInContent(registries),
    ...HOLLOW_CREATURES.flatMap((s) => [
      registries.assets.register({ id: s.appearance, version: "1.0.0", kind: "image", url: "-" }),
      registries.species.register(s),
    ]),
  ];
}

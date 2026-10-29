import { registerBuiltInContent } from "@living-diorama/built-in-content";
import type { Registries } from "@living-diorama/extension-api";

// Test-only species for Woodland Hollow's swim and hop scenarios (ADR 0020, M16 PR 7): an
// amphibian that walks and swims, a water-only swimmer and a land-only hopper, each living like
// the mossling (wander, feed, rest, vision). The built-in pack ships only the mossling; these
// stand in for creatures drawn in the Studio, so they live here and not in built-in content.
// Used by tests, `pnpm sim --species` and `pnpm soak`.

const species = (
  id: string,
  name: string,
  capabilities: Record<string, number>,
  body: { template: string; locomotion: { land: { gait: string } } },
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
  body,
});

/** Walks and swims, slower in water; the drawn default size, medium. */
export const otter = species(
  "fixture:otter",
  "Otter",
  { "core:land": 1, "core:swim": 0.6 },
  { template: "walker", locomotion: { land: { gait: "walk" } } },
);
/** Only swims, so it appears at the river's spawn point and never leaves the water. */
export const carp = species(
  "fixture:carp",
  "Carp",
  { "core:swim": 1 },
  { template: "swimmer", locomotion: { land: { gait: "walk" } } },
);
/** Only moves on land, hopping. */
export const toad = species(
  "fixture:toad",
  "Toad",
  { "core:land": 1 },
  { template: "hopper", locomotion: { land: { gait: "hop" } } },
);

export const HOLLOW_CREATURES = [otter, carp, toad] as const;

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

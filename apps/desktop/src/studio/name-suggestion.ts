// A playful two-part name the Studio suggests for a new creature (issue #48), such as "Mossy
// Pebble". Offline and deterministic: the same seed and library always give the same name.

const FIRST = [
  "Mossy",
  "Bumble",
  "Speckled",
  "Fuzzy",
  "Puddle",
  "Twiggy",
  "Wobbly",
  "Sleepy",
  "Dewy",
  "Fern",
  "Acorn",
  "Thistle",
  "Clover",
  "Hazel",
  "Misty",
  "Pip",
  "Tumble",
  "Nibble",
  "Snuffle",
  "Crumble",
  "Velvet",
  "Breezy",
  "Muddy",
  "Sunny",
] as const;

const SECOND = [
  "Pebble",
  "Sprout",
  "Button",
  "Whisker",
  "Puff",
  "Bean",
  "Nugget",
  "Muffin",
  "Bramble",
  "Pod",
  "Toadstool",
  "Biscuit",
  "Dumpling",
  "Waddle",
  "Scamper",
  "Burrow",
  "Thimble",
  "Noodle",
  "Pickle",
  "Nook",
  "Wiggle",
  "Truffle",
  "Bloom",
  "Tadpole",
] as const;

/** How many different names there are to suggest. */
export const SUGGESTION_COUNT = FIRST.length * SECOND.length;

const nameAt = (index: number) =>
  `${FIRST[Math.floor(index / SECOND.length)]} ${SECOND[index % SECOND.length]}`;

/** Spreads neighbouring seeds over the names (a 32-bit integer mix). */
function mix(seed: number): number {
  let x = Math.trunc(seed) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** A fresh seed for {@link suggestName}. */
export const randomNameSeed = () => Math.floor(Math.random() * 2 ** 32);

/** Seeds tried by {@link anotherName} before it settles for whatever it last drew. */
const REROLL_TRIES = 16;

/**
 * A suggestion other than `current` (the reroll button), still skipping `taken` names where it
 * can. Settles for a repeat only if a run of seeds keeps landing on `current`.
 */
export function anotherName(
  current: string,
  taken: Iterable<string> = [],
  random: () => number = randomNameSeed,
): string {
  const names = Array.from(taken);
  let name = current;
  for (let tries = 0; tries < REROLL_TRIES && name === current; tries++) {
    name = suggestName(random(), names);
  }
  return name;
}

/**
 * The suggested name for `seed`, skipping names already in the library where it can (names
 * needn't be unique, so when every name is taken the seed's own name is still suggested).
 */
export function suggestName(seed: number, taken: Iterable<string> = []): string {
  const used = new Set(Array.from(taken, (name) => name.trim().toLowerCase()));
  const start = mix(seed) % SUGGESTION_COUNT;
  for (let step = 0; step < SUGGESTION_COUNT; step++) {
    const name = nameAt((start + step) % SUGGESTION_COUNT);
    if (!used.has(name.toLowerCase())) return name;
  }
  return nameAt(start);
}

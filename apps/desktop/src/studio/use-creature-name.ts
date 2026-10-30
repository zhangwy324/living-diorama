import { useState } from "react";
import type { LibrarySnapshot } from "../studio-protocol";
import { anotherName, randomNameSeed, suggestName } from "./name-suggestion";

/**
 * A new creature's name: the one typed, else a suggestion. The suggestion is chosen once the
 * library arrives, then kept until a reroll or a release, so it doesn't jump when the library
 * changes.
 */
export function useCreatureName(library: LibrarySnapshot | undefined) {
  // Undefined until the player types one, so the suggestion shows.
  const [typed, setTyped] = useState<string>();
  const [suggestion, setSuggestion] = useState<string>();
  const [seed] = useState(randomNameSeed);
  // The first suggestion, once the library has come.
  if (library && suggestion === undefined) {
    setSuggestion(
      suggestName(
        seed,
        library.species.map((s) => s.name),
      ),
    );
  }
  const names = () => library?.species.map((species) => species.name) ?? [];
  const name = typed ?? suggestion ?? "";
  return {
    /** The name shown and released. */
    name,
    /** The player typed `next`. */
    type: setTyped,
    /** Replaces the name, typed or suggested, with a new suggestion. */
    another() {
      setTyped(undefined);
      setSuggestion(anotherName(name, names()));
    },
    /** A fresh suggestion for the next creature, after one named `released` was released. */
    afterRelease(released: string) {
      setTyped(undefined);
      setSuggestion(suggestName(randomNameSeed(), [...names(), released]));
    },
  };
}

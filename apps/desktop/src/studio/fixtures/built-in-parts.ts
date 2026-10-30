import { sortedParts, sortedPartTypes, sortedSocketTypes } from "@living-diorama/extension-api";
import { loadContent } from "../../content";
import type { StudioParts } from "../../studio-protocol";

/** Test only: the built-in parts as the strip's `parts` answer lists them, for Build mode's tests. */
export function builtInParts(): StudioParts {
  const content = loadContent();
  if (!content.ok) throw new Error("The built-in content doesn't load");
  return {
    parts: sortedParts(content.value).map(({ id, name, version, starter, part }) => ({
      id,
      name,
      version,
      ...(starter ? { starter } : {}),
      part,
    })),
    partTypes: sortedPartTypes(content.value).map(({ id, name, fits, role }) => ({
      id,
      name,
      fits: [...fits],
      ...(role ? { role } : {}),
    })),
    socketTypes: sortedSocketTypes(content.value).map(({ id }) => id),
    // Recolouring is PR 5b's.
    suggestedColors: [],
  };
}

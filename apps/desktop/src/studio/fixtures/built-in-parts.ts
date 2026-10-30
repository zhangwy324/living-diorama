import { describeVoxelParts } from "@living-diorama/simulation";
import { loadContent } from "../../content";
import type { StudioParts } from "../../studio-protocol";

/** Test only: the built-in parts as the strip's `parts` answer lists them, for Build mode's tests. */
export function builtInParts(): StudioParts {
  const content = loadContent();
  if (!content.ok) throw new Error("The built-in content doesn't load");
  return describeVoxelParts(content.value);
}

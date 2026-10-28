import { RequestTimeoutError } from "@living-diorama/desktop-integration";

// Releasing a drawing (roadmap M11 task 6): when the button is available and what the Studio
// says afterwards.

/**
 * Release needs a name and a body to build, and one release at a time. `empty` is true while the
 * image has nothing a body is built from: nothing drawn, all of it erased, or only faint pixels.
 */
export const canRelease = ({
  name,
  empty,
  releasing,
}: {
  name: string;
  empty: boolean;
  releasing: boolean;
}): boolean => name.trim() !== "" && !empty && !releasing;

/** The line shown when a creature goes into the world. */
export const releasedMessage = (name: string) => `${name} is off into the world!`;

/** The line shown when the species was kept but no creature of it could join the world. */
export const keptMessage = (name: string, why: string) =>
  `${name} is saved in My creatures, but couldn't join the world: ${why}`;

/** What went wrong, in the player's words. A timeout may have worked: trying again is safe. */
export function describeFailure(error: unknown): string {
  if (error instanceof RequestTimeoutError) {
    return "The world didn't answer in time. Try again in a moment.";
  }
  return error instanceof Error ? error.message : String(error);
}

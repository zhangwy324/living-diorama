import type { VoxelAssembly } from "@living-diorama/content-schema";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LoadRequest } from "./AssemblyEditor";
import type { StudioMode } from "./modes";

// Edit a copy (ADR 0023 §3): a released voxel creature's assembly, loaded into Build mode under a
// new name, so releasing it makes a new species and leaves the old one as it was.

/** The longest name the name field takes. */
const MAX_NAME_LENGTH = 40;
const SUFFIX = " copy";

/** The copy's name: "<name> copy", the name cut short to fit the name field. */
export function copyName(name: string): string {
  return `${name
    .trim()
    .slice(0, MAX_NAME_LENGTH - SUFFIX.length)
    .trimEnd()}${SUFFIX}`;
}

/**
 * Fetches a species' assembly and makes the load request for it, keyed by `key` (a new one for
 * each Edit a copy, so pressing it again on the same species loads it again).
 */
export async function copyRequest(
  fetch: (speciesId: string) => Promise<{ assembly: VoxelAssembly }>,
  species: { speciesId: string; name: string },
  key: number,
): Promise<LoadRequest> {
  const { assembly } = await fetch(species.speciesId);
  return { key, assembly, name: copyName(species.name) };
}

/**
 * Edit a copy's state for the Studio: `start` fetches a species' copy and makes it the load
 * request, and `loadRequest` is the latest one for `AssemblyEditor`. Only the latest press counts:
 * an earlier fetch that answers after it is dropped. The Studio switches to Build mode when the
 * copy arrives, unless the player has changed mode since pressing it; the copy still loads then,
 * waiting in Build mode.
 */
export function useEditCopy(
  fetch: (speciesId: string) => Promise<{ assembly: VoxelAssembly }>,
  mode: StudioMode,
  onMode: (mode: StudioMode) => void,
) {
  const [loadRequest, setLoadRequest] = useState<LoadRequest>();
  const latest = useRef(0);
  const currentMode = useRef(mode);
  useEffect(() => {
    currentMode.current = mode;
  }, [mode]);
  const start = useCallback(
    async (species: { speciesId: string; name: string }) => {
      const key = ++latest.current;
      const pressedIn = currentMode.current;
      const request = await copyRequest(fetch, species, key);
      if (request.key !== latest.current) return;
      setLoadRequest(request);
      if (currentMode.current === pressedIn) onMode("build");
    },
    [fetch, onMode],
  );
  return { loadRequest, start };
}

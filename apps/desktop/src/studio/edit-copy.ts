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

export interface EditCopyOptions {
  fetch(speciesId: string): Promise<{ assembly: VoxelAssembly }>;
  mode: StudioMode;
  onMode(mode: StudioMode): void;
  /** Whether Build mode holds a creature that would be lost, so pressing asks first. */
  unsaved(): boolean;
  /** Runs a load for a species, e.g. marking it busy and saying why it failed. */
  run(species: CopySource, load: () => Promise<void>): void;
}

type CopySource = { speciesId: string; name: string };

/**
 * Edit a copy's state for the Studio. `press` loads a species' copy, or, when Build mode has a
 * creature that wasn't released, first sets `confirming` to it for the Studio to ask whether to
 * discard that creature: `confirm` then loads it and `cancel` keeps the creature. `loadRequest`
 * is the latest copy for `AssemblyEditor`. Only the latest load counts: an earlier fetch that
 * answers after it is dropped. The Studio switches to Build mode when the copy arrives, unless the
 * player has changed mode since; the copy still loads then, waiting in Build mode.
 */
export function useEditCopy({ fetch, mode, onMode, unsaved, run }: EditCopyOptions) {
  const [loadRequest, setLoadRequest] = useState<LoadRequest>();
  const [confirming, setConfirming] = useState<CopySource>();
  const latest = useRef(0);
  const currentMode = useRef(mode);
  useEffect(() => {
    currentMode.current = mode;
  }, [mode]);
  const start = useCallback(
    async (species: CopySource) => {
      const key = ++latest.current;
      const pressedIn = currentMode.current;
      const request = await copyRequest(fetch, species, key);
      if (request.key !== latest.current) return;
      setLoadRequest(request);
      if (currentMode.current === pressedIn) onMode("build");
    },
    [fetch, onMode],
  );
  const load = (species: CopySource) => run(species, () => start(species));
  return {
    loadRequest,
    confirming,
    press(species: CopySource) {
      if (unsaved()) setConfirming(species);
      else load(species);
    },
    confirm() {
      if (!confirming) return;
      setConfirming(undefined);
      load(confirming);
    },
    cancel: () => setConfirming(undefined),
  };
}

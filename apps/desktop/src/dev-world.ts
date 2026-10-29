import type { WorldSaving } from "./world-saving";

// A development-only console hook to the saved world (ADR 0019 §9); players have no reset. In the
// dev app's console:
//
//   await livingDiorama.world.reset()   // every creature out, the starting ones in, then saved
//   await livingDiorama.world.save()    // save now instead of within the minute

export interface WorldDevHook {
  reset(): Promise<void>;
  save(): Promise<void>;
}

/** Puts the hook on `window.livingDiorama.world`; returns a function that takes it off again. */
export function installWorldDevHook(saving: WorldSaving): () => void {
  const hook: WorldDevHook = { reset: () => saving.reset(), save: () => saving.save() };
  window.livingDiorama = { ...window.livingDiorama, world: hook };
  return () => {
    if (window.livingDiorama?.world === hook) delete window.livingDiorama.world;
  };
}

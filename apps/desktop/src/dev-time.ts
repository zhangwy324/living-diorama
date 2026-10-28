import { parseClockTime } from "@living-diorama/simulation";
import type { SimulationClient } from "./simulation-client";

// A development-only console hook to the time of day (ADR 0018 §5), so night can be checked at
// noon. In the dev app's console:
//
//   livingDiorama.time.set("21:30")   // fix the time of day; phases and lighting follow it
//   livingDiorama.time.follow()       // back to the real clock
//   livingDiorama.time.speed(20)      // run simulation time 20 times as fast (1 is normal)

export interface TimeDevHook {
  set(time: string): void;
  follow(): void;
  speed(multiplier: number): void;
}

/** The hook's commands, sent through `client`. Each throws on a value it can't use. */
export function timeDevHook(
  client: Pick<SimulationClient, "fixTimeOfDay" | "setSpeed">,
): TimeDevHook {
  return {
    set(time) {
      const minutes = parseClockTime(String(time));
      if (minutes === undefined) throw new Error(`Expected a time such as "21:30", got ${time}`);
      client.fixTimeOfDay(minutes);
    },
    follow() {
      client.fixTimeOfDay(undefined);
    },
    speed(multiplier) {
      if (!(Number.isFinite(multiplier) && multiplier > 0)) {
        throw new Error(`Expected a positive number, got ${String(multiplier)}`);
      }
      client.setSpeed(multiplier);
    },
  };
}

/** Puts the hook on `window.livingDiorama.time`; returns a function that takes it off again. */
export function installTimeDevHook(client: SimulationClient): () => void {
  const hook = timeDevHook(client);
  window.livingDiorama = { ...window.livingDiorama, time: hook };
  return () => {
    if (window.livingDiorama?.time === hook) delete window.livingDiorama.time;
  };
}

// Kept apart from `protocol.ts`, which carries these events to the main thread, so that action
// contracts don't depend on the protocol and the protocol can name restore types without a cycle.

/**
 * Events an action emits about its creature (`ActionContext.emit`), without the tick and creature
 * ID, which the engine adds.
 */
export type ActionEvent =
  /**
   * A meal finished (ADR 0018 §17) at the placement. `hunger` is the creature's hunger after it.
   * An interrupted meal lowers hunger in part but emits nothing.
   */
  | { type: "ate"; placementId: string; hunger: number }
  /**
   * The creature fell asleep (ADR 0018 §13, §17), beside the shelter `placementId`, or where it
   * stood (null). `tiredness` is its tiredness then.
   */
  | { type: "fell_asleep"; placementId: string | null; tiredness: number }
  /**
   * The creature woke: `rested` when its sleep ended by itself, `interrupted` when something
   * more pressing (hunger) or the watchdog cut it short.
   */
  | { type: "woke_up"; reason: "rested" | "interrupted"; tiredness: number };

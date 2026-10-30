import type { SizeClass } from "@living-diorama/content-schema";
import type { LocomotionRule } from "@living-diorama/extension-api";
import type { CheckedLimits } from "@living-diorama/simulation";
import { useEffect, useState } from "react";
import type { LocomotionChoice } from "../body-plan";
import { limitHints } from "./hints";
import { keepTrying } from "./retry";

// Where a creature of a size and ways of moving won't fit in the world (ADR 0015 §8, ADR 0020 §12,
// ADR 0023 §14), asked of the strip and kept, for both of the Studio's modes.

export interface LimitsAnswer {
  /** Every limit, in the player's words, each said once. */
  hints: string[];
  /** The limit errors among them, which block a voxel creature's release (ADR 0023 §14). */
  errors: string[];
}

const NONE: LimitsAnswer = { hints: [], errors: [] };

/** The answer's hints and errors. */
export const limitsAnswer = ({ limits }: Pick<CheckedLimits, "limits">): LimitsAnswer => ({
  hints: limitHints(limits),
  errors: limitHints(limits.filter((limit) => limit.severity === "error")),
});

export type AskLimits = (
  sizeClass: SizeClass,
  locomotion: Pick<LocomotionChoice, "land" | "swim">,
) => Promise<CheckedLimits>;

/**
 * The limits for `sizeClass` (none while undefined) and the ways of moving, with the locomotion
 * rules of every way of moving asked about so far, which the preview plays (issue #136). The gait
 * doesn't change the limits, and the world doesn't change while the app runs, so each pairing is
 * asked once. An unanswered question (the strip still starting, say) is asked again, since the
 * preview's motion waits on the rules that come with the answer.
 */
export function useLimits(
  ask: AskLimits,
  sizeClass: SizeClass | undefined,
  { land, swim }: Pick<LocomotionChoice, "land" | "swim">,
): LimitsAnswer & { rules: Readonly<Record<string, LocomotionRule>> } {
  // By size and ways of moving: the navigation profile the limits are for.
  const [answers, setAnswers] = useState<ReadonlyMap<string, LimitsAnswer>>(new Map());
  const [rules, setRules] = useState<Readonly<Record<string, LocomotionRule>>>({});
  // Nothing to ask with no way of moving or no size; no limits are shown then.
  const key =
    (land || swim) && sizeClass !== undefined
      ? `${sizeClass}:${land ? "land" : ""}:${swim ? "swim" : ""}`
      : undefined;
  const known = key !== undefined && answers.has(key);
  useEffect(() => {
    if (key === undefined || sizeClass === undefined || known) return;
    const stop = keepTrying(
      () =>
        ask(sizeClass, { land, swim }).then((checked) => {
          setRules((kept) => ({ ...kept, ...checked.locomotion }));
          // Kept even when no longer shown: the world doesn't change while the app runs.
          setAnswers((kept) => new Map(kept).set(key, limitsAnswer(checked)));
        }),
      (error: unknown) => console.warn(`Could not check the limits for ${key}`, error),
    );
    return stop;
  }, [ask, key, known, sizeClass, land, swim]);
  return { ...((key !== undefined && answers.get(key)) || NONE), rules };
}

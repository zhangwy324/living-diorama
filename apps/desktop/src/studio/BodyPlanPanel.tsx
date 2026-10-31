import { LAND_GAITS } from "@living-diorama/content-schema";
import type { Ref } from "react";
import type { LocomotionChoice } from "../body-plan";
import { GAIT_LABELS, planHeading, type PreviewMode } from "./body-plan-view";

// The confirm step between building and Release (ADR 0020 §12, ADR 0023 §2): where the creature
// can move and how it moves on land, and which way the preview plays. A voxel body's anchors come
// from its cubes, so there are no points to place.

export function BodyPlanPanel({
  headingRef,
  ...props
}: {
  name: string;
  locomotion: LocomotionChoice;
  onLocomotion(locomotion: LocomotionChoice): void;
  /** The ways of moving the preview can play, and the one it plays. */
  modes: readonly PreviewMode[];
  mode: PreviewMode["key"] | undefined;
  onMode(mode: PreviewMode["key"]): void;
  hints: readonly string[];
  /** The heading, which takes the focus when the step opens. */
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const { locomotion } = props;
  const set = (change: Partial<LocomotionChoice>) =>
    props.onLocomotion({ ...locomotion, ...change });
  return (
    <div className="body-plan">
      <h2 ref={headingRef} tabIndex={-1}>
        {planHeading(props.name)}
      </h2>
      <fieldset className="field locomotion">
        <legend>Moves</legend>
        <div className="locomotion-row">
          <label className="toggle">
            <input
              type="checkbox"
              checked={locomotion.land}
              onChange={(event) => set({ land: event.target.checked })}
            />
            <span>On land</span>
          </label>
          <span className="gaits" role="radiogroup" aria-label="On land it">
            {LAND_GAITS.map((gait) => (
              <label key={gait}>
                <input
                  type="radio"
                  name="gait"
                  value={gait}
                  checked={locomotion.gait === gait}
                  disabled={!locomotion.land}
                  onChange={() => set({ gait })}
                />
                <span>{GAIT_LABELS[gait]}</span>
              </label>
            ))}
          </span>
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={locomotion.swim}
            onChange={(event) => set({ swim: event.target.checked })}
          />
          <span>Swims</span>
        </label>
      </fieldset>
      {props.modes.length > 1 && (
        <fieldset className="field preview-modes">
          <legend>Preview</legend>
          {props.modes.map((mode) => (
            <label key={mode.key}>
              <input
                type="radio"
                name="preview-mode"
                value={mode.key}
                checked={(props.mode ?? props.modes[0]?.key) === mode.key}
                onChange={() => props.onMode(mode.key)}
              />
              <span>{mode.label}</span>
            </label>
          ))}
        </fieldset>
      )}
      {props.hints.length > 0 && (
        <ul className="hints" aria-label="Hints" aria-live="polite">
          {props.hints.map((hint) => (
            <li key={hint}>{hint}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

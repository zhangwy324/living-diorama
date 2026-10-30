import {
  DRAWING_SIZE,
  LAND_GAITS,
  defaultAnchor,
  type Anchor,
  type AnchorName,
  type DrawingBounds,
} from "@living-diorama/content-schema";
import type { Ref } from "react";
import { planAnchors, type BodyPlanChoice, type LocomotionChoice } from "../body-plan";
import {
  ANCHOR_LABELS,
  GAIT_LABELS,
  anchorNote,
  anchorWord,
  drawingPoint,
  planHeading,
  type PreviewMode,
} from "./body-plan-view";

// The confirm step between drawing and Release (ADR 0020 §12): where the creature can move and how
// it moves on land, the points those ways of moving use, and which way the preview plays.

export function BodyPlanPanel({
  headingRef,
  ...props
}: {
  name: string;
  plan: BodyPlanChoice;
  onLocomotion(locomotion: LocomotionChoice): void;
  /**
   * Whether the points (anchors) are shown, true by default. A voxel body's are derived from its
   * cubes, so Build mode leaves them out (ADR 0023 §2).
   */
  showAnchors?: boolean;
  /** The point a click on the drawing places, when there is one. */
  placing: AnchorName | undefined;
  onPlacing(name: AnchorName): void;
  onResetAnchors(): void;
  /** The ways of moving the preview can play, and the one it plays. */
  modes: readonly PreviewMode[];
  mode: PreviewMode["key"] | undefined;
  onMode(mode: PreviewMode["key"]): void;
  hints: readonly string[];
  /** The heading, which takes the focus when the step opens. */
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const { plan } = props;
  const { locomotion } = plan;
  const anchors = props.showAnchors === false ? [] : planAnchors(locomotion);
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
      {anchors.length > 0 && (
        <fieldset className="field anchors">
          <legend>Points</legend>
          {anchors.map((name) => {
            const only = anchors.length === 1;
            const help = (
              <>
                <strong id={`anchor-name-${name}`}>{ANCHOR_LABELS[name].name}</strong>
                <span id={`anchor-help-${name}`}>
                  : {ANCHOR_LABELS[name].help}.{" "}
                  {plan.anchors[name]
                    ? "Placed."
                    : `At its default${only ? "; click the drawing to place it" : ""}.`}
                </span>
              </>
            );
            // With two points, each is a choice of which one a click places.
            return only ? (
              <p key={name} className="anchor-help">
                {help}
              </p>
            ) : (
              <label key={name} className="anchor-choice">
                <input
                  type="radio"
                  name="placing"
                  value={name}
                  checked={props.placing === name}
                  aria-labelledby={`anchor-name-${name}`}
                  aria-describedby={`anchor-help-${name}`}
                  onChange={() => props.onPlacing(name)}
                />
                <span className="anchor-help">{help}</span>
              </label>
            );
          })}
          <button
            type="button"
            className="reset-anchors"
            disabled={anchors.every((name) => !plan.anchors[name])}
            onClick={props.onResetAnchors}
          >
            Reset to default
          </button>
        </fieldset>
      )}
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

/**
 * Over the drawing in the confirm step: the anchors the ways of moving use, as markers placed or
 * at their defaults, and clicks that place `placing`. Covers the canvas, so nothing is drawn
 * meanwhile.
 */
export function AnchorLayer(props: {
  plan: BodyPlanChoice;
  /** The drawn shape's bounds, for the default positions. */
  bounds: DrawingBounds | undefined;
  /** The anchor a click places; undefined with no way of moving. */
  placing: AnchorName | undefined;
  onPlace(name: AnchorName, point: Anchor): void;
}) {
  const anchors = planAnchors(props.plan.locomotion);
  const { bounds, placing } = props;
  return (
    <div
      className={placing ? "anchor-layer placing" : "anchor-layer"}
      role="group"
      aria-label="Points on the drawing"
      aria-describedby="anchor-note"
      onClick={(event) => {
        if (!placing) return;
        const box = event.currentTarget.getBoundingClientRect();
        props.onPlace(placing, drawingPoint(event.clientX, event.clientY, box));
      }}
    >
      {bounds &&
        anchors.map((name) => {
          const placed = props.plan.anchors[name];
          const at = placed ?? defaultAnchor(name, bounds);
          // With two points, the one a click doesn't place is dimmed.
          const classes = [
            "anchor-marker",
            placed ? "placed" : "",
            anchors.length > 1 && name !== placing ? "inactive" : "",
          ];
          return (
            <span
              key={name}
              className={classes.filter(Boolean).join(" ")}
              style={{
                left: `${(at.x / DRAWING_SIZE) * 100}%`,
                top: `${(at.y / DRAWING_SIZE) * 100}%`,
              }}
            >
              <span className="anchor-label">
                {ANCHOR_LABELS[name].name}
                {placed ? "" : " (default)"}
              </span>
            </span>
          );
        })}
      <span id="anchor-note" className="visually-hidden">
        {anchorNote(props.plan, placing)}
      </span>
      <span className="anchor-guide" aria-hidden="true">
        {placing
          ? `Click to ${props.plan.anchors[placing] ? "move" : "place"} the ${anchorWord(placing)}`
          : "Drawing locked while you choose how it moves"}
      </span>
    </div>
  );
}

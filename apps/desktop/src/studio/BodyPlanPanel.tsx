import {
  BODY_TEMPLATES,
  DRAWING_SIZE,
  LAND_GAITS,
  defaultAnchor,
  type Anchor,
  type AnchorName,
  type BodyTemplate,
  type DrawingBounds,
} from "@living-diorama/content-schema";
import type { ReactNode, Ref } from "react";
import { templateAnchors, type BodyPlanChoice, type LocomotionChoice } from "../body-plan";
import {
  ANCHOR_LABELS,
  GAIT_LABELS,
  TEMPLATE_LABELS,
  anchorNote,
  drawingPoint,
  planHeading,
  type PreviewMode,
} from "./body-plan-view";

// The confirm step between drawing and Release (ADR 0020 §12): the template, where the creature
// can move and how it moves on land, its anchors, and which way of moving the preview plays.

/** Small pictures of each template, in the toolbar's 16-unit icon style. */
const TEMPLATE_ICONS: Readonly<Record<BodyTemplate, ReactNode>> = {
  walker: (
    <>
      <ellipse cx="8" cy="7" rx="5" ry="3.6" />
      <path className="stroke" d="M5.5 10.3v3M10.5 10.3v3" />
    </>
  ),
  hopper: (
    <>
      <ellipse cx="9" cy="6" rx="4.2" ry="3.4" />
      <path className="stroke" d="M2 14q2-5 4-1q2-4 4 0" />
    </>
  ),
  swimmer: (
    <>
      <path d="M2.5 8q4-4.5 9 0q-5 4.5-9 0z" />
      <path d="M11 8l3.5-2.5v5z" />
    </>
  ),
};

export function BodyPlanPanel({
  headingRef,
  ...props
}: {
  name: string;
  plan: BodyPlanChoice;
  onTemplate(template: BodyTemplate): void;
  onLocomotion(locomotion: LocomotionChoice): void;
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
  const anchors = templateAnchors(plan.template);
  const set = (change: Partial<LocomotionChoice>) =>
    props.onLocomotion({ ...locomotion, ...change });
  return (
    <div className="body-plan">
      <h2 ref={headingRef} tabIndex={-1}>
        {planHeading(props.name)}
      </h2>
      <fieldset className="field templates">
        <legend>Body</legend>
        {BODY_TEMPLATES.map((template) => (
          <label key={template} title={TEMPLATE_LABELS[template].blurb}>
            <input
              type="radio"
              name="template"
              value={template}
              checked={plan.template === template}
              onChange={() => props.onTemplate(template)}
            />
            <span className="template-card">
              <svg viewBox="0 0 16 16" width="22" height="22" aria-hidden="true">
                {TEMPLATE_ICONS[template]}
              </svg>
              <span>{TEMPLATE_LABELS[template].name}</span>
            </span>
          </label>
        ))}
      </fieldset>
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
      <div className="field anchors">
        <span>Points</span>
        {anchors.map((name) => (
          <p key={name} className="anchor-help">
            <strong>{ANCHOR_LABELS[name].name}</strong>: {ANCHOR_LABELS[name].help}.{" "}
            {plan.anchors[name]
              ? "Placed."
              : `Click the drawing to place ${ANCHOR_LABELS[name].them}.`}
          </p>
        ))}
        <button
          type="button"
          className="reset-anchors"
          disabled={anchors.every((name) => !plan.anchors[name])}
          onClick={props.onResetAnchors}
        >
          Reset to default
        </button>
      </div>
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
 * Over the drawing in the confirm step: the template's anchors as markers, placed or at their
 * defaults, and clicks that place them. Covers the canvas, so nothing is drawn meanwhile.
 */
export function AnchorLayer(props: {
  plan: BodyPlanChoice;
  /** The drawn shape's bounds, for the default positions. */
  bounds: DrawingBounds | undefined;
  onPlace(name: AnchorName, point: Anchor): void;
}) {
  const anchors = templateAnchors(props.plan.template);
  // A template has one anchor for now; a click places the first.
  const placing = anchors[0];
  const { bounds } = props;
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
          return (
            <span
              key={name}
              className={placed ? "anchor-marker placed" : "anchor-marker"}
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
        {anchorNote(props.plan)}
      </span>
      <span className="anchor-guide" aria-hidden="true">
        {placing
          ? `Click to ${props.plan.anchors[placing] ? "move" : "place"} the ${ANCHOR_LABELS[placing].name.toLowerCase()}`
          : "Drawing locked while you choose how it moves"}
      </span>
    </div>
  );
}

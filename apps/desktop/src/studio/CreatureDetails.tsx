import type { SizeClass } from "@living-diorama/content-schema";

// The creature's name and size, and the hints, beside the preview (roadmap M11 tasks 4 and 5,
// ADR 0017 §11). The size is measured from its cubes (ADR 0022 §3), so it is shown, not picked.

/** The reroll button's label and tooltip. */
export const SUGGEST_NAME_LABEL = "Suggest another name";

/** The size readout for a voxel creature larger than every size class. */
export const TOO_BIG_SIZE = "Too big";

const sizeLabel = (size: SizeClass) => size.charAt(0).toUpperCase() + size.slice(1);

export function CreatureDetails(props: {
  name: string;
  placeholder: string;
  onName(name: string): void;
  /** Replaces the name, typed or suggested, with a new suggestion. */
  onSuggestName(): void;
  /** The size measured from its cubes; none when it is too large for every size class. */
  sizeClass: SizeClass | undefined;
  /** What the size is measured from, e.g. "32 cm tall". */
  measured?: string | undefined;
  hints: readonly string[];
}) {
  return (
    <div className="creature-details">
      <label className="field">
        <span>Name</span>
        <span className="name-row">
          <input
            type="text"
            value={props.name}
            placeholder={props.placeholder}
            maxLength={40}
            spellCheck={false}
            onChange={(event) => props.onName(event.target.value)}
          />
          <button
            type="button"
            className="suggest-name"
            title={SUGGEST_NAME_LABEL}
            aria-label={SUGGEST_NAME_LABEL}
            onClick={props.onSuggestName}
          >
            {/* A die showing five. */}
            <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
              <rect
                x="2"
                y="2"
                width="12"
                height="12"
                rx="2.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
              />
              <circle cx="5.5" cy="5.5" r="1.1" />
              <circle cx="10.5" cy="5.5" r="1.1" />
              <circle cx="8" cy="8" r="1.1" />
              <circle cx="5.5" cy="10.5" r="1.1" />
              <circle cx="10.5" cy="10.5" r="1.1" />
            </svg>
          </button>
        </span>
      </label>
      <p className="field size-readout" aria-live="polite">
        <span>Size</span>
        <span>
          <strong>{props.sizeClass ? sizeLabel(props.sizeClass) : TOO_BIG_SIZE}</strong>
          {props.measured && <span className="measured"> · {props.measured}</span>}
        </span>
      </p>
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

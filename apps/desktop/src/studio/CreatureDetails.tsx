import { BODY_THICKNESS, SIZE_CLASSES, type SizeClass } from "@living-diorama/content-schema";

// The creature's name, size and thickness, and the hints, beside the preview (roadmap M11 tasks 4
// and 5, ADR 0017 §11).

export const SIZES = Object.keys(SIZE_CLASSES) as SizeClass[];

/** A new drawing's size: the mossling's, the size the built-in world is made for. */
export const DEFAULT_SIZE_CLASS: SizeClass = "medium";

/** The thickness slider works in whole percent of the height, in steps of this many. */
export const THICKNESS_STEP_PERCENT = 5;

const percent = (share: number) => Math.round(share * 100);

/** "40% of the height": what the slider shows and says. */
export const thicknessLabel = (thickness: number) => `${percent(thickness)}% of the height`;

const sizeLabel = (size: SizeClass) => size.charAt(0).toUpperCase() + size.slice(1);

export function CreatureDetails(props: {
  name: string;
  placeholder: string;
  onName(name: string): void;
  sizeClass: SizeClass;
  onSizeClass(size: SizeClass): void;
  /** Depth as a share of the height. */
  thickness: number;
  onThickness(thickness: number): void;
  hints: readonly string[];
}) {
  return (
    <div className="creature-details">
      <label className="field">
        <span>Name</span>
        <input
          type="text"
          value={props.name}
          placeholder={props.placeholder}
          maxLength={40}
          spellCheck={false}
          onChange={(event) => props.onName(event.target.value)}
        />
      </label>
      <fieldset className="field sizes">
        <legend>Size</legend>
        {SIZES.map((size) => (
          <label key={size} title={`${Math.round(SIZE_CLASSES[size].height * 100)} cm tall`}>
            <input
              type="radio"
              name="size"
              value={size}
              checked={props.sizeClass === size}
              onChange={() => props.onSizeClass(size)}
            />
            <span>{sizeLabel(size)}</span>
          </label>
        ))}
      </fieldset>
      <label className="field thickness">
        <span>Thickness</span>
        <span className="thickness-row">
          <input
            type="range"
            min={percent(BODY_THICKNESS.min)}
            max={percent(BODY_THICKNESS.max)}
            step={THICKNESS_STEP_PERCENT}
            value={percent(props.thickness)}
            aria-label="Thickness"
            aria-valuetext={thicknessLabel(props.thickness)}
            onChange={(event) => props.onThickness(Number(event.target.value) / 100)}
          />
          <output>{percent(props.thickness)}%</output>
        </span>
      </label>
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

import { SIZE_CLASSES, type SizeClass } from "@living-diorama/content-schema";

// The creature's name and size, and the hints, beside the preview (roadmap M11 tasks 4 and 5).

export const SIZES = Object.keys(SIZE_CLASSES) as SizeClass[];

/** A new drawing's size: the mossling's, the size the built-in world is made for. */
export const DEFAULT_SIZE_CLASS: SizeClass = "medium";

/** "Creature N", N one more than the species in the library; names needn't be unique. */
export const defaultName = (speciesInLibrary: number) => `Creature ${speciesInLibrary + 1}`;

const sizeLabel = (size: SizeClass) => size.charAt(0).toUpperCase() + size.slice(1);

export function CreatureDetails(props: {
  name: string;
  placeholder: string;
  onName(name: string): void;
  sizeClass: SizeClass;
  onSizeClass(size: SizeClass): void;
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

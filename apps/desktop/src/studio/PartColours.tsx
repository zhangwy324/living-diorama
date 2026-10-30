import { useEffect, useRef } from "react";

// Recolouring the selected part (ADR 0023 §11, §12): its colour slots as swatches, one chosen,
// then the packs' suggested colours or any colour from the picker for it.

export function PartColours(props: {
  /** The part's colours, one per slot. */
  colors: readonly string[];
  /** The slot being recoloured. */
  slot: number;
  onSlot(slot: number): void;
  /** The suggested colours, lower-case `#rrggbb`. */
  suggested: readonly string[];
  /**
   * Sets the chosen slot's colour; `live` while the picker moves, so a run of them can be one undo
   * step.
   */
  onColor(color: string, live: boolean): void;
  /** The picker closed: its run of live colours is over. */
  onColorDone(): void;
}) {
  const { colors, slot, onColorDone } = props;
  const current = colors[slot]?.toLowerCase();
  // React's onChange is the input event; the change event comes once, when the picker closes.
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const element = picker.current;
    if (!element) return;
    element.addEventListener("change", onColorDone);
    return () => element.removeEventListener("change", onColorDone);
  }, [onColorDone]);

  return (
    <section className="part-colours" aria-labelledby="part-colours-heading">
      <h3 id="part-colours-heading">Colours</h3>
      {colors.length > 1 && (
        <div className="palette colour-slots" role="group" aria-label="Its colours">
          {colors.map((color, i) => (
            <button
              // Slots are fixed for a part, so the index is the slot's identity.
              key={i}
              type="button"
              className="swatch"
              title={`Colour ${i + 1}`}
              aria-label={`Colour ${i + 1}, ${color}`}
              aria-pressed={i === slot}
              style={{ background: color }}
              onClick={() => props.onSlot(i)}
            />
          ))}
        </div>
      )}
      <div className="palette suggested-colours" role="group" aria-label="Suggested colours">
        {props.suggested.map((color) => (
          <button
            key={color}
            type="button"
            className="swatch"
            title={color}
            aria-label={`Use ${color}`}
            aria-pressed={color === current}
            style={{ background: color }}
            onClick={() => props.onColor(color, false)}
          />
        ))}
      </div>
      <label className="colour-picker">
        <input
          ref={picker}
          type="color"
          value={current ?? "#000000"}
          onChange={(event) => props.onColor(event.target.value, true)}
        />
        <span>Any colour…</span>
      </label>
    </section>
  );
}

import type { Stroke } from "@living-diorama/content-schema";

/** What the next stroke is drawn with. */
export interface Brush {
  tool: Stroke["tool"];
  color: string;
  /** Width in canvas units at full pressure. */
  width: number;
}

const round = (value: number, digits: number) => Number(value.toFixed(digits));

/**
 * A stroke being drawn. A pen's pressure is stored as reported; any other pointer draws at full
 * pressure, the brush's whole width (ADR 0015 §11).
 */
export class LiveStroke {
  readonly stroke: Stroke;
  private last?: { x: number; y: number };

  constructor(
    brush: Brush,
    private readonly pen: boolean,
  ) {
    this.stroke = { ...brush, points: [] };
  }

  /**
   * Adds a sample in canvas units with the pressure the pointer reported. Skips a sample at the
   * same place as the last one.
   */
  add(x: number, y: number, reportedPressure: number): void {
    x = round(x, 2);
    y = round(y, 2);
    if (this.last?.x === x && this.last.y === y) return;
    const pressure = this.pen ? Math.min(1, Math.max(0, reportedPressure)) : 1;
    this.stroke.points.push(x, y, round(pressure, 3));
    this.last = { x, y };
  }
}

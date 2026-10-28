import type { Stroke } from "@living-diorama/content-schema";

/** What the next stroke is drawn with. */
export interface Brush {
  tool: Stroke["tool"];
  color: string;
  /** Width in canvas units at full pressure. */
  width: number;
}

/**
 * Pressure from speed, for pointers that report none worth using (ADR 0015 §11): it eases towards
 * a target that falls from 1 when the pointer moves slowly to `floor` at `fastSpeed` and above, so
 * quick flicks taper like a brush.
 */
export const SPEED_PRESSURE = {
  floor: 0.35,
  /** Canvas units per millisecond: about 3.5 CSS px/ms with the canvas 600 px wide. */
  fastSpeed: 1.5,
  /** How quickly the pressure follows the target. */
  easeMs: 50,
};

/** The pressure after moving `distance` canvas units in `ms` milliseconds at `previous`. */
export function speedPressure(previous: number, distance: number, ms: number): number {
  if (ms <= 0) return previous;
  const { floor, fastSpeed, easeMs } = SPEED_PRESSURE;
  const target = 1 - (1 - floor) * Math.min(1, distance / ms / fastSpeed);
  return previous + (target - previous) * (1 - Math.exp(-ms / easeMs));
}

const round = (value: number, digits: number) => Number(value.toFixed(digits));

/**
 * A stroke being drawn. A pen's pressure is stored as reported; any other pointer's is derived
 * from its speed, so replaying the stroke never needs to know what drew it.
 */
export class LiveStroke {
  readonly stroke: Stroke;
  private last?: { x: number; y: number; time: number; pressure: number };

  constructor(
    brush: Brush,
    private readonly pen: boolean,
  ) {
    this.stroke = { ...brush, points: [] };
  }

  /**
   * Adds a sample in canvas units at `time` (ms), with the pressure the pointer reported. Skips a
   * sample at the same place as the last one.
   */
  add(x: number, y: number, time: number, reportedPressure: number): void {
    x = round(x, 2);
    y = round(y, 2);
    const last = this.last;
    if (last && last.x === x && last.y === y) return;
    const pressure = this.pen
      ? Math.min(1, Math.max(0, reportedPressure))
      : last
        ? speedPressure(last.pressure, Math.hypot(x - last.x, y - last.y), time - last.time)
        : 1;
    this.stroke.points.push(x, y, round(pressure, 3));
    this.last = { x, y, time, pressure };
  }
}

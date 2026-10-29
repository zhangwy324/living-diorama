/** A deep copy of plain data: arrays, plain objects and primitives (behavior memory, saves). */
export function clonePlain<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clonePlain) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, clonePlain(v as unknown)]),
    ) as T;
  }
  return value;
}

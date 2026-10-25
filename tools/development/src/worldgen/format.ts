// Pretty-prints a generated world for readable diffs: two-space JSON, except that the big
// per-sample arrays (heights, material indices) are written one terrain row per line.

const GRID_KEYS = new Set(["heights", "values"]);

export function formatWorldJson(world: { terrain: { heightfield: { columns: number } } }): string {
  const columns = world.terrain.heightfield.columns;
  const grids: number[][] = [];
  const json = JSON.stringify(
    world,
    (key, value: unknown) => {
      if (!GRID_KEYS.has(key) || !Array.isArray(value)) return value;
      grids.push(value as number[]);
      return `@@grid-${grids.length - 1}@@`;
    },
    2,
  );
  const expanded = json.replace(
    /^( *)("\w+": )"@@grid-(\d+)@@"/gm,
    (_, indent: string, key: string, index: string) => {
      const values = grids[Number(index)] ?? [];
      const rows: string[] = [];
      for (let k = 0; k < values.length; k += columns) {
        rows.push(`${indent}  ${values.slice(k, k + columns).join(",")}`);
      }
      return `${indent}${key}[\n${rows.join(",\n")}\n${indent}]`;
    },
  );
  return `${expanded}\n`;
}

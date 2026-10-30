import {
  allConnections,
  allRegions,
  error,
  WORLD_TOLERANCES,
  type AppliedWorldEdit,
  type AppliedWorldEditOp,
  type Diagnostic,
  type PropPlacement,
  type Result,
  type Vec2,
  type WorldBounds,
  type WorldDefinition,
  type WorldEdit,
} from "@living-diorama/content-schema";

// Applying a world edit to a world definition (ADR 0021 §1, §2, §5, §10, §11): a pure function
// from one definition to the next, with the checks only the world can answer (the placements
// exist, a new placement's ID is free, its prop type is registered, its footprint lies inside the
// world) and the inverse edit. The shape of the edit was checked by `parseWorldEdit`. Rebuilding
// what derives from the world, and reconciling creatures with it, is the simulation's
// (`runtime/world-edit.ts`).

/** What applying an edit needs to know beyond the world definition. */
export interface EditEnvironment {
  /** A registered prop type's block radius at scale 1, or undefined if it isn't registered. */
  blockRadius(propId: string): number | undefined;
  /** The ground's height at (x, z), which a prop is put on (§5). */
  groundHeight(x: number, z: number): number;
}

/** A world definition after an edit, and how to undo it. */
export interface EditedWorld {
  world: WorldDefinition;
  /** Each op's inverse, in reverse order; exact up to the ground snap. */
  inverse: AppliedWorldEdit;
  /** Placements the edit added and still has, in the order first named. One removed and added
   * back under the same ID counts as changed, not added. */
  added: string[];
  /**
   * Placements that were there before and that it moved or scaled, and still has. One only turned
   * isn't listed: its footprint and spots stay where they were.
   */
  changed: string[];
  /** Placements that were there before and that it removed. */
  removed: string[];
}

/** Generated placement IDs are `prop-<n>`. */
const GENERATED_PREFIX = "prop-";

/** Every local ID a world uses: they share one namespace (`WorldDefinitionSchema`). */
export function localIds(world: WorldDefinition): Set<string> {
  return new Set([
    ...allRegions(world).map((r) => r.id),
    ...allConnections(world).map((c) => c.id),
    ...world.structures.map((s) => s.id),
    ...world.props.map((p) => p.id),
    ...world.spawnPoints.map((s) => s.id),
  ]);
}

/**
 * Gives every `prop.add` without an ID a generated one (§2): `prop-<n>` from the counter `next`
 * up, skipping any ID the world uses or the edit names. Returns the edit as applied and the
 * counter after it. Deterministic, and changes neither argument.
 */
export function assignPlacementIds(
  world: WorldDefinition,
  edit: WorldEdit,
  next: number,
): { edit: AppliedWorldEdit; next: number } {
  const taken = localIds(world);
  for (const op of edit.ops) if (op.id !== undefined) taken.add(op.id);
  let counter = next;
  const ops = edit.ops.map((op): AppliedWorldEditOp => {
    if (op.op !== "prop.add" || op.id !== undefined) return { ...op } as AppliedWorldEditOp;
    let id = `${GENERATED_PREFIX}${counter++}`;
    while (taken.has(id)) id = `${GENERATED_PREFIX}${counter++}`;
    taken.add(id);
    return { ...op, id };
  });
  return { edit: { ops }, next: counter };
}

/** Whether a circle lies inside the world's bounds, horizontally. False for non-finite input. */
function insideBounds({ min, max }: WorldBounds, center: Vec2, radius: number): boolean {
  const eps = WORLD_TOLERANCES.positionEpsilon;
  return (
    center.x - radius >= min.x - eps &&
    center.x + radius <= max.x + eps &&
    center.z - radius >= min.z - eps &&
    center.z + radius <= max.z + eps
  );
}

/**
 * Applies an edit whose adds all name their placement (`assignPlacementIds`), op by op, all or
 * nothing (§1). Fails with diagnostics whose paths point into the edit when an op names a
 * placement the world doesn't have at that point, adds one under an ID in use or of a prop type
 * not registered, or would leave a footprint (block radius × scale around the position) outside
 * the world's bounds, or a scale that isn't above 0. A placement it adds or moves stands on the
 * ground (§5). Changes neither argument.
 */
export function applyWorldEdit(
  world: WorldDefinition,
  edit: AppliedWorldEdit,
  env: EditEnvironment,
): Result<EditedWorld> {
  const props: PropPlacement[] = [...world.props];
  const before = new Set(world.props.map((p) => p.id));
  const others = localIds({ ...world, props: [] });
  const diagnostics: Diagnostic[] = [];
  const inverse: AppliedWorldEditOp[] = [];
  const touched: string[] = [];
  const fail = (code: string, message: string, path: (string | number)[]) =>
    diagnostics.push(error(code, message, path, "world edit"));
  const indexOf = (id: string) => props.findIndex((p) => p.id === id);
  const fits = (prop: string, position: Vec2, scale: number) =>
    insideBounds(world.bounds, position, (env.blockRadius(prop) ?? 0) * scale);
  const placed = (x: number, z: number) => ({ x, y: env.groundHeight(x, z), z });

  edit.ops.forEach((op, index) => {
    const at = (field: string) => ["ops", index, field];
    const count = diagnostics.length;
    if (op.op === "prop.add") {
      if (others.has(op.id) || indexOf(op.id) !== -1) {
        fail("placement_id_in_use", `The ID "${op.id}" is already in use`, at("id"));
      }
      if (env.blockRadius(op.prop) === undefined) {
        fail("unknown_prop", `Prop type "${op.prop}" is not registered`, at("prop"));
      }
      if (!(op.scale > 0))
        fail("invalid_scale", "A prop's scale must be greater than 0", at("scale"));
      else if (!fits(op.prop, op.position, op.scale)) {
        fail("outside_world", `Prop "${op.id}" would reach outside the world`, at("position"));
      }
      if (diagnostics.length > count) return;
      const { x, z } = op.position;
      props.push({
        id: op.id,
        prop: op.prop,
        transform: { position: placed(x, z), rotationY: op.rotationY, scale: op.scale },
      });
      inverse.push({ op: "prop.remove", id: op.id });
      touched.push(op.id);
      return;
    }
    const k = indexOf(op.id);
    const placement = props[k];
    if (!placement) {
      fail("unknown_placement", `There is no prop "${op.id}"`, at("id"));
      return;
    }
    const { position, rotationY, scale } = placement.transform;
    switch (op.op) {
      case "prop.remove":
        props.splice(k, 1);
        inverse.push({
          op: "prop.add",
          id: op.id,
          prop: placement.prop,
          position: { x: position.x, z: position.z },
          rotationY,
          scale,
        });
        break;
      case "prop.move": {
        const to = op.position ?? position;
        if (op.position && !fits(placement.prop, to, scale)) {
          fail("outside_world", `Prop "${op.id}" would reach outside the world`, at("position"));
          return;
        }
        props[k] = {
          ...placement,
          transform: {
            position: placed(to.x, to.z),
            rotationY: op.rotationY ?? rotationY,
            scale,
          },
        };
        inverse.push({
          op: "prop.move",
          id: op.id,
          ...(op.position && { position: { x: position.x, z: position.z } }),
          ...(op.rotationY !== undefined && { rotationY }),
        });
        // A turn alone leaves the footprint and every spot where they were (spots don't depend on
        // a prop's rotation), so only a move counts as changing the placement.
        if (op.position) touched.push(op.id);
        break;
      }
      case "prop.scale":
        if (!(op.scale > 0)) {
          fail("invalid_scale", "A prop's scale must be greater than 0", at("scale"));
          return;
        }
        if (!fits(placement.prop, position, op.scale)) {
          fail("outside_world", `Prop "${op.id}" would reach outside the world`, at("scale"));
          return;
        }
        props[k] = { ...placement, transform: { ...placement.transform, scale: op.scale } };
        inverse.push({ op: "prop.scale", id: op.id, scale });
        touched.push(op.id);
        break;
      default: {
        const kind = (op as { op: unknown }).op;
        fail("unknown_edit_op", `Unknown edit op "${String(kind)}"`, at("op"));
      }
    }
  });
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const after = new Set(props.map((p) => p.id));
  const unique = [...new Set(touched)].filter((id) => after.has(id));
  return {
    ok: true,
    value: {
      world: { ...world, props },
      inverse: { ops: inverse.reverse() },
      added: unique.filter((id) => !before.has(id)),
      changed: unique.filter((id) => before.has(id)),
      removed: [...before].filter((id) => !after.has(id)),
    },
  };
}

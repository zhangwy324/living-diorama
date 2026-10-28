import {
  error,
  validate,
  type ConnectionDefinition,
  type Diagnostic,
  type RegionKind,
  type Result,
  type Transform,
  type Vec2,
  type WorldBounds,
  type WorldDefinition,
} from "@living-diorama/content-schema";
import type { Registries } from "@living-diorama/extension-api";
import { boxOf, type Box2 } from "./geometry";
import { isSurfaceProvider, type Surface } from "./surfaces";
import { Terrain } from "./terrain";

export interface RegionModel {
  id: string;
  kind: RegionKind;
  footprint: readonly Vec2[];
  box: Box2;
  surface: Surface;
  /** Placement ID of the structure that contributed this region, if any. */
  structureId?: string;
}

export interface ConnectionModel extends ConnectionDefinition {
  structureId?: string;
}

/** A prop placement resolved against its type (ADR 0018 §3). */
export interface PropModel {
  /** Placement ID. */
  id: string;
  /** Prop type ID. Engine code finds props by `affordances`, never by this. */
  prop: string;
  model: string;
  transform: Transform;
  /** In world metres: the type's block radius × `transform.scale`. */
  blockRadius: number;
  /**
   * Affordance → params as the type declares them, parsed by each affordance type's
   * `paramsSchema` (defaults applied), so engine code may read them typed: `core:food`'s are a
   * `FoodAffordanceParams`.
   */
  affordances: Readonly<Record<string, unknown>>;
}

/** A world definition with its terrain decoded, surfaces instantiated and props resolved. */
export interface WorldModel {
  definition: WorldDefinition;
  bounds: WorldBounds;
  terrain: Terrain;
  regions: ReadonlyMap<string, RegionModel>;
  connections: readonly ConnectionModel[];
  props: readonly PropModel[];
  /** Props by placement ID. */
  propsById: ReadonlyMap<string, PropModel>;
  /** Per affordance ID, the props offering it, in placement order, for perception (ADR 0018 §10). */
  propsByAffordance: ReadonlyMap<string, readonly PropModel[]>;
}

/** Builds the runtime model. Expects references to be resolved (`resolveReferences`) first. */
export function buildWorldModel(
  world: WorldDefinition,
  registries: Registries,
): Result<WorldModel> {
  const source = `worlds/${world.id}`;
  const diagnostics: Diagnostic[] = [];
  const terrain = Terrain.fromDefinition(world.terrain.heightfield, world.bounds);
  if (!terrain) {
    return {
      ok: false,
      diagnostics: [
        error(
          "unsupported_heightfield_source",
          "Only inline heightfields are supported so far",
          ["terrain", "heightfield", "source"],
          source,
        ),
      ],
    };
  }

  const regions = new Map<string, RegionModel>();
  const addRegion = (
    region: WorldDefinition["regions"][number],
    path: (string | number)[],
    structureId?: string,
  ) => {
    const type = registries.surfaces.get(region.surface.type);
    if (!type || !isSurfaceProvider(type)) {
      diagnostics.push(
        error(
          "no_surface_implementation",
          `Surface type "${region.surface.type}" has no simulation implementation`,
          [...path, "surface", "type"],
          source,
        ),
      );
      return;
    }
    regions.set(region.id, {
      id: region.id,
      kind: region.kind,
      footprint: region.footprint,
      box: boxOf(region.footprint),
      surface: type.create(region.surface.params, { terrain }),
      ...(structureId === undefined ? {} : { structureId }),
    });
  };
  world.regions.forEach((r, i) => addRegion(r, ["regions", i]));
  world.structures.forEach((s, si) =>
    s.regions.forEach((r, i) => addRegion(r, ["structures", si, "regions", i], s.id)),
  );
  const props: PropModel[] = [];
  world.props.forEach((placement, i) => {
    const type = registries.props.get(placement.prop);
    if (!type) {
      diagnostics.push(
        error(
          "unresolved_reference",
          `"${placement.prop}" is not registered in props`,
          ["props", i, "prop"],
          source,
        ),
      );
      return;
    }
    const affordances: Record<string, unknown> = {};
    for (const [id, params] of Object.entries(type.affordances)) {
      const schema = registries.affordances.get(id)?.paramsSchema;
      const parsed = schema && validate(schema, params);
      // References were resolved first, so the params were already checked against the schema.
      if (!parsed?.ok) throw new Error(`"${type.id}" has unchecked params for "${id}"`);
      affordances[id] = parsed.value;
    }
    props.push({
      id: placement.id,
      prop: type.id,
      model: type.model,
      transform: placement.transform,
      blockRadius: type.blockRadius * placement.transform.scale,
      affordances,
    });
  });
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const connections: ConnectionModel[] = [
    ...world.connections,
    ...world.structures.flatMap((s) => s.connections.map((c) => ({ ...c, structureId: s.id }))),
  ];
  return {
    ok: true,
    value: {
      definition: world,
      bounds: world.bounds,
      terrain,
      regions,
      connections,
      props,
      propsById: new Map(props.map((p) => [p.id, p])),
      propsByAffordance: indexByAffordance(props),
    },
  };
}

function indexByAffordance(props: readonly PropModel[]): Map<string, PropModel[]> {
  const index = new Map<string, PropModel[]>();
  for (const prop of props) {
    for (const id of Object.keys(prop.affordances)) {
      let list = index.get(id);
      if (!list) index.set(id, (list = []));
      list.push(prop);
    }
  }
  return index;
}

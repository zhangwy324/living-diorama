import {
  error,
  type ConnectionDefinition,
  type Diagnostic,
  type PropPlacement,
  type RegionKind,
  type Result,
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

/** A world definition with its terrain decoded and every region's surface instantiated. */
export interface WorldModel {
  definition: WorldDefinition;
  bounds: WorldBounds;
  terrain: Terrain;
  regions: ReadonlyMap<string, RegionModel>;
  connections: readonly ConnectionModel[];
  props: readonly PropPlacement[];
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
      props: world.props,
    },
  };
}

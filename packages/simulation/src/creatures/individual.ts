import type { SpeciesDefinition } from "@living-diorama/content-schema";
import type { NeedType, Registries } from "@living-diorama/extension-api";
import { Rng, type RngState } from "../runtime/rng";

// Individual state that comes from data (ADR 0018 §1, §4, §16 and amendments): which needs a
// creature has, its traits with defaults, and the variation drawn once at spawn. Generic over
// whatever needs, senses and traits are registered; nothing here knows an ID.

/** Each individual's factors, drawn once at spawn, per need and per sense ID. */
export interface IndividualVariation {
  /** Scales both of the need's rates. */
  needs: Record<string, number>;
  /** Scales the sense's value. */
  senses: Record<string, number>;
}

/**
 * The needs a species' creatures have: those its behaviors declare as `needs` dependencies, in
 * the order first declared. A species with only `core:wander` has none.
 */
export function speciesNeeds(species: SpeciesDefinition, registries: Registries): NeedType[] {
  const needs: NeedType[] = [];
  for (const behaviorId of species.behaviors) {
    for (const dep of registries.behaviors.get(behaviorId)?.dependencies ?? []) {
      if (dep.registry !== "needs" || needs.some((n) => n.id === dep.id)) continue;
      const need = registries.needs.get(dep.id);
      if (need) needs.push(need);
    }
  }
  return needs;
}

/** Every registered trait: the species' value, or the registry default where it has none. */
export function speciesTraits(
  species: SpeciesDefinition,
  registries: Registries,
): Record<string, number> {
  return Object.fromEntries(
    registries.traits.values().map((t) => [t.id, species.traits[t.id] ?? t.default]),
  );
}

/**
 * Draws an individual: a variation factor in [1 − v, 1 + v] for each of its needs and senses
 * that declares `variation` (needs first, then senses, each in declaration order), then each
 * need's starting value, uniformly below its `startBelow` (default `actAt`, so spawned creatures
 * don't all act at once),
 * then the angle at which it stands beside a place it eats or sleeps at (ADR 0018 amendments, §11).
 * The draws come from the stream forked as `"individual"` off the creature's own stream, so they
 * never shift the sequence its behaviors see.
 */
export function drawIndividual(
  creatureRng: RngState,
  needs: readonly NeedType[],
  species: SpeciesDefinition,
  registries: Registries,
): { variation: IndividualVariation; needs: Record<string, number>; spotAngle: number } {
  const rng = new Rng(creatureRng).fork("individual");
  const variation: IndividualVariation = { needs: {}, senses: {} };
  for (const need of needs) {
    if (need.variation) variation.needs[need.id] = factor(rng, need.variation);
  }
  for (const id of Object.keys(species.senses)) {
    const v = registries.senses.get(id)?.variation;
    if (v) variation.senses[id] = factor(rng, v);
  }
  const values = Object.fromEntries(
    needs.map((n) => [n.id, rng.range(0, n.startBelow ?? n.actAt)]),
  );
  const spotAngle = rng.range(-Math.PI, Math.PI);
  return { variation, needs: values, spotAngle };
}

const factor = (rng: Rng, variation: number) => rng.range(1 - variation, 1 + variation);

export const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

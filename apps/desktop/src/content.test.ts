import { formatDiagnostic } from "@living-diorama/content-schema";
import { Simulation } from "@living-diorama/simulation";
import { expect, it } from "vitest";
import { loadContent } from "./content";
import { STARTUP } from "./startup";

it("loads content the startup world and creatures can run on", () => {
  const content = loadContent();
  if (!content.ok) throw new Error(content.diagnostics.map(formatDiagnostic).join("\n"));
  const created = Simulation.create(content.value, {
    worldId: STARTUP.worldId,
    seed: 1,
    tickRateHz: STARTUP.tickRateHz,
  });
  if (!created.ok) throw new Error(created.diagnostics.map(formatDiagnostic).join("\n"));
  for (const { speciesId, count } of STARTUP.creatures) {
    for (let i = 0; i < count; i++) expect(created.value.spawn(speciesId).ok).toBe(true);
  }
});

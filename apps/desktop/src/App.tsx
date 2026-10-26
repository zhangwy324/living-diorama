import { formatDiagnostic } from "@living-diorama/content-schema";
import { createDioramaView, type DioramaView } from "@living-diorama/renderer";
import { useEffect, useRef } from "react";
import { loadWorld } from "./load-world";
import { startSimulation } from "./simulation-client";

// Content is static for now, so it loads once at startup.
const { scene, assets, species, diagnostics } = loadWorld();

export function App() {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<DioramaView>(undefined);

  useEffect(() => {
    if (!scene || !container.current) return;
    const created = createDioramaView(container.current, scene, {
      resolveAsset: (ref) => assets?.get(ref),
      resolveSpecies: (id) => species?.get(id),
    });
    view.current = created;
    const stop = startSimulation((snapshot) => created.pushSnapshot(snapshot));
    return () => {
      stop();
      created.dispose();
    };
  }, []);

  if (!scene) {
    return (
      <main className="diagnostics">
        <h1>The world failed to load</h1>
        <ul>
          {diagnostics.map((d, i) => (
            <li key={i}>{formatDiagnostic(d)}</li>
          ))}
        </ul>
      </main>
    );
  }
  return (
    <main className="diorama" ref={container} onDoubleClick={() => view.current?.resetCamera()} />
  );
}

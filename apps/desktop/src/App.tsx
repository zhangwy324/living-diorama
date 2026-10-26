import { formatDiagnostic } from "@living-diorama/content-schema";
import { createDioramaView, type DioramaView } from "@living-diorama/renderer";
import { useEffect, useRef } from "react";
import { loadWorld } from "./load-world";
import { startSimulation } from "./simulation-client";

// Content is static for now, so it loads once at startup.
const { scene, navigation, assets, species, diagnostics } = loadWorld();

/** Toggles the debug overlays. M5's controls overlay will add a button for it. */
const DEBUG_KEY = "d";

export function App() {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<DioramaView>(undefined);

  useEffect(() => {
    if (!scene || !container.current) return;
    const created = createDioramaView(container.current, scene, {
      resolveAsset: (ref) => assets?.get(ref),
      resolveSpecies: (id) => species?.get(id),
      ...(navigation ? { navigation } : {}),
    });
    view.current = created;
    const simulation = startSimulation((snapshot) => created.pushSnapshot(snapshot));
    let debug = false;
    const onKeyDown = (event: KeyboardEvent) => {
      const modified = event.ctrlKey || event.altKey || event.metaKey || event.shiftKey;
      if (event.key.toLowerCase() !== DEBUG_KEY || modified || event.repeat) return;
      debug = !debug;
      created.setDebug(debug);
      simulation.setDebug(debug);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      simulation.stop();
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

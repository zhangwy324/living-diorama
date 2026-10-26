import { formatDiagnostic } from "@living-diorama/content-schema";
import { connectDesktopShell } from "@living-diorama/desktop-integration";
import { createDioramaView, type DioramaView } from "@living-diorama/renderer";
import { useEffect, useRef } from "react";
import { loadWorld } from "./load-world";
import { startSimulation } from "./simulation-client";
import { StripResizeHandle } from "./StripResizeHandle";

// Content is static for now, so it loads once at startup.
const { scene, navigation, assets, species, diagnostics } = loadWorld();
const shell = connectDesktopShell();

/**
 * Toggles the debug overlays. The strip never takes keyboard focus (ADR 0008 §6), so this only
 * works when the frontend runs in a browser; M5 PR C's controls overlay replaces it.
 */
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
    <div className="app">
      <main className="diorama" ref={container} onDoubleClick={() => view.current?.resetCamera()} />
      <StripResizeHandle shell={shell} />
    </div>
  );
}

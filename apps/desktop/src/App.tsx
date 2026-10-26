import { formatDiagnostic } from "@living-diorama/content-schema";
import { connectDesktopShell } from "@living-diorama/desktop-integration";
import { createDioramaView, type DioramaView } from "@living-diorama/renderer";
import { useEffect, useRef, useState } from "react";
import { ControlsOverlay } from "./ControlsOverlay";
import { loadWorld } from "./load-world";
import { startSimulation, type SimulationClient } from "./simulation-client";
import { StripResizeHandle } from "./StripResizeHandle";

// Content is static for now, so it loads once at startup.
const { scene, navigation, assets, species, diagnostics } = loadWorld();
const shell = connectDesktopShell();

export function App() {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<DioramaView>(undefined);
  const simulation = useRef<SimulationClient>(undefined);
  // The shell owns paused and expanded; these mirror its change events.
  const [paused, setPaused] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [debug, setDebug] = useState(false);

  useEffect(() => {
    if (!scene || !container.current) return;
    const created = createDioramaView(container.current, scene, {
      resolveAsset: (ref) => assets?.get(ref),
      resolveSpecies: (id) => species?.get(id),
      ...(navigation ? { navigation } : {}),
    });
    view.current = created;
    const client = startSimulation((snapshot) => created.pushSnapshot(snapshot));
    simulation.current = client;
    const stopListening = [
      shell.onPausedChanged((value) => {
        client.setPaused(value);
        setPaused(value);
      }),
      shell.onExpandedChanged(setExpanded),
      // Clean shutdown (ADR 0008 §14); the process exits next, so nothing is torn down twice.
      shell.onQuitRequested(() => {
        client.shutdown();
        created.dispose();
      }),
    ];
    return () => {
      for (const stop of stopListening) stop();
      client.stop();
      created.dispose();
    };
  }, []);

  const toggleDebug = () => {
    view.current?.setDebug(!debug);
    simulation.current?.setDebug(!debug);
    setDebug(!debug);
  };

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
      {/* The shell ignores height changes while expanded (ADR 0008 §8). */}
      {!expanded && <StripResizeHandle shell={shell} />}
      <ControlsOverlay
        paused={paused}
        expanded={expanded}
        debug={debug}
        onTogglePaused={() => void shell.setPaused(!paused)}
        onToggleExpanded={() => void shell.setExpanded(!expanded)}
        onResetCamera={() => view.current?.resetCamera()}
        onToggleDebug={toggleDebug}
        onHide={() => void shell.hide()}
      />
    </div>
  );
}

import { formatDiagnostic } from "@living-diorama/content-schema";
import { connectDesktopShell } from "@living-diorama/desktop-integration";
import { createDioramaView, type DioramaView } from "@living-diorama/renderer";
import { useEffect, useRef, useState } from "react";
import { ControlsOverlay } from "./ControlsOverlay";
import { ErrorScreen, type Failure } from "./ErrorScreen";
import { EventCounter } from "./event-counts";
import { loadWorld } from "./load-world";
import { startSimulation, type SimulationClient } from "./simulation-client";
import { StripResizeHandle } from "./StripResizeHandle";

// Content is static for now, so it loads once at startup.
const { scene, navigation, assets, species, diagnostics } = loadWorld();
const contentFailure: Failure | undefined = scene
  ? undefined
  : { summary: "The world failed to load", details: diagnostics.map(formatDiagnostic) };
const shell = connectDesktopShell();

export function App() {
  const container = useRef<HTMLDivElement>(null);
  // Set while the diorama runs; cleared when it stops, so nothing is torn down twice.
  const view = useRef<DioramaView>(undefined);
  const simulation = useRef<SimulationClient>(undefined);
  // The shell owns paused and expanded; these mirror its change events.
  const [paused, setPaused] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [debug, setDebug] = useState(false);
  const [failure, setFailure] = useState(contentFailure);

  // Every failure reaches the diagnostics log too (ADR 0009 §14).
  useEffect(() => {
    if (failure) console.error([failure.summary, ...failure.details].join("\n  "));
  }, [failure]);

  // Shell events matter on the error screen too: expanding shows the details, and Quit must answer.
  useEffect(() => {
    const stopListening = [
      shell.onPausedChanged((value) => {
        simulation.current?.setPaused(value);
        setPaused(value);
      }),
      shell.onExpandedChanged(setExpanded),
      // Clean shutdown (ADR 0008 §14); the process exits next.
      shell.onQuitRequested(() => {
        simulation.current?.shutdown();
        view.current?.dispose();
      }),
    ];
    return () => {
      for (const stop of stopListening) stop();
    };
  }, []);

  useEffect(() => {
    if (!scene || !container.current) return;
    let created: DioramaView;
    try {
      created = createDioramaView(container.current, scene, {
        resolveAsset: (ref) => assets?.get(ref),
        resolveSpecies: (id) => species?.get(id),
        ...(navigation ? { navigation } : {}),
      });
    } catch (error) {
      // The view needs the mounted container, so its failure is only known inside this effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFailure({ summary: "The 3D view could not start", details: [describeError(error)] });
      return;
    }
    // Recorded at start too, so the measuring script never reads a previous run's counts.
    const counter = new EventCounter();
    const recordCounts = () =>
      void shell
        .recordEventCounts(counter.counts)
        .catch((error: unknown) => console.warn("Could not record the event counts", error));
    recordCounts();
    const client = startSimulation({
      onSnapshot: (snapshot, events) => {
        created.pushSnapshot(snapshot);
        if (counter.observe(snapshot, events)) recordCounts();
      },
      onFailure: (details) => {
        stop();
        setFailure((current) => current ?? { summary: "The simulation stopped", details });
      },
    });
    view.current = created;
    simulation.current = client;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      view.current = undefined;
      simulation.current = undefined;
      client.stop();
      created.dispose();
    };
    return stop;
  }, []);

  const toggleDebug = () => {
    view.current?.setDebug(!debug);
    simulation.current?.setDebug(!debug);
    setDebug(!debug);
  };

  if (failure) {
    return (
      <ErrorScreen
        failure={failure}
        expanded={expanded}
        onShowDetails={() => void shell.setExpanded(true)}
      />
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

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

import { connectDesktopShell, connectLibraryStore } from "@living-diorama/desktop-integration";
import { createDioramaView, type DioramaView } from "@living-diorama/renderer";
import type { AssetSummary, SimulationSnapshot, SpeciesSummary } from "@living-diorama/simulation";
import { useEffect, useRef, useState } from "react";
import { ControlsOverlay } from "./ControlsOverlay";
import { ErrorScreen, type Failure } from "./ErrorScreen";
import { installLibraryDevHook } from "./dev-library";
import { EventCounter } from "./event-counts";
import { startSimulation, type SimulationClient } from "./simulation-client";
import { openSpeciesLibrary } from "./species-library";
import { StripResizeHandle } from "./StripResizeHandle";

const shell = connectDesktopShell();
const libraryStore = connectLibraryStore();

export function App() {
  const container = useRef<HTMLDivElement>(null);
  // Set while the diorama runs; cleared when it stops, so nothing is torn down twice.
  const view = useRef<DioramaView>(undefined);
  const simulation = useRef<SimulationClient>(undefined);
  // The shell owns paused and expanded; these mirror its change events.
  const [paused, setPaused] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [debug, setDebug] = useState(false);
  const [failure, setFailure] = useState<Failure>();

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

  // The worker loads and checks the content; the view starts once the worker describes the world.
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let created: DioramaView | undefined;
    // Recorded at start too, so the measuring script never reads a previous run's counts.
    const counter = new EventCounter();
    const recordCounts = () =>
      void shell
        .recordEventCounts(counter.counts)
        .catch((error: unknown) => console.warn("Could not record the event counts", error));
    recordCounts();
    const fail = (next: Failure) => {
      stop();
      setFailure((current) => current ?? next);
    };
    // What the renderer resolves; species registered while the world runs are added (ADR 0012).
    const assets = new Map<string, AssetSummary>();
    const species = new Map<string, SpeciesSummary>();
    let latest: SimulationSnapshot | undefined;
    // The library registers its species once the world is ready (ADR 0014 §8). Until the Studio
    // gives it a UI, development builds reach it from the console.
    const openLibrary = () =>
      void openSpeciesLibrary(libraryStore, {
        registerSpecies: client.registerSpecies,
        spawn: client.spawn,
        despawn: client.despawn,
        creatures: () => latest?.creatures ?? [],
      }).then((library) => {
        if (import.meta.env.DEV && !stopped) installLibraryDevHook(library);
      });
    const client = startSimulation({
      onReady: ({ scene, navigations, ...content }) => {
        for (const [id, asset] of Object.entries(content.assets)) assets.set(id, asset);
        for (const [id, summary] of Object.entries(content.species)) species.set(id, summary);
        const [navigation] = navigations;
        try {
          created = createDioramaView(element, scene, {
            resolveAsset: (ref) => assets.get(ref),
            resolveSpecies: (id) => species.get(id),
            ...(navigation ? { navigation } : {}),
          });
        } catch (error) {
          fail({ summary: "The 3D view could not start", details: [describeError(error)] });
          return;
        }
        view.current = created;
        openLibrary();
      },
      onSpeciesRegistered: (id, summary, asset) => {
        species.set(id, summary);
        assets.set(summary.appearance, asset);
      },
      onSnapshot: (snapshot, events) => {
        latest = snapshot;
        created?.pushSnapshot(snapshot);
        if (counter.observe(snapshot, events)) recordCounts();
      },
      onFailure: (summary, details) => fail({ summary, details }),
    });
    simulation.current = client;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      view.current = undefined;
      simulation.current = undefined;
      client.stop();
      created?.dispose();
    };
    return stop;
  }, []);

  const toggleDebug = () => {
    // The view starts when the world is ready; until then there is nothing to debug.
    if (!view.current) return;
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

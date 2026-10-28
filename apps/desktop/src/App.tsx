import {
  connectDesktopShell,
  connectLibraryStore,
  serveStudio,
} from "@living-diorama/desktop-integration";
import { createDioramaView, type DioramaView } from "@living-diorama/renderer";
import type { AssetSummary, SimulationSnapshot, SpeciesSummary } from "@living-diorama/simulation";
import { useEffect, useRef, useState } from "react";
import { ControlsOverlay } from "./ControlsOverlay";
import { ErrorScreen, type Failure } from "./ErrorScreen";
import { installLibraryDevHook } from "./dev-library";
import { EventCounter } from "./event-counts";
import { creatureCap, startSimulation, type SimulationClient } from "./simulation-client";
import { ShapeCameras } from "./shape-cameras";
import { shortcutFor } from "./shortcuts";
import { openSpeciesLibrary, type SpeciesLibrary } from "./species-library";
import { StripResizeHandle } from "./StripResizeHandle";
import { STARTUP } from "./startup";
import {
  countBySpecies,
  librarySnapshot,
  studioHandlers,
  type LibrarySnapshot,
  type StudioRequests,
  type StudioServices,
} from "./studio-protocol";

const shell = connectDesktopShell();
const libraryStore = connectLibraryStore();

export function App() {
  const container = useRef<HTMLDivElement>(null);
  // Set while the diorama runs; cleared when it stops, so nothing is torn down twice.
  const view = useRef<DioramaView>(undefined);
  const simulation = useRef<SimulationClient>(undefined);
  const cameras = useRef(new ShapeCameras());
  // The shell owns paused, expanded and full screen; these mirror its change events.
  const [paused, setPaused] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
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
      shell.onExpandedChanged((value) => {
        cameras.current.switchTo(value, view.current);
        setExpanded(value);
      }),
      shell.onFullScreenChanged(setFullScreen),
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

  // The normal window takes focus, so it has keys; only these three (ADR 0016 §2).
  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = shortcutFor(event, fullScreen);
      if (!shortcut) return;
      event.preventDefault();
      if (shortcut === "reset-camera") view.current?.resetCamera();
      else void shell.setFullScreen(shortcut === "toggle-full-screen" && !fullScreen);
    };
    addEventListener("keydown", onKeyDown);
    return () => removeEventListener("keydown", onKeyDown);
  }, [expanded, fullScreen]);

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
    // The Studio talks to the world here (ADR 0015 §5); it is told whenever the library changes.
    let library: SpeciesLibrary | undefined;
    // Commands sent before the world is ready would be misuse (ADR 0009 §2), so queries wait.
    let worldReady = () => {};
    const ready = new Promise<void>((resolve) => (worldReady = resolve));
    const services: StudioServices = {
      library: () => library,
      creatures: () => latest?.creatures ?? [],
      maxCreatures: creatureCap(STARTUP),
      checkLimits: (sizeClass, capabilities) =>
        ready.then(() => client.checkLimits(sizeClass, capabilities)),
    };
    const studio = serveStudio<StudioRequests, LibrarySnapshot>(studioHandlers(services));
    const pushLibrary = () =>
      void studio
        .pushLibrary(librarySnapshot(services))
        .catch((error: unknown) => console.warn("Could not update the Studio", error));
    // The Studio shows how many of each species are in the world, so it hears when that changes.
    let counted = "";
    const countChanged = (snapshot: SimulationSnapshot) => {
      const counts = JSON.stringify([...countBySpecies(snapshot.creatures)].sort());
      if (counts === counted) return false;
      counted = counts;
      return true;
    };
    // The library registers its species once the world is ready (ADR 0014 §8). Development
    // builds also reach it from the console.
    const openLibrary = () =>
      void openSpeciesLibrary(
        libraryStore,
        {
          registerSpecies: client.registerSpecies,
          spawn: client.spawn,
          despawn: client.despawn,
          creatures: () => latest?.creatures ?? [],
        },
        { onChange: pushLibrary },
      ).then((opened) => {
        if (stopped) return;
        library = opened;
        pushLibrary();
        if (import.meta.env.DEV) installLibraryDevHook(opened);
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
        // Until the simulation sends the time of day (ADR 0018 §5), preview it from the console.
        if (import.meta.env.DEV) {
          const shown = created;
          window.livingDiorama = {
            ...window.livingDiorama,
            setTimeOfDay: (m) => shown.setTimeOfDay(m),
          };
        }
        worldReady();
        openLibrary();
      },
      onSpeciesRegistered: (id, summary, asset) => {
        species.set(id, summary);
        assets.set(summary.appearance, asset);
      },
      onSnapshot: (snapshot, events) => {
        latest = snapshot;
        created?.pushSnapshot(snapshot);
        if (countChanged(snapshot) && library) pushLibrary();
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
      studio.close();
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
      {/* The shell ignores height changes while expanded (ADR 0016 §1). */}
      {!expanded && <StripResizeHandle shell={shell} />}
      <ControlsOverlay
        paused={paused}
        expanded={expanded}
        fullScreen={fullScreen}
        debug={debug}
        onTogglePaused={() => void shell.setPaused(!paused)}
        onToggleExpanded={() => void shell.setExpanded(!expanded)}
        onResetCamera={() => view.current?.resetCamera()}
        onToggleDebug={toggleDebug}
        onToggleFullScreen={() => void shell.setFullScreen(!fullScreen)}
        onHide={() => void shell.hide()}
        onOpenStudio={() => void shell.openStudio()}
      />
    </div>
  );
}

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

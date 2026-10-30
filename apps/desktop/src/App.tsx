import type { Result } from "@living-diorama/content-schema";
import {
  connectDesktopShell,
  connectLibraryStore,
  connectWorldStore,
  serveStudio,
} from "@living-diorama/desktop-integration";
import { createDioramaView, type DioramaView } from "@living-diorama/renderer";
import type { AssetSummary, SimulationSnapshot, SpeciesSummary } from "@living-diorama/simulation";
import { useEffect, useRef, useState } from "react";
import { ControlsOverlay } from "./ControlsOverlay";
import { ErrorScreen, type Failure } from "./ErrorScreen";
import { installLibraryDevHook } from "./dev-library";
import { installTimeDevHook } from "./dev-time";
import { installWorldDevHook } from "./dev-world";
import { EventCounter } from "./event-counts";
import {
  COUNT_OVERRIDE,
  creatureCap,
  startSimulation,
  type SimulationClient,
} from "./simulation-client";
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
import { worldSaving, type WorldSaving } from "./world-saving";

const shell = connectDesktopShell();
const libraryStore = connectLibraryStore();
// A world measured with an overridden creature count is neither loaded nor saved (ADR 0019 §11).
const worldStore = COUNT_OVERRIDE === undefined ? connectWorldStore() : undefined;

export function App() {
  const container = useRef<HTMLDivElement>(null);
  // Set while the diorama runs; cleared when it stops, so nothing is torn down twice.
  const view = useRef<DioramaView>(undefined);
  const simulation = useRef<SimulationClient>(undefined);
  const saving = useRef<WorldSaving>(undefined);
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
      // Clean shutdown (ADR 0008 §14, ADR 0019 §4): the world is saved, then the process exits.
      shell.onQuitRequested(async () => {
        await saving.current?.save();
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
    let uninstallTimeHook = () => {};
    let uninstallWorldHook = () => {};
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
    // Creatures coming and going are saved at once (ADR 0019 §4).
    const savedAfter = <T,>(result: Result<T>) => {
      if (result.ok) void world.save();
      return result;
    };
    // The library registers its species once the world is ready (ADR 0014 §8), and the saved
    // world is restored only then, so its drawn creatures find their species (ADR 0019 §3). The
    // Studio reaches the library once the world is open. Development builds also reach both from
    // the console.
    const openWorld = async () => {
      const opened = await openSpeciesLibrary(
        libraryStore,
        {
          registerSpecies: client.registerSpecies,
          spawn: (speciesId, options) => client.spawn(speciesId, options).then(savedAfter),
          despawn: (creatureId) => client.despawn(creatureId).then(savedAfter),
          creatures: () => latest?.creatures ?? [],
        },
        { onChange: pushLibrary },
      );
      if (stopped) return;
      await world.open();
      if (stopped) return;
      library = opened;
      pushLibrary();
      if (import.meta.env.DEV) {
        installLibraryDevHook(opened);
        uninstallWorldHook = installWorldDevHook(world);
      }
    };
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
        if (import.meta.env.DEV) uninstallTimeHook = installTimeDevHook(client);
        worldReady();
        void openWorld();
      },
      // The restored world's ticks may be behind the empty world's, or far ahead after catch-up,
      // as are those of a world caught up in place (issue #113).
      onRestored: () => created?.resetSnapshots(),
      onCaughtUp: () => created?.resetSnapshots(),
      // An applied edit, or a restored edited world (ADR 0021 §4). An edit is saved at once, so a
      // crash right after it loses no more than that edit. After the startup restore of an edited
      // world this queues a second save behind the one opening the world makes; that is harmless.
      onWorldChanged: ({ scene, navigations: [navigation] }) => {
        void created?.replaceProps(scene, navigation);
        void world.save();
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
        // Snapshots keep coming while the strip is hidden, so they drive the autosave (#117).
        void world.saveIfDue();
      },
      onFailure: (summary, details) => fail({ summary, details }),
    });
    simulation.current = client;
    const world = worldSaving(client, {
      store: worldStore,
      creatures: () => latest?.creatures ?? [],
    });
    saving.current = world;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      view.current = undefined;
      simulation.current = undefined;
      saving.current = undefined;
      world.stop();
      client.stop();
      studio.close();
      created?.dispose();
      uninstallTimeHook();
      uninstallWorldHook();
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

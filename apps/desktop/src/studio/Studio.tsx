import {
  connectLibraryStore,
  connectStudioWindow,
  openStudioChannel,
} from "@living-diorama/desktop-integration";
import { createStandaloneVoxelThumbnails } from "@living-diorama/renderer";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  studioClient,
  type LibrarySnapshot,
  type ReleaseParams,
  type Released,
  type StudioRequests,
  type StudioSpecies,
} from "../studio-protocol";
import { AssemblyEditor } from "./AssemblyEditor";
import { CloseDialog } from "./CloseDialog";
import { DeleteDialog } from "./DeleteDialog";
import { DrawMode } from "./DrawMode";
import { useEditCopy } from "./edit-copy";
import type { AskLimits } from "./limits";
import type { StudioMode } from "./modes";
import { MyCreatures } from "./MyCreatures";
import { describeFailure, keptMessage, releasedMessage } from "./release";
import { Thumbnails } from "./thumbnails";
import { VoxelCreatureThumbnails } from "./voxel-thumbnails";

// The Creation Studio's page (ADR 0015, ADR 0023 §1): Build mode and Draw mode side by side in one
// window, with My creatures beside them. It never starts a simulation and never creates a
// DesktopShell, so the shell's events and quit_ready stay the strip's.

const studioWindow = connectStudioWindow();
const channel = openStudioChannel<StudioRequests, LibrarySnapshot>();
const libraryStore = connectLibraryStore();
const client = studioClient(channel);
const askLimits: AskLimits = (sizeClass, locomotion) =>
  channel.request("limits", { sizeClass, locomotion });
const releaseDrawing = (params: ReleaseParams) => channel.request("release", params);

/** How long "… is off into the world!" stays. */
const CELEBRATION_MS = 4000;

export const MODE_LABELS: Readonly<Record<StudioMode, string>> = { build: "Build", draw: "Draw" };

export function Studio() {
  // Build is the main way to make a creature, so the Studio opens in it.
  const [mode, setMode] = useState<StudioMode>("build");
  const [closing, setClosing] = useState(false);
  // What each mode would lose on closing.
  const unsaved = useRef<Record<StudioMode, boolean>>({ build: false, draw: false });
  const onUnsavedBuild = useCallback((value: boolean) => {
    unsaved.current.build = value;
  }, []);
  const onUnsavedDraw = useCallback((value: boolean) => {
    unsaved.current.draw = value;
  }, []);
  const [library, setLibrary] = useState<LibrarySnapshot>();
  const [celebration, setCelebration] = useState<{ text: string; happy: boolean }>();
  // Each mode keeps its own: Build starts with it collapsed, so the 3D view has the room.
  const [listOpen, setListOpen] = useState<Record<StudioMode, boolean>>({
    build: false,
    draw: true,
  });
  const [busySpecies, setBusySpecies] = useState<string>();
  const [listMessage, setListMessage] = useState<string>();
  const [deleting, setDeleting] = useState<StudioSpecies>();
  const [, setThumbnailsLoaded] = useState(0);
  const thumbnails = useRef<Thumbnails>(undefined);
  const voxelThumbnails = useRef<VoxelCreatureThumbnails>(undefined);
  // Edit a copy's latest creature for Build mode (ADR 0023 §3).
  const editCopy = useEditCopy(client.assembly, mode, setMode);

  // Closing with a creature not released asks first (ADR 0015 §10, ADR 0023 §21).
  useEffect(
    () =>
      studioWindow.onCloseRequested(() => {
        if (!unsaved.current.build && !unsaved.current.draw) return true;
        setClosing(true);
        return false;
      }),
    [],
  );

  // The library lives in the strip's window: ask for it now, then hear about every change.
  useEffect(() => {
    const created = new Thumbnails({
      load: (libraryId) => libraryStore.loadImage(libraryId),
      onChange: () => setThumbnailsLoaded((n) => n + 1),
    });
    thumbnails.current = created;
    const keep = (snapshot: LibrarySnapshot) => {
      created.sync(snapshot.species);
      setLibrary(snapshot);
    };
    const stop = channel.onLibraryChanged(keep);
    channel
      .request("snapshot", undefined)
      .then(keep)
      .catch((error: unknown) => console.warn("Could not read the species library", error));
    return () => {
      stop();
      created.dispose();
      thumbnails.current = undefined;
    };
  }, []);

  // Voxel species' images are drawn by the Studio from their assemblies (ADR 0023 §19), with a
  // renderer of its own made only once one is listed: Build mode's view, which could draw them,
  // lives inside AssemblyEditor and only while it runs.
  useEffect(() => {
    const created = new VoxelCreatureThumbnails({
      fetch: (speciesId) => client.assembly(speciesId),
      createRenderer: () => createStandaloneVoxelThumbnails(document),
      onChange: () => setThumbnailsLoaded((n) => n + 1),
    });
    voxelThumbnails.current = created;
    return () => {
      created.dispose();
      voxelThumbnails.current = undefined;
    };
  }, []);

  // Asked for only while My creatures is open, so a Studio that never opens it fetches nothing.
  const listShown = listOpen[mode];
  useEffect(() => {
    if (library && listShown) voxelThumbnails.current?.sync(library.species);
  }, [library, listShown]);

  useEffect(() => {
    if (!celebration) return;
    const timer = setTimeout(() => setCelebration(undefined), CELEBRATION_MS);
    return () => clearTimeout(timer);
  }, [celebration]);

  const onReleased = useCallback(
    (released: Released) =>
      setCelebration(
        released.notAdded === undefined
          ? { text: releasedMessage(released.name), happy: true }
          : { text: keptMessage(released.name, released.notAdded), happy: false },
      ),
    [],
  );

  const onReleaseStart = useCallback(() => setCelebration(undefined), []);

  /** Runs a My creatures request, one species at a time, saying what went wrong if it fails. */
  const ask = (speciesId: string, request: () => Promise<unknown>) => {
    setBusySpecies(speciesId);
    setListMessage(undefined);
    request()
      .catch((error: unknown) => setListMessage(describeFailure(error)))
      .finally(() => setBusySpecies(undefined));
  };

  const keysEnabled = !closing && !deleting;
  const modeSwitch = <ModeSwitch mode={mode} onMode={setMode} />;
  return (
    <div className="studio">
      <AssemblyEditor
        active={mode === "build"}
        keysEnabled={keysEnabled && mode === "build"}
        library={library}
        modeSwitch={modeSwitch}
        askLimits={askLimits}
        client={client}
        onReleaseStart={onReleaseStart}
        onReleased={onReleased}
        onUnsaved={onUnsavedBuild}
        loadRequest={editCopy.loadRequest}
      />
      <DrawMode
        active={mode === "draw"}
        keysEnabled={keysEnabled && mode === "draw"}
        library={library}
        modeSwitch={modeSwitch}
        askLimits={askLimits}
        release={releaseDrawing}
        onReleaseStart={onReleaseStart}
        onReleased={onReleased}
        onUnsaved={onUnsavedDraw}
      />
      <MyCreatures
        library={library}
        thumbnail={(speciesId) =>
          thumbnails.current?.get(speciesId) ?? voxelThumbnails.current?.get(speciesId)
        }
        open={listShown}
        onToggle={() => setListOpen((open) => ({ ...open, [mode]: !open[mode] }))}
        busy={busySpecies}
        message={listMessage}
        onAdd={(speciesId) => ask(speciesId, () => channel.request("addCreature", { speciesId }))}
        onRemove={(speciesId) =>
          ask(speciesId, () => channel.request("removeCreature", { speciesId }))
        }
        onDelete={setDeleting}
        onEditCopy={(species) => ask(species.speciesId, () => editCopy.start(species))}
      />
      {celebration && (
        <div
          key={celebration.text}
          className={celebration.happy ? "celebration" : "celebration quiet"}
          role="status"
        >
          {celebration.happy && <span className="sparkles" aria-hidden="true" />}
          {celebration.text}
        </div>
      )}
      {deleting && (
        <DeleteDialog
          name={deleting.name}
          inWorld={deleting.inWorld}
          onDelete={() => {
            const { speciesId } = deleting;
            setDeleting(undefined);
            ask(speciesId, () => channel.request("deleteSpecies", { speciesId }));
          }}
          onCancel={() => setDeleting(undefined)}
        />
      )}
      {closing && (
        <CloseDialog
          onDiscard={() => void studioWindow.close()}
          onCancel={() => setClosing(false)}
        />
      )}
    </div>
  );
}

/** The Build/Draw switch, at the start of each mode's toolbar (ADR 0023 §1). */
export function ModeSwitch(props: { mode: StudioMode; onMode(mode: StudioMode): void }) {
  return (
    <div className="tool-group mode-switch" role="group" aria-label="Mode">
      {(["build", "draw"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          aria-pressed={props.mode === mode}
          onClick={() => props.onMode(mode)}
        >
          {MODE_LABELS[mode]}
        </button>
      ))}
    </div>
  );
}

import type { PlayerPartEntry } from "@living-diorama/content-schema";
import {
  connectPartsStore,
  connectStudioWindow,
  openStudioChannel,
} from "@living-diorama/desktop-integration";
import { createStandaloneVoxelThumbnails } from "@living-diorama/renderer";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  studioClient,
  type LibrarySnapshot,
  type Released,
  type StudioRequests,
  type StudioSpecies,
} from "../studio-protocol";
import { AssemblyEditor } from "./AssemblyEditor";
import { CloseDialog } from "./CloseDialog";
import { DeleteDialog } from "./DeleteDialog";
import { useEditCopy } from "./edit-copy";
import type { AskLimits } from "./limits";
import { closeMessage, type StudioMode } from "./modes";
import { ModeSwitch } from "./ModeSwitch";
import { MyCreatures } from "./MyCreatures";
import { useOpenDraw } from "./open-draw";
import { PartDrawMode } from "./PartDrawMode";
import { describeFailure, keptMessage, releasedMessage } from "./release";
import { VoxelCreatureThumbnails } from "./voxel-thumbnails";

// The Creation Studio's page (ADR 0015, ADR 0023 §1): Build mode and Draw mode side by side in one
// window, with My creatures beside them. Draw mode draws parts (ADR 0025 §9). It never starts a
// simulation and never creates a DesktopShell, so the shell's events and quit_ready stay the
// strip's.

const studioWindow = connectStudioWindow();
const channel = openStudioChannel<StudioRequests, LibrarySnapshot>();
const client = studioClient(channel);
// The player's parts (ADR 0025 §6): Draw mode saves to it, and Build mode lists from it.
const partsStore = connectPartsStore();
const askLimits: AskLimits = (sizeClass, locomotion) =>
  channel.request("limits", { sizeClass, locomotion });

/** How long "… is off into the world!" stays. */
const CELEBRATION_MS = 4000;

export function Studio() {
  // Build is the main way to make a creature, so the Studio opens in it.
  const [mode, setMode] = useState<StudioMode>("build");
  // What closing would lose, while the Studio asks about it.
  const [closing, setClosing] = useState<string>();
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
    draw: false,
  });
  const [busySpecies, setBusySpecies] = useState<string>();
  const [listMessage, setListMessage] = useState<string>();
  const [deleting, setDeleting] = useState<StudioSpecies>();
  const [, setThumbnailsLoaded] = useState(0);
  const voxelThumbnails = useRef<VoxelCreatureThumbnails>(undefined);
  // Edit a copy's latest creature for Build mode (ADR 0023 §3).
  // It asks first when Build mode has a creature that wasn't released.
  const editCopy = useEditCopy({
    fetch: client.assembly,
    mode,
    onMode: setMode,
    unsaved: () => unsaved.current.build,
    run: (species, load) => ask(species.speciesId, load),
  });

  // Draw mode on a new part of a type or a saved part (ADR 0025 §9), asking first if a drawing
  // would be lost. PR 7: the tray's "Draw your own" tiles and My parts' Edit call `openDraw.open`.
  const openDraw = useOpenDraw({ unsaved: () => unsaved.current.draw, onMode: setMode });
  // Build mode will pick the part: PR 7 passes the entry on to it.
  const onUseInBuild = useCallback((entry: PlayerPartEntry) => {
    setMode("build");
    setCelebration({ text: `${entry.name} is in My parts.`, happy: true });
  }, []);

  // Closing with a creature not released or a part not saved asks first (ADR 0015 §10, ADR 0023
  // §21, ADR 0025).
  useEffect(
    () =>
      studioWindow.onCloseRequested(() => {
        if (!Object.values(unsaved.current).some(Boolean)) return true;
        setClosing(closeMessage(unsaved.current));
        return false;
      }),
    [],
  );

  // The library lives in the strip's window: ask for it now, then hear about every change.
  useEffect(() => {
    const stop = channel.onLibraryChanged(setLibrary);
    channel
      .request("snapshot", undefined)
      .then(setLibrary)
      .catch((error: unknown) => console.warn("Could not read the species library", error));
    return stop;
  }, []);

  // Species' images are drawn by the Studio from their assemblies (ADR 0023 §19), with a renderer
  // of its own made only once one is listed: Build mode's view, which could draw them, lives inside
  // AssemblyEditor and only while it runs.
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

  const keysEnabled = !closing && !deleting && !editCopy.confirming && !openDraw.confirming;
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
      <PartDrawMode
        active={mode === "draw"}
        keysEnabled={keysEnabled && mode === "draw"}
        modeSwitch={modeSwitch}
        onUnsaved={onUnsavedDraw}
        client={client}
        store={partsStore}
        request={openDraw.request}
        onNew={(partType) => openDraw.open({ partType })}
        onSaved={() => {}}
        onUseInBuild={onUseInBuild}
      />
      <MyCreatures
        library={library}
        thumbnail={(speciesId) => voxelThumbnails.current?.get(speciesId)}
        open={listShown}
        onToggle={() => setListOpen((open) => ({ ...open, [mode]: !open[mode] }))}
        busy={busySpecies}
        message={listMessage}
        onAdd={(speciesId) => ask(speciesId, () => channel.request("addCreature", { speciesId }))}
        onRemove={(speciesId) =>
          ask(speciesId, () => channel.request("removeCreature", { speciesId }))
        }
        onDelete={setDeleting}
        onEditCopy={editCopy.press}
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
      {editCopy.confirming && (
        <CloseDialog
          title="Discard your creature?"
          message={`Your creature in Build hasn't been released. Editing a copy of ${editCopy.confirming.name} replaces it.`}
          onDiscard={editCopy.confirm}
          onCancel={editCopy.cancel}
        />
      )}
      {openDraw.confirming && (
        <CloseDialog
          title="Discard your part?"
          message="Your part hasn't been saved. Starting another one loses it."
          drafts={false}
          onDiscard={openDraw.confirm}
          onCancel={openDraw.cancel}
        />
      )}
      {closing && (
        <CloseDialog
          message={closing}
          onDiscard={() => void studioWindow.close()}
          onCancel={() => setClosing(undefined)}
        />
      )}
    </div>
  );
}

import type { ViewPointer } from "@living-diorama/renderer";
import type { PropCategorySummary, PropSummary } from "@living-diorama/simulation";
import { DRAG_THRESHOLD_PX, type EditorState, type PropEditor } from "./prop-editor";

// The prop drawer's logic (ADR 0021, PR 7b): its tabs, its thumbnails and dragging a tile into the
// world. `PropDrawer.tsx` draws it.

/**
 * The tab of prop types with no category, or one that isn't registered. Content IDs are always
 * namespaced ("pack:name"), so no category can take this ID.
 */
export const OTHER_TAB = "other";

export interface DrawerTab {
  id: string;
  /** The tab's label. */
  name: string;
  /** Its prop types' IDs, by name. */
  types: string[];
}

/**
 * The drawer's tabs: the categories in the order given (the registry's tab order), then "Other"
 * for prop types whose category is missing or unknown. A tab with no prop types isn't shown.
 */
export function drawerTabs(
  propTypes: Readonly<Record<string, PropSummary>>,
  categories: readonly PropCategorySummary[],
): DrawerTab[] {
  const known = new Set(categories.map((c) => c.id));
  const byName = ([a, x]: [string, PropSummary], [b, y]: [string, PropSummary]) =>
    x.name.localeCompare(y.name) || (a < b ? -1 : a > b ? 1 : 0);
  const entries = Object.entries(propTypes).sort(byName);
  const tabOf = (type: PropSummary) =>
    type.category !== undefined && known.has(type.category) ? type.category : OTHER_TAB;
  return [...categories, { id: OTHER_TAB, name: "Other" }]
    .map(({ id, name }) => ({
      id,
      name,
      types: entries.filter(([, type]) => tabOf(type) === id).map(([typeId]) => typeId),
    }))
    .filter((tab) => tab.types.length > 0);
}

/** The drawer shows only in the normal window, while Edit mode is on and it isn't closed. */
export const drawerShown = (expanded: boolean, state: EditorState | undefined): boolean =>
  expanded && state !== undefined && state.active && state.drawerOpen;

/** A tile's thumbnail, in CSS pixels square. */
export const TILE_THUMBNAIL_PX = 56;

/**
 * The drawer's thumbnails, drawn by the view (`DioramaView.propThumbnail`), which reads each back
 * from the GPU synchronously. So they are asked for only for the tab shown, once per model, at one
 * size fixed when the drawer's thumbnails are made, and never per frame (#198).
 */
export class PropThumbnails {
  readonly size: number;
  readonly #draw: (model: string, size: number) => Promise<string | undefined>;
  readonly #urls = new Map<string, string>();
  readonly #asked = new Set<string>();
  readonly #listeners = new Set<() => void>();
  #version = 0;

  constructor(draw: (model: string, size: number) => Promise<string | undefined>, size: number) {
    this.#draw = draw;
    this.size = size;
  }

  /** Asks for the thumbnails of these models not asked for yet. */
  load(models: Iterable<string>): void {
    for (const model of models) {
      if (this.#asked.has(model)) continue;
      this.#asked.add(model);
      void this.#draw(model, this.size).then(
        (url) => {
          if (url === undefined) return;
          this.#urls.set(model, url);
          this.#version++;
          for (const listener of this.#listeners) listener();
        },
        (error: unknown) => console.warn(`Could not draw a thumbnail of ${model}`, error),
      );
    }
  }

  /** The model's thumbnail as a data URL, once drawn. */
  get(model: string): string | undefined {
    return this.#urls.get(model);
  }

  /** For `useSyncExternalStore`: changes whenever a thumbnail arrives. */
  get version(): number {
    return this.#version;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

/** What dragging a tile needs of the editor. */
export type DrawerEditor = Pick<
  PropEditor,
  "startPlacingDrag" | "movePlacingDrag" | "endPlacingDrag" | "cancelPlacingDrag"
>;

/**
 * A press on one of the drawer's tiles. Released where it started it is a click, left to the
 * tile's button (choose the type, then click the ground). Moved further than a click may, it drags
 * the type into the world: the editor's preview follows the pointer over the ground, and the
 * release places it there. `overWorld` says whether a pointer is over the world view, not the
 * drawer or the toolbar.
 */
export class TileDrag {
  readonly #editor: DrawerEditor;
  readonly #propType: string;
  readonly #start: ViewPointer;
  readonly #overWorld: (pointer: ViewPointer) => boolean;
  #dragging = false;
  #ended = false;

  constructor(
    editor: DrawerEditor,
    propType: string,
    start: ViewPointer,
    overWorld: (pointer: ViewPointer) => boolean,
  ) {
    this.#editor = editor;
    this.#propType = propType;
    this.#start = { clientX: start.clientX, clientY: start.clientY };
    this.#overWorld = overWorld;
  }

  /** It became a drag: the click that follows the release must not choose the type again. */
  get dragged(): boolean {
    return this.#dragging;
  }

  move(pointer: ViewPointer): void {
    if (this.#ended) return;
    if (!this.#dragging) {
      const distance = Math.hypot(
        pointer.clientX - this.#start.clientX,
        pointer.clientY - this.#start.clientY,
      );
      if (distance <= DRAG_THRESHOLD_PX) return;
      this.#dragging = true;
      this.#editor.startPlacingDrag(this.#propType);
    }
    this.#editor.movePlacingDrag(pointer, this.#overWorld(pointer));
  }

  up(pointer: ViewPointer): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#dragging) this.#editor.endPlacingDrag(pointer, this.#overWorld(pointer));
  }

  /** The pointer was lost to the tile, e.g. to another window. */
  cancel(): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#dragging) this.#editor.cancelPlacingDrag();
  }
}

/** "a rock", "an oak": a prop type's name in lower case after its article, for labels and hints. */
export const aProp = (name: string): string => {
  const lower = name.toLowerCase();
  return `${/^[aeiou]/.test(lower) ? "an" : "a"} ${lower}`;
};

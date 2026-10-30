import type { ViewPointer } from "@living-diorama/renderer";
import type { PropSummary } from "@living-diorama/simulation";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import type { PropEditor } from "./prop-editor";
import {
  aProp,
  TileDrag,
  type DrawerEditor,
  type DrawerTab,
  type PropThumbnails,
} from "./prop-drawer";

export interface PropDrawerProps {
  /** The tabs, from `drawerTabs`; at least one. */
  tabs: DrawerTab[];
  /** The tab shown; the first when it is unset or gone. */
  tab: string | undefined;
  onTab(tab: string): void;
  propTypes: Record<string, PropSummary>;
  /** The prop type being placed, if any: its tile shows pressed. */
  placing: string | undefined;
  thumbnails: PropThumbnails | undefined;
  editor: DrawerEditor & Pick<PropEditor, "choosePlacing">;
  /** Whether a pointer is over the world view, where a dragged tile places its type. */
  overWorld(pointer: ViewPointer): boolean;
  onClose(): void;
}

const EMPTY = () => () => {};

/**
 * Edit mode's prop drawer on the right of the normal window (ADR 0021, PR 7b), which pushes the
 * world view narrower: a tab per prop category, and a tile per prop type with its thumbnail and
 * name. Drag a tile into the world to place one where it is released, or click a tile, then the
 * ground. Thumbnails are asked for only for the tab shown.
 */
export function PropDrawer(props: PropDrawerProps) {
  const { tabs, propTypes, thumbnails, editor } = props;
  const current = tabs.find((t) => t.id === props.tab) ?? tabs[0];
  const id = useId();
  const tabList = useRef<HTMLDivElement>(null);
  const drag = useRef<TileDrag>(undefined);
  useSyncExternalStore(
    useCallback((listener: () => void) => thumbnails?.subscribe(listener) ?? EMPTY(), [thumbnails]),
    () => thumbnails?.version ?? 0,
  );

  // Only the tab shown, once per change of tab: never per frame (#198).
  const models = (current?.types ?? []).flatMap((type) => {
    const model = propTypes[type]?.model;
    return model === undefined ? [] : [model];
  });
  const modelsKey = models.join("\n");
  useEffect(() => {
    if (modelsKey !== "") thumbnails?.load(modelsKey.split("\n"));
  }, [thumbnails, modelsKey]);

  // Arrow keys, Home and End move between the tabs, as in the ARIA tabs pattern.
  const onTabKey = (event: KeyboardEvent) => {
    if (!current) return;
    const at = tabs.indexOf(current);
    const index =
      event.key === "ArrowRight"
        ? (at + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (at - 1 + tabs.length) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : undefined;
    const next = index === undefined ? undefined : tabs[index];
    if (index === undefined || !next) return;
    event.preventDefault();
    props.onTab(next.id);
    (tabList.current?.children[index] as HTMLElement | undefined)?.focus();
  };

  return (
    <aside className="prop-drawer" aria-label="Props">
      <header className="prop-drawer-header">
        <h2>Props</h2>
        <button
          type="button"
          className="prop-drawer-close"
          title="Close the drawer"
          aria-label="Close the drawer"
          onClick={props.onClose}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path className="stroke" d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>
      <div
        className="prop-drawer-tabs"
        role="tablist"
        aria-label="Prop categories"
        ref={tabList}
        onKeyDown={onTabKey}
      >
        {tabs.map((tab) => {
          const selected = tab === current;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`${id}-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${id}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => props.onTab(tab.id)}
            >
              {tab.name}
            </button>
          );
        })}
      </div>
      {current && (
        <div
          className="prop-drawer-tiles"
          role="tabpanel"
          id={`${id}-panel`}
          aria-labelledby={`${id}-tab-${current.id}`}
        >
          {current.types.map((typeId) => {
            const type = propTypes[typeId];
            if (!type) return null;
            const thumbnail = thumbnails?.get(type.model);
            return (
              <button
                key={typeId}
                type="button"
                className="prop-tile"
                title={`Drag into the world, or click and then click the ground, to place ${aProp(type.name)}`}
                aria-label={`Place ${aProp(type.name)}`}
                aria-pressed={props.placing === typeId}
                onPointerDown={(event) => {
                  drag.current = undefined;
                  if (event.button !== 0) return;
                  drag.current = new TileDrag(editor, typeId, event, props.overWorld);
                  // The drag goes on over the world; the camera never sees it.
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => drag.current?.move(event)}
                onPointerUp={(event) => drag.current?.up(event)}
                onPointerCancel={() => drag.current?.cancel()}
                onLostPointerCapture={() => drag.current?.cancel()}
                onClick={() => {
                  // The click that ends a drag has placed it already.
                  const dragged = drag.current?.dragged ?? false;
                  drag.current = undefined;
                  if (dragged) return;
                  editor.choosePlacing(props.placing === typeId ? undefined : typeId);
                }}
              >
                <span className="prop-tile-picture">
                  {thumbnail && <img src={thumbnail} alt="" draggable={false} />}
                </span>
                <span className="prop-tile-name">{type.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </aside>
  );
}

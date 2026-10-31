// @vitest-environment jsdom
import type { PlayerPartEntry } from "@living-diorama/content-schema";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { builtInParts } from "./fixtures/built-in-parts";
import { drawnPartEntry } from "./fixtures/player-parts";
import { MyParts } from "./MyParts";
import { playerPartSummary, type PlayerPart, type PlayerPartsState } from "./player-parts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const studioParts = builtInParts();
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const part = (uuid: string, type: string, name: string): PlayerPart => {
  const entry = drawnPartEntry(studioParts, { uuid, type, name });
  return { uuid, entry, summary: playerPartSummary(entry) };
};
const STILT = part(A, "hollow:leg", "Stilt");
const BEAD = part(B, "hollow:eye", "Bead");

let root: Root | undefined;
let container: HTMLDivElement;
beforeEach(() => {
  // jsdom has no modal dialogs.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

function state(parts: PlayerPart[] | undefined, error?: string) {
  return {
    parts,
    error,
    reload: vi.fn<PlayerPartsState["reload"]>(() => Promise.resolve()),
    rename: vi.fn<PlayerPartsState["rename"]>(() => Promise.resolve(true)),
    remove: vi.fn<PlayerPartsState["remove"]>(() => Promise.resolve(true)),
  } satisfies PlayerPartsState;
}

async function mount(playerParts: PlayerPartsState, onEditPart?: (entry: PlayerPartEntry) => void) {
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <MyParts
        playerParts={playerParts}
        typeName={(type) => studioParts.partTypes.find((t) => t.id === type)?.name}
        onEditPart={onEditPart}
      />,
    ),
  );
}

const labelled = (label: string) => {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`No button "${label}"`);
  return found;
};
const button = (text: string) => {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent === text);
  if (!found) throw new Error(`No button "${text}"`);
  return found;
};
const click = (target: HTMLElement) => act(async () => target.click());
const rows = () => [...container.querySelectorAll(".my-part-text")].map((row) => row.textContent);

it("lists each part with its type, and says where drawn parts go when there are none", async () => {
  await mount(state([STILT, BEAD]));
  expect(rows()).toEqual(["StiltLeg", "BeadEye"]);
  // No Edit without Draw mode to edit in.
  expect(container.querySelector('button[aria-label="Edit Stilt"]')).toBeNull();
  act(() => root?.unmount());
  await mount(state([]));
  expect(container.textContent).toContain("Parts you draw appear here.");
});

it("shows what went wrong", async () => {
  await mount(state([STILT], "Could not delete Stilt: Access is denied"));
  expect(container.querySelector("[role=alert]")?.textContent).toBe(
    "Could not delete Stilt: Access is denied",
  );
});

it("opens a part's drawing to edit", async () => {
  const onEditPart = vi.fn();
  await mount(state([STILT]), onEditPart);
  await click(labelled("Edit Stilt"));
  expect(onEditPart).toHaveBeenCalledWith(STILT.entry);
});

it("renames a part, and Escape or Cancel keep its name", async () => {
  const parts = state([STILT]);
  await mount(parts);
  await click(labelled("Rename Stilt"));
  const input = container.querySelector<HTMLInputElement>('input[aria-label="New name for Stilt"]');
  if (!input) throw new Error("No name field");
  expect(button("Save").disabled).toBe(true);
  await act(async () => {
    // React tracks the value through the native setter.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      input,
      "Long leg",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(button("Save"));
  expect(parts.rename).toHaveBeenCalledWith(A, "Long leg");
  expect(container.querySelector("input")).toBeNull();

  await click(labelled("Rename Stilt"));
  await act(async () =>
    container
      .querySelector("input")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(container.querySelector("input")).toBeNull();
  expect(parts.rename).toHaveBeenCalledTimes(1);
});

it("asks before deleting a part, and Cancel keeps it", async () => {
  const parts = state([STILT, BEAD]);
  await mount(parts);
  await click(labelled("Delete Stilt"));
  expect(container.querySelector("dialog h2")?.textContent).toBe("Delete Stilt?");
  expect(document.activeElement?.textContent).toBe("Cancel");
  await click(button("Cancel"));
  expect(container.querySelector("dialog")).toBeNull();
  expect(parts.remove).not.toHaveBeenCalled();

  await click(labelled("Delete Bead"));
  await click(button("Delete"));
  expect(parts.remove).toHaveBeenCalledWith(B);
  expect(container.querySelector("dialog")).toBeNull();
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LibrarySnapshot, StudioSpecies } from "../studio-protocol";
import { DeleteDialog, speciesDeleteMessage } from "./DeleteDialog";
import { MyCreatures, type MyCreaturesProps } from "./MyCreatures";

const base = {
  sizeClass: "medium",
  createdAt: "2026-10-27T12:00:00.000Z",
} as const;
const puddle: StudioSpecies = {
  ...base,
  speciesId: "user:1",
  libraryId: "1",
  name: "Puddle",
  available: true,
  limits: [],
  inWorld: 2,
};
const twig: StudioSpecies = {
  ...puddle,
  speciesId: "user:2",
  libraryId: "2",
  name: "Twig",
  inWorld: 0,
};
const ghost: StudioSpecies = {
  ...base,
  speciesId: "user:3",
  libraryId: "3",
  name: "Ghost",
  available: false,
  reasons: [{ severity: "error", code: "no_spawn_point", message: "No room anywhere.", path: [] }],
  inWorld: 0,
};
const LIBRARY: LibrarySnapshot = { species: [puddle, twig, ghost], creatures: 5, maxCreatures: 20 };

const render = (props: Partial<MyCreaturesProps> = {}) =>
  renderToStaticMarkup(
    <MyCreatures
      library={LIBRARY}
      thumbnail={(id) => (id === "user:1" ? "blob:puddle" : undefined)}
      open={true}
      onToggle={() => {}}
      onAdd={() => {}}
      onRemove={() => {}}
      onDelete={() => {}}
      onEditCopy={() => {}}
      {...props}
    />,
  );

/** Each row's text and its buttons, with "*" after a disabled one. */
function rows(html: string) {
  return [...html.matchAll(/<li class="[^"]*">(.*?)<\/li>/g)].map(([, row]) => ({
    text: [...row!.matchAll(/<span class="species-(?:name|count|reason)"[^>]*>(.*?)<\/span>/g)]
      .map(([, text]) => text)
      .join(" / "),
    buttons: [...row!.matchAll(/<button([^>]*)aria-label="([^"]*)"([^>]*)>/g)].map(
      ([, before, label, after]) => `${label}${(before! + after!).includes("disabled") ? "*" : ""}`,
    ),
  }));
}

describe("My creatures", () => {
  it("lists the library with counts, and what each row can do", () => {
    const html = render();
    expect(html).toContain("5 of 20 creatures in the world");
    expect(html).toContain('src="blob:puddle"');
    expect(rows(html)).toEqual([
      {
        text: "Puddle / 2 in the world",
        buttons: [
          "Take one Puddle out of the world",
          "Add a Puddle to the world",
          "Edit a copy of Puddle",
          "Delete Puddle",
        ],
      },
      {
        text: "Twig / 0 in the world",
        buttons: [
          "Take one Twig out of the world*",
          "Add a Twig to the world",
          "Edit a copy of Twig",
          "Delete Twig",
        ],
      },
      {
        text: "Ghost / Unavailable: No room anywhere.",
        buttons: ["Edit a copy of Ghost", "Delete Ghost"],
      },
    ]);
  });

  it("shows a species' drawn image, and a placeholder until it is drawn", () => {
    const waiting = render({ library: { ...LIBRARY, species: [twig] } });
    expect(waiting).toContain("thumbnail voxel-placeholder");
    expect(waiting).not.toContain("<img");
    const drawn = render({
      library: { ...LIBRARY, species: [puddle, twig] },
      thumbnail: (id) => (id === "user:1" ? "blob:puddle" : "data:image/png;base64,twig"),
    });
    expect(drawn).toContain('src="blob:puddle"');
    expect(drawn).toContain('src="data:image/png;base64,twig"');
    expect(drawn).not.toContain("voxel-placeholder");
  });

  it("disables a species' buttons while its request is on the way, and shows a failure", () => {
    const html = render({ busy: "user:1", message: "The world is full (20 creatures)." });
    expect(rows(html)[0]?.buttons.every((button) => button.endsWith("*"))).toBe(true);
    expect(html).toContain('role="alert">The world is full (20 creatures).</p>');
  });

  it("says where released creatures go when there are none, and folds away", () => {
    expect(render({ library: { species: [], creatures: 3, maxCreatures: 20 } })).toContain(
      "Creatures you release appear here.",
    );
    const folded = render({ open: false });
    expect(folded).toContain("My creatures (3)");
    expect(folded).not.toContain("Puddle");
  });
});

describe("deleting", () => {
  it("asks first and says its creatures leave the world", () => {
    const html = renderToStaticMarkup(
      <DeleteDialog
        name="Puddle"
        message={speciesDeleteMessage("Puddle", 2)}
        onDelete={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain("Delete Puddle?");
    expect(html).toContain("All 2 in the world leave it.");
    expect(speciesDeleteMessage("Twig", 1)).toBe(
      "Twig will be gone from My creatures for good. The one in the world leaves it.",
    );
    expect(speciesDeleteMessage("Twig", 0)).toBe("Twig will be gone from My creatures for good.");
    expect([...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(([, text]) => text)).toEqual([
      "Delete",
      "Cancel",
    ]);
  });
});

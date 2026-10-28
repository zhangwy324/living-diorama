# ADR 0014: Species library

- **Status:** Accepted
- **Date:** 2026-10-27
- **Context:** Roadmap M10. Drawn species (M11) have to survive a relaunch, while the world itself still resets on launch. The player's strokes are the source of truth, so later releases can add body plans without the player redrawing. Rust is the app's only filesystem boundary (ADR 0008), and drawn species go through the same schemas and registries as pack content (ADR 0012).

**Amended by [ADR 0017](0017-hollow-bodies-and-fill.md)** (M13 PR 2): the drawn image becomes the source of truth, with the strokes (and later fills) kept beside it as a record that is never replayed, and library files need no backward compatibility. Until that PR lands, this ADR describes the code.

## Decisions

1. **One folder per species.** The library is `library/` in the app data directory (`%APPDATA%\com.livingdiorama.desktop\library`). Each species has a folder named by the UUID of its `user:<uuid>` ID, holding:
   - `entry.json`: the library entry;
   - `drawing.json`: the strokes;
   - `appearance.png`: the image the body is built from, derived from the strokes.

2. **Saves are atomic and entries never change.** A save writes the three files to `<uuid>.tmp/`, then renames the folder into place, so an entry appears complete or not at all. A delete renames the folder to `<uuid>.tmp/` before removing it. Listing removes `.tmp` folders left by a crash. Saving over an existing ID is an error: a redraw is a new species, and editing comes later.

3. **Rust stores, TypeScript checks.** `apps/desktop/src-tauri/src/library.rs` lists, saves, loads and deletes entries, and doesn't interpret their contents. It skips, with a warning in the log, folders that aren't entries and entries it can't read: a missing file, JSON that doesn't parse, a file over its size limit. The schemas and migrations live in `content-schema`, so they exist once. An entry that fails them, comes from a newer version, or holds a species other than `user:<its folder>` with the image `user:<its folder>/appearance.png`, is skipped with a diagnostic, and its files are left alone, so a newer build can still read them. A bad entry never stops the app.

4. **Rust guards the paths and sizes.** IDs must be lowercase UUIDs before any path is built from them, so the frontend can't reach outside the library. Each file has a size limit, well above what the Studio produces: 64 KB for the entry, 16 MB for the drawing, 4 MB for the image.

5. **The schemas.**
   - Library entry: `{ schemaVersion, species, createdAt }`. `species` is a species definition, checked like pack content. The name shown to the player is the species' name.
   - Drawing: `{ schemaVersion, canvas: { width, height }, strokes }`. A stroke has a `tool` (`pen` or `eraser`), a `color`, a `width` at full pressure, and flat `points`: `[x, y, pressure, …]` in canvas pixels, pressure from 0 to 1. Eraser strokes are kept, so the strokes alone reproduce the drawing.

   Each has its own version constant (`DRAWING_SCHEMA_VERSION`, `LIBRARY_ENTRY_SCHEMA_VERSION`), separate from the definition versions in ADR 0003.

6. **Files are migrated before they are validated.** `parseDrawing` and `parseLibraryEntry` run the file through `migrate`: `migrations[n]` turns version `n` into `n + 1`, up to the current version. Version 1 has no migrations. A file without a version, or from a newer build, is rejected with `unsupported_schema_version`; a gap in the migrations with `missing_migration`. The next release adds body-plan data by adding a migration.

7. **Images reach the renderer as `blob:` URLs.** `load_library_image` returns the PNG's bytes as raw binary (`ipc::Response`), and the frontend makes a `blob:` URL from them for `register_species`. The CSP already allows `blob:` images, so the asset protocol isn't needed. The URL is revoked when the species is deleted.

8. **Startup registers the library.** Once the world is ready, the app registers every library species, one at a time, and spawns none of them. Saving registers the new species before storing it, so a species the world rejects never reaches the disk. A species the world rejects stays in the list as unavailable, with the reason, and can't be added.

9. **Deleting a species doesn't unregister it.** Its creatures leave the world and its files are deleted. The species stays registered, unseen, until the next launch: registries have no unregister, and nothing can reach a species that isn't in the library.

10. **The library holds only drawn species.** The mossling isn't in it, and still spawns at launch. Adding a creature works for any registered species, so the Studio can list the mossling later if wanted.

11. **Drawn species defaults** (`core:walk`, `core:wander`, base speed 0.6, the mossling's) are app configuration, next to the startup config.

12. **A console hook until the Studio.** Development builds put the library on `window.livingDiorama.library`, with `saveSample()` to save a sample drawing, so saving and relaunching can be checked by hand before M11 gives it a UI.

## Consequences

- An unreadable or newer library entry is skipped, not lost: its files stay until the player deletes it or a newer build reads it.
- Images and drawings cross the IPC boundary as bytes and JSON. A save sends the image as a JSON array of numbers, which is fine for a 256 px PNG.
- The registry keeps deleted species until relaunch. Each costs a few kilobytes and, for a new size class, its navigation.
- Rust unit tests cover saving, loading, deleting, unreadable entries, size limits, rejected IDs and interrupted saves; Vitest covers the schemas and migrations, and the library's startup, saving, creatures and deletes against an in-memory store.

# ADR 0015: Creation Studio

- **Status:** Accepted
- **Date:** 2026-10-27
- **Context:** Roadmap M11. The player draws a creature and releases it into the world. The strip never takes focus (ADR 0008 §6), so it can't take keyboard input such as undo shortcuts or a name, and the Studio needs a window of its own. The simulation worker and the species library (ADR 0014) live in the strip's window. M11 ships as four PRs: **1** this ADR and an editor performance spike; **2** the Studio window, the editor and the window channel; **3** the live preview, name and size, hints and the limits query; **4** release and the list of the player's creatures. Decisions for all four are recorded here; each PR updates this ADR if it has to deviate.

## Decisions

### The window (PR 2)

1. **A separate, normal window.** Label `studio`: framed, resizable, focusable, with a taskbar entry and an Alt+Tab entry. Rust creates it on demand with `WebviewWindowBuilder` when the controls overlay or the tray asks for it (an `open_studio` command and a tray menu item). There is one at a time: opening it again shows and focuses the existing window. Closing it destroys it, which frees its WebGL context (§6), and never touches the simulation. The strip keeps every ADR 0008 behaviour, non-focusable included. Expanded mode (issue #30) is a separate question and out of scope.

2. **A second Vite entry.** `apps/desktop` builds two pages, `index.html` (the strip) and `studio.html` (the Studio), as a multi-page Vite build, sharing the workspace packages. The Studio page never starts a simulation worker.

3. **Its own capability file.** `capabilities/studio.json` grants the `studio` window only what it uses: listening and emitting to a target (`core:event:allow-listen`, `allow-unlisten`, `allow-emit-to`), the window calls behind the close dialog (§10), and the log. The strip's `default.json` stays scoped to `main`, and gains `allow-emit-to` for the channel's replies (it has only listen and unlisten today).

### Talking to the world (PRs 2–4)

4. **The world stays in the strip's window.** The worker, the registries and the species library stay in `main`. The Studio holds no world state of its own, only its drawing and the latest library snapshot.

5. **A typed request/response channel in `desktop-integration`.** The only package that imports `@tauri-apps/api` (ADR 0008 §1) gets a small channel over targeted Tauri events:
   - the Studio sends `studio-request` with `emitTo("main", …)`: `{ requestId, request }`, where `request` is one of release (save the drawing and add a creature), add a creature, remove a creature, delete a species, and check the limits for a size class (§8);
   - `main` answers with `emitTo("studio", "studio-response", { requestId, result | error })`;
   - `main` pushes `library-changed` with a snapshot of the library to `studio` whenever it changes. The Studio asks for one when it opens (a `snapshot` request), because a push sent before its listener exists is lost.

   Each side listens with its own label as the target (`listen(event, handler, { target: label })`). `listen` defaults to any target, which would also deliver events emitted to the other window. The Studio's requests time out after a few seconds, so a reloading or busy strip shows an error rather than a stuck button. Both ends have a no-op or in-memory implementation for tests, like `DesktopShell`.

   Payloads are JSON. A release carries the drawing (at most a few megabytes for a very long one, under the 16 MB file limit of ADR 0014) and the PNG bytes as a number array, which is fine for a 256 px image. Images in the snapshot are not `blob:` URLs: those belong to the strip's document. The Studio loads a species' image itself with `load_library_image` when it needs to show one.

6. **The Studio ignores shell broadcasts.** Rust sends `quit-requested`, `paused-changed` and `expanded-changed` with `app.emit`, which reaches every window, and exits on the first `quit_ready`. So:
   - the Studio page never creates a `DesktopShell` and never subscribes to these events, so it can't answer `quit-requested`;
   - `quit_ready` also takes the calling window and ignores any caller but `main`, since app commands are callable from every window regardless of capabilities;
   - shell events meant for the strip move to `emit_to("main", …)`, so the Studio doesn't receive them at all.

   Quitting closes the Studio with the app. A drawing that wasn't released is lost then; the close dialog (§10) only covers closing the Studio itself, until drafts arrive.

### Preview and limits (PR 3)

7. **The live preview uses the renderer's body code.** `renderer`'s `index.ts` exports `buildBody` and `readImage` (ADR 0011 §1). The Studio runs its own small three.js scene, lit like the diorama, with the body turning slowly and rebuilt from the rasterised drawing (§9) a short while after each stroke ends. The second WebGL context exists only while the Studio is open.

8. **A read-only limits query.** A new worker command, `check_limits` with a `requestId`, a size class and the capabilities drawn species use (ADR 0014 §11; a navigation profile is size class plus capabilities, ADR 0012), answered by `limits` with the profile's limits as `Diagnostic[]` (ADR 0013 §4). It registers nothing. A known profile answers from the world state; a new one builds its navigation and checks it (about 30 ms in the worker) and keeps the result, so switching back and forth in the size picker is instant and a later registration of that profile can reuse it. Errors for the profile (e.g. `no_spawn_point`) come back as diagnostics too, so the Studio can say the size can't be released. `PROTOCOL_VERSION` stays 4 if v4 is still unreleased then, else it goes to 5. The Studio turns limit codes into the player's words.

### The drawing (PRs 2 and 4)

9. **Strokes on a square 256-unit canvas.** The canvas is 256 × 256 units, the body image's size (ADR 0011 §1), shown scaled up to fit the window. Strokes keep the ADR 0014 format: tool (`pen` or `eraser`), colour, width at full pressure and flat `[x, y, pressure, …]` points in canvas units. The Studio rasterises them to the PNG it releases, with the same stroke-drawing code as the editor: `rasterize` moves out of `dev-library.ts` into a module both use, and the console hook keeps using it.

10. **Closing with an unreleased drawing asks first.** Closing the window while the canvas has strokes that weren't released shows a dialog: **Discard** closes, **Save draft** is shown but disabled ("coming later"), **Cancel** keeps the Studio open. An empty or released drawing closes without asking.

11. **The editor is a plain `<canvas>`, not React Konva.** The roadmap proposed React Konva; the spike below showed it doesn't fit this editor. React renders the toolbar and panels only. The canvas is driven imperatively:
    - finished strokes are already on the canvas; a pointer move draws only its new segments (with `getCoalescedEvents`, so a pen's extra samples count). Live points are never React state;
    - the eraser draws with `destination-out` on the same canvas, so its result is exact while drawing;
    - undo clears and replays all strokes; redo draws one stroke more;
    - the backing store follows `devicePixelRatio`, and the guide ("facing right, feet on this line") is a separate element over the canvas, so it is never part of the drawing.

## Spike: React Konva or a plain canvas

A throwaway harness (not committed) drew strokes in the ADR 0014 format on a 256-unit canvas shown at 640 CSS px, at a device pixel ratio of 1.5, with `react-konva` 19.3.2 (React 19), `konva` 10.9.0 and React 19.3.1. It ran in Microsoft Edge (the engine WebView2 uses) with the GPU, driven by synthetic pen pointer events with varying pressure through `puppeteer-core`. The display ran at 100 Hz, so 10 ms is a full-rate frame. Each case seeded 50 strokes of 750 points (and 10 × 500, 50 × 1000), then drew a new stroke with 2 and 4 pointer moves per frame, then undid and redid a stroke 10 times. Six editors:

- **canvas:** a plain `<canvas>` drawn incrementally (§11);
- **konva-react:** one Konva `Shape` per stroke whose `sceneFunc` draws each segment at `width × pressure`, the live stroke in React state;
- **konva-imperative:** the same shapes, but the live stroke mutated in place with `layer.batchDraw()`;
- **konva-cached:** like imperative, with the finished strokes in a `Group` cached to a bitmap, re-cached on every change;
- **konva-line:** one Konva `Line` per stroke, which has a single `strokeWidth`, so pressure is ignored;
- **konva-segments:** one Konva `Line` per segment, so each has its own width.

| Editor (50 × 750) | Frame while drawing, mean / p95 | JS per frame (2 moves) | Undo, to the next frame |
| ----------------- | ------------------------------- | ---------------------- | ----------------------- |
| canvas            | 10 / 10 ms                      | 0.05 ms                | ~38 ms                  |
| konva-react       | 33 / 40 ms                      | 5.5 ms                 | ~46 ms                  |
| konva-imperative  | 32 / 40 ms                      | 0.2 ms                 | ~53 ms                  |
| konva-cached      | 10 / 10 ms                      | 0.3 ms                 | ~38 ms                  |
| konva-line        | 31 / 40 ms                      | 8.1 ms                 | ~60 ms                  |
| konva-segments    | 302 / 430 ms                    | 258 ms                 | ~240 ms                 |

At 10 × 500, canvas, konva-imperative and konva-cached all kept full rate. At 50 × 1000, konva-imperative fell to 42 ms frames while canvas and konva-cached stayed at 10 ms, with undo at ~55 ms for both. Undo times include waiting for the next frame (at least 20 ms here).

What it shows:

- **Konva redraws the whole layer every frame.** That replays every segment of every stroke, so a drawing that grows makes every new stroke slower, from full rate at 5,000 points to 30 fps at 37,500. The cost is in rasterising, not in JavaScript, and it doesn't depend on React: the imperative variant spends 0.2 ms in JavaScript per frame and is as slow.
- **Pressure needs a custom `sceneFunc`.** A Konva `Line` has one `strokeWidth`. One `Line` per segment gives each its own width but means tens of thousands of nodes, and is unusable. A `Shape` with a `sceneFunc` that draws the segments itself works, which is the plain canvas code inside Konva.
- **Live points in React state cost 5–16 ms of JavaScript per frame** (copying the points and reconciling), on top of the redraw. They have to stay out of React whichever way is chosen.
- **Konva can be made fast,** by caching the finished strokes to a bitmap and drawing only the live stroke, which is what the plain canvas does by itself. Then Konva contributes no shapes, hit testing or transforms the editor uses, only a dependency and a cache to keep in step.

So the plain canvas (§11), the fallback roadmap risk R1 named, with the stroke format unchanged.

## Consequences

- The app has a second window and a second page. The manual checks in `docs/development.md` gain a Studio section with PR 2: focus, one instance, closing, scaling and two monitors.
- `desktop-integration` grows the window channel and stays the only package that imports `@tauri-apps/api`. Rust's shell events go to `main` only.
- No new runtime dependency for drawing. Shapes, selection or transforms in later drawing releases would be a reason to look at a scene-graph library again; the stroke format doesn't depend on the choice.
- The editor and `rasterize` share one stroke-drawing function, so the released image matches what the player saw.
- A drawing that isn't released is lost when the Studio closes (after asking) or the app quits, until drafts are saved.
- A limits query for a new size class builds that profile's navigation, which stays in the worker even if nothing of that size is ever released, like a deleted species (ADR 0014 §9).

# Body fixtures

Drawings made in the Creation Studio for the body side-colour tests (issue #40, `textures.test.ts`). Each case is the Studio's `drawing.json` (`<case>.json`) and the `appearance.png` it rasterised from it (`<case>.png`), copied from a development build's library (`LIVING_DIORAMA_DEV_DATA_DIR`, see `docs/development.md`).

| Case              | What it is                                                     |
| ----------------- | -------------------------------------------------------------- |
| `outline`         | A purple body with a thin dark outline                         |
| `no-outline`      | A brown body with no outline                                   |
| `thick-outline`   | A yellow body with a thick pink outline                        |
| `edge-details`    | A dark body, yellow patches on its edge and thin blue antennae |
| `thin-limbs`      | A pink body with a dark outline, thin legs and brown arms      |
| `separate-shapes` | A yellow body and a pink tail that don't touch                 |

To add a case, draw and release it in the dev app, then copy its `drawing.json` and `appearance.png` from the library folder. The tests read the PNG, so they don't depend on the Studio's code; the JSON is kept to redraw it.

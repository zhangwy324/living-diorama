# Body fixtures

Drawings made in the Creation Studio for the body tests: holes (`outline.test.ts`) and wall colours (`textures.test.ts`). They were first drawn for issue #40. Each case is the Studio's `drawing.json` (`<case>.json`) and the `appearance.png` it rasterised from it (`<case>.png`), copied from a development build's library (`LIVING_DIORAMA_DEV_DATA_DIR`, see `docs/development.md`).

| Case              | What it is                                                     |
| ----------------- | -------------------------------------------------------------- |
| `outline`         | A purple body with a thin dark outline                         |
| `no-outline`      | A brown body with no outline                                   |
| `thick-outline`   | A yellow body with a thick pink outline                        |
| `edge-details`    | A dark body, yellow patches on its edge and thin blue antennae |
| `thin-limbs`      | A pink body with a dark outline, thin legs and brown arms      |
| `separate-shapes` | A yellow body and a pink tail that don't touch                 |

`mossling.png` is the drawn mossling the built-in pack had until M20 (its `mossling.svg`) as `readImage` reads it: drawn into a 256 px canvas in a browser and saved with `toBlob`. The mossling is now made of voxels, but the drawing stays here as a test case for drawn bodies: a body with thin hairs and gaps under them.

To add a case, draw and release it in the dev app, then copy its `drawing.json` and `appearance.png` from the library folder. The tests read the PNG through `load.ts`, so they don't depend on the Studio's code; the JSON is kept to redraw it. Add its stroke colours to the palette in `load.ts`.

`voxel-creature.ts` is a voxel assembly in code for the voxel body's and the assembly view's tests: a torso with a mirror pair of arms turned a quarter turn, a hand on each (the right one reflected through its arm), and a tail with a mirror pair of fins, so rotations and mirroring meet.

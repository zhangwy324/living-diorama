# @living-diorama/simulation

Headless simulation: clock, seeded RNG, world state, region graph, navigation, actions, behaviors and events.

## Owns

- All authoritative world and creature state.
- The fixed-tick clock (wall-clock time is fed in, never read directly).
- The worker-side host and the versioned snapshot/command message protocol (`protocol.ts`).

## Must not

- Import `three`, `react`, `@tauri-apps/*`, Node built-ins or any DOM API. It must run unchanged in Node (tests) and in a Web Worker.
- Branch on content IDs.

## Workspace dependencies

`@living-diorama/content-schema`, `@living-diorama/extension-api`

Boundary rules are enforced by `pnpm boundaries` (dependency-cruiser) and `pnpm lint`; see roadmap §1.4.

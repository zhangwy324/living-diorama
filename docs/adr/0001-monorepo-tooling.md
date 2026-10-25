# ADR 0001: Monorepo tooling

- **Status:** Accepted
- **Date:** 2026-10-25
- **Context:** Roadmap M0 tasks 2–6.

## Decisions

1. **pnpm workspaces** (`apps/*`, `packages/*`, `tools/*`), packages scoped as `@living-diorama/*`. pnpm's strict `node_modules` means a package can only import what its own `package.json` declares.
2. **Internal packages export TypeScript source.** Each package's `exports` points at `src/index.ts`; there is no per-package JS build. Vite and Vitest consume the source directly, and `tsc -b` uses project references to typecheck in dependency order, emitting declarations only (into `.tsbuild/`). If a package ever needs to be published, it gets a real build step then.
3. **TypeScript 6.0, not 7.** TypeScript 7 (the native port) is current, but `typescript-eslint` only supports `<6.1`. Revisit when it supports 7.
4. **Per-package `lib` settings carry part of the boundary rules.** `simulation` compiles with `lib: ["ES2023"]` only, so any DOM global is a type error. `renderer`, `desktop-integration` and the app add `DOM`.
5. **dependency-cruiser enforces import boundaries** (`.dependency-cruiser.cjs`):
   - `simulation` may not import `three`, `react`, `@tauri-apps/*`, Node built-ins, `renderer` or `desktop-integration`;
   - `renderer` may import `simulation` **types only** (the mechanical form of "never mutates simulation state");
   - no package except the app and dev tools may import `built-in-content`;
   - packages may not import apps or tools, and nothing may deep-import another package's internals;
   - no cycles, no unresolvable or undeclared dependencies.
6. **ESLint enforces "no branching on content IDs"** via `no-restricted-syntax`: comparing against or switching on a `namespace:name` string literal is an error in engine packages (`built-in-content` and tests are exempt).
7. **CI** (GitHub Actions): an Ubuntu job runs lint, format check, boundaries, tests and build; a Windows job runs `tauri build --no-bundle`.

## Consequences

- Adding a workspace dependency requires both a `package.json` entry and a `references` entry in the package's `tsconfig.json`.
- The renderer receives runtime data from the simulation only as messages, never by calling into it.

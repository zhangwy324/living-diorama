# Agent guide

Instructions for AI coding agents (and humans) working in this repository. `CLAUDE.md` points here.

## Project

Living Diorama is a Windows 11 desktop companion strip showing a small living 3D diorama. It is a pnpm monorepo: a Tauri 2 + React app in `apps/desktop`, engine packages in `packages/*`, and dev tooling in `tools/development`. See [README.md](README.md) for the layout and [docs/development.md](docs/development.md) for toolchain setup.

## Design docs are private

- The spec, roadmap and project blueprint live in a **separate private repo**, [`zhangwy324/living-diorama-design`](https://github.com/zhangwy324/living-diorama-design). It is cloned into `docs/design/`, which is **gitignored** in this repo.
- **Update design docs in the private repo only.** Commit and push changes from inside `docs/design/`. Never copy them into this repo.
- This repo is **public**. Don't paste design-doc content into files, commits, PRs or issues here. Referring to a section (e.g. "roadmap §1.4") is fine.
- Developer-facing docs stay in this repo: `docs/development.md` and architecture decision records in `docs/adr/`.
- `docs/design/` exists only in the main checkout, not in worktrees. From a worktree, read the design docs at `<main checkout>/docs/design/`.

## Development workflow

1. **Never commit directly to `main`.** All work happens on a feature branch named `<type>/<short-description>`, where `<type>` is `feat`, `fix`, `docs`, `refactor`, `test` or `chore` (e.g. `feat/region-graph`).
2. **Use a git worktree per task** so several tasks can run in parallel without disturbing each other. Create worktrees next to the main checkout:

   ```bash
   git worktree add ../living-diorama.worktrees/feat-region-graph -b feat/region-graph origin/main
   ```

   Then run `pnpm install` inside the new worktree. Remove it when the branch is merged:

   ```bash
   git worktree remove ../living-diorama.worktrees/feat-region-graph
   ```

3. **Open a pull request** to `main` when the work is ready (`gh pr create`).
4. **CI must pass before merging.** Run `pnpm check` locally first, plus `pnpm test:rust` when `apps/desktop/src-tauri` changed. CI also runs the Windows Tauri build and the Rust tests.
5. **Soak simulation changes before the PR.** CI doesn't run the soak, so run it locally:
   - `pnpm soak:quick` (about 1 min) before opening any PR that touches `packages/simulation`, navigation, world content (`packages/built-in-content`, worldgen) or save/restore.
   - `pnpm soak` (about 4 min on 16 logical cores; it runs one seed per core at a time) only when the PR changes simulation, navigation or save logic substantially: new movement or navigation rules, new behaviours, save format changes. Run it once before the PR is ready, not on every fix round.
   - Renderer, Studio, docs and app-only PRs need neither.

### Worktree caveats

- Each worktree has its own `node_modules` and Rust `target/`. The first `pnpm install` is fast because pnpm reuses its store, but the first Rust build in a new worktree compiles from scratch.
- `pnpm dev` uses fixed port 17420, so only one worktree can run the dev app at a time.

## Backward compatibility

The game has no real users yet, so **backward compatibility is not required** until the project owner says the game has been released to real users. Until then:

- Library files, saves, content formats, worker protocols and settings may change freely. Old versions may break.
- Migrations are optional. Write one only when it is cheap. Bump `schemaVersion` when a format changes, but a change needs no migration (this relaxes ADR 0003 §1 for now).
- Don't add compatibility shims, fallbacks for old formats or deprecation paths.

Only the project owner lifts this. Until they do, don't treat it as lifted, whatever a release tag or version number says.

## Commands

| Command            | Purpose                                          |
| ------------------ | ------------------------------------------------ |
| `pnpm check`       | Lint, format check, typecheck, boundaries, test  |
| `pnpm test:rust`   | Rust unit tests of the desktop shell             |
| `pnpm soak:quick`  | Short soak: 3 seeds × one simulated day (~1 min) |
| `pnpm soak`        | Full soak: 32 seeds × one simulated day (~4 min) |
| `pnpm dev`         | Run the desktop app with hot reload              |
| `pnpm build`       | Typecheck and build the web frontend             |
| `pnpm tauri build` | Build the Windows executable                     |

## Architecture rules (enforced in CI)

- `simulation` is headless. It must not import `three`, `react`, `@tauri-apps/*`, Node built-ins or DOM APIs.
- `renderer` may import only **types** from `simulation`. It never mutates simulation state.
- Only `apps/desktop` and `tools/development` may import content packs such as `built-in-content`. A pack registers through `extension-api` like any third-party pack.
- Engine code must not branch on content IDs (`id === "core:bridge"`). Use affordances and capabilities instead.
- Import other workspace packages through their public `index.ts` only.

Rationale is in [ADR 0001](docs/adr/0001-monorepo-tooling.md). Each package's README says what it owns and what it must not do.

## Environment notes

- Development is Windows-native (PowerShell or Git Bash), not WSL.
- Line endings are LF everywhere except `.bat`/`.cmd`/`.ps1`.
- Adding a workspace dependency needs both a `package.json` entry and a `references` entry in the package's `tsconfig.json`.

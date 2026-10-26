// Architectural boundary rules (roadmap §1.4). Run with `pnpm boundaries`; CI fails on any error.
// Paths are matched after resolution, so workspace imports resolve to packages/<name>/src/...
// Unresolvable modules keep their bare name, hence the `(^|/)name(/|$)` patterns.

const UI_OR_HOST_LIBS = "(^|/)(three|react|react-dom|@tauri-apps/[^/]+)(/|$)";

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "simulation-is-headless",
      comment:
        "simulation must run in Node and in a Web Worker: no three, react, Tauri, or DOM-bound libraries.",
      severity: "error",
      from: { path: "^packages/simulation/" },
      to: { path: UI_OR_HOST_LIBS },
    },
    {
      name: "simulation-no-node-builtins",
      comment: "simulation also runs in a Web Worker, where Node built-ins do not exist.",
      severity: "error",
      from: { path: "^packages/simulation/", pathNot: "\\.test\\.ts$" },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "simulation-no-presentation-packages",
      severity: "error",
      from: { path: "^packages/simulation/" },
      to: { path: "^packages/(renderer|desktop-integration)/" },
    },
    {
      name: "renderer-reads-simulation-types-only",
      comment:
        "renderer only reads snapshots and events; it may import simulation types but never runtime code.",
      severity: "error",
      from: { path: "^packages/renderer/" },
      to: { path: "^packages/simulation/", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "only-desktop-integration-talks-to-tauri",
      comment:
        "OS calls go through desktop-integration's OS-neutral interface (ADR 0008), so other platforms can be added there.",
      severity: "error",
      from: { path: "^(apps|packages|tools)/", pathNot: "^packages/desktop-integration/" },
      to: { path: "(^|/)@tauri-apps/(api|plugin-[^/]+)(/|$)" },
    },
    {
      name: "engine-does-not-import-built-in-content",
      comment:
        "built-in-content registers through extension-api like any third-party pack; only apps and dev tools may import it.",
      severity: "error",
      from: { path: "^packages/", pathNot: "^packages/built-in-content/" },
      to: { path: "^packages/built-in-content/" },
    },
    {
      name: "packages-do-not-import-apps-or-tools",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^(apps|tools)/" },
    },
    {
      name: "no-deep-imports-across-packages",
      comment: "Import other workspace packages through their public index only.",
      severity: "error",
      from: { path: "^(?:apps|packages|tools)/([^/]+)/" },
      to: {
        path: "^(?:apps|packages|tools)/[^/]+/",
        pathNot: ["^(?:apps|packages|tools)/$1/", "^packages/[^/]+/src/index\\.ts$"],
      },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "no-undeclared-dependencies",
      comment: "Every npm dependency must be declared in a package.json.",
      severity: "error",
      from: {},
      to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(node_modules|dist|\\.tsbuild|target|gen)/" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    combinedDependencies: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".d.ts", ".js", ".mjs", ".cjs", ".json"],
    },
  },
};

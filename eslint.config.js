import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

// Matches namespaced content IDs such as "core:bridge".
const CONTENT_ID = "/^[a-z0-9_-]+:[a-z0-9_./-]+$/";

export default tseslint.config(
  {
    ignores: ["**/dist/", "**/.tsbuild/", "**/src-tauri/target/", "**/src-tauri/gen/"],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ["*.{js,ts}", "apps/*/*.{js,ts}"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["*.cjs"],
    languageOptions: { globals: globals.node, sourceType: "commonjs" },
  },
  {
    files: ["apps/desktop/src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    ...reactHooks.configs.flat.recommended,
  },
  {
    // Roadmap §1.4: engine code must not branch on content names; behavior comes from
    // affordances and capabilities. Content packages and tests are exempt.
    files: ["packages/*/src/**/*.{ts,tsx}"],
    ignores: ["packages/built-in-content/**", "**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: `BinaryExpression[operator=/^[!=]==?$/] > Literal[value=${CONTENT_ID}]`,
          message: "Do not branch on content IDs; use affordances or capabilities instead.",
        },
        {
          selector: `SwitchCase > Literal[value=${CONTENT_ID}]`,
          message: "Do not branch on content IDs; use affordances or capabilities instead.",
        },
      ],
    },
  },
  prettier,
);

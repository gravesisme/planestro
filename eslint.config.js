// Lint (#407): a small, type-aware rule set for signal, not style.
// - no-floating-promises: a promise nobody awaits or catches loses its rejection.
// - no-unused-vars: dead imports and locals (`_`-prefixed names are deliberate).
// - no-explicit-any: `any` creeping into ports and engine code. The `any`s that were already in
//   src when this landed are grandfathered in eslint-suppressions.json (a ratchet: a file may lose
//   them, never gain one); tests and spikes cast fakes freely and are exempt.
// - react-hooks/rules-of-hooks: hooks only at a component's top level (packages/web).
// Typecheck stays `npm run typecheck`; this does not repeat what tsc already checks.
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default defineConfig(
  {
    ignores: [".claude/**", "**/node_modules/**", "**/dist/**", "site/**", "plugins/**", "**/*.js", "**/*.mjs", "**/*.cjs"],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: ["packages/*/test/**", "spikes/**", "vitest.config.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    files: ["packages/web/**/*.ts", "packages/web/**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: { "react-hooks/rules-of-hooks": "error" },
  },
);

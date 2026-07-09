import js from "@eslint/js";
import tseslint from "typescript-eslint";
import jsxA11y from "eslint-plugin-jsx-a11y";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Type-checked layer for the pure-TS packages. We deliberately enable only
  // no-floating-promises here rather than the full recommendedTypeChecked preset:
  // the preset surfaces ~12 mostly-noise errors (require-await in test files,
  // no-unnecessary-type-assertion) that are out of scope for a low-risk hygiene
  // pass. no-floating-promises is the high-value rule — it catches unawaited
  // async calls — and is clean today.
  // TODO(CQ2-TOOLING): evaluate the full ...tseslint.configs.recommendedTypeChecked
  // as its own dedicated batch (fix/silence require-await in tests first).
  {
    files: ["packages/core/**/*.ts", "packages/cli/**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: { "@typescript-eslint/no-floating-promises": "error" },
  },
  { plugins: { "jsx-a11y": jsxA11y }, rules: { "jsx-a11y/alt-text": "error" } },
  { ignores: ["**/dist/**", "**/.next/**", "**/node_modules/**"] },
);

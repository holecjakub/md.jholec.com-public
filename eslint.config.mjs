import js from "@eslint/js";
import tseslint from "typescript-eslint";
import jsxA11y from "eslint-plugin-jsx-a11y";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { plugins: { "jsx-a11y": jsxA11y }, rules: { "jsx-a11y/alt-text": "error" } },
  { ignores: ["**/dist/**", "**/.next/**", "**/node_modules/**"] },
);

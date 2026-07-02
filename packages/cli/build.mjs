import { build } from "esbuild";
import { chmodSync } from "node:fs";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/index.mjs",
  // commander (CJS) uses require() internally; provide it in the ESM output.
  banner: {
    js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
  },
});

chmodSync("dist/index.mjs", 0o755);

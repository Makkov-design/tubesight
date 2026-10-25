// Bundles the server and all its dependencies into one file, dist/tubesight.mjs.
// The file is committed, so `npx github:Makkov-design/tubesight` starts without installing or compiling anything.
// The shebang comes from src/index.ts; `.mjs` keeps the file an ES module wherever it is copied.
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/tubesight.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "eof",
  // Bundled CommonJS dependencies call require(); give them one in the ESM output.
  banner: {
    js: [
      'import { createRequire as __tubesightCreateRequire } from "node:module";',
      "const require = __tubesightCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "warning",
});

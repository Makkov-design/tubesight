// Bundles the server and all its dependencies into one file, dist/ytlens.mjs.
// The file is committed, so `npx github:Makkov-design/ytlens` starts without installing or compiling anything.
// The shebang comes from src/index.ts; `.mjs` keeps the file an ES module wherever it is copied.
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/ytlens.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "eof",
  // Bundled CommonJS dependencies call require(); give them one in the ESM output.
  banner: {
    js: [
      'import { createRequire as __ytlensCreateRequire } from "node:module";',
      "const require = __ytlensCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "warning",
});

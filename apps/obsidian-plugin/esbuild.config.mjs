import esbuild from "esbuild";
import builtins from "builtin-modules";
import { copyFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/autocomplete", "@codemirror/collab", "@codemirror/commands", "@codemirror/language", "@codemirror/lint", "@codemirror/search", "@codemirror/state", "@codemirror/view", "@lezer/common", "@lezer/highlight", "@lezer/lr", ...builtins],
  format: "cjs",
  platform: "node",
  target: "es2018",
  logLevel: "info",
  outfile: "main.js"
});

// sql.js ships its SQLite engine as a WASM binary. It cannot be bundled into main.js,
// so it is copied alongside main.js and read from disk at runtime (see serverManager.ts).
copyFileSync(require.resolve("sql.js/dist/sql-wasm.wasm"), "sql-wasm.wasm");

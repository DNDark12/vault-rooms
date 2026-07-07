import esbuild from "esbuild";
import builtins from "builtin-modules";

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // sql.js ships its SQLite engine as a WASM binary. The community-plugin installer only ever
  // downloads main.js/manifest.json/styles.css from a GitHub release - any extra file (like a
  // standalone sql-wasm.wasm) never reaches end users. So the WASM binary is embedded directly
  // into main.js at build time via esbuild's "binary" loader (base64-encoded, decoded into a
  // Uint8Array at load time) instead of being shipped and read from disk - see serverManager.ts.
  loader: { ".wasm": "binary" },
  external: ["obsidian", "electron", "@codemirror/autocomplete", "@codemirror/collab", "@codemirror/commands", "@codemirror/language", "@codemirror/lint", "@codemirror/search", "@codemirror/state", "@codemirror/view", "@lezer/common", "@lezer/highlight", "@lezer/lr", ...builtins],
  format: "cjs",
  platform: "node",
  target: "es2018",
  logLevel: "info",
  outfile: "main.js"
});

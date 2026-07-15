import esbuild from "esbuild";
import builtins from "builtin-modules";
import { writeFile } from "node:fs/promises";

const result = await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // sql.js ships its SQLite engine as a WASM binary. The community-plugin installer only ever
  // downloads main.js/manifest.json/styles.css from a GitHub release - any extra file (like a
  // standalone sql-wasm.wasm) never reaches end users. So the WASM binary is embedded directly
  // into main.js at build time via esbuild's "binary" loader (base64-encoded, decoded into a
  // Uint8Array at load time) instead of being shipped and read from disk - see serverManager.ts.
  loader: { ".wasm": "binary" },
  // The plugin always uses ws' pure-JS fallbacks. Folding these documented ws switches removes
  // process.env probes and unreachable optional-native require() branches from the shipped bundle.
  define: {
    "process.env.WS_NO_BUFFER_UTIL": "true",
    "process.env.WS_NO_UTF_8_VALIDATE": "true"
  },
  external: ["obsidian", "electron", "bufferutil", "utf-8-validate", "@codemirror/autocomplete", "@codemirror/collab", "@codemirror/commands", "@codemirror/language", "@codemirror/lint", "@codemirror/search", "@codemirror/state", "@codemirror/view", "@lezer/common", "@lezer/highlight", "@lezer/lr", ...builtins],
  format: "cjs",
  platform: "node",
  target: "es2018",
  minify: true,
  legalComments: "eof",
  logLevel: "info",
  outfile: "main.js",
  write: false
});

const output = result.outputFiles.find((file) => file.path.endsWith("main.js"));
if (!output) {
  throw new Error("esbuild did not produce main.js");
}
// Some preserved third-party license blocks contain line-end spaces. Normalize only whitespace at
// EOL so the committed artifact remains license-complete and passes git diff --check reproducibly.
await writeFile("main.js", output.text.replace(/[\t ]+$/gm, ""));

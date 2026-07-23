import esbuild from "esbuild";
import builtins from "builtin-modules";
import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

// yjs (and transitively y-codemirror.next) depend on lib0, whose logging/environment-detection
// modules read `process.env`/`process.argv`/`process.stdout.isTTY` at module load time and call
// `console.log` for their generic "print" helper - both of which are things this bundle must never
// contain (CLAUDE.md rules 3 and 13). Neither is reachable through a `define`-able static branch
// (lib0/environment.js's `getVariable` does a *dynamic* `process.env[computedKey]` lookup, not a
// literal `process.env.NAME` esbuild's `define` can match), so this plugin substitutes lib0's own
// logging/environment modules for local shims that preserve their exported API but never touch
// `process.env` and never call `console.log` (see src/vendor-shims/lib0-*.js for the full
// rationale). The filter matches the *resolved* absolute path, so it applies no matter which of
// lib0's node/browser/bun export conditions esbuild would otherwise have picked.
const lib0ShimPlugin = {
  name: "lib0-shims",
  setup(build) {
    build.onLoad({ filter: /\/lib0\/environment\.js$/ }, async () => ({
      contents: await readFile(here + "src/vendor-shims/lib0-environment.js", "utf8"),
      loader: "js"
    }));
    build.onLoad({ filter: /\/lib0\/logging(\.node)?\.js$/ }, async () => ({
      contents: await readFile(here + "src/vendor-shims/lib0-logging.js", "utf8"),
      loader: "js"
    }));
  }
};

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
  plugins: [lib0ShimPlugin],
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

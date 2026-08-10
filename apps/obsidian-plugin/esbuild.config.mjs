import esbuild from "esbuild";
import builtins from "builtin-modules";
import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

// Replace lib0 modules that introduce forbidden environment and logging calls.
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
  // Embed SQLite WASM because plugin releases ship only standard artifacts.
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

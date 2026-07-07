import { copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = resolve(root, "apps/obsidian-plugin");

// sql-wasm.wasm is no longer a separate asset - esbuild embeds it directly into main.js
// (see esbuild.config.mjs) so that a plain GitHub-release install (main.js/manifest.json/
// styles.css only) is fully self-contained.
for (const file of ["manifest.json", "main.js", "styles.css"]) {
  copyFileSync(resolve(pluginDir, file), resolve(root, file));
}

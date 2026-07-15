import { copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = resolve(root, "apps/obsidian-plugin");

for (const file of ["manifest.json", "main.js", "styles.css"]) {
  copyFileSync(resolve(pluginDir, file), resolve(root, file));
}

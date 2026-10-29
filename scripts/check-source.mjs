// Mechanical source rules, checked before the typecheck (pnpm typecheck). Each rule names what it prevents.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const RULES = [
  {
    // Every element becomes an argument: past about 100k elements this throws RangeError (a long history, say).
    pattern: /\b(push|unshift)\(\.\.\.|\bMath\.(max|min)\(\.\.\.|\bString\.(fromCharCode|fromCodePoint)\(\.\.\./,
    message: "spread of an array into arguments: use a loop (or reduce) so its length can't overflow the stack"
  }
];

function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) yield path;
  }
}

const problems = [];
for (const dir of ["packages/secure/src", "apps/obsidian-plugin/src"]) {
  for (const file of sources(join(root, dir))) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      for (const rule of RULES) if (rule.pattern.test(line)) problems.push(`${relative(root, file).replaceAll("\\", "/")}:${i + 1}: ${rule.message}`);
    });
  }
}
for (const problem of problems) console.error(problem);
process.exit(problems.length > 0 ? 1 : 0);

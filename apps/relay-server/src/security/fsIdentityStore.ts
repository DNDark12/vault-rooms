import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { IdentityStore, PersistedIdentity } from "./identityStore.js";

export function createFsIdentityStore(directory: string): IdentityStore {
  const identityPath = join(directory, "identity.json");

  return {
    async load() {
      try {
        return JSON.parse(await readFile(identityPath, "utf8")) as PersistedIdentity;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },
    async save(persisted) {
      await mkdir(directory, { recursive: true });
      const temporaryPath = join(directory, `.identity.json.${randomBytes(16).toString("hex")}.tmp`);
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.chmod(0o600);
        await file.writeFile(`${JSON.stringify(persisted, null, 2)}\n`, "utf8");
        await file.sync();
      } catch (error) {
        await file.close();
        await unlink(temporaryPath).catch(() => {});
        throw error;
      }
      await file.close();
      try {
        await rename(temporaryPath, identityPath);
        await chmod(identityPath, 0o600);
      } catch (error) {
        await unlink(temporaryPath).catch(() => {});
        throw error;
      }
    }
  };
}

import type { DataAdapter } from "obsidian";

function replacementBackupPath(targetPath: string): string {
  return `${targetPath}.replace-backup`;
}

/** Restore the last complete file if a previous replacement stopped after moving it aside. */
export async function recoverDataAdapterFileReplacement(adapter: DataAdapter, targetPath: string): Promise<void> {
  const backupPath = replacementBackupPath(targetPath);
  if (await adapter.exists(targetPath)) {
    // The replacement reached its commit point; stale-backup cleanup is best effort and must not
    // stop startup from reading the valid target.
    if (await adapter.exists(backupPath)) {
      await adapter.remove(backupPath).catch(() => {});
    }
    return;
  }
  if (await adapter.exists(backupPath)) {
    await adapter.rename(backupPath, targetPath);
  }
}

/**
 * Replace a DataAdapter file without depending on rename-overwrite behavior. Obsidian's desktop
 * adapter rejects rename(source, target) when target already exists, so move the last complete
 * target aside first and restore it if promoting the temporary file fails.
 */
export async function replaceDataAdapterFile(
  adapter: DataAdapter,
  targetPath: string,
  writeTemporaryFile: (temporaryPath: string) => Promise<void>
): Promise<void> {
  const temporaryPath = `${targetPath}.tmp`;
  const backupPath = replacementBackupPath(targetPath);
  await recoverDataAdapterFileReplacement(adapter, targetPath);
  if (await adapter.exists(temporaryPath)) {
    await adapter.remove(temporaryPath);
  }

  let movedExistingTarget = false;
  try {
    await writeTemporaryFile(temporaryPath);
    if (await adapter.exists(targetPath)) {
      if (await adapter.exists(backupPath)) {
        await adapter.remove(backupPath);
      }
      await adapter.rename(targetPath, backupPath);
      movedExistingTarget = true;
    }
    await adapter.rename(temporaryPath, targetPath);
  } catch (error) {
    await adapter.remove(temporaryPath).catch(() => {});
    if (movedExistingTarget && !(await adapter.exists(targetPath)) && (await adapter.exists(backupPath))) {
      await adapter.rename(backupPath, targetPath).catch(() => {});
    }
    throw error;
  }

  if (movedExistingTarget) {
    // The target is already committed. A cleanup failure may leave an extra backup but must not
    // make callers roll their in-memory state back while the new image is durable on disk.
    await adapter.remove(backupPath).catch(() => {});
  }
}

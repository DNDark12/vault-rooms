import { isEligibleBinaryPath } from "@vault-rooms/protocol";

export type VaultChangeEvent = { type: "create" | "modify" | "delete"; path: string };

export interface VaultAdapter {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  /** Byte-accurate read for images/PDFs - `read()` decodes as UTF-8 text and corrupts these. */
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
  /** Returns an unsubscribe function - callers are responsible for calling it once they no longer
   *  need this particular registration (e.g. a room was unmounted), otherwise the listener stays
   *  registered for the plugin's whole lifetime. */
  onChange(cb: (event: VaultChangeEvent) => void): () => void;
}

export type RelayFileApi = {
  readFile(roomId: string, relativePath: string): Promise<{ relativePath: string; version: number; sha256: string; content: string }>;
  writeFile(roomId: string, relativePath: string, baseVersion: number, content: string): Promise<{ ok: true; relativePath: string; version: number; sha256: string }>;
  deleteFile(roomId: string, relativePath: string, baseVersion: number): Promise<void>;
};

export type MountedFileState = {
  serverVersion: number;
  serverSha256: string | null;
  localSha256: string | null;
  dirty: boolean;
};

export type MountedRoomState = {
  roomId: string;
  mountPath: string;
  files: Record<string, MountedFileState>;
};

export function mountPathForRoom(input: {
  owner: boolean;
  mountRoot: string;
  mountName: string;
  sourcePath: string;
}): string {
  return input.owner ? stripSlashes(input.sourcePath) : [stripSlashes(input.mountRoot), input.mountName].map(stripSlashes).join("/");
}

export async function createConflictCopyPath(vault: VaultAdapter, path: string, deviceName: string, now = new Date()): Promise<string> {
  const slash = path.lastIndexOf("/");
  const directory = slash >= 0 ? path.slice(0, slash + 1) : "";
  const filename = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = filename.lastIndexOf(".");
  const basename = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : "";
  const timestamp = formatConflictTimestamp(now);
  const base = `${directory}${basename} (conflict ${deviceName} ${timestamp})`;
  let candidate = `${base}${extension}`;
  let suffix = 2;
  while (await vault.exists(candidate)) {
    candidate = `${base} ${suffix}${extension}`;
    suffix += 1;
  }
  return candidate;
}

export function isConflictCopyPath(path: string): boolean {
  return /\(conflict .+ \d{4}-\d{2}-\d{2}T\d{6}\)(?: \d+)?\.[^/]+$/.test(path);
}

const CONFLICT_SUFFIX = /\s\(conflict .+ \d{4}-\d{2}-\d{2}T\d{6}\)(?: \d+)?(?=\.[^/]+$)/;

/** Reverses createConflictCopyPath()'s naming: strips the inserted "(conflict ...)" suffix to get
 *  back the canonical path this conflict copy forked from. Returns null for a non-conflict path. */
export function canonicalPathForConflictCopy(path: string): string | null {
  if (!isConflictCopyPath(path)) {
    return null;
  }
  return path.replace(CONFLICT_SUFFIX, "");
}

export class VaultSyncEngine {
  constructor(
    private readonly vault: VaultAdapter,
    private readonly api: RelayFileApi,
    private readonly now: () => Date = () => new Date()
  ) {}

  static async sha256(content: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  /**
   * Reads a synced file's content as the string form used for hashing/transport: raw text for
   * Markdown/text/canvas/etc, or base64 for images/PDFs. `vault.read()` decodes bytes as UTF-8, so
   * it silently corrupts binary files - `isEligibleBinaryPath` (keyed off the room-relative path,
   * which shares the conflict copy's extension) picks the byte-accurate path instead.
   */
  private async readContent(path: string, relativePath: string): Promise<string> {
    if (isEligibleBinaryPath(relativePath)) {
      return arrayBufferToBase64(await this.vault.readBinary(path));
    }
    return this.vault.read(path);
  }

  private async writeContent(path: string, relativePath: string, content: string): Promise<void> {
    if (isEligibleBinaryPath(relativePath)) {
      await this.vault.writeBinary(path, base64ToArrayBuffer(content));
      return;
    }
    await this.vault.write(path, content);
  }

  async applyRemoteChange(
    room: MountedRoomState,
    remote: { relativePath: string; version: number; sha256: string; content: string },
    deviceName: string
  ): Promise<void> {
    const path = mountedPath(room, remote.relativePath);
    const existingState = room.files[remote.relativePath];
    if (existingState?.dirty && (await this.vault.exists(path))) {
      const local = await this.readContent(path, remote.relativePath);
      await this.writeContent(await createConflictCopyPath(this.vault, path, deviceName, this.now()), remote.relativePath, local);
    }
    await this.writeContent(path, remote.relativePath, remote.content);
    room.files[remote.relativePath] = {
      serverVersion: remote.version,
      serverSha256: remote.sha256,
      localSha256: await VaultSyncEngine.sha256(remote.content),
      dirty: false
    };
  }

  async applyRemoteDelete(
    room: MountedRoomState,
    remote: { relativePath: string; version: number },
    deviceName: string
  ): Promise<void> {
    const path = mountedPath(room, remote.relativePath);
    const existingState = room.files[remote.relativePath];
    if (existingState?.dirty && (await this.vault.exists(path))) {
      const local = await this.readContent(path, remote.relativePath);
      await this.writeContent(await createConflictCopyPath(this.vault, path, deviceName, this.now()), remote.relativePath, local);
    }
    if (await this.vault.exists(path)) {
      await this.vault.delete(path);
    }
    room.files[remote.relativePath] = {
      serverVersion: remote.version,
      serverSha256: null,
      localSha256: null,
      dirty: false
    };
  }

  async pushLocalChange(room: MountedRoomState, relativePath: string, deviceName: string): Promise<void> {
    if (isConflictCopyPath(relativePath)) {
      return;
    }
    const path = mountedPath(room, relativePath);
    const content = await this.readContent(path, relativePath);
    const current = room.files[relativePath];
    const localSha = await VaultSyncEngine.sha256(content);
    if (current?.serverSha256 === localSha) {
      room.files[relativePath] = { ...current, localSha256: localSha, dirty: false };
      return;
    }

    const baseVersion = current?.serverVersion ?? 0;
    try {
      const result = await this.api.writeFile(room.roomId, relativePath, baseVersion, content);
      room.files[relativePath] = {
        serverVersion: result.version,
        serverSha256: result.sha256,
        localSha256: localSha,
        dirty: false
      };
    } catch (error) {
      if (isVersionConflict(error)) {
        await this.writeContent(await createConflictCopyPath(this.vault, path, deviceName, this.now()), relativePath, content);
        await this.writeContent(path, relativePath, error.serverContent);
        room.files[relativePath] = {
          serverVersion: error.serverVersion,
          serverSha256: error.serverSha256,
          localSha256: await VaultSyncEngine.sha256(error.serverContent),
          dirty: false
        };
        return;
      }
      throw error;
    }
  }

  /**
   * Resolves a local conflict copy against its canonical file. Conflict copies never sync (see
   * isConflictCopyPath checks above) - they're purely a local safety net - so this only ever
   * touches files on this one device:
   * - "mine": overwrite the canonical file with the conflict copy's content and push it as a new
   *   version, then remove the now-redundant conflict copy.
   * - "theirs": keep the canonical file as-is (it already holds the version that won) and just
   *   remove the conflict copy.
   */
  async resolveConflict(room: MountedRoomState, relativePath: string, conflictRelativePath: string, keep: "mine" | "theirs", deviceName: string): Promise<void> {
    const conflictPath = mountedPath(room, conflictRelativePath);
    if (keep === "theirs") {
      if (await this.vault.exists(conflictPath)) {
        await this.vault.delete(conflictPath);
      }
      return;
    }
    if (!(await this.vault.exists(conflictPath))) {
      // Someone (or a previous click) already removed the conflict copy - nothing left to keep.
      return;
    }
    const path = mountedPath(room, relativePath);
    const conflictContent = await this.readContent(conflictPath, relativePath);
    await this.writeContent(path, relativePath, conflictContent);
    if (await this.vault.exists(conflictPath)) {
      await this.vault.delete(conflictPath);
    }
    await this.pushLocalChange(room, relativePath, deviceName);
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("base64");
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const buffer = Buffer.from(base64, "base64");
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function mountedPath(room: MountedRoomState, relativePath: string): string {
  return `${stripSlashes(room.mountPath)}/${stripSlashes(relativePath)}`;
}

function stripSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function formatConflictTimestamp(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
}

function isVersionConflict(error: unknown): error is {
  code: "VERSION_CONFLICT";
  serverVersion: number;
  serverSha256: string;
  serverContent: string;
} {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "VERSION_CONFLICT";
}

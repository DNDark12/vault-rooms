export type VaultChangeEvent = { type: "create" | "modify" | "delete"; path: string };

export interface VaultAdapter {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
  onChange(cb: (event: VaultChangeEvent) => void): void;
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
  teamSlug: string;
  mountName: string;
  sourcePath: string;
}): string {
  return input.owner ? stripSlashes(input.sourcePath) : [stripSlashes(input.mountRoot), input.teamSlug, input.mountName].map(stripSlashes).join("/");
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

  async applyRemoteChange(
    room: MountedRoomState,
    remote: { relativePath: string; version: number; sha256: string; content: string },
    deviceName: string
  ): Promise<void> {
    const path = mountedPath(room, remote.relativePath);
    const existingState = room.files[remote.relativePath];
    if (existingState?.dirty && (await this.vault.exists(path))) {
      const local = await this.vault.read(path);
      await this.vault.write(await createConflictCopyPath(this.vault, path, deviceName, this.now()), local);
    }
    await this.vault.write(path, remote.content);
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
      const local = await this.vault.read(path);
      await this.vault.write(await createConflictCopyPath(this.vault, path, deviceName, this.now()), local);
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
    const content = await this.vault.read(path);
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
        await this.vault.write(await createConflictCopyPath(this.vault, path, deviceName, this.now()), content);
        await this.vault.write(path, error.serverContent);
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

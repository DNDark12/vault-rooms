import type { FileRow } from "../db/schema.js";
import { AppError, contentTypeForPath, type ContentType } from "@vault-rooms/protocol";
import type { FileDeleteResult, FileWriteResult, RelayRepository } from "../db/repositories/relayRepository.js";
import type { BlobStore } from "./blobStore.js";

/** Decodes transport content to raw stored bytes. */
export function decodeTransportContent(content: string, contentType: ContentType): Buffer {
  return contentType === "binary" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
}

/** Re-encodes raw bytes in the canonical wire format. */
export function encodeRawBytesAsTransportContent(bytes: Uint8Array, contentType: ContentType): string {
  return Buffer.from(bytes).toString(contentType === "binary" ? "base64" : "utf8");
}

export type ContentWriteService = {
  writeFile(input: {
    roomId: string;
    relativePath: string;
    baseVersion: number;
    content: string;
    actorUserId: string;
    /** Whether the caller may read this file: only then does a conflict carry the server's copy. */
    revealServerContent?: boolean;
    /** A whole-file-lane write, rechecked against the room's live-editing mode as it commits. */
    wholeFileLane?: boolean;
  }): Promise<FileWriteResult>;
  materializeCrdtContent(input: {
    fileId: string;
    epoch: number;
    content: string;
    actorUserId: string;
  }): Promise<{ version: number; sha256: string } | null>;
  readFileContent(input: { roomId: string; relativePath: string }): Promise<{ file: FileRow; content: string }>;
  deleteFile(input: {
    roomId: string;
    relativePath: string;
    baseVersion: number;
    actorUserId: string;
    crdtAuthoritative?: boolean;
  }): Promise<FileDeleteResult>;
  collectOrphanedBlobKeys(keys: string[]): Promise<void>;
  migrateLegacyContentBatch(batchSize: number): Promise<{ processedCount: number; done: boolean }>;
  sweepOrphanedBlobStoreBatch(batchSize: number): Promise<{ processedCount: number; done: boolean }>;
};

/** Coordinates blob I/O with synchronous metadata transactions. */
export function createContentWriteService(repo: RelayRepository, blobStore: BlobStore): ContentWriteService {
  let accessTail = Promise.resolve();

  const withBlobAccess = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = accessTail;
    let release!: () => void;
    accessTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const collect = async (keys: string[] | undefined, bestEffort = false): Promise<void> => {
    const unreferenced = [...new Set(keys ?? [])].filter((key) => !repo.isBlobKeyReferenced(key));
    if (unreferenced.length === 0) {
      return;
    }
    // The in-memory image already dropped these references, but the on-disk one is written on a
    // delay and may still hold them. Persist it first: deleting before that lets a crash reopen
    // metadata that points at a blob which no longer exists. A failed flush keeps the blobs; the
    // orphan sweep reclaims them later.
    try {
      await repo.flush();
    } catch (error) {
      if (!bestEffort) throw error;
      return;
    }
    for (const key of unreferenced) {
      if (!repo.isBlobKeyReferenced(key)) {
        try {
          await blobStore.delete(key);
        } catch (error) {
          if (!bestEffort) throw error;
        }
      }
    }
  };

  const enrichConflict = async (error: unknown, revealServerContent: boolean): Promise<never> => {
    if (!(error instanceof AppError) || error.code !== "VERSION_CONFLICT") {
      throw error;
    }
    const details = error.details as
      | { serverBlobKey?: string; serverContentType?: ContentType; serverVersion?: number; serverSha256?: string | null }
      | undefined;
    if (!revealServerContent) {
      // The content and its fingerprint belong to callers who may read the file.
      throw new AppError(error.code, error.message, error.statusCode, { serverVersion: details?.serverVersion });
    }
    if (!details?.serverBlobKey || !details.serverContentType) {
      throw error;
    }
    const bytes = await blobStore.get(details.serverBlobKey);
    if (!bytes) {
      throw new Error(`Missing referenced blob: ${details.serverBlobKey}`);
    }
    throw new AppError(error.code, error.message, error.statusCode, {
      serverVersion: details.serverVersion,
      serverSha256: details.serverSha256,
      serverContent: encodeRawBytesAsTransportContent(bytes, details.serverContentType)
    });
  };

  return {
    async writeFile(input) {
      return withBlobAccess(async () => {
        const { revealServerContent = false, ...write } = input;
        const bytes = decodeTransportContent(write.content, contentTypeForPath(write.relativePath));
        const blobKey = await blobStore.put(bytes);
        try {
          const result = await repo.withExclusiveAccess(() => repo.writeFile({ ...write, blobKey }));
          await collect(result.orphanedBlobKeys, true);
          const { orphanedBlobKeys: _ignored, ...publicResult } = result;
          return publicResult;
        } catch (error) {
          if (!repo.isBlobKeyReferenced(blobKey)) {
            await collect([blobKey], true);
          }
          return enrichConflict(error, revealServerContent);
        }
      });
    },
    async materializeCrdtContent(input) {
      return withBlobAccess(async () => {
        const blobKey = await blobStore.put(Buffer.from(input.content, "utf8"));
        const result = await repo.withExclusiveAccess(() => repo.materializeCrdtContent({ ...input, blobKey }));
        if (!result) {
          if (!repo.isBlobKeyReferenced(blobKey)) {
            await collect([blobKey], true);
          }
          return null;
        }
        await collect(result.orphanedBlobKeys, true);
        return { version: result.version, sha256: result.sha256 };
      });
    },
    async readFileContent(input) {
      return withBlobAccess(async () => {
        const { file, content, blobKey } = repo.readFileContent(input.roomId, input.relativePath);
        if (blobKey) {
          const bytes = await blobStore.get(blobKey);
          if (!bytes) {
            throw new Error(`Missing referenced blob: ${blobKey}`);
          }
          return { file, content: encodeRawBytesAsTransportContent(bytes, contentTypeForPath(file.relative_path)) };
        }
        if (content === null) {
          throw new Error("Missing legacy file content");
        }
        return { file, content };
      });
    },
    async deleteFile(input) {
      return withBlobAccess(async () => {
        const result = await repo.withExclusiveAccess(() => repo.deleteFile(input));
        await collect(result.orphanedBlobKeys, true);
        const { orphanedBlobKeys: _ignored, ...publicResult } = result;
        return publicResult;
      });
    },
    async collectOrphanedBlobKeys(keys) {
      await withBlobAccess(() => collect(keys, true));
    },
    async migrateLegacyContentBatch(batchSize) {
      return withBlobAccess(async () => {
        const references = await repo.withExclusiveAccess(() => repo.listLegacyContentReferences(batchSize));
        let processedCount = 0;
        for (const reference of references) {
          const bytes = decodeTransportContent(reference.content, reference.contentType);
          const blobKey = await blobStore.put(bytes);
          const migrated = await repo.withExclusiveAccess(() =>
            repo.migrateLegacyContentReference({
              ...reference,
              blobKey,
              rawSizeBytes: bytes.byteLength
            })
          );
          if (migrated) {
            processedCount += 1;
          } else if (!repo.isBlobKeyReferenced(blobKey)) {
            await collect([blobKey], true);
          }
        }
        const done = await repo.withExclusiveAccess(() => !repo.hasLegacyContentReferences());
        return { processedCount, done };
      });
    },
    async sweepOrphanedBlobStoreBatch(batchSize) {
      return withBlobAccess(async () => {
        const orphanKeys = (await blobStore.list()).filter((key) => !repo.isBlobKeyReferenced(key));
        const batch = orphanKeys.slice(0, batchSize);
        await collect(batch);
        return { processedCount: batch.length, done: batch.length === orphanKeys.length };
      });
    }
  };
}

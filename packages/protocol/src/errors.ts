export type ErrorCode =
  | "UNAUTHORIZED"
  | "PERMISSION_DENIED"
  | "VERSION_CONFLICT"
  | "FILE_EXISTS"
  | "FILE_DELETED"
  | "FILE_TOO_LARGE"
  | "INVALID_PATH"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "ADAPTER_CONFLICT"
  | "RATE_LIMITED"
  | "TLS_REQUIRED"
  // --- CRDT sync (docs/superpowers/plans/2026-07-20-crdt-sync.md Phase 4) ---
  | "CRDT_DISABLED"
  | "CRDT_CAPABILITY_REQUIRED"
  | "CRDT_STALE_EPOCH"
  | "CRDT_INVALID_UPDATE"
  // Phase 6, contract 1.4 ("decided-for-now: reject"): a legacy whole-file REST PUT or WS
  // file_change targeting a path that is CRDT-enabled (room.crdt_enabled && isCrdtEligiblePath)
  // is rejected with this code rather than silently diff-applied or corrupting the document -
  // legacy clients keep read compatibility (GET / remote_file_change stay materialized-fresh)
  // but must use the CRDT message types (or upgrade) to write.
  | "CRDT_WRITE_UNSUPPORTED";

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly statusCode = 400,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export function toApiError(error: AppError): { error: { code: ErrorCode; message: string; details?: unknown } } {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details })
    }
  };
}

export type ErrorCode =
  | "UNAUTHORIZED"
  | "PERMISSION_DENIED"
  | "VERSION_CONFLICT"
  | "FILE_EXISTS"
  | "FILE_DELETED"
  | "FILE_TOO_LARGE"
  | "INVALID_PATH"
  | "PATH_COLLISION"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "ADAPTER_CONFLICT"
  | "RATE_LIMITED"
  | "TLS_REQUIRED"
  | "STORAGE_QUOTA_EXCEEDED"
  | "CRDT_DISABLED"
  | "CRDT_CAPABILITY_REQUIRED"
  | "CRDT_OPERATION_DEVICE_MISMATCH"
  | "CRDT_STALE_EPOCH"
  | "CRDT_INVALID_UPDATE"
  // Rejects whole-file writes to CRDT-owned paths.
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

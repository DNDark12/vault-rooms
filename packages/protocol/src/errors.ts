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
  | "ADAPTER_CONFLICT";

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

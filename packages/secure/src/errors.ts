/** Every failure from this package. `code` is stable and safe to show or log; it never carries secrets. */
export class SecureError extends Error {
  constructor(
    readonly code: string,
    message?: string
  ) {
    super(message ?? code);
    this.name = "SecureError";
  }
}

export function fail(code: string, message?: string): never {
  throw new SecureError(code, message);
}

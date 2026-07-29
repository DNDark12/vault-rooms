import type { Permission } from "@vault-rooms/protocol";

/**
 * Helpers for keeping wire identifiers out of `AppError` messages
 * (docs/superpowers/plans/2026-07-29-user-facing-error-messages.md).
 *
 * `AppError.message` is not a developer log line - it crosses the wire in the REST/WS error envelope
 * and the Obsidian plugin puts it straight into a `Notice`. A permission code or an env-var name in
 * that string is something a user reads and cannot act on. Codes and HTTP statuses are unaffected:
 * `ErrorCode` is behaviour (clients branch on it), the message is presentation.
 */

/** Renders a `Permission` as the action a user was stopped from doing. Exhaustive by design: no
 *  string-returning `default`, so adding to the union is a compile error rather than a silent
 *  fallthrough that leaks the raw code again. */
export function describePermission(permission: Permission): string {
  switch (permission) {
    case "room:read":
      return "see this room";
    case "room:write":
      return "change this room";
    case "room:delete":
      return "delete this room";
    case "file:read":
      return "read this file";
    case "file:write":
      return "edit this file";
    case "file:create":
      return "create files here";
    case "file:delete":
      return "delete this file";
    case "sync:subscribe":
      return "sync this room";
    case "sync:push":
      return "send changes for this file";
    default:
      return assertNever(permission);
  }
}

/**
 * The configured size cap as something a user can compare against a file in their vault.
 *
 * The unit steps down rather than always reporting megabytes: `MAX_FILE_BYTES` is operator-set and can
 * legitimately be small (the test suite runs with 32 and 1024), where a fixed "MB" rendering would
 * report "0 MB" and read as "nothing can ever be uploaded". Trailing `.0` is trimmed so the common
 * whole-unit case reads "5 MB", not "5.0 MB".
 */
export function formatFileLimit(bytes: number): string {
  const scale = (value: number, unit: string) =>
    `${Number.isInteger(value) ? value : Number(value.toFixed(1))} ${unit}`;
  if (bytes >= 1024 * 1024) return scale(bytes / (1024 * 1024), "MB");
  if (bytes >= 1024) return scale(bytes / 1024, "KB");
  return `${bytes} bytes`;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled permission: ${String(value)}`);
}

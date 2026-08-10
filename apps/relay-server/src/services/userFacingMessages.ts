import type { Permission } from "@vault-rooms/protocol";

/** Keeps wire identifiers out of user-facing error messages. */

/** Renders a permission as the blocked user action. */
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

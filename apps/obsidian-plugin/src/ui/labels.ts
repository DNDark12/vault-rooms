import type { WorkspaceState } from "@vault-rooms/secure";

/**
 * How people and computers are named wherever someone is picked or confirmed: names needn't be unique, so one that
 * another shares gets the start of its id, the same everywhere.
 */
export function personLabel(state: WorkspaceState, userId: string): string {
  const name = state.users[userId]?.name ?? "?";
  const twin = Object.entries(state.users).some(([other, user]) => other !== userId && !user.removed && user.name === name);
  return twin ? `${name} (${userId.slice(1, 5)})` : name;
}

/** A computer's name, told apart from another of the same person's by the start of its id, and whose it is. */
export function deviceLabel(state: WorkspaceState, deviceId: string): string {
  const device = state.devices[deviceId];
  if (!device) return "?";
  const twin = Object.entries(state.devices).some(([other, d]) => other !== deviceId && !d.revoked && d.user === device.user && d.name === device.name);
  return `"${twin ? `${device.name} (${deviceId.slice(1, 5)})` : device.name}" of ${personLabel(state, device.user)}`;
}

import { describe, expect, it } from "vitest";
import type { WorkspaceState } from "@vault-rooms/secure";
import { deviceLabel, personLabel } from "../../src/ui/labels.js";

const sam1 = `u${"A".repeat(22)}`;
const sam2 = `u${"B".repeat(22)}`;
const ana = `u${"C".repeat(22)}`;
const device = (user: string, name: string) => ({ user, name, sign: "", agree: "", tls: "" });
const state = {
  name: "Team",
  roomCreation: "admins",
  invites: {},
  rooms: {},
  users: { [sam1]: { name: "Sam", admin: false }, [sam2]: { name: "Sam", admin: false }, [ana]: { name: "Ana", admin: true } },
  devices: { [`d${"X".repeat(42)}`]: device(sam1, "Laptop"), [`d${"Y".repeat(42)}`]: device(sam1, "Laptop"), [`d${"Z".repeat(42)}`]: device(ana, "Laptop") }
} as unknown as WorkspaceState;

describe("labels", () => {
  it("tell apart people, and computers of one person, that share a name; others keep theirs", () => {
    expect(personLabel(state, sam1)).not.toBe(personLabel(state, sam2));
    expect(personLabel(state, sam1)).toMatch(/^Sam \(/);
    expect(personLabel(state, ana)).toBe("Ana");
    expect(deviceLabel(state, `d${"X".repeat(42)}`)).not.toBe(deviceLabel(state, `d${"Y".repeat(42)}`));
    expect(deviceLabel(state, `d${"Z".repeat(42)}`)).toBe('"Laptop" of Ana');
  });
});

import type { RelayFileApi } from "./syncClient.js";

export type RoomSummary = {
  id: string;
  name: string;
  type: "file" | "folder";
  sourcePath: string;
  mountName: string;
  ownerUserId: string;
  permissions: string[];
  capabilities: Array<{ pluginId: string; displayName: string; mode: string; minVersion?: string; installed: boolean | null }>;
};

export type TeamMemberSummary = {
  userId: string;
  displayName: string;
  role: "owner" | "admin" | "member";
  revokedAt: string | null;
};

export type AclRuleSummary = {
  id: string;
  teamId: string;
  roomId: string;
  subjectType: "user" | "role" | "device" | "agent";
  subjectId: string;
  effect: "allow" | "deny";
  permissions: string[];
  pathPattern: string;
  createdAt: string;
};

export class RelayApiClient implements RelayFileApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
    /**
     * Called whenever a request fails with UNAUTHORIZED - i.e. the token this client was built
     * with no longer resolves to an active device on this server. That happens whenever the
     * server's data was reset/recreated after the token was issued (e.g. testing, reinstalling,
     * or switching between embedded/standalone modes with different data files) - the token
     * itself isn't malformed, the server simply has no record of it. Lets the caller (the plugin)
     * flag the saved team as needing to be re-set-up/re-joined instead of just failing silently.
     */
    private readonly onUnauthorized?: () => void
  ) {}

  async testConnection(): Promise<{ ok: true; version: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    try {
      const response = await fetch(`${this.baseUrl}/health`, { signal: controller.signal });
      const body = await response.json();
      if (body.name !== "vault-rooms") {
        throw new Error("Something answered, but it is not a Vault Rooms server.");
      }
      return { ok: true, version: body.version };
    } finally {
      clearTimeout(timeout);
    }
  }

  async bootstrap(teamName: string, ownerDisplayName: string, ownerDeviceName: string) {
    return this.request("/api/teams/bootstrap", {
      method: "POST",
      body: { teamName, ownerDisplayName, ownerDeviceName }
    });
  }

  async createInvite(teamId: string, role: "member" | "admin" = "member") {
    return this.request(`/api/teams/${teamId}/invites`, {
      method: "POST",
      body: { role, expiresInMinutes: 60, maxUses: 1 }
    });
  }

  async listMembers(teamId: string): Promise<{ members: TeamMemberSummary[] }> {
    return this.request(`/api/teams/${teamId}/members`);
  }

  async revokeMember(teamId: string, userId: string, reason?: string): Promise<{ ok: true }> {
    return this.request(`/api/teams/${teamId}/members/${userId}/revoke`, {
      method: "POST",
      body: { reason: reason ?? "Revoked from Vault Rooms plugin" }
    });
  }

  async join(inviteToken: string, displayName: string, deviceName: string) {
    return this.request("/api/join", {
      method: "POST",
      body: { inviteToken, displayName, deviceName }
    });
  }

  async listRooms(teamId: string): Promise<{ rooms: RoomSummary[] }> {
    return this.request(`/api/teams/${teamId}/rooms`);
  }

  async createRoom(
    teamId: string,
    input: { name: string; type: "file" | "folder"; sourcePath: string; mountName: string; capabilities: Array<{ pluginId: string; displayName: string; mode: string; minVersion?: string }> }
  ) {
    return this.request(`/api/teams/${teamId}/rooms`, {
      method: "POST",
      body: input
    });
  }

  async updateRoom(
    roomId: string,
    input: { name: string; type: "file" | "folder"; sourcePath: string; mountName: string; capabilities: Array<{ pluginId: string; displayName: string; mode: string; minVersion?: string }> }
  ): Promise<{ room: RoomSummary }> {
    return this.request(`/api/rooms/${roomId}`, {
      method: "PATCH",
      body: input
    });
  }

  async grantAcl(roomId: string, input: { subjectType: "user" | "role" | "device" | "agent"; subjectId: string; effect: "allow" | "deny"; preset?: "reader" | "editor"; permissions?: string[]; pathPattern: string }) {
    return this.request(`/api/rooms/${roomId}/acl`, {
      method: "POST",
      body: input
    });
  }

  async listRoomAcl(roomId: string): Promise<{ aclRules: AclRuleSummary[] }> {
    return this.request(`/api/rooms/${roomId}/acl`);
  }

  async removeAcl(roomId: string, aclId: string): Promise<{ ok: true }> {
    return this.request(`/api/rooms/${roomId}/acl/${aclId}`, { method: "DELETE" });
  }

  async deleteRoom(roomId: string): Promise<{ ok: true }> {
    return this.request(`/api/rooms/${roomId}`, { method: "DELETE" });
  }

  async deleteTeam(teamId: string): Promise<{ ok: true }> {
    return this.request(`/api/teams/${teamId}`, { method: "DELETE" });
  }

  async listFiles(roomId: string): Promise<{ files: Array<{ relativePath: string; version: number; sha256: string | null; deleted: boolean }> }> {
    return this.request(`/api/rooms/${roomId}/files`);
  }

  async readFile(roomId: string, relativePath: string): Promise<{ relativePath: string; version: number; sha256: string; content: string }> {
    return this.request(`/api/rooms/${roomId}/files/content?path=${encodeURIComponent(relativePath)}`);
  }

  async writeFile(roomId: string, relativePath: string, baseVersion: number, content: string): Promise<{ ok: true; relativePath: string; version: number; sha256: string }> {
    return this.request(`/api/rooms/${roomId}/files/content`, {
      method: "PUT",
      body: { relativePath, baseVersion, content }
    });
  }

  async deleteFile(roomId: string, relativePath: string, baseVersion: number): Promise<void> {
    await this.request(`/api/rooms/${roomId}/files/delete`, {
      method: "POST",
      body: { relativePath, baseVersion }
    });
  }

  private async request(path: string, options: { method?: string; body?: unknown } = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(options.body ? { "content-type": "application/json" } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const body = await response.json();
    if (!response.ok) {
      const error = toRelayError(body);
      if (error.code === "UNAUTHORIZED") {
        this.onUnauthorized?.();
      }
      throw error;
    }
    return body;
  }
}

function toRelayError(body: any): Error & { code?: string } {
  const error = new Error(body?.error?.message ?? "Relay request failed") as Error & Record<string, unknown>;
  error.code = body?.error?.code;
  if (body?.error?.details && typeof body.error.details === "object") {
    Object.assign(error, body.error.details);
  }
  return error;
}

import { requestUrl, type RequestUrlParam } from "obsidian";
import type { RelayFileApi } from "./syncClient.js";

export type RoomSummary = {
  id: string;
  name: string;
  type: "file" | "folder";
  sourcePath: string;
  mountName: string;
  ownerUserId: string;
  conflictPolicy: "keep_both" | "owner_wins";
  permissions: string[];
  capabilities: Array<{ pluginId: string; displayName: string; mode: string; minVersion?: string; installed: boolean | null }>;
};

export type TeamMemberSummary = {
  userId: string;
  displayName: string;
  role: "admin" | "member";
  revokedAt: string | null;
};

export type TeamSummary = {
  id: string;
  slug: string;
  name: string;
  ownerUserId: string;
};

/** Minimal directory entry for any team on the server - no ownerUserId or membership - used only
 *  to populate pickers (e.g. the room ACL "grant to a team" picker), never team-management UI. */
export type TeamDirectoryEntry = {
  id: string;
  slug: string;
  name: string;
};

export type MyTeamSummary = {
  id: string;
  name: string;
  slug: string;
  role: "admin" | "member";
};

export type FriendSummary = {
  id: string;
  displayName: string;
  revokedAt: string | null;
  teams: Array<{ id: string; role: "admin" | "member" }>;
};

export type BootstrapResponse = {
  user: { id: string; displayName: string };
  device: { id: string; displayName: string };
  deviceToken: string;
  isServerOwner: boolean;
  team?: { id: string; slug: string; name: string };
};

export type AclRuleSummary = {
  id: string;
  roomId: string;
  subjectType: "user" | "team";
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
    const response = await requestUrlWithTimeout({ url: `${this.baseUrl}/health`, throw: false }, 3_000);
    let body: { name?: string; version?: string };
    try {
      body = response.json as { name?: string; version?: string };
    } catch {
      // response.json is a synchronous getter that throws SyntaxError on invalid JSON - e.g. a
      // router admin page or some other non-Vault-Rooms HTTP service answering on that host/port.
      throw new Error("Something answered, but it is not a Vault Rooms server.");
    }
    if (body.name !== "vault-rooms") {
      throw new Error("Something answered, but it is not a Vault Rooms server.");
    }
    return { ok: true, version: body.version ?? "unknown" };
  }

  async bootstrapServer(input: { displayName: string; deviceName: string; teamName?: string; pin: string }): Promise<BootstrapResponse> {
    return this.request("/api/bootstrap", {
      method: "POST",
      body: input
    });
  }

  async me(): Promise<{
    user: { id: string; displayName: string };
    device: { id: string; displayName: string };
    isServerOwner: boolean;
    teams: MyTeamSummary[];
  }> {
    return this.request("/api/me");
  }

  async acceptInvite(inviteToken: string): Promise<{ team: { id: string; slug: string; name: string } }> {
    return this.request("/api/invites/accept", {
      method: "POST",
      body: { inviteToken }
    });
  }

  async listFriends(): Promise<{ friends: FriendSummary[] }> {
    return this.request("/api/friends");
  }

  async revokeFriend(userId: string): Promise<{ ok: true }> {
    return this.request(`/api/friends/${userId}/revoke`, { method: "POST" });
  }

  async listTeams(): Promise<{ teams: TeamSummary[] }> {
    return this.request("/api/teams");
  }

  /** Every team on the server (id/name/slug only) - for pickers, e.g. the room ACL "Team" dropdown.
   *  Do not use for team-management UI, which needs ownerUserId/role from listTeams()/me(). */
  async listTeamDirectory(): Promise<{ teams: TeamDirectoryEntry[] }> {
    return this.request("/api/team-directory");
  }

  async createTeam(name: string): Promise<{ team: TeamSummary }> {
    return this.request("/api/teams", {
      method: "POST",
      body: { name }
    });
  }

  async addTeamMember(teamId: string, userId: string, role: "member" | "admin" = "member"): Promise<{ ok: true }> {
    return this.request(`/api/teams/${teamId}/members`, {
      method: "POST",
      body: { userId, role }
    });
  }

  async createInvite(teamId: string, role: "member" | "admin" = "member"): Promise<{ inviteId: string; inviteToken: string; serverUrl: string; joinUrl: string }> {
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

  async join(inviteToken: string, displayName: string, deviceName: string): Promise<BootstrapResponse & { team: { id: string; slug: string; name: string } }> {
    return this.request("/api/join", {
      method: "POST",
      body: { inviteToken, displayName, deviceName }
    });
  }

  async listRooms(): Promise<{ rooms: RoomSummary[] }> {
    return this.request("/api/rooms");
  }

  async createRoom(input: {
    name: string;
    type: "file" | "folder";
    sourcePath: string;
    mountName: string;
    conflictPolicy?: "keep_both" | "owner_wins";
    capabilities: Array<{ pluginId: string; displayName: string; mode: string; minVersion?: string }>;
  }): Promise<{ room: RoomSummary }> {
    return this.request("/api/rooms", {
      method: "POST",
      body: input
    });
  }

  async updateRoom(
    roomId: string,
    input: {
      name: string;
      type: "file" | "folder";
      sourcePath: string;
      mountName: string;
      conflictPolicy?: "keep_both" | "owner_wins";
      capabilities: Array<{ pluginId: string; displayName: string; mode: string; minVersion?: string }>;
    }
  ): Promise<{ room: RoomSummary }> {
    return this.request(`/api/rooms/${roomId}`, {
      method: "PATCH",
      body: input
    });
  }

  async grantAcl(roomId: string, input: { subjectType: "user" | "team"; subjectId: string; effect: "allow" | "deny"; preset?: "reader" | "editor"; permissions?: string[]; pathPattern: string }): Promise<{ aclRule: AclRuleSummary }> {
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

  async deleteFile(roomId: string, relativePath: string, baseVersion: number): Promise<{ ok: true; relativePath: string; version: number }> {
    return this.request(`/api/rooms/${roomId}/files/delete`, {
      method: "POST",
      body: { relativePath, baseVersion }
    });
  }

  private async request<T = unknown>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await requestUrl({
      url: `${this.baseUrl}${path}`,
      method: options.method ?? "GET",
      headers: {
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {})
      },
      contentType: options.body ? "application/json" : undefined,
      throw: false,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    // A well-behaved relay always answers with JSON (success or error envelope), but a network-
    // level proxy, an empty response, or a truncated body could hand back something that isn't -
    // response.json() throws a raw SyntaxError for that, which would bypass toRelayError()'s
    // UNAUTHORIZED handling entirely and surface a confusing low-level error to the caller instead
    // of a clean, actionable one.
    let body: unknown;
    try {
      body = response.json;
    } catch {
      throw toRelayError(undefined, "Unexpected non-JSON response from relay");
    }
    if (response.status < 200 || response.status >= 300) {
      const error = toRelayError(body);
      if (error.code === "UNAUTHORIZED") {
        this.onUnauthorized?.();
      }
      throw error;
    }
    return body as T;
  }
}

export function requestUrlWithTimeout(request: RequestUrlParam, timeoutMs: number): Promise<Awaited<ReturnType<typeof requestUrl>>> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("Request timed out.")), timeoutMs);
    requestUrl(request).then(
      (response) => {
        window.clearTimeout(timeout);
        resolve(response);
      },
      (error: unknown) => {
        window.clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

type RelayErrorBody = { error?: { message?: string; code?: string; details?: Record<string, unknown> } };

function toRelayError(body: unknown, fallbackMessage = "Relay request failed"): Error & { code?: string } {
  const errorBody = body as RelayErrorBody | undefined;
  const error = new Error(errorBody?.error?.message ?? fallbackMessage) as Error & Record<string, unknown>;
  error.code = errorBody?.error?.code;
  if (errorBody?.error?.details && typeof errorBody.error.details === "object") {
    Object.assign(error, errorBody.error.details);
  }
  return error;
}

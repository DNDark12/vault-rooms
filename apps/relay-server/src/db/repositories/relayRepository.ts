import { createHash } from "node:crypto";
import { AppError, contentTypeForPath, createId, createToken, hashToken, type AclEffect, type AclRule, type CapabilityMode, type Permission, type SubjectType, type TeamRole } from "@vault-rooms/protocol";
import type { AclRuleRow, AgentPrincipalRow, DevicePrincipalRow, FileRow, FileVersionWithContentRow, InviteRow, MemberRow, RoomCapabilityRow, RoomRow, TeamRow } from "../schema.js";
import type { RelayDb } from "../sqlJsAdapter.js";

export type DevicePrincipal = {
  deviceId: string;
  deviceDisplayName: string;
  deviceRevokedAt: string | null;
  userId: string;
  userDisplayName: string;
  teamId: string;
  teamName: string;
  teamSlug: string;
  role: TeamRole;
  memberRevokedAt: string | null;
};

export type AgentPrincipal = {
  agentId: string;
  teamId: string;
  userId: string;
  displayName: string;
  revokedAt: string | null;
};

export type BootstrapResult = {
  team: { id: string; slug: string; name: string };
  user: { id: string; displayName: string };
  device: { id: string; displayName: string };
  deviceToken: string;
  role: TeamRole;
};

export type FileWriteResult = {
  ok: true;
  relativePath: string;
  version: number;
  sha256: string;
  content: string;
};

export type FileDeleteResult = {
  ok: true;
  relativePath: string;
  version: number;
};

export class RelayRepository {
  constructor(private readonly db: RelayDb) {}

  bootstrapTeam(input: { teamName: string; ownerDisplayName: string; ownerDeviceName: string }): BootstrapResult {
    const now = new Date().toISOString();
    const teamId = createId("team");
    const userId = createId("usr");
    const deviceId = createId("dev");
    const deviceToken = createToken("dev");
    const slug = this.nextTeamSlug(input.teamName);

    const create = this.db.transaction(() => {
      this.db
        .prepare("insert into users(id, display_name, created_at, updated_at) values (?, ?, ?, ?)")
        .run(userId, input.ownerDisplayName, now, now);
      this.db
        .prepare("insert into teams(id, slug, name, owner_user_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?)")
        .run(teamId, slug, input.teamName, userId, now, now);
      this.db
        .prepare("insert into team_members(team_id, user_id, role, revoked_at, created_at) values (?, ?, ?, null, ?)")
        .run(teamId, userId, "owner", now);
      this.db
        .prepare("insert into devices(id, team_id, user_id, display_name, token_hash, revoked_at, last_seen_at, created_at) values (?, ?, ?, ?, ?, null, null, ?)")
        .run(deviceId, teamId, userId, input.ownerDeviceName, hashToken(deviceToken), now);
      this.audit({
        teamId,
        actorType: "user",
        actorId: userId,
        action: "team.created",
        resourceType: "team",
        resourceId: teamId,
        metadata: { teamName: input.teamName }
      });
    });
    create();

    return {
      team: { id: teamId, slug, name: input.teamName },
      user: { id: userId, displayName: input.ownerDisplayName },
      device: { id: deviceId, displayName: input.ownerDeviceName },
      deviceToken,
      role: "owner"
    };
  }

  authenticateDeviceToken(token: string): DevicePrincipal | null {
    const row = this.db
      .prepare(
        `
          select
            d.id as device_id,
            d.display_name as device_display_name,
            d.revoked_at as device_revoked_at,
            u.id as user_id,
            u.display_name as user_display_name,
            t.id as team_id,
            t.name as team_name,
            t.slug as team_slug,
            tm.role as role,
            tm.revoked_at as member_revoked_at
          from devices d
          join users u on u.id = d.user_id
          join teams t on t.id = d.team_id
          join team_members tm on tm.team_id = d.team_id and tm.user_id = d.user_id
          where d.token_hash = ?
        `
      )
      .get(hashToken(token)) as DevicePrincipalRow | undefined;
    return row ? mapPrincipal(row) : null;
  }

  createInvite(input: {
    teamId: string;
    createdByUserId: string;
    role: "member" | "admin";
    expiresInMinutes: number;
    maxUses: number;
  }): { inviteId: string; inviteToken: string } {
    const now = new Date();
    const inviteId = createId("inv");
    const inviteToken = createToken("inv");
    const expiresAt = new Date(now.getTime() + input.expiresInMinutes * 60_000).toISOString();
    this.db
      .prepare(
        "insert into invites(id, team_id, created_by_user_id, token_hash, role, expires_at, max_uses, use_count, revoked_at, created_at) values (?, ?, ?, ?, ?, ?, ?, 0, null, ?)"
      )
      .run(inviteId, input.teamId, input.createdByUserId, hashToken(inviteToken), input.role, expiresAt, input.maxUses, now.toISOString());
    this.audit({
      teamId: input.teamId,
      actorType: "user",
      actorId: input.createdByUserId,
      action: "invite.created",
      resourceType: "invite",
      resourceId: inviteId,
      metadata: { role: input.role, maxUses: input.maxUses }
    });
    return { inviteId, inviteToken };
  }

  joinInvite(input: { inviteToken: string; displayName: string; deviceName: string }): BootstrapResult {
    const invite = this.db
      .prepare("select * from invites where token_hash = ?")
      .get(hashToken(input.inviteToken)) as InviteRow | undefined;
    if (!invite || invite.revoked_at || invite.use_count >= invite.max_uses || Date.parse(invite.expires_at) <= Date.now()) {
      throw new Error("Invalid or expired invite");
    }

    const team = this.getTeam(invite.team_id);
    if (!team) {
      throw new Error("Team not found");
    }

    const now = new Date().toISOString();
    const userId = createId("usr");
    const deviceId = createId("dev");
    const deviceToken = createToken("dev");

    const join = this.db.transaction(() => {
      this.db
        .prepare("insert into users(id, display_name, created_at, updated_at) values (?, ?, ?, ?)")
        .run(userId, input.displayName, now, now);
      this.db
        .prepare("insert into team_members(team_id, user_id, role, revoked_at, created_at) values (?, ?, ?, null, ?)")
        .run(team.id, userId, invite.role, now);
      this.db
        .prepare("insert into devices(id, team_id, user_id, display_name, token_hash, revoked_at, last_seen_at, created_at) values (?, ?, ?, ?, ?, null, null, ?)")
        .run(deviceId, team.id, userId, input.deviceName, hashToken(deviceToken), now);
      this.db.prepare("update invites set use_count = use_count + 1 where id = ?").run(invite.id);
      this.audit({
        teamId: team.id,
        actorType: "user",
        actorId: userId,
        action: "member.joined",
        resourceType: "user",
        resourceId: userId,
        metadata: { inviteId: invite.id }
      });
      this.audit({
        teamId: team.id,
        actorType: "user",
        actorId: userId,
        action: "invite.used",
        resourceType: "invite",
        resourceId: invite.id,
        metadata: { displayName: input.displayName }
      });
    });
    join();

    return {
      team: { id: team.id, slug: team.slug, name: team.name },
      user: { id: userId, displayName: input.displayName },
      device: { id: deviceId, displayName: input.deviceName },
      deviceToken,
      role: invite.role
    };
  }

  listMembers(teamId: string, includeRevoked: boolean): MemberRow[] {
    const where = includeRevoked ? "" : "and tm.revoked_at is null";
    return this.db
      .prepare(
        `
          select u.id as user_id, u.display_name, tm.role, tm.revoked_at
          from team_members tm
          join users u on u.id = tm.user_id
          where tm.team_id = ? ${where}
          order by tm.created_at asc
        `
      )
      .all(teamId) as MemberRow[];
  }

  revokeMember(input: { teamId: string; userId: string; actorUserId: string; reason?: string }): void {
    const now = new Date().toISOString();
    const revoke = this.db.transaction(() => {
      this.db.prepare("update team_members set revoked_at = ? where team_id = ? and user_id = ?").run(now, input.teamId, input.userId);
      const devices = this.db.prepare("select id from devices where team_id = ? and user_id = ? and revoked_at is null").all(input.teamId, input.userId) as Array<{ id: string }>;
      this.db.prepare("update devices set revoked_at = ? where team_id = ? and user_id = ?").run(now, input.teamId, input.userId);
      this.audit({
        teamId: input.teamId,
        actorType: "user",
        actorId: input.actorUserId,
        action: "member.revoked",
        resourceType: "user",
        resourceId: input.userId,
        metadata: { reason: input.reason ?? null }
      });
      for (const device of devices) {
        this.audit({
          teamId: input.teamId,
          actorType: "user",
          actorId: input.actorUserId,
          action: "device.revoked",
          resourceType: "device",
          resourceId: device.id,
          metadata: { userId: input.userId }
        });
      }
    });
    revoke();
  }

  createAgentToken(input: { teamId: string; userId: string; displayName: string }): { agent: { id: string; displayName: string }; agentToken: string } {
    const agentId = createId("agt");
    const agentToken = createToken("agt");
    const now = new Date().toISOString();
    this.db
      .prepare("insert into mcp_agent_tokens(id, team_id, user_id, display_name, token_hash, revoked_at, created_at) values (?, ?, ?, ?, ?, null, ?)")
      .run(agentId, input.teamId, input.userId, input.displayName, hashToken(agentToken), now);
    this.audit({
      teamId: input.teamId,
      actorType: "user",
      actorId: input.userId,
      action: "mcp.agent.created",
      resourceType: "agent",
      resourceId: agentId,
      metadata: { displayName: input.displayName }
    });
    return { agent: { id: agentId, displayName: input.displayName }, agentToken };
  }

  authenticateAgentToken(token: string): AgentPrincipal | null {
    const row = this.db
      .prepare("select id, team_id, user_id, display_name, revoked_at from mcp_agent_tokens where token_hash = ?")
      .get(hashToken(token)) as AgentPrincipalRow | undefined;
    return row
      ? { agentId: row.id, teamId: row.team_id, userId: row.user_id, displayName: row.display_name, revokedAt: row.revoked_at }
      : null;
  }

  revokeAgent(input: { teamId: string; agentId: string; actorUserId: string }): void {
    const now = new Date().toISOString();
    this.db.prepare("update mcp_agent_tokens set revoked_at = ? where team_id = ? and id = ?").run(now, input.teamId, input.agentId);
    this.audit({
      teamId: input.teamId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "mcp.agent.revoked",
      resourceType: "agent",
      resourceId: input.agentId,
      metadata: {}
    });
  }

  createRoom(input: {
    teamId: string;
    name: string;
    type: "file" | "folder";
    sourcePath: string;
    mountName: string;
    ownerUserId: string;
    capabilities: Array<{ pluginId: string; displayName: string; mode: CapabilityMode; minVersion?: string }>;
  }): RoomRow {
    const now = new Date().toISOString();
    const roomId = createId("room");
    const create = this.db.transaction(() => {
      this.db
        .prepare("insert into rooms(id, team_id, name, type, source_path, mount_name, owner_user_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(roomId, input.teamId, input.name, input.type, input.sourcePath, input.mountName, input.ownerUserId, now, now);
      const insertCapability = this.db.prepare(
        "insert into room_capabilities(id, room_id, plugin_id, display_name, mode, min_version) values (?, ?, ?, ?, ?, ?)"
      );
      for (const capability of input.capabilities) {
        insertCapability.run(createId("cap"), roomId, capability.pluginId, capability.displayName, capability.mode, capability.minVersion ?? null);
      }
      this.audit({
        teamId: input.teamId,
        actorType: "user",
        actorId: input.ownerUserId,
        action: "room.created",
        resourceType: "room",
        resourceId: roomId,
        metadata: { name: input.name, sourcePath: input.sourcePath, mountName: input.mountName }
      });
    });
    create();
    const room = this.getRoom(roomId);
    if (!room) {
      throw new Error("Failed to create room");
    }
    return room;
  }

  getRoom(roomId: string): RoomRow | null {
    return (this.db.prepare("select * from rooms where id = ?").get(roomId) as RoomRow | undefined) ?? null;
  }

  listTeamRooms(teamId: string): RoomRow[] {
    return this.db.prepare("select * from rooms where team_id = ? order by created_at asc").all(teamId) as RoomRow[];
  }

  listCapabilities(roomId: string): RoomCapabilityRow[] {
    return this.db.prepare("select * from room_capabilities where room_id = ? order by id asc").all(roomId) as RoomCapabilityRow[];
  }

  updateRoom(input: {
    roomId: string;
    actorUserId: string;
    name: string;
    type: "file" | "folder";
    sourcePath: string;
    mountName: string;
    capabilities: Array<{ pluginId: string; displayName: string; mode: CapabilityMode; minVersion?: string }>;
  }): RoomRow {
    const room = this.getRoom(input.roomId);
    if (!room) {
      throw new AppError("NOT_FOUND", "Room not found.", 404);
    }
    const now = new Date().toISOString();
    const update = this.db.transaction(() => {
      this.db
        .prepare("update rooms set name = ?, type = ?, source_path = ?, mount_name = ?, updated_at = ? where id = ?")
        .run(input.name, input.type, input.sourcePath, input.mountName, now, input.roomId);
      this.db.prepare("delete from room_capabilities where room_id = ?").run(input.roomId);
      const insertCapability = this.db.prepare(
        "insert into room_capabilities(id, room_id, plugin_id, display_name, mode, min_version) values (?, ?, ?, ?, ?, ?)"
      );
      for (const capability of input.capabilities) {
        insertCapability.run(createId("cap"), input.roomId, capability.pluginId, capability.displayName, capability.mode, capability.minVersion ?? null);
      }
      this.audit({
        teamId: room.team_id,
        actorType: "user",
        actorId: input.actorUserId,
        action: "room.updated",
        resourceType: "room",
        resourceId: input.roomId,
        metadata: { name: input.name, sourcePath: input.sourcePath, mountName: input.mountName }
      });
    });
    update();
    const updated = this.getRoom(input.roomId);
    if (!updated) {
      throw new Error("Failed to update room");
    }
    return updated;
  }

  deleteAclRule(input: { aclId: string; teamId: string; roomId: string; actorUserId: string }): void {
    const rule = this.db.prepare("select * from acl_rules where id = ? and room_id = ? and team_id = ?").get(input.aclId, input.roomId, input.teamId) as
      | AclRuleRow
      | undefined;
    if (!rule) {
      throw new AppError("NOT_FOUND", "Access rule not found.", 404);
    }
    this.db.prepare("delete from acl_rules where id = ?").run(input.aclId);
    this.audit({
      teamId: input.teamId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "acl.removed",
      resourceType: "room",
      resourceId: input.roomId,
      metadata: { aclId: input.aclId, subjectType: rule.subject_type, subjectId: rule.subject_id }
    });
  }

  deleteRoom(input: { roomId: string; teamId: string; actorUserId: string }): void {
    const room = this.getRoom(input.roomId);
    if (!room || room.team_id !== input.teamId) {
      throw new AppError("NOT_FOUND", "Room not found.", 404);
    }
    const remove = this.db.transaction(() => {
      const fileIds = (this.db.prepare("select id from files where room_id = ?").all(input.roomId) as Array<{ id: string }>).map((row) => row.id);
      for (const fileId of fileIds) {
        this.db.prepare("delete from file_versions where file_id = ?").run(fileId);
      }
      this.db.prepare("delete from files where room_id = ?").run(input.roomId);
      this.db.prepare("delete from room_capabilities where room_id = ?").run(input.roomId);
      this.db.prepare("delete from acl_rules where room_id = ?").run(input.roomId);
      this.db.prepare("delete from rooms where id = ?").run(input.roomId);
      this.audit({
        teamId: input.teamId,
        actorType: "user",
        actorId: input.actorUserId,
        action: "room.deleted",
        resourceType: "room",
        resourceId: input.roomId,
        metadata: { name: room.name, mountName: room.mount_name }
      });
    });
    remove();
  }

  deleteTeam(input: { teamId: string; actorUserId: string }): void {
    const team = this.getTeam(input.teamId);
    if (!team) {
      throw new AppError("NOT_FOUND", "Team not found.", 404);
    }
    const remove = this.db.transaction(() => {
      const roomIds = (this.db.prepare("select id from rooms where team_id = ?").all(input.teamId) as Array<{ id: string }>).map((row) => row.id);
      for (const roomId of roomIds) {
        const fileIds = (this.db.prepare("select id from files where room_id = ?").all(roomId) as Array<{ id: string }>).map((row) => row.id);
        for (const fileId of fileIds) {
          this.db.prepare("delete from file_versions where file_id = ?").run(fileId);
        }
        this.db.prepare("delete from files where room_id = ?").run(roomId);
        this.db.prepare("delete from room_capabilities where room_id = ?").run(roomId);
      }
      this.db.prepare("delete from acl_rules where team_id = ?").run(input.teamId);
      this.db.prepare("delete from rooms where team_id = ?").run(input.teamId);
      this.db.prepare("delete from mcp_agent_tokens where team_id = ?").run(input.teamId);
      this.db.prepare("delete from invites where team_id = ?").run(input.teamId);
      this.db.prepare("delete from devices where team_id = ?").run(input.teamId);
      const userIds = (this.db.prepare("select user_id from team_members where team_id = ?").all(input.teamId) as Array<{ user_id: string }>).map(
        (row) => row.user_id
      );
      this.db.prepare("delete from team_members where team_id = ?").run(input.teamId);
      for (const userId of userIds) {
        const stillMember = this.db.prepare("select 1 from team_members where user_id = ?").get(userId);
        if (!stillMember) {
          this.db.prepare("delete from users where id = ?").run(userId);
        }
      }
      this.db.prepare("delete from audit_events where team_id = ?").run(input.teamId);
      this.db.prepare("delete from teams where id = ?").run(input.teamId);
    });
    remove();
  }

  createAclRule(input: {
    teamId: string;
    roomId: string;
    actorUserId: string;
    subjectType: SubjectType;
    subjectId: string;
    effect: AclEffect;
    permissions: Permission[];
    pathPattern: string;
  }): AclRule {
    const now = new Date().toISOString();
    const id = createId("acl");
    this.db
      .prepare(
        "insert into acl_rules(id, team_id, room_id, subject_type, subject_id, effect, permissions_json, path_pattern, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(id, input.teamId, input.roomId, input.subjectType, input.subjectId, input.effect, JSON.stringify(input.permissions), input.pathPattern, now);
    this.audit({
      teamId: input.teamId,
      actorType: "user",
      actorId: input.actorUserId,
      action: input.effect === "allow" ? "acl.granted" : "acl.denied",
      resourceType: "room",
      resourceId: input.roomId,
      metadata: { subjectType: input.subjectType, subjectId: input.subjectId, permissions: input.permissions, pathPattern: input.pathPattern }
    });
    return {
      id,
      teamId: input.teamId,
      roomId: input.roomId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      effect: input.effect,
      permissions: input.permissions,
      pathPattern: input.pathPattern,
      createdAt: now
    };
  }

  listAclRulesForTeam(teamId: string): AclRule[] {
    return (this.db.prepare("select * from acl_rules where team_id = ? order by created_at asc").all(teamId) as AclRuleRow[]).map(mapAclRule);
  }

  listAclRulesForRoom(roomId: string): AclRule[] {
    return (this.db.prepare("select * from acl_rules where room_id = ? order by created_at asc").all(roomId) as AclRuleRow[]).map(mapAclRule);
  }

  listFiles(roomId: string): FileRow[] {
    return this.db.prepare("select * from files where room_id = ? order by relative_path asc").all(roomId) as FileRow[];
  }

  getFile(roomId: string, relativePath: string): FileRow | null {
    return (
      (this.db.prepare("select * from files where room_id = ? and relative_path = ?").get(roomId, relativePath) as FileRow | undefined) ?? null
    );
  }

  readFileContent(roomId: string, relativePath: string): { file: FileRow; content: string } {
    const file = this.getFile(roomId, relativePath);
    if (!file) {
      throw new AppError("NOT_FOUND", "File not found.", 404);
    }
    if (file.deleted_at) {
      throw new AppError("FILE_DELETED", "The file has been deleted.", 404);
    }
    const version = this.latestFileVersion(file.id);
    if (!version) {
      throw new AppError("NOT_FOUND", "File content not found.", 404);
    }
    return { file, content: version.content };
  }

  writeFile(input: { roomId: string; relativePath: string; baseVersion: number; content: string; actorUserId: string }): FileWriteResult {
    const write = this.db.transaction(() => {
      const existing = this.getFile(input.roomId, input.relativePath);
      const sha256 = sha256Text(input.content);
      const sizeBytes = Buffer.byteLength(input.content, "utf8");
      const now = new Date().toISOString();
      const storageKey = `sha256:${sha256}`;

      if (input.baseVersion === 0) {
        if (existing && !existing.deleted_at) {
          throw new AppError("FILE_EXISTS", "The file already exists.", 409, { serverVersion: existing.version });
        }
        const version = existing ? existing.version + 1 : 1;
        const fileId = existing?.id ?? createId("fil");
        if (existing) {
          this.db
            .prepare("update files set version = ?, sha256 = ?, size_bytes = ?, deleted_at = null, updated_by_user_id = ?, updated_at = ? where id = ?")
            .run(version, sha256, sizeBytes, input.actorUserId, now, existing.id);
        } else {
          this.db
            .prepare(
              "insert into files(id, room_id, relative_path, kind, content_type, version, sha256, size_bytes, deleted_at, updated_by_user_id, updated_at, created_at) values (?, ?, ?, 'file', ?, ?, ?, ?, null, ?, ?, ?)"
            )
            .run(fileId, input.roomId, input.relativePath, contentTypeForPath(input.relativePath), version, sha256, sizeBytes, input.actorUserId, now, now);
        }
        this.insertFileVersion({ fileId, version, sha256, sizeBytes, storageKey, content: input.content, actorUserId: input.actorUserId, now });
        this.auditFileEvent(input.roomId, input.actorUserId, version === 1 ? "file.created" : "file.updated", fileId, input.relativePath, version);
        return { ok: true as const, relativePath: input.relativePath, version, sha256, content: input.content };
      }

      if (!existing || existing.deleted_at) {
        throw new AppError(existing?.deleted_at ? "FILE_DELETED" : "NOT_FOUND", existing?.deleted_at ? "The file has been deleted." : "File not found.", 404);
      }
      if (existing.version !== input.baseVersion) {
        throw this.versionConflict(existing);
      }

      const version = existing.version + 1;
      this.db
        .prepare("update files set version = ?, sha256 = ?, size_bytes = ?, updated_by_user_id = ?, updated_at = ? where id = ?")
        .run(version, sha256, sizeBytes, input.actorUserId, now, existing.id);
      this.insertFileVersion({ fileId: existing.id, version, sha256, sizeBytes, storageKey, content: input.content, actorUserId: input.actorUserId, now });
      this.auditFileEvent(input.roomId, input.actorUserId, "file.updated", existing.id, input.relativePath, version);
      return { ok: true as const, relativePath: input.relativePath, version, sha256, content: input.content };
    });
    return write();
  }

  deleteFile(input: { roomId: string; relativePath: string; baseVersion: number; actorUserId: string }): FileDeleteResult {
    const remove = this.db.transaction(() => {
      const existing = this.getFile(input.roomId, input.relativePath);
      if (!existing) {
        throw new AppError("NOT_FOUND", "File not found.", 404);
      }
      if (existing.version !== input.baseVersion) {
        throw this.versionConflict(existing);
      }
      const version = existing.version + 1;
      const now = new Date().toISOString();
      this.db
        .prepare("update files set version = ?, sha256 = null, size_bytes = null, deleted_at = ?, updated_by_user_id = ?, updated_at = ? where id = ?")
        .run(version, now, input.actorUserId, now, existing.id);
      this.auditFileEvent(input.roomId, input.actorUserId, "file.deleted", existing.id, input.relativePath, version);
      return { ok: true as const, relativePath: input.relativePath, version };
    });
    return remove();
  }

  latestFileVersion(fileId: string): FileVersionWithContentRow | null {
    return (
      (this.db
        .prepare(
          `
            select fv.*, cb.content
            from file_versions fv
            join content_blobs cb on cb.storage_key = fv.content_storage_key
            where fv.file_id = ?
            order by fv.version desc
            limit 1
          `
        )
        .get(fileId) as FileVersionWithContentRow | undefined) ?? null
    );
  }

  getTeam(teamId: string): TeamRow | null {
    return (this.db.prepare("select * from teams where id = ?").get(teamId) as TeamRow | undefined) ?? null;
  }

  audit(input: {
    teamId: string;
    actorType: "user" | "device" | "agent" | "system";
    actorId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    metadata: unknown;
    ipAddress?: string;
  }): void {
    this.db
      .prepare(
        "insert into audit_events(id, team_id, actor_type, actor_id, action, resource_type, resource_id, metadata_json, ip_address, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        createId("aud"),
        input.teamId,
        input.actorType,
        input.actorId,
        input.action,
        input.resourceType,
        input.resourceId,
        JSON.stringify(input.metadata),
        input.ipAddress ?? null,
        new Date().toISOString()
      );
  }

  private insertFileVersion(input: {
    fileId: string;
    version: number;
    sha256: string;
    sizeBytes: number;
    storageKey: string;
    content: string;
    actorUserId: string;
    now: string;
  }): void {
    this.db.prepare("insert or ignore into content_blobs(storage_key, content, created_at) values (?, ?, ?)").run(input.storageKey, input.content, input.now);
    this.db
      .prepare(
        "insert into file_versions(id, file_id, version, sha256, size_bytes, content_storage_key, created_by_user_id, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(createId("ver"), input.fileId, input.version, input.sha256, input.sizeBytes, input.storageKey, input.actorUserId, input.now);
  }

  private versionConflict(file: FileRow): AppError {
    const latest = this.latestFileVersion(file.id);
    return new AppError("VERSION_CONFLICT", "The file changed on the server before your edit was applied.", 409, {
      serverVersion: file.version,
      serverSha256: file.sha256,
      ...(latest ? { serverContent: latest.content } : {})
    });
  }

  private auditFileEvent(roomId: string, actorUserId: string, action: string, fileId: string, relativePath: string, version: number): void {
    const room = this.getRoom(roomId);
    this.audit({
      teamId: room?.team_id ?? "unknown",
      actorType: "user",
      actorId: actorUserId,
      action,
      resourceType: "file",
      resourceId: fileId,
      metadata: { roomId, relativePath, version }
    });
  }

  private nextTeamSlug(name: string): string {
    const base = slugify(name);
    let candidate = base;
    let suffix = 2;
    while (this.db.prepare("select 1 from teams where slug = ?").get(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }
}

export function isActivePrincipal(principal: DevicePrincipal | null): principal is DevicePrincipal {
  return Boolean(principal && !principal.memberRevokedAt && !principal.deviceRevokedAt);
}

export function canManageTeam(principal: DevicePrincipal, teamId: string): boolean {
  return principal.teamId === teamId && (principal.role === "owner" || principal.role === "admin");
}

function mapPrincipal(row: DevicePrincipalRow): DevicePrincipal {
  return {
    deviceId: row.device_id,
    deviceDisplayName: row.device_display_name,
    deviceRevokedAt: row.device_revoked_at,
    userId: row.user_id,
    userDisplayName: row.user_display_name,
    teamId: row.team_id,
    teamName: row.team_name,
    teamSlug: row.team_slug,
    role: row.role,
    memberRevokedAt: row.member_revoked_at
  };
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "team";
}

function sha256Text(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function mapAclRule(row: AclRuleRow): AclRule {
  return {
    id: row.id,
    teamId: row.team_id,
    roomId: row.room_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    effect: row.effect,
    permissions: JSON.parse(row.permissions_json) as Permission[],
    pathPattern: row.path_pattern,
    createdAt: row.created_at
  };
}

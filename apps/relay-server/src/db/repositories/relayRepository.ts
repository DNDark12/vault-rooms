import {
  AppError,
  createId,
  createToken,
  hashToken,
  verifyInviteAcceptanceProofForTokenHash,
  type AclEffect,
  type AclRule,
  type CapabilityMode,
  type MigrationMode,
  type Permission,
  type ServerSecurityState,
  type SubjectType,
  type TeamRole
} from "@vault-rooms/protocol";
import { expandPreset } from "@vault-rooms/policy";
import type {
  AclRuleRow,
  AuditEventRow,
  DevicePrincipalRow,
  DeviceRow,
  FileRow,
  FileVersionWithContentRow,
  InviteRow,
  MemberRow,
  RoomCapabilityRow,
  RoomRow,
  TeamRow,
  UserRow
} from "../schema.js";
import type { RelayDb } from "../sqlJsAdapter.js";
import { RelayFileRepository, type FileDeleteResult, type FileRenameResult, type FileWriteResult } from "./fileRepository.js";
import { RelayCrdtRepository, type CrdtSnapshot } from "./crdtRepository.js";

export type { FileDeleteResult, FileWriteResult } from "./fileRepository.js";
export type { CrdtSnapshot } from "./crdtRepository.js";

export type DevicePrincipal = {
  deviceId: string;
  deviceDisplayName: string;
  deviceRevokedAt: string | null;
  userId: string;
  userDisplayName: string;
  userRevokedAt: string | null;
  isServerOwner: boolean;
  tokenSecurity: "plain" | "tls";
};

export type UserTeam = {
  teamId: string;
  name: string;
  slug: string;
  role: TeamRole;
};

export type BootstrapResult = {
  user: { id: string; displayName: string };
  device: { id: string; displayName: string };
  deviceToken: string;
  isServerOwner: boolean;
  team?: { id: string; slug: string; name: string };
};

type InviteCreateTarget =
  | { teamId: string; role: TeamRole; roomId?: undefined; permissionPreset?: undefined }
  | { roomId: string; permissionPreset: "reader" | "editor"; teamId?: undefined; role?: undefined }
  | { teamId?: undefined; roomId?: undefined; role?: undefined; permissionPreset?: undefined };

type InviteGrantResult =
  | { inviteType: "team"; team: { id: string; slug: string; name: string } }
  | { inviteType: "room"; room: { id: string; name: string } }
  | { inviteType: "friend" };

export type InviteAcceptanceResult = InviteGrantResult | { inviteType: "friend"; alreadyConnected: true };
export type JoinInviteResult = BootstrapResult & InviteGrantResult;

export class RelayRepository {
  private readonly files: RelayFileRepository;
  private readonly crdt: RelayCrdtRepository;

  constructor(private readonly db: RelayDb) {
    this.crdt = new RelayCrdtRepository(db);
    this.files = new RelayFileRepository(
      db,
      (input) => this.audit(input),
      (roomId) => this.getRoom(roomId),
      (fileId) => this.bumpFileCrdtEpochStatements(fileId)
    );
  }

  durable<T>(operation: () => T): Promise<T> {
    return this.db.durable(operation);
  }

  getServerOwnerId(): string | null {
    const row = this.db.prepare("select value from server_meta where key = 'owner_user_id'").get() as { value: string } | undefined;
    return row?.value ?? null;
  }

  setServerOwner(userId: string): void {
    this.db.prepare("insert or replace into server_meta(key, value) values ('owner_user_id', ?)").run(userId);
  }

  getServerId(): string | null {
    const row = this.db.prepare("select value from server_meta where key = 'server_id'").get() as { value: string } | undefined;
    return row?.value ?? null;
  }

  getOrCreateServerId(): string {
    const existing = this.getServerId();
    if (existing) return existing;
    const serverId = createId("srv");
    this.db.prepare("insert into server_meta(key, value) values ('server_id', ?)").run(serverId);
    return serverId;
  }

  setServerIdIfMissing(serverId: string): void {
    this.db.prepare("insert or ignore into server_meta(key, value) values ('server_id', ?)").run(serverId);
  }

  wasMigratedFromLegacyV01(): boolean {
    return Boolean(this.db.prepare("select 1 from server_meta where key = 'legacy_v01_migrated' and value = '1'").get());
  }

  getSecurityState(): ServerSecurityState {
    const row = this.db.prepare("select value from server_meta where key = 'security_state'").get() as { value: ServerSecurityState } | undefined;
    return row?.value ?? "plain_legacy";
  }

  hasExplicitSecurityState(): boolean {
    return Boolean(this.db.prepare("select 1 as present from server_meta where key = 'security_state'").get());
  }

  setSecurityState(state: ServerSecurityState): void {
    this.db.prepare("insert or replace into server_meta(key, value) values ('security_state', ?)").run(state);
  }

  getMigrationMode(): MigrationMode {
    const row = this.db.prepare("select value from server_meta where key = 'migration_mode'").get() as { value: MigrationMode } | undefined;
    return row?.value ?? "non_strict";
  }

  setMigrationMode(mode: MigrationMode): void {
    this.db.prepare("insert or replace into server_meta(key, value) values ('migration_mode', ?)").run(mode);
  }

  bootstrapServer(input: { displayName: string; deviceName: string; teamName?: string; tokenSecurity: "plain" | "tls" }): BootstrapResult {
    const now = new Date().toISOString();
    const userId = createId("usr");
    const deviceId = createId("dev");
    const deviceToken = createToken("dev");
    let team: { id: string; slug: string; name: string } | undefined;

    const create = this.db.transaction(() => {
      if (this.getServerOwnerId()) {
        throw new AppError("PERMISSION_DENIED", "Bootstrap has already been completed.", 403);
      }
      this.db
        .prepare("insert into users(id, display_name, revoked_at, created_at, updated_at) values (?, ?, null, ?, ?)")
        .run(userId, input.displayName, now, now);
      this.db
        .prepare(
          "insert into devices(id, user_id, display_name, token_hash, revoked_at, last_seen_at, last_transport, token_security, created_at) values (?, ?, ?, ?, null, null, null, ?, ?)"
        )
        .run(deviceId, userId, input.deviceName, hashToken(deviceToken), input.tokenSecurity ?? "plain", now);
      this.setServerOwner(userId);

      if (input.teamName) {
        const teamId = createId("team");
        const slug = this.nextTeamSlug(input.teamName);
        this.db
          .prepare("insert into teams(id, slug, name, owner_user_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?)")
          .run(teamId, slug, input.teamName, userId, now, now);
        // Team ownership is stored on teams.owner_user_id. The owner is also an admin member so
        // listUserTeams and membership UI stay consistent with team ACL evaluation.
        this.db
          .prepare("insert into team_members(team_id, user_id, role, revoked_at, created_at) values (?, ?, 'admin', null, ?)")
          .run(teamId, userId, now);
        this.audit({
          teamId,
          actorType: "user",
          actorId: userId,
          action: "team.created",
          resourceType: "team",
          resourceId: teamId,
          metadata: { teamName: input.teamName }
        });
        team = { id: teamId, slug, name: input.teamName };
      }
    });
    create();

    return {
      user: { id: userId, displayName: input.displayName },
      device: { id: deviceId, displayName: input.deviceName },
      deviceToken,
      isServerOwner: true,
      ...(team ? { team } : {})
    };
  }

  recoverServerOwnerDevice(input: { deviceName: string; tokenSecurity: "plain" | "tls" }): BootstrapResult & { isServerOwner: true } {
    const recover = this.db.transaction(() => {
      const ownerUserId = this.getServerOwnerId();
      const owner = ownerUserId ? this.getUser(ownerUserId) : null;
      if (!owner || owner.revoked_at) {
        throw new AppError("NOT_FOUND", "Active server owner not found.", 404);
      }
      const now = new Date().toISOString();
      const deviceId = createId("dev");
      const deviceToken = createToken("dev");
      this.db
        .prepare(
          "insert into devices(id, user_id, display_name, token_hash, revoked_at, last_seen_at, last_transport, token_security, created_at) values (?, ?, ?, ?, null, null, null, ?, ?)"
        )
        .run(deviceId, owner.id, input.deviceName, hashToken(deviceToken), input.tokenSecurity, now);
      this.audit({
        teamId: null,
        actorType: "system",
        actorId: owner.id,
        action: "owner.device_recovered",
        resourceType: "device",
        resourceId: deviceId,
        metadata: { tokenSecurity: input.tokenSecurity }
      });
      return {
        user: { id: owner.id, displayName: owner.display_name },
        device: { id: deviceId, displayName: input.deviceName },
        deviceToken,
        isServerOwner: true
      } satisfies BootstrapResult & { isServerOwner: true };
    });
    return recover();
  }

  revokeRecoveredOwnerDevice(deviceId: string): void {
    const revoke = this.db.transaction(() => {
      const ownerUserId = this.getServerOwnerId();
      const device = this.db.prepare("select user_id, revoked_at from devices where id = ?").get(deviceId) as
        | { user_id: string; revoked_at: string | null }
        | undefined;
      const recoveryAudit = this.db
        .prepare("select 1 from audit_events where action = 'owner.device_recovered' and resource_id = ?")
        .get(deviceId);
      if (!ownerUserId || !device || device.user_id !== ownerUserId || !recoveryAudit) {
        throw new AppError("VALIDATION_ERROR", "Device is not a recovery device for the server owner.", 422);
      }
      if (device.revoked_at) {
        return;
      }
      this.db.prepare("update devices set revoked_at = ? where id = ?").run(new Date().toISOString(), deviceId);
      this.audit({
        teamId: null,
        actorType: "system",
        actorId: ownerUserId,
        action: "owner.device_recovery_rolled_back",
        resourceType: "device",
        resourceId: deviceId,
        metadata: {}
      });
    });
    revoke();
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
            u.revoked_at as user_revoked_at,
            (select value from server_meta where key = 'owner_user_id') as server_owner_id,
            d.token_security
          from devices d
          join users u on u.id = d.user_id
          where d.token_hash = ?
        `
      )
      .get(hashToken(token)) as DevicePrincipalRow | undefined;
    return row ? mapPrincipal(row) : null;
  }

  authenticateDeviceInviteProof(input: {
    deviceId: string;
    deviceProof: string;
    serverId: string;
    inviteToken: string;
    identitySpkiSha256: string;
  }): DevicePrincipal | null {
    const row = this.db
      .prepare("select token_hash, token_security from devices where id = ? and revoked_at is null")
      .get(input.deviceId) as { token_hash: string; token_security: "plain" | "tls" } | undefined;
    if (
      !row ||
      row.token_security !== "plain" ||
      !verifyInviteAcceptanceProofForTokenHash(row.token_hash, input.deviceProof, input)
    ) {
      return null;
    }
    return this.authenticateDeviceById(input.deviceId);
  }

  // Registers an additional device for an existing user. There is no REST route for this yet
  // (self-service multi-device enrollment is a separate slice) - this exists so integration tests
  // can construct a "one user, two devices" fixture without duplicating this insert inline.
  addDevice(input: { userId: string; deviceName: string }): { deviceId: string; deviceToken: string } {
    const now = new Date().toISOString();
    const deviceId = createId("dev");
    const deviceToken = createToken("dev");
    this.db
      .prepare("insert into devices(id, user_id, display_name, token_hash, revoked_at, last_seen_at, created_at) values (?, ?, ?, ?, null, null, ?)")
      .run(deviceId, input.userId, input.deviceName, hashToken(deviceToken), now);
    return { deviceId, deviceToken };
  }

  markDeviceTransport(deviceId: string, transport: "http" | "https"): void {
    this.db.prepare("update devices set last_transport = ?, last_seen_at = ? where id = ? and revoked_at is null").run(
      transport,
      new Date().toISOString(),
      deviceId
    );
  }

  countActiveDevicesOnPlainTransport(): number {
    const row = this.db
      .prepare(
        `
          select count(*) as count
          from devices d
          join users u on u.id = d.user_id
          where d.last_transport = 'http' and d.revoked_at is null and u.revoked_at is null
        `
      )
      .get() as { count: number };
    return row.count;
  }

  rotateDeviceToken(deviceId: string): { deviceToken: string } {
    return this.db.transaction(() => this.rotateDeviceTokenWithinTransaction(deviceId, "tls_migration"))();
  }

  isLegacyPlainToken(principal: DevicePrincipal): boolean {
    return principal.tokenSecurity === "plain";
  }

  listUserTeams(userId: string): UserTeam[] {
    return this.db
      .prepare(
        `
          select t.id as team_id, t.name, t.slug, tm.role
          from team_members tm
          join teams t on t.id = tm.team_id
          where tm.user_id = ? and tm.revoked_at is null
          order by tm.created_at asc
        `
      )
      .all(userId)
      .map((row) => {
        const team = row as { team_id: string; name: string; slug: string; role: TeamRole };
        return { teamId: team.team_id, name: team.name, slug: team.slug, role: team.role };
      });
  }

  createInvite(input: InviteCreateTarget & {
    createdByUserId: string;
    expiresInMinutes: number;
    maxUses: number;
  }): { inviteId: string; inviteToken: string } {
    const now = new Date();
    const inviteId = createId("inv");
    const inviteToken = createToken("inv");
    const expiresAt = new Date(now.getTime() + input.expiresInMinutes * 60_000).toISOString();
    this.db
      .prepare(
        "insert into invites(id, team_id, room_id, permission_preset, created_by_user_id, token_hash, role, expires_at, max_uses, use_count, revoked_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, null, ?)"
      )
      .run(
        inviteId,
        input.teamId ?? null,
        input.roomId ?? null,
        input.permissionPreset ?? null,
        input.createdByUserId,
        hashToken(inviteToken),
        input.role ?? null,
        expiresAt,
        input.maxUses,
        now.toISOString()
      );
    this.audit({
      teamId: input.teamId ?? null,
      actorType: "user",
      actorId: input.createdByUserId,
      action: "invite.created",
      resourceType: "invite",
      resourceId: inviteId,
      metadata: {
        inviteType: input.teamId ? "team" : input.roomId ? "room" : "friend",
        role: input.role,
        roomId: input.roomId,
        permissionPreset: input.permissionPreset,
        maxUses: input.maxUses
      }
    });
    return { inviteId, inviteToken };
  }

  joinInvite(input: { inviteToken: string; displayName: string; deviceName: string; tokenSecurity: "plain" | "tls" }): JoinInviteResult {
    const invite = this.requireValidInvite(input.inviteToken);
    const target = this.resolveInviteTarget(invite);

    const now = new Date().toISOString();
    const userId = createId("usr");
    const deviceId = createId("dev");
    const deviceToken = createToken("dev");

    const join = this.db.transaction(() => {
      this.db
        .prepare("insert into users(id, display_name, revoked_at, created_at, updated_at) values (?, ?, null, ?, ?)")
        .run(userId, input.displayName, now, now);
      if (target.inviteType === "team") {
        this.db
          .prepare("insert into team_members(team_id, user_id, role, revoked_at, created_at) values (?, ?, ?, null, ?)")
          .run(target.team.id, userId, invite.role, now);
      } else if (target.inviteType === "room") {
        this.upsertRoomInviteGrant(target.room.id, userId, invite.permission_preset!, invite.created_by_user_id);
      }
      this.db
        .prepare(
          "insert into devices(id, user_id, display_name, token_hash, revoked_at, last_seen_at, last_transport, token_security, created_at) values (?, ?, ?, ?, null, null, null, ?, ?)"
        )
        .run(deviceId, userId, input.deviceName, hashToken(deviceToken), input.tokenSecurity ?? "plain", now);
      this.db.prepare("update invites set use_count = use_count + 1 where id = ?").run(invite.id);
      if (target.inviteType === "team") {
        this.auditMemberJoined(target.team.id, userId, invite.id, input.displayName);
      } else {
        this.auditInviteUsed(invite, userId, input.displayName);
      }
    });
    join();

    return {
      ...target,
      user: { id: userId, displayName: input.displayName },
      device: { id: deviceId, displayName: input.deviceName },
      deviceToken,
      isServerOwner: false
    };
  }

  acceptInvite(input: { inviteToken: string; userId: string }): InviteAcceptanceResult {
    return this.db.transaction(() => this.acceptInviteWithinTransaction(input))();
  }

  acceptInviteAndMaybeRotateDeviceToken(input: {
    inviteToken: string;
    userId: string;
    deviceId: string;
    transport: "http" | "https";
  }): InviteAcceptanceResult & { deviceToken?: string } {
    return this.db.transaction(() => {
      const accepted = this.acceptInviteWithinTransaction(input);
      const principal = this.authenticateDeviceById(input.deviceId);
      if (!principal || principal.userId !== input.userId) {
        throw new AppError("UNAUTHORIZED", "Invalid device credentials.", 401);
      }
      if (input.transport !== "https" || principal.tokenSecurity === "tls") {
        return accepted;
      }
      return {
        ...accepted,
        ...this.rotateDeviceTokenWithinTransaction(input.deviceId, "pinned_invite_accept")
      };
    })();
  }

  private acceptInviteWithinTransaction(input: { inviteToken: string; userId: string }): InviteAcceptanceResult {
    const invite = this.requireValidInvite(input.inviteToken);
    const target = this.resolveInviteTarget(invite);
    const user = this.getUser(input.userId);
    if (!user || user.revoked_at) {
      throw new Error("User not found");
    }

    if (target.inviteType === "friend") {
      return { inviteType: "friend", alreadyConnected: true };
    }

    const now = new Date().toISOString();
    if (target.inviteType === "team") {
      const existing = this.getTeamMembership(target.team.id, input.userId);
      if (existing) {
        this.db.prepare("update team_members set role = ?, revoked_at = null where team_id = ? and user_id = ?").run(invite.role, target.team.id, input.userId);
      } else {
        this.db
          .prepare("insert into team_members(team_id, user_id, role, revoked_at, created_at) values (?, ?, ?, null, ?)")
          .run(target.team.id, input.userId, invite.role, now);
      }
    } else {
      this.upsertRoomInviteGrant(target.room.id, input.userId, invite.permission_preset!, invite.created_by_user_id);
    }
    this.db.prepare("update invites set use_count = use_count + 1 where id = ?").run(invite.id);
    if (target.inviteType === "team") {
      this.auditMemberJoined(target.team.id, input.userId, invite.id, user.display_name);
    } else {
      this.auditInviteUsed(invite, input.userId, user.display_name);
    }

    return target;
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

  listFriends(): Array<{ id: string; displayName: string; revokedAt: string | null; teams: Array<{ id: string; role: TeamRole }> }> {
    const users = this.db.prepare("select * from users where revoked_at is null order by created_at asc").all() as UserRow[];
    const memberships = this.db
      .prepare(
        `
          select team_id, user_id, role
          from team_members
          where revoked_at is null
          order by created_at asc
        `
      )
      .all() as Array<{ team_id: string; user_id: string; role: TeamRole }>;

    return users.map((user) => ({
      id: user.id,
      displayName: user.display_name,
      revokedAt: user.revoked_at,
      teams: memberships.filter((membership) => membership.user_id === user.id).map((membership) => ({ id: membership.team_id, role: membership.role }))
    }));
  }

  revokeUser(input: { userId: string; actorUserId: string }): void {
    const now = new Date().toISOString();
    const devices = this.db.prepare("select id from devices where user_id = ? and revoked_at is null").all(input.userId) as Array<{ id: string }>;
    const revoke = this.db.transaction(() => {
      this.db.prepare("update users set revoked_at = ?, updated_at = ? where id = ?").run(now, now, input.userId);
      this.db.prepare("update devices set revoked_at = ? where user_id = ? and revoked_at is null").run(now, input.userId);
      this.audit({
        teamId: null,
        actorType: "user",
        actorId: input.actorUserId,
        action: "user.revoked",
        resourceType: "user",
        resourceId: input.userId,
        metadata: {}
      });
      for (const device of devices) {
        this.audit({
          teamId: null,
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

  getDevice(deviceId: string): DeviceRow | null {
    return (this.db.prepare("select * from devices where id = ?").get(deviceId) as DeviceRow | undefined) ?? null;
  }

  revokeDevice(input: { deviceId: string; actorUserId: string }): void {
    const now = new Date().toISOString();
    this.db.prepare("update devices set revoked_at = ? where id = ? and revoked_at is null").run(now, input.deviceId);
    this.audit({
      teamId: null,
      actorType: "user",
      actorId: input.actorUserId,
      action: "device.revoked",
      resourceType: "device",
      resourceId: input.deviceId,
      metadata: {}
    });
  }

  createTeam(input: { name: string; ownerUserId: string }): TeamRow {
    const teamId = createId("team");
    const slug = this.nextTeamSlug(input.name);
    const now = new Date().toISOString();
    const create = this.db.transaction(() => {
      this.db
        .prepare("insert into teams(id, slug, name, owner_user_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?)")
        .run(teamId, slug, input.name, input.ownerUserId, now, now);
      this.db
        .prepare("insert into team_members(team_id, user_id, role, revoked_at, created_at) values (?, ?, 'admin', null, ?)")
        .run(teamId, input.ownerUserId, now);
      this.audit({
        teamId,
        actorType: "user",
        actorId: input.ownerUserId,
        action: "team.created",
        resourceType: "team",
        resourceId: teamId,
        metadata: { teamName: input.name }
      });
    });
    create();
    const team = this.getTeam(teamId);
    if (!team) {
      throw new Error("Failed to create team");
    }
    return team;
  }

  addTeamMember(input: { teamId: string; userId: string; role: TeamRole; actorUserId: string }): void {
    const team = this.getTeam(input.teamId);
    const user = this.getUser(input.userId);
    if (!team || !user || user.revoked_at) {
      throw new AppError("NOT_FOUND", "Team or user not found.", 404);
    }
    const existing = this.getTeamMembership(input.teamId, input.userId);
    const now = new Date().toISOString();
    const add = this.db.transaction(() => {
      if (existing) {
        this.db.prepare("update team_members set role = ?, revoked_at = null where team_id = ? and user_id = ?").run(input.role, input.teamId, input.userId);
      } else {
        this.db
          .prepare("insert into team_members(team_id, user_id, role, revoked_at, created_at) values (?, ?, ?, null, ?)")
          .run(input.teamId, input.userId, input.role, now);
      }
      if (!existing || existing.revoked_at) {
        this.audit({
          teamId: input.teamId,
          actorType: "user",
          actorId: input.actorUserId,
          action: "member.joined",
          resourceType: "user",
          resourceId: input.userId,
          metadata: { inviteId: null, addedDirectly: true }
        });
      }
    });
    add();
  }

  revokeMember(input: { teamId: string; userId: string; actorUserId: string; reason?: string }): void {
    const now = new Date().toISOString();
    this.db.prepare("update team_members set revoked_at = ? where team_id = ? and user_id = ?").run(now, input.teamId, input.userId);
    this.audit({
      teamId: input.teamId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "member.revoked",
      resourceType: "user",
      resourceId: input.userId,
      metadata: { reason: input.reason ?? null }
    });
  }

  createRoom(input: {
    name: string;
    type: "file" | "folder";
    sourcePath: string;
    mountName: string;
    ownerUserId: string;
    conflictPolicy?: "keep_both" | "owner_wins";
    capabilities: Array<{ pluginId: string; displayName: string; mode: CapabilityMode; minVersion?: string }>;
  }): RoomRow {
    const now = new Date().toISOString();
    const roomId = createId("room");
    const conflictPolicy = input.conflictPolicy ?? "keep_both";
    const create = this.db.transaction(() => {
      this.db
        .prepare(
          "insert into rooms(id, name, type, source_path, mount_name, owner_user_id, conflict_policy, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(roomId, input.name, input.type, input.sourcePath, input.mountName, input.ownerUserId, conflictPolicy, now, now);
      const insertCapability = this.db.prepare(
        "insert into room_capabilities(id, room_id, plugin_id, display_name, mode, min_version) values (?, ?, ?, ?, ?, ?)"
      );
      for (const capability of input.capabilities) {
        insertCapability.run(createId("cap"), roomId, capability.pluginId, capability.displayName, capability.mode, capability.minVersion ?? null);
      }
      this.audit({
        teamId: null,
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

  listAllRooms(): RoomRow[] {
    return this.db.prepare("select * from rooms order by created_at asc").all() as RoomRow[];
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
    conflictPolicy?: "keep_both" | "owner_wins";
    capabilities: Array<{ pluginId: string; displayName: string; mode: CapabilityMode; minVersion?: string }>;
  }): RoomRow {
    const room = this.getRoom(input.roomId);
    if (!room) {
      throw new AppError("NOT_FOUND", "Room not found.", 404);
    }
    const now = new Date().toISOString();
    const conflictPolicy = input.conflictPolicy ?? room.conflict_policy;
    const update = this.db.transaction(() => {
      this.db
        .prepare("update rooms set name = ?, type = ?, source_path = ?, mount_name = ?, conflict_policy = ?, updated_at = ? where id = ?")
        .run(input.name, input.type, input.sourcePath, input.mountName, conflictPolicy, now, input.roomId);
      this.db.prepare("delete from room_capabilities where room_id = ?").run(input.roomId);
      const insertCapability = this.db.prepare(
        "insert into room_capabilities(id, room_id, plugin_id, display_name, mode, min_version) values (?, ?, ?, ?, ?, ?)"
      );
      for (const capability of input.capabilities) {
        insertCapability.run(createId("cap"), input.roomId, capability.pluginId, capability.displayName, capability.mode, capability.minVersion ?? null);
      }
      this.audit({
        teamId: null,
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

  /** Room-mode toggle (docs/superpowers/plans/2026-07-20-crdt-sync.md contract 1.11). Separate
   *  from `updateRoom` since it's a distinct lifecycle concern with its own audit action, not just
   *  another settings field - Phase 6 hooks Y.Doc seeding onto this same transition once
   *  `CrdtDocManager` exists (contract 1.10's "conversion writes the current file text as the
   *  initial Y.Doc state"). */
  setRoomCrdtEnabled(input: { roomId: string; actorUserId: string; enabled: boolean }): RoomRow {
    const set = this.db.transaction(() => {
      this.db.prepare("update rooms set crdt_enabled = ?, updated_at = ? where id = ?").run(input.enabled ? 1 : 0, new Date().toISOString(), input.roomId);
      this.audit({
        teamId: null,
        actorType: "user",
        actorId: input.actorUserId,
        action: input.enabled ? "room.crdt_enabled" : "room.crdt_disabled",
        resourceType: "room",
        resourceId: input.roomId,
        metadata: {}
      });
    });
    set();
    const updated = this.getRoom(input.roomId);
    if (!updated) {
      throw new Error("Failed to update room");
    }
    return updated;
  }

  deleteAclRule(input: { aclId: string; roomId: string; actorUserId: string }): void {
    const rule = this.db.prepare("select * from acl_rules where id = ? and room_id = ?").get(input.aclId, input.roomId) as AclRuleRow | undefined;
    if (!rule) {
      throw new AppError("NOT_FOUND", "Access rule not found.", 404);
    }
    this.db.prepare("delete from acl_rules where id = ?").run(input.aclId);
    this.audit({
      teamId: null,
      actorType: "user",
      actorId: input.actorUserId,
      action: "acl.removed",
      resourceType: "room",
      resourceId: input.roomId,
      metadata: { aclId: input.aclId, subjectType: rule.subject_type, subjectId: rule.subject_id }
    });
  }

  deleteRoom(input: { roomId: string; actorUserId: string }): void {
    const room = this.getRoom(input.roomId);
    if (!room) {
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
      this.db.prepare("delete from invites where room_id = ?").run(input.roomId);
      this.db.prepare("delete from rooms where id = ?").run(input.roomId);
      this.audit({
        teamId: null,
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
      this.audit({
        teamId: input.teamId,
        actorType: "user",
        actorId: input.actorUserId,
        action: "team.deleted",
        resourceType: "team",
        resourceId: input.teamId,
        metadata: { teamName: team.name }
      });
      this.db.prepare("delete from acl_rules where subject_type = 'team' and subject_id = ?").run(input.teamId);
      this.db.prepare("delete from invites where team_id = ?").run(input.teamId);
      this.db.prepare("delete from team_members where team_id = ?").run(input.teamId);
      this.db.prepare("delete from teams where id = ?").run(input.teamId);
    });
    remove();
  }

  /**
   * Third-hardware-testing-round item 2: a fresh "allow" rule must supersede any existing "deny"
   * rule that would otherwise permanently block it, since `evaluatePolicy` (packages/policy-engine)
   * checks deny rules before allow rules regardless of which was created more recently - a member
   * revoked via a `deny` rule (the room-settings UI's natural, intuitive way to "remove access")
   * could otherwise never be re-granted access at all, even by a brand-new `allow` grant.
   *
   * Scoped deliberately narrow: only reconciles a deny rule for the *exact same*
   * (roomId, subjectType, subjectId, pathPattern) tuple as the new allow rule - no attempt at
   * general partial-path-overlap reconciliation across different `pathPattern` strings (out of
   * scope; the UI/tests always use "**\/*" for whole-room grants, so exact-tuple matching already
   * covers the reported bug). For each matched deny rule: if the new allow grant's permissions fully
   * cover the deny rule's permissions, the deny rule is deleted outright (this is the common case -
   * a reader/editor preset re-grant covering exactly what an earlier "remove access" deny blocked).
   * If only some of the deny rule's permissions are covered, the deny rule is narrowed to keep just
   * the non-overlapping permissions, so it keeps doing useful work for whatever the new allow grant
   * doesn't cover. A deny rule with no overlap at all is left untouched.
   *
   * Runs in the same transaction as the insert below so the delete/update-and-insert is atomic - no
   * crash window where the deny row is gone but the new allow row never landed, or vice versa.
   *
   * This is the public entry point (opens its own transaction) for callers with no transaction of
   * their own already open (the `POST /api/rooms/:roomId/acl` route). `RelayDb.transaction()` has no
   * nesting/savepoint support (see sqlJsAdapter.ts - it unconditionally issues a raw `BEGIN`), so a
   * caller that's already inside a transaction (e.g. `joinInvite`/`acceptInviteWithinTransaction`,
   * via `upsertRoomInviteGrant`) must call `createAclRuleWithinTransaction` directly instead of this
   * method, or the nested `BEGIN` fails outright.
   */
  createAclRule(input: {
    roomId: string;
    actorUserId: string;
    subjectType: SubjectType;
    subjectId: string;
    effect: AclEffect;
    permissions: Permission[];
    pathPattern: string;
  }): AclRule {
    return this.db.transaction(() => this.createAclRuleWithinTransaction(input))();
  }

  private createAclRuleWithinTransaction(input: {
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
    if (input.effect === "allow") {
      this.supersedeConflictingDenyRules(input, now);
    }
    this.db
      .prepare("insert into acl_rules(id, room_id, subject_type, subject_id, effect, permissions_json, path_pattern, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.roomId, input.subjectType, input.subjectId, input.effect, JSON.stringify(input.permissions), input.pathPattern, now);
    this.audit({
      teamId: null,
      actorType: "user",
      actorId: input.actorUserId,
      action: input.effect === "allow" ? "acl.granted" : "acl.denied",
      resourceType: "room",
      resourceId: input.roomId,
      metadata: { subjectType: input.subjectType, subjectId: input.subjectId, permissions: input.permissions, pathPattern: input.pathPattern }
    });
    return {
      id,
      roomId: input.roomId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      effect: input.effect,
      permissions: input.permissions,
      pathPattern: input.pathPattern,
      createdAt: now
    };
  }

  private supersedeConflictingDenyRules(
    input: { roomId: string; actorUserId: string; subjectType: SubjectType; subjectId: string; permissions: Permission[]; pathPattern: string },
    now: string
  ): void {
    const conflictingDenyRules = (
      this.db
        .prepare(
          "select * from acl_rules where room_id = ? and subject_type = ? and subject_id = ? and path_pattern = ? and effect = 'deny'"
        )
        .all(input.roomId, input.subjectType, input.subjectId, input.pathPattern) as AclRuleRow[]
    ).map(mapAclRule);
    for (const denyRule of conflictingDenyRules) {
      const remainingPermissions = denyRule.permissions.filter((permission) => !input.permissions.includes(permission));
      if (remainingPermissions.length === denyRule.permissions.length) {
        // No overlap at all - this deny rule isn't in conflict with the new allow grant, leave it.
        continue;
      }
      if (remainingPermissions.length === 0) {
        this.db.prepare("delete from acl_rules where id = ?").run(denyRule.id);
      } else {
        this.db.prepare("update acl_rules set permissions_json = ? where id = ?").run(JSON.stringify(remainingPermissions), denyRule.id);
      }
      this.audit({
        teamId: null,
        actorType: "user",
        actorId: input.actorUserId,
        action: "acl.deny_superseded",
        resourceType: "room",
        resourceId: input.roomId,
        metadata: {
          supersededAclId: denyRule.id,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          pathPattern: input.pathPattern,
          supersededByPermissions: input.permissions,
          removedPermissions: denyRule.permissions.filter((permission) => input.permissions.includes(permission)),
          remainingPermissions,
          deleted: remainingPermissions.length === 0,
          at: now
        }
      });
    }
  }

  listAclRulesForRoom(roomId: string): AclRule[] {
    return (this.db.prepare("select * from acl_rules where room_id = ? order by created_at asc").all(roomId) as AclRuleRow[]).map(mapAclRule);
  }

  listFiles(roomId: string): FileRow[] {
    return this.files.listFiles(roomId);
  }

  getFile(roomId: string, relativePath: string): FileRow | null {
    return this.files.getFile(roomId, relativePath);
  }

  getFileById(fileId: string): FileRow | null {
    return this.files.getFileById(fileId);
  }

  readFileContent(roomId: string, relativePath: string): { file: FileRow; content: string } {
    return this.files.readFileContent(roomId, relativePath);
  }

  writeFile(input: { roomId: string; relativePath: string; baseVersion: number; content: string; actorUserId: string }): FileWriteResult {
    return this.files.writeFile(input);
  }

  deleteFile(input: { roomId: string; relativePath: string; baseVersion: number; actorUserId: string }): FileDeleteResult {
    return this.files.deleteFile(input);
  }

  renameFile(input: { roomId: string; oldRelativePath: string; relativePath: string; actorUserId: string }): FileRenameResult {
    return this.files.renameFile(input);
  }

  latestFileVersion(fileId: string): FileVersionWithContentRow | null {
    return this.files.latestFileVersion(fileId);
  }

  // --- CRDT sync (docs/superpowers/plans/2026-07-20-crdt-sync.md Phase 2) ---

  /** Bumps a file's authoritative CRDT epoch (contract 1.9) and purges the old epoch's update
   *  log/snapshots (contract 1.5), transactionally. Standalone entry point for callers outside a
   *  delete (e.g. Phase 4's explicit epoch management); `deleteFile` calls the non-transactional
   *  `bumpFileCrdtEpochStatements` form directly so it stays atomic with its own tombstone update. */
  bumpFileCrdtEpoch(fileId: string): number {
    return this.db.transaction(() => this.bumpFileCrdtEpochStatements(fileId))();
  }

  private bumpFileCrdtEpochStatements(fileId: string): number {
    const row = this.db.prepare("select crdt_epoch from files where id = ?").get(fileId) as { crdt_epoch: number } | undefined;
    const currentEpoch = row?.crdt_epoch ?? 0;
    const newEpoch = currentEpoch + 1;
    this.db.prepare("update files set crdt_epoch = ? where id = ?").run(newEpoch, fileId);
    this.crdt.purgeCrdtStateStatements(fileId, currentEpoch);
    return newEpoch;
  }

  appendCrdtUpdate(fileId: string, epoch: number, updateBase64: string): number {
    return this.crdt.appendCrdtUpdate(fileId, epoch, updateBase64);
  }

  listCrdtUpdatesSince(fileId: string, epoch: number, sinceSeq: number): Array<{ seq: number; update: string }> {
    return this.crdt.listCrdtUpdatesSince(fileId, epoch, sinceSeq);
  }

  writeCrdtSnapshot(fileId: string, epoch: number, stateVectorBase64: string, snapshotBase64: string, upToSeq: number): void {
    this.crdt.writeCrdtSnapshot(fileId, epoch, stateVectorBase64, snapshotBase64, upToSeq);
  }

  getLatestCrdtSnapshot(fileId: string, epoch: number): CrdtSnapshot | null {
    return this.crdt.getLatestCrdtSnapshot(fileId, epoch);
  }

  purgeCrdtState(fileId: string, epoch: number): void {
    this.crdt.purgeCrdtState(fileId, epoch);
  }

  createCrdtFile(input: { roomId: string; relativePath: string; actorUserId: string }): { fileId: string; epoch: number } {
    return this.files.createCrdtFile(input);
  }

  materializeCrdtContent(input: { fileId: string; content: string; actorUserId: string }): { version: number; sha256: string } | null {
    return this.files.materializeCrdtContent(input);
  }

  getTeam(teamId: string): TeamRow | null {
    return (this.db.prepare("select * from teams where id = ?").get(teamId) as TeamRow | undefined) ?? null;
  }

  listTeams(): TeamRow[] {
    return this.db.prepare("select * from teams order by created_at asc").all() as TeamRow[];
  }

  /**
   * Minimal team directory (id/name/slug only, no ownerUserId or membership) for every team on the
   * server - safe to expose to any active principal, e.g. for the room ACL "grant to a team"
   * picker. Deliberately narrower than listTeams(), which exposes ownerUserId.
   */
  listTeamsDirectory(): Array<{ id: string; name: string; slug: string }> {
    return this.db.prepare("select id, name, slug from teams order by created_at asc").all() as Array<{
      id: string;
      name: string;
      slug: string;
    }>;
  }

  getUser(userId: string): UserRow | null {
    return (this.db.prepare("select * from users where id = ?").get(userId) as UserRow | undefined) ?? null;
  }

  getTeamMembership(teamId: string, userId: string): { role: TeamRole; revoked_at: string | null } | null {
    return (
      (this.db.prepare("select role, revoked_at from team_members where team_id = ? and user_id = ?").get(teamId, userId) as
        | { role: TeamRole; revoked_at: string | null }
        | undefined) ?? null
    );
  }

  audit(input: {
    teamId: string | null;
    actorType: "user" | "device" | "system";
    actorId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    metadata?: unknown;
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
        JSON.stringify(input.metadata ?? {}),
        input.ipAddress ?? null,
        new Date().toISOString()
      );
  }

  /**
   * Newest-first page of audit events. `teamId` narrows to one team's rows (used for the
   * team-admin view - server-level rows have a null team_id and are owner-only). Simple
   * limit/offset pagination is fine here: the table is append-only and newest-first, so a page
   * shifting by a few rows between requests only ever re-shows an event, never hides one.
   */
  listAuditEvents(options: { teamId?: string; limit: number; offset: number }): AuditEventRow[] {
    if (options.teamId !== undefined) {
      return this.db
        .prepare("select * from audit_events where team_id = ? order by created_at desc, id desc limit ? offset ?")
        .all(options.teamId, options.limit, options.offset) as AuditEventRow[];
    }
    return this.db
      .prepare("select * from audit_events order by created_at desc, id desc limit ? offset ?")
      .all(options.limit, options.offset) as AuditEventRow[];
  }

  private requireValidInvite(inviteToken: string): InviteRow {
    const invite = this.db.prepare("select * from invites where token_hash = ?").get(hashToken(inviteToken)) as InviteRow | undefined;
    if (!invite || invite.revoked_at || invite.use_count >= invite.max_uses || Date.parse(invite.expires_at) <= Date.now()) {
      throw new Error("Invalid or expired invite");
    }
    return invite;
  }

  private authenticateDeviceById(deviceId: string): DevicePrincipal | null {
    const row = this.db
      .prepare(
        `
          select
            d.id as device_id,
            d.display_name as device_display_name,
            d.revoked_at as device_revoked_at,
            u.id as user_id,
            u.display_name as user_display_name,
            u.revoked_at as user_revoked_at,
            (select value from server_meta where key = 'owner_user_id') as server_owner_id,
            d.token_security
          from devices d
          join users u on u.id = d.user_id
          where d.id = ?
        `
      )
      .get(deviceId) as DevicePrincipalRow | undefined;
    return row ? mapPrincipal(row) : null;
  }

  private rotateDeviceTokenWithinTransaction(
    deviceId: string,
    reason: "tls_migration" | "pinned_invite_accept"
  ): { deviceToken: string } {
    const deviceToken = createToken("dev");
    const result = this.db
      .prepare("update devices set token_hash = ?, token_security = 'tls' where id = ? and revoked_at is null")
      .run(hashToken(deviceToken), deviceId);
    if (result.changes !== 1) {
      throw new AppError("NOT_FOUND", "Active device not found.", 404);
    }
    this.audit({
      teamId: null,
      actorType: "device",
      actorId: deviceId,
      action: "device.token_rotated",
      resourceType: "device",
      resourceId: deviceId,
      metadata: { reason }
    });
    return { deviceToken };
  }

  private resolveInviteTarget(invite: InviteRow): InviteGrantResult {
    if (invite.team_id && invite.room_id) {
      throw new Error("Invite cannot target both a team and a room");
    }
    if (invite.team_id) {
      if (invite.role !== "admin" && invite.role !== "member") {
        throw new Error(`Unsupported team invite role: ${invite.role ?? "missing"}`);
      }
      const team = this.getTeam(invite.team_id);
      if (!team) {
        throw new Error("Team not found");
      }
      return { inviteType: "team", team: { id: team.id, slug: team.slug, name: team.name } };
    }
    if (invite.room_id) {
      if (invite.permission_preset !== "reader" && invite.permission_preset !== "editor") {
        throw new Error("Room invite permission preset is missing");
      }
      const room = this.getRoom(invite.room_id);
      if (!room) {
        throw new Error("Room not found");
      }
      return { inviteType: "room", room: { id: room.id, name: room.name } };
    }
    if (invite.role || invite.permission_preset) {
      throw new Error("Friend invite cannot carry a role or room preset");
    }
    return { inviteType: "friend" };
  }

  private upsertRoomInviteGrant(roomId: string, userId: string, preset: "reader" | "editor", actorUserId: string): void {
    const permissions = expandPreset(preset);
    const existing = this.db
      .prepare(
        "select * from acl_rules where room_id = ? and subject_type = 'user' and subject_id = ? and effect = 'allow' and path_pattern = '**/*' order by created_at asc limit 1"
      )
      .get(roomId, userId) as AclRuleRow | undefined;
    if (existing) {
      this.db.prepare("update acl_rules set permissions_json = ? where id = ?").run(JSON.stringify(permissions), existing.id);
      this.audit({
        teamId: null,
        actorType: "user",
        actorId: actorUserId,
        action: "acl.granted",
        resourceType: "room",
        resourceId: roomId,
        metadata: { aclId: existing.id, subjectType: "user", subjectId: userId, permissions, pathPattern: "**/*", updatedByInvite: true }
      });
      return;
    }
    // upsertRoomInviteGrant is always called from within an already-open transaction
    // (joinInvite/acceptInviteWithinTransaction) - use the non-transaction-opening variant, not the
    // public createAclRule (see its doc comment on why nesting RelayDb.transaction() calls breaks).
    this.createAclRuleWithinTransaction({
      roomId,
      actorUserId,
      subjectType: "user",
      subjectId: userId,
      effect: "allow",
      permissions,
      pathPattern: "**/*"
    });
  }

  private auditInviteUsed(invite: InviteRow, userId: string, displayName: string): void {
    this.audit({
      teamId: invite.team_id,
      actorType: "user",
      actorId: userId,
      action: "invite.used",
      resourceType: "invite",
      resourceId: invite.id,
      metadata: { displayName, roomId: invite.room_id }
    });
  }

  private auditMemberJoined(teamId: string, userId: string, inviteId: string, displayName: string): void {
    this.audit({
      teamId,
      actorType: "user",
      actorId: userId,
      action: "member.joined",
      resourceType: "user",
      resourceId: userId,
      metadata: { inviteId }
    });
    this.audit({
      teamId,
      actorType: "user",
      actorId: userId,
      action: "invite.used",
      resourceType: "invite",
      resourceId: inviteId,
      metadata: { displayName }
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
  return Boolean(principal && !principal.userRevokedAt && !principal.deviceRevokedAt);
}

export function canManageTeam(repo: RelayRepository, principal: DevicePrincipal, teamId: string): boolean {
  if (principal.isServerOwner) {
    return true;
  }
  const team = repo.getTeam(teamId);
  if (!team) {
    return false;
  }
  if (team.owner_user_id === principal.userId) {
    return true;
  }
  const membership = repo.getTeamMembership(teamId, principal.userId);
  return Boolean(membership && !membership.revoked_at && membership.role === "admin");
}

export function canManageRoom(principal: DevicePrincipal, room: RoomRow): boolean {
  return principal.isServerOwner || room.owner_user_id === principal.userId;
}

function mapPrincipal(row: DevicePrincipalRow): DevicePrincipal {
  return {
    deviceId: row.device_id,
    deviceDisplayName: row.device_display_name,
    deviceRevokedAt: row.device_revoked_at,
    userId: row.user_id,
    userDisplayName: row.user_display_name,
    userRevokedAt: row.user_revoked_at,
    isServerOwner: row.server_owner_id === row.user_id,
    tokenSecurity: row.token_security
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

function mapAclRule(row: AclRuleRow): AclRule {
  return {
    id: row.id,
    roomId: row.room_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    effect: row.effect,
    permissions: JSON.parse(row.permissions_json) as Permission[],
    pathPattern: row.path_pattern,
    createdAt: row.created_at
  };
}

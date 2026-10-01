import type { FastifyInstance } from "fastify";
import { AppError, assertPortablePath, isCrdtEligiblePath, normalizeRelativePath, type CapabilityMode, type ConflictPolicy, type Permission, type SubjectType } from "@vault-rooms/protocol";
import { evaluatePolicy, expandPreset, isPermissionPreset } from "@vault-rooms/policy";
import type { DevicePrincipal, RelayRepository } from "../db/repositories/relayRepository.js";
import { canManageRoom } from "../db/repositories/relayRepository.js";
import type { FileRow, RoomRow } from "../db/schema.js";
import { getActivePrincipal } from "../services/authService.js";
import { revalidateRoomAccess } from "../services/policyService.js";
import type { ConnectionRegistry } from "../sync/connectionRegistry.js";
import type { CrdtDocManager } from "../sync/crdtDocManager.js";
import type { PresenceService } from "../sync/presenceService.js";
import type { ContentWriteService } from "../storage/contentWriteService.js";
import { toInviteResponse, type InviteSecurityContext } from "./inviteResponse.js";

const LISTED_PERMISSIONS: Permission[] = [
  "room:read",
  "room:write",
  "room:delete",
  "file:read",
  "file:write",
  "file:create",
  "file:delete",
  "sync:subscribe",
  "sync:push"
];

export type RoomRoutesOptions = {
  publicUrl: string;
  connectionRegistry?: ConnectionRegistry;
  security?: InviteSecurityContext;
  /** Phase 6: needed so turning CRDT on for a room with pre-existing `.md` files can seed a fresh
   *  Y.Doc for each one (contract 1.4/1.5's "conversion never discards content") - optional only so
   *  tests/callers that never toggle crdtEnabled can omit it. */
  crdtDocManager?: CrdtDocManager;
  /** Live cursors: presence has to be cleared when a room is deleted or leaves the CRDT lane, and
   *  re-checked per path whenever an ACL mutation lands (the existing room-level revalidation cannot
   *  see a single path losing `file:read`). */
  presenceService: PresenceService;
  contentWriteService?: ContentWriteService;
};

export function registerRoomRoutes(app: FastifyInstance, repo: RelayRepository, options: RoomRoutesOptions): void {
  app.post("/api/rooms", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const body = request.body as Partial<{
      name: string;
      type: "file" | "folder";
      sourcePath: string;
      mountName: string;
      conflictPolicy: ConflictPolicy;
      crdtEnabled: boolean;
      capabilities: Array<{ pluginId: string; displayName: string; mode: CapabilityMode; minVersion?: string }>;
    }>;
    validateRoomBody(body);

    try {
      const room = repo.createRoom({
        name: body.name!,
        type: body.type!,
        sourcePath: body.sourcePath!,
        mountName: body.mountName!,
        ownerUserId: principal.userId,
        conflictPolicy: body.conflictPolicy,
        crdtEnabled: body.crdtEnabled,
        capabilities: body.capabilities ?? []
      });
      return { room: toRoomResponse(repo, room) };
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) {
        throw new AppError("VALIDATION_ERROR", "You already have a room with that folder name.", 409);
      }
      throw error;
    }
  });

  app.get("/api/rooms", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const teamIds = repo.listUserTeams(principal.userId).map((team) => team.teamId);
    const rooms = repo
      .listAllRooms()
      .map((room) => visibleRoom(repo, principal, room, teamIds))
      .filter((room): room is NonNullable<typeof room> => room !== null);

    return { rooms };
  });

  app.post("/api/rooms/:roomId/invites", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const { roomId } = request.params as { roomId: string };
    const room = requireRoom(repo, roomId);
    if (!canManageRoom(principal, room)) {
      throw new AppError("PERMISSION_DENIED", "Only the room owner or server owner can create invites.", 403);
    }
    const body = request.body as Partial<{ preset: "reader" | "editor"; expiresInMinutes: number; maxUses: number }>;
    if (body.preset !== "reader" && body.preset !== "editor") {
      throw new AppError("VALIDATION_ERROR", "Choose either the reader or the editor access level.", 422);
    }
    const invite = await repo.durable(() =>
      repo.createInvite({
        roomId,
        permissionPreset: body.preset!,
        createdByUserId: principal.userId,
        expiresInMinutes: body.expiresInMinutes ?? 60,
        maxUses: body.maxUses ?? 1
      })
    );
    return toInviteResponse(
      invite,
      options.publicUrl,
      repo.getOrCreateServerId(),
      repo.getSecurityState() === "plain_legacy" ? undefined : options.security
    );
  });

  app.patch("/api/rooms/:roomId", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const { roomId } = request.params as { roomId: string };
    const room = requireRoom(repo, roomId);
    if (!canManageRoom(principal, room)) {
      throw new AppError("PERMISSION_DENIED", "Only the room owner or server owner can update room settings.", 403);
    }

    const body = request.body as Partial<{
      name: string;
      type: "file" | "folder";
      sourcePath: string;
      mountName: string;
      conflictPolicy: ConflictPolicy;
      capabilities: Array<{ pluginId: string; displayName: string; mode: CapabilityMode; minVersion?: string }>;
      crdtEnabled: boolean;
    }>;
    validateRoomBody(body, room);

    if (body.crdtEnabled !== undefined && body.crdtEnabled !== Boolean(room.crdt_enabled) && repo.listPathCollisions(room.id).length) {
      throw new AppError("PATH_COLLISION", "Repair overlapping file names before changing Live editing.", 409);
    }

    try {
      let updated = repo.updateRoom({
        roomId,
        actorUserId: principal.userId,
        name: body.name!,
        type: body.type!,
        sourcePath: body.sourcePath!,
        mountName: body.mountName!,
        conflictPolicy: body.conflictPolicy,
        capabilities: body.capabilities ?? []
      });
      // CRDT room-mode toggle (contract 1.11) - a distinct lifecycle transition from the settings
      // above, so it gets its own repo method/audit action; broadcast lets an already-subscribed
      // socket transition cleanly without forcing a reconnect. Turning CRDT ON for a room that
      // already has existing .md files must seed a fresh CRDT document for each of them (Phase 6,
      // contract 1.4/1.5's "conversion never discards content", at a NEW epoch since
      // bumpFileCrdtEpoch/purgeCrdtState semantics apply even though there's nothing yet to purge)
      // - toggling OFF keeps serving files from their materialized files/file_versions rows, but only
      // after CrdtDocManager.retireRoom has landed every accepted live edit in them and before any
      // whole-file write is accepted; it then drops the room's documents and timers, so a stale
      // debounced materialize can never overwrite a later whole-file write.
      // The whole ON transition (flag flip + every per-file epoch bump/seed) goes through
      // repo.durable(...) as one lifecycle operation, matching this codebase's established pattern
      // for security/lifecycle transitions (see the epoch-bump code in Phase 2/4).
      if (body.crdtEnabled !== undefined && body.crdtEnabled !== Boolean(updated.crdt_enabled)) {
        const crdtEnabled = body.crdtEnabled;
        const actor = { userId: principal.userId, displayName: principal.userDisplayName };
        // The seed text is read before entering durable() - its callback must stay synchronous
        // (sqlJsAdapter.ts's durable() contract). Whole-file writes keep landing while those reads run,
        // so the commit re-checks the room against what was read and starts over if anything moved.
        const readSeeds = async () =>
          Promise.all(
            repo
              .listFiles(roomId)
              .filter((file) => !file.deleted_at && isCrdtEligiblePath(file.relative_path))
              .map(async (listed) =>
                options.contentWriteService
                  ? options.contentWriteService.readFileContent({ roomId, relativePath: listed.relative_path })
                  : { file: listed, content: repo.latestFileVersion(listed.id)?.content ?? "" }
              )
          );
        const switchMode = (filesToSeed: Array<{ file: FileRow; content: string }>) =>
          // Queued like every other database writer, so the image cannot start under one mid-commit.
          repo.withExclusiveAccess(() =>
            repo.durable(() => {
              const current = requireRoom(repo, roomId);
              if (Boolean(current.crdt_enabled) === crdtEnabled) {
                return current;
              }
              if (crdtEnabled && !seedsAreCurrent(repo, roomId, filesToSeed)) {
                throw new SeedsOutdated();
              }
              const room = repo.setRoomCrdtEnabled({ roomId, actorUserId: principal.userId, enabled: crdtEnabled });
              for (const { file, content } of filesToSeed) {
                const newEpoch = repo.bumpFileCrdtEpoch(file.id);
                options.crdtDocManager?.createDocumentFromText(file.id, newEpoch, content, actor);
              }
              return room;
            })
          );
        if (!crdtEnabled) {
          updated = options.crdtDocManager
            ? await options.crdtDocManager.retireRoom(roomId, () => switchMode([]), actor)
            : await switchMode([]);
        } else {
          for (let attempt = 1; ; attempt += 1) {
            try {
              updated = await switchMode(await readSeeds());
              break;
            } catch (error) {
              if (!(error instanceof SeedsOutdated)) throw error;
              if (attempt === MAX_SEED_ATTEMPTS) {
                throw new AppError("VERSION_CONFLICT", "Notes in this room kept changing while live editing was turning on - try again.", 409);
              }
            }
          }
        }
        if (!crdtEnabled) {
          // Leaving the CRDT lane retires every document in the room, so presence has nothing left to
          // attach to. Enabling needs no equivalent - there is no presence yet to clear.
          options.presenceService.removeRoom(roomId);
        }
        options.connectionRegistry?.broadcastToRoom(roomId, { type: "room_mode_changed", roomId, crdtEnabled });
      }
      const teamIds = repo.listUserTeams(principal.userId).map((team) => team.teamId);
      return { room: visibleRoom(repo, principal, updated, teamIds) ?? managedRoomResponse(repo, updated) };
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) {
        throw new AppError("VALIDATION_ERROR", "You already have a room with that folder name.", 409);
      }
      throw error;
    }
  });

  app.get("/api/rooms/:roomId/acl", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const { roomId } = request.params as { roomId: string };
    const room = requireRoom(repo, roomId);
    if (!canManageRoom(principal, room)) {
      throw new AppError("PERMISSION_DENIED", "Only the room owner or server owner can inspect room permissions.", 403);
    }

    return { aclRules: repo.listAclRulesForRoom(roomId) };
  });

  app.post("/api/rooms/:roomId/acl", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const { roomId } = request.params as { roomId: string };
    const room = requireRoom(repo, roomId);
    if (!canManageRoom(principal, room)) {
      throw new AppError("PERMISSION_DENIED", "Only the room owner or server owner can grant room permissions.", 403);
    }

    const body = request.body as Partial<{
      subjectType: SubjectType;
      subjectId: string;
      effect: "allow" | "deny";
      preset: string;
      permissions: Permission[];
      pathPattern: string;
    }>;
    if (!body.subjectType || !body.subjectId || !body.effect || !body.pathPattern) {
      throw new AppError("VALIDATION_ERROR", "An access rule needs a person or team, an allow/deny choice, and a path pattern.", 422);
    }
    if (!isSubjectType(body.subjectType)) {
      throw new AppError("VALIDATION_ERROR", "Choose a person or a team for this access rule.", 422);
    }
    if (body.effect !== "allow" && body.effect !== "deny") {
      throw new AppError("VALIDATION_ERROR", "Choose whether this access rule allows or denies access.", 422);
    }
    const preset = body.preset;
    if (preset !== undefined && (!isPermissionPreset(preset) || (body.effect === "allow" && preset === "blocked"))) {
      throw new AppError("VALIDATION_ERROR", "Choose Can view, Can edit, or Blocked.", 422);
    }
    // A preset on a deny is always a full block: older plugin builds send Blocked as a deny of the
    // reader preset, which on its own left creating, writing and deleting open.
    const permissions = preset !== undefined ? expandPreset(body.effect === "deny" ? "blocked" : preset) : body.permissions;
    if (!permissions || permissions.length === 0) {
      throw new AppError("VALIDATION_ERROR", "Choose an access level or at least one permission.", 422);
    }

    const aclRule = repo.createAclRule({
      roomId,
      actorUserId: principal.userId,
      subjectType: body.subjectType,
      subjectId: body.subjectId,
      effect: body.effect,
      permissions,
      pathPattern: body.pathPattern
    });
    revalidateRoomAccess(repo, options.connectionRegistry);
    // Live cursors: the room-level revalidation above only re-checks `sync:subscribe`, so a narrowing
    // ACL that revokes `file:read` on one path leaves the room subscription intact and fires no event
    // at all. This path-aware sweep is what actually removes that cursor.
    options.presenceService.revalidate();
    return { aclRule };
  });

  app.delete("/api/rooms/:roomId/acl/:aclId", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const { roomId, aclId } = request.params as { roomId: string; aclId: string };
    const room = requireRoom(repo, roomId);
    if (!canManageRoom(principal, room)) {
      throw new AppError("PERMISSION_DENIED", "Only the room owner or server owner can remove room permissions.", 403);
    }
    repo.deleteAclRule({ aclId, roomId, actorUserId: principal.userId });
    revalidateRoomAccess(repo, options.connectionRegistry);
    // Live cursors: the room-level revalidation above only re-checks `sync:subscribe`, so a narrowing
    // ACL that revokes `file:read` on one path leaves the room subscription intact and fires no event
    // at all. This path-aware sweep is what actually removes that cursor.
    options.presenceService.revalidate();
    return { ok: true };
  });

  app.delete("/api/rooms/:roomId", async (request) => {
    const principal = getActivePrincipal(repo, request);
    const { roomId } = request.params as { roomId: string };
    const room = requireRoom(repo, roomId);
    if (!canManageRoom(principal, room)) {
      throw new AppError("PERMISSION_DENIED", "Only the room owner or server owner can delete rooms.", 403);
    }
    // Before deleteRoom, not after: the removal fanout has to evaluate per-recipient `file:read`, and
    // once the room (and its cascaded ACL rules) are gone that is no longer possible - the retraction
    // would be dropped rather than delivered.
    options.presenceService.removeRoom(roomId);
    const blobKeys = repo.listFiles(roomId).flatMap((file) => repo.listBlobKeysForFile(file.id));
    repo.deleteRoom({ roomId, actorUserId: principal.userId });
    await options.contentWriteService?.collectOrphanedBlobKeys(blobKeys);
    options.connectionRegistry?.broadcastToRoom(roomId, { type: "room_deleted", roomId });
    return { ok: true };
  });
}

/** Read attempts before turning live editing on gives up on a room whose notes keep changing. */
const MAX_SEED_ATTEMPTS = 3;

/** The notes changed between reading their seed text and committing the switch. */
class SeedsOutdated extends Error {}

/** Whether the room's live Markdown notes are exactly the seeded ones, each still at the version its
 *  seed text was read from. */
function seedsAreCurrent(repo: RelayRepository, roomId: string, seeds: Array<{ file: FileRow }>): boolean {
  const seededVersions = new Map(seeds.map(({ file }) => [file.id, file.version]));
  const live = repo.listFiles(roomId).filter((file) => !file.deleted_at && isCrdtEligiblePath(file.relative_path));
  return live.length === seededVersions.size && live.every((file) => seededVersions.get(file.id) === file.version);
}

function visibleRoom(repo: RelayRepository, principal: DevicePrincipal, room: RoomRow, teamIds: string[]) {
  const subject = { type: "user" as const, id: principal.userId, userId: principal.userId, teamIds };
  const aclRules = repo.listAclRulesForRoom(room.id);
  const roomRead = evaluatePolicy({
    subject,
    resource: { type: "room", roomId: room.id, roomOwnerUserId: room.owner_user_id },
    permission: "room:read",
    aclRules,
    membershipRevokedAt: principal.userRevokedAt,
    deviceRevokedAt: principal.deviceRevokedAt
  });
  if (!roomRead.allowed) {
    return null;
  }

  const decisions = new Map(
    LISTED_PERMISSIONS.map((permission) => [
      permission,
      evaluatePolicy({
        subject,
        resource: resourceFor(permission, room),
        permission,
        aclRules,
        membershipRevokedAt: principal.userRevokedAt,
        deviceRevokedAt: principal.deviceRevokedAt
      })
    ])
  );
  const permissions = LISTED_PERMISSIONS.filter((permission) => decisions.get(permission)?.allowed);
  const editorPermissions = expandPreset("editor");
  const readerPermissions = expandPreset("reader");
  const accessLevel = editorPermissions.every((permission) => decisions.get(permission)?.allowed)
    ? "editor" as const
    : readerPermissions.every((permission) => decisions.get(permission)?.allowed)
      ? "reader" as const
      : "custom" as const;
  const sourcePermissions = accessLevel === "editor"
    ? editorPermissions
    : accessLevel === "reader"
      ? readerPermissions
      : permissions;
  const matchedRuleIds = [
    ...new Set(sourcePermissions.flatMap((permission) => decisions.get(permission)?.matchedRuleIds ?? []))
  ];
  type AccessSource =
    | { type: "owner" }
    | { type: "direct" }
    | { type: "team"; teamId: string; teamName: string };
  const sources: AccessSource[] = matchedRuleIds.length === 0 && room.owner_user_id === principal.userId
    ? [{ type: "owner" as const }]
    : matchedRuleIds.flatMap<AccessSource>((ruleId) => {
        const rule = aclRules.find((candidate) => candidate.id === ruleId);
        if (!rule) return [];
        if (rule.subjectType === "user") return [{ type: "direct" as const }];
        const team = repo.getTeam(rule.subjectId);
        return team
          ? [{ type: "team" as const, teamId: team.id, teamName: team.name }]
          : [];
      });

  return {
    ...managedRoomResponse(repo, room),
    permissions,
    accessSummary: {
      level: accessLevel,
      sources: sources.filter(
        (source, index, all) =>
          all.findIndex((candidate) =>
            candidate.type === source.type &&
            (candidate.type !== "team" || (source.type === "team" && candidate.teamId === source.teamId))
          ) === index
      )
    }
  };
}

function resourceFor(permission: Permission, room: RoomRow) {
  if (permission.startsWith("room:")) {
    return { type: "room" as const, roomId: room.id, roomOwnerUserId: room.owner_user_id };
  }
  return { type: "file" as const, roomId: room.id, roomOwnerUserId: room.owner_user_id, relativePath: "" };
}

function managedRoomResponse(repo: RelayRepository, room: RoomRow) {
  return {
    ...toRoomResponse(repo, room),
    permissions: [] as Permission[],
    capabilities: repo.listCapabilities(room.id).map((capability) => ({
      pluginId: capability.plugin_id,
      displayName: capability.display_name,
      mode: capability.mode,
      minVersion: capability.min_version ?? undefined,
      installed: null
    }))
  };
}

function toRoomResponse(repo: RelayRepository, room: RoomRow) {
  return {
    id: room.id,
    name: room.name,
    type: room.type,
    sourcePath: room.source_path,
    mountName: room.mount_name,
    ownerUserId: room.owner_user_id,
    conflictPolicy: room.conflict_policy,
    crdtEnabled: Boolean(room.crdt_enabled),
    // Shared blobs are counted in each referencing room.
    storedBytes: repo.getRoomStorageBytes(room.id)
  };
}

function requireRoom(repo: RelayRepository, roomId: string): RoomRow {
  const room = repo.getRoom(roomId);
  if (!room) {
    throw new AppError("NOT_FOUND", "Room not found.", 404);
  }
  return room;
}

function validateRoomBody(body: Partial<{
  name: string;
  type: "file" | "folder";
  sourcePath: string;
  mountName: string;
  conflictPolicy: ConflictPolicy;
  crdtEnabled: boolean;
}>, previous?: { source_path: string; mount_name: string }): void {
  if (!body.name || !body.type || !body.sourcePath || !body.mountName) {
    throw new AppError("VALIDATION_ERROR", "Enter a room name, choose the shared folder, and enter its folder name.", 422);
  }
  if (body.type !== "file" && body.type !== "folder") {
    throw new AppError("VALIDATION_ERROR", "Choose a folder room.", 422);
  }
  // sourcePath names a folder/file in the OWNER's own vault, but it's still attacker-controllable
  // input over the wire (a buggy or modified client could send anything) and nothing downstream
  // re-checks it - normalize it the same way any other room-relative path is normalized, so a
  // ".." or absolute path can never be stored, broadcast, or handed back to a client to mount.
  try {
    body.sourcePath = normalizeRelativePath(body.sourcePath);
  } catch {
    throw new AppError("INVALID_PATH", "Choose a visible folder inside the vault.", 422);
  }
  if (!isSafeMountName(body.mountName)) {
    throw new AppError("INVALID_PATH", "The local folder name must be one valid folder name.", 422);
  }
  if (body.sourcePath !== previous?.source_path) assertPortablePath(body.sourcePath);
  if (body.mountName !== previous?.mount_name) assertPortablePath(body.mountName);
  if (body.conflictPolicy !== undefined && body.conflictPolicy !== "keep_both" && body.conflictPolicy !== "owner_wins") {
    throw new AppError("VALIDATION_ERROR", "Choose how this room handles conflicting file changes.", 422);
  }
  if (body.crdtEnabled !== undefined && typeof body.crdtEnabled !== "boolean") {
    throw new AppError("VALIDATION_ERROR", "Choose whether Live editing is on for this room.", 422);
  }
}

function isSubjectType(value: string): value is SubjectType {
  return value === "user" || value === "team";
}

function isSafeMountName(value: string): boolean {
  return Boolean(value) && !value.includes("/") && !value.includes("\\") && !value.startsWith(".") && value !== "." && value !== "..";
}

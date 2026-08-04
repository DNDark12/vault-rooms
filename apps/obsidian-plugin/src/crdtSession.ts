import * as Y from "yjs";
import { isCrdtEligiblePath, type SyncClientMessage, type SyncServerMessage } from "@vault-rooms/protocol";
import { CRDT_TEXT_KEY } from "vault-rooms-relay/embedded-core";
import type { CrdtDocStore } from "./crdtDocStore.js";
import { reconcileYTextWithDiskText } from "./crdtReconcile.js";
import { CrdtPresenceSession } from "./crdtPresence.js";

/** Origin tag applied when hydrating a Y.Doc from persisted state (contract 1.12) - never sent
 *  back to the server, same reasoning as REMOTE_ORIGIN below (it's not a new edit, just replaying
 *  what the doc already durably had). */
const HYDRATE_ORIGIN = Symbol("crdt-hydrate");
/** Origin tag applied to updates that arrived from the server (handshake diffs or fanout) - the
 *  `doc.on("update")` listener skips re-sending anything tagged with this, so remote-applied
 *  updates never echo back to the server that just sent them. */
export const REMOTE_ORIGIN = Symbol("crdt-remote");
/** Exported for tests/editor-binding code that want to tag their own local-origin transactions
 *  explicitly (anything that isn't REMOTE_ORIGIN/HYDRATE_ORIGIN is already treated as local by the
 *  update listener - see the doc comment on CrdtSessionManager - but a named constant reads better
 *  than `undefined` at call sites that want to be explicit about it). */
export const LOCAL_ORIGIN = Symbol("crdt-local");

const PERSIST_DEBOUNCE_MS = 800;
const MATERIALIZE_DEBOUNCE_MS = 800;
/** Bound on reconcileAgainstDisk's retry loop (see its doc comment) - a real run would only ever
 *  need more than one attempt under a continuous flood of incoming updates for several disk-read
 *  round trips in a row; this just guarantees the loop can't spin forever. */
const MAX_RECONCILE_ATTEMPTS = 5;

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function sessionKey(roomId: string, relativePath: string): string {
  return `${roomId}\0${relativePath}`;
}

/**
 * A `crdt_rejected` answer to one of this manager's requests, carrying the server's error `code`
 * alongside its message. Callers need the code, not just the text: main.ts's rename fallback must
 * treat "the old path was never on the server" (NOT_FOUND/FILE_DELETED - creating at the new path is
 * the correct recovery) differently from "the new path is already taken" (FILE_EXISTS - creating is
 * both impossible and how stray duplicate files used to get manufactured; see the sixth
 * hardware-testing round in docs/superpowers/plans/2026-07-20-crdt-sync.md).
 */
export class CrdtRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "CrdtRejectedError";
  }
}

export type CrdtSession = {
  roomId: string;
  relativePath: string;
  epoch: number;
  doc: Y.Doc;
  ytext: Y.Text;
  /** Whether this session is currently bound to an open CM6 editor (crdtEditorBinding.ts). While
   *  bound, remote updates are applied to the doc but not separately materialized to disk (the
   *  editor + Obsidian's own save own the on-disk copy) - matching the research spec's "remote
   *  updates apply into the editor without touching the file on disk until Obsidian's own save." */
  boundToEditor: boolean;
  /** Bumped by the `doc.on("update", ...)` listener on *every* applied update, regardless of
   *  origin (local, remote, hydrate). Lets `reconcileAgainstDisk` detect whether a concurrent
   *  `remote_crdt_update`/handshake merge landed in the Y.Doc while a `readDiskText` await was in
   *  flight - see that method's doc comment for the data-loss bug this closes. */
  revision: number;
  /** Exact callback registered with Y.Doc, retained so retirement can remove it before destroy. */
  updateHandler: (update: Uint8Array, origin: unknown) => void;
  /** Resolves after the first server step2 has hydrated/reconciled this document. Editor binding
   *  waits for this so an already-populated CM6 view is never attached to a still-empty replacement
   *  Y.Doc during remount. */
  initialSync: Promise<void>;
  resolveInitialSync: () => void;
  /** Live cursors. Bound to this session's immutable Y.Doc: when an epoch bump or recovery replaces
   *  the doc, the whole presence session is destroyed and rebuilt alongside it rather than being
   *  re-pointed, because yCollab freezes (ytext, awareness) together into one CodeMirror facet. */
  presence: CrdtPresenceSession;
};

export type CrdtSessionManagerDeps = {
  /** Returns false when the socket wasn't open and the message was dropped. Anything that waits for a reply
   *  must treat that as an immediate failure - see `performRename`/`ensureEpoch`. */
  send: (message: SyncClientMessage) => boolean | void;
  docStore: CrdtDocStore;
  isRoomCrdtEnabled: (roomId: string) => boolean;
  /** Pending structural journal paths must not adopt a reconnect snapshot before their receipt is
   *  resolved, or an unrelated server document can overwrite the offline local note. */
  isPathProtectedByJournal?: (roomId: string, relativePath: string) => boolean;
  /** Reads the current on-disk text for reconciliation. Returns null if the file doesn't exist
   *  locally (nothing to reconcile against yet - e.g. a brand-new remote document not yet
   *  downloaded). */
  readDiskText: (roomId: string, relativePath: string) => Promise<string | null>;
  /** Writes materialized doc text back to the vault when the file is not currently bound to an open
   *  editor (coexistence: an unopened CRDT file's on-disk copy still needs to stay current - see
   *  the research spec's "when the file is not open" case). */
  writeDiskText: (roomId: string, relativePath: string, text: string) => Promise<void>;
  /** Moves the vault file on disk to match a `remote_crdt_rename` from another device (fourth
   *  hardware-testing round, 2026-07-23) - never called for this device's *own* rename (Obsidian
   *  already renamed the file itself before the watcher ever fired). A no-op if the source path
   *  doesn't exist locally (e.g. this device never downloaded the file before the rename). */
  renameDiskFile: (roomId: string, oldRelativePath: string, newRelativePath: string) => Promise<void>;
  onSessionChanged?: (roomId: string, relativePath: string) => void;
  /** Synchronously removes editor bindings before a session's Y.Doc is destroyed. */
  onSessionRetiring?: (roomId: string, relativePath: string) => void;
  /** Lets the editor controller attach open views after a replacement/new session becomes live. */
  onSessionOpened?: (roomId: string, relativePath: string) => void;
  /** Called when the server assigned this device's brand-new note a different path than the one it
   *  asked for, because another device had already created a note at that path first (every new
   *  Obsidian note starts with the same default name, so this is routine, not an error). The local
   *  file has already been moved to `relativePath` by the time this fires - main.ts uses it to tell
   *  the user why the note they just made is now called something else. */
  onPathReassigned?: (roomId: string, requestedRelativePath: string, relativePath: string) => void;
  createRequestId?: () => string;
  schedule?: (fn: () => void, ms: number) => number;
  cancel?: (id: number) => void;
};

/** The subset of RoomSyncSocket's wiring the CRDT lane needs - kept as a small structural interface
 *  (rather than importing RoomSyncSocket's own types back) so syncWsClient.ts can depend on this
 *  without a circular import. */
export interface CrdtWsBridge {
  handleServerMessage(message: SyncServerMessage): Promise<void>;
  handleRoomSnapshot(roomId: string, files: Array<{ relativePath: string; crdtEpoch?: number }>): void;
  /** Re-runs the outbound half of the bidirectional handshake for every currently-active session -
   *  call this once the socket (re)connects (contract 1.3, blocker 1: this is what recovers a local
   *  edit made while offline, since the server's reply to this step1 request is what will surface
   *  it wants the client's missing update). */
  onConnected(): void;
  /** Called when the connection is lost, so requests waiting on a server reply can be failed instead of
   *  hanging forever - see the implementation for the orphaned-rename bug that caused. */
  onDisconnected(): void;
  /** Records a document's epoch learned from a `remote_file_change` announce/materialize, so the disk
   *  write it triggers can't make this device try to create a document the server already has - see
   *  the implementation's doc comment for the feedback loop this prevents. */
  registerKnownEpoch(roomId: string, relativePath: string, epoch: number): void;
  /** Whether a live CRDT session is already open for (roomId, relativePath) - used by
   *  syncWsClient.ts's `remote_file_change` handler (second-hardware-testing-round item 1) to decide
   *  whether the materialized fallback broadcast should still be applied to disk. When a session is
   *  already open, the CRDT lane owns this file live and applying the coarser materialized snapshot
   *  on top could clobber in-flight editor state; when no session is open (including for a file that
   *  was never a CRDT target at all), applying it keeps the on-disk copy fresh. */
  isSessionOpen(roomId: string, relativePath: string): boolean;
}

/**
 * Owns per-file CRDT session state on the client: persistent hydration (contract 1.12, strategy A),
 * the bidirectional handshake (contract 1.3) both as the initiator (on session open / reconnect)
 * and as the responder (to the server's own independently-sent step1), first-create + stale-epoch
 * resync (contracts 1.5/1.9/1.10), and origin-tagged update forwarding so remote-applied updates
 * never echo back to the server that sent them.
 *
 * A session is only ever created for a path that is both CRDT-eligible (`.md`) and in a room with
 * `crdtEnabled` - `ensureSession` throws if called for anything else, since every caller (the editor
 * binding, the file-watcher's CRDT-lane branch) is expected to have already checked this via
 * `isCrdtManagedLocalChange`/equivalent before calling in.
 */
export class CrdtSessionManager implements CrdtWsBridge {
  private readonly sessions = new Map<string, CrdtSession>();
  private readonly knownEpoch = new Map<string, number>();
  private readonly pendingCreate = new Map<
    string,
    {
      key: string;
      resolve: (created: { epoch: number; relativePath: string; documentCreatedNow: boolean }) => void;
      reject: (error: Error) => void;
    }
  >();
  /** Coalesces concurrent `ensureSession` callers for the same (roomId, relativePath) onto one
   *  in-flight open (see `ensureSession`'s doc comment for why this needs to wrap the whole open,
   *  not just the epoch fetch). */
  private readonly pendingSessionOpen = new Map<string, Promise<CrdtSession>>();
  private readonly pendingHandshake = new Map<string, string>();
  /** Correlates an in-flight `crdt_rename` request with its `crdt_renamed`/`crdt_rejected` answer -
   *  see `renameSession`. */
  private readonly pendingRename = new Map<
    string,
    { resolve: (acked: { epoch: number; relativePath: string }) => void; reject: (error: Error) => void }
  >();
  /** One promise chain per room, serializing `renameSession` calls - see its doc comment for the
   *  duplicate-file race this closes. Keyed by room (not by path) deliberately: a rename chain's
   *  whole point is that each link's path depends on the previous link's outcome. */
  private readonly renameChains = new Map<string, Promise<unknown>>();
  /** Paths with an in-flight `recoverMissingDocument` attempt - see that method for why re-entrancy
   *  here has to be blocked rather than retried. */
  private readonly recoveringPaths = new Set<string>();
  /** Destination paths of in-flight renames. `ensureSession` waits for the rename rather than creating
   *  a competing document at a path a rename is about to move an existing document onto - see
   *  `renameSession` for the self-collision this closes. */
  private readonly pendingRenameTargets = new Set<string>();
  private readonly persistTimers = new Map<string, number>();
  private readonly materializeTimers = new Map<string, number>();
  private readonly schedule: (fn: () => void, ms: number) => number;
  private readonly cancel: (id: number) => void;
  private requestCounter = 0;
  private disposed = false;

  constructor(private readonly deps: CrdtSessionManagerDeps) {
    this.schedule = deps.schedule ?? ((fn, ms) => window.setTimeout(fn, ms));
    this.cancel = deps.cancel ?? ((id) => window.clearTimeout(id));
  }

  /** Feeds per-file known epochs from a `room_snapshot` (contract 1.11) - the only source of epoch
   *  info for a document this device hasn't created itself in this session. */
  handleRoomSnapshot(roomId: string, files: Array<{ relativePath: string; crdtEpoch?: number }>): void {
    for (const file of files) {
      if (file.crdtEpoch !== undefined && !this.deps.isPathProtectedByJournal?.(roomId, file.relativePath)) {
        this.knownEpoch.set(sessionKey(roomId, file.relativePath), file.crdtEpoch);
      }
    }
  }

  /** Re-runs the handshake for every live session - call on reconnect (blocker 1: outbound recovery
   *  of a local edit made while offline). */
  onConnected(): void {
    for (const session of this.sessions.values()) {
      if (this.deps.isPathProtectedByJournal?.(session.roomId, session.relativePath)) continue;
      this.startHandshake(session);
    }
  }

  /**
   * Fails every request that was waiting on a server reply, because that reply is never coming once the
   * connection is gone. Only the two request kinds whose callers have real recovery logic are settled:
   * `renameSession`'s promise (main.ts decides between creating at the new path and leaving both paths
   * alone) and `ensureEpoch`'s create (its caller reports the failure and the next vault event retries).
   * Leaving them pending was a live bug: a `crdt_rename` interrupted by a dropped socket never resolved
   * *or* rejected, so main.ts's fallback never ran and the session stayed keyed to the old path while the
   * file on disk had already moved. Pending handshakes need no such treatment - `onConnected` restarts
   * one for every open session on reconnect.
   */
  onDisconnected(): void {
    // Presence is not re-announced from onConnected: it waits for each session's own handshake to
    // complete (see the crdt_sync_step2 handler). Local selections are retained across the gap so the
    // re-announce lands where the user actually is.
    for (const session of this.sessions.values()) {
      session.presence.setTransportReady(false);
    }
    const reason = new Error("The connection to the server was lost before this request was answered.");
    for (const [requestId, pending] of [...this.pendingRename.entries()]) {
      this.pendingRename.delete(requestId);
      pending.reject(reason);
    }
    for (const [requestId, pending] of [...this.pendingCreate.entries()]) {
      this.pendingCreate.delete(requestId);
      pending.reject(reason);
    }
    this.pendingHandshake.clear();
  }

  isSessionOpen(roomId: string, relativePath: string): boolean {
    return this.sessions.has(sessionKey(roomId, relativePath));
  }

  /** Presence half of main.ts's "Diagnose live editing" command - undefined when no session is open
   *  for this target, so the caller can distinguish "no session" from "session but no cursors". */
  describePresence(roomId: string, relativePath: string): ReturnType<CrdtPresenceSession["describe"]> | undefined {
    return this.sessions.get(sessionKey(roomId, relativePath))?.presence.describe();
  }

  /**
   * Records the epoch of a document this device learned about from the server *without* opening a
   * session for it - specifically a `remote_file_change` carrying `crdtEpoch` (a creation announce or
   * materialized fanout). This is what stops a receive→create feedback loop: applying that broadcast
   * writes the file to disk, which makes this device's own vault watcher fire a local "create", which
   * calls `ensureSession`. With no known epoch, `ensureSession` would `crdt_create` a path the server
   * already has a document at - and once collisions started auto-renaming rather than failing, each
   * such collision produced a new suffixed name that was announced back, escalating without bound
   * between the two devices (`Untitled (a) (b) (a) (b)…`). Knowing the epoch makes that same
   * `ensureSession` adopt the existing document instead. Never downgrades a newer epoch, and never
   * touches an already-open session (that path has its own epoch/handshake handling).
   */
  registerKnownEpoch(roomId: string, relativePath: string, epoch: number): void {
    if (!isCrdtEligiblePath(relativePath) || !this.deps.isRoomCrdtEnabled(roomId)) {
      return;
    }
    const key = sessionKey(roomId, relativePath);
    if (this.sessions.has(key)) {
      return;
    }
    const known = this.knownEpoch.get(key);
    if (known !== undefined && known >= epoch) {
      return;
    }
    this.knownEpoch.set(key, epoch);
  }

  /**
   * Opens a session **only** for a document this device already knows an epoch for (from a room
   * snapshot, an announce, or an earlier open) - returning undefined instead of allocating a new
   * document when it doesn't.
   *
   * This is what the editor-binding pass uses. Binding an editor must never *create* a document,
   * because Obsidian moves the open editor's file as part of a rename and can deliver the resulting
   * workspace event *before* the vault rename event: the bind pass then allocated a fresh document at
   * the rename's destination path, and the rename that arrived milliseconds later collided with it
   * (`crdt_create` at .450, `crdt_rename` at .455, `crdt_rejected FILE_EXISTS` at .469 in a real WS
   * trace). Claiming the destination inside `renameSession` only helps when the rename is seen first,
   * which is why that guard alone did not close this. A document's existence is owned by the vault
   * "create" watcher event (and by the server's own snapshot/announce); the editor only ever attaches
   * to one. A brand-new note therefore binds a beat later - once its create event has established the
   * document - rather than racing it.
   */
  async ensureSessionIfKnown(roomId: string, relativePath: string): Promise<CrdtSession | undefined> {
    if (
      !this.deps.isRoomCrdtEnabled(roomId) ||
      !isCrdtEligiblePath(relativePath) ||
      this.deps.isPathProtectedByJournal?.(roomId, relativePath)
    ) {
      return undefined;
    }
    const key = sessionKey(roomId, relativePath);
    if (!this.sessions.has(key) && this.knownEpoch.get(key) === undefined) {
      return undefined;
    }
    const session = await this.ensureSession(roomId, relativePath);
    await session.initialSync;
    return this.sessions.get(key) === session ? session : undefined;
  }

  /** Marks a session as currently bound to an open CM6 editor - see CrdtSession.boundToEditor. */
  bindToEditor(roomId: string, relativePath: string): void {
    const session = this.sessions.get(sessionKey(roomId, relativePath));
    if (session) session.boundToEditor = true;
  }

  unbindFromEditor(roomId: string, relativePath: string): void {
    const session = this.sessions.get(sessionKey(roomId, relativePath));
    if (session) session.boundToEditor = false;
  }

  /**
   * Opens (or returns the already-open) CRDT session for (roomId, relativePath): allocates an
   * epoch via `crdt_create` if this device has never seen one for this path, hydrates persisted
   * state if any (contract 1.12), reconciles disk text against it *before* starting the handshake,
   * wires update forwarding, and kicks off the handshake. Safe to call repeatedly - returns the
   * existing live session unless its epoch has been superseded.
   */
  async ensureSession(
    roomId: string,
    relativePath: string,
    options: { brandNewNote?: boolean; operationId?: string } = {}
  ): Promise<CrdtSession> {
    if (!this.deps.isRoomCrdtEnabled(roomId) || !isCrdtEligiblePath(relativePath)) {
      throw new Error(`ensureSession called for a non-CRDT target: ${roomId}/${relativePath}`);
    }
    const key = sessionKey(roomId, relativePath);
    // A rename is already in flight to move an existing document onto this exact path. Creating one
    // here would race it and win, so the rename would then collide with this device's own brand-new
    // document (FILE_EXISTS) - the self-collision confirmed from a real WS trace, where Obsidian's
    // rename moved the open editor's file, the pane bind pass fired ensureSession for the destination,
    // and that allocated a competing document ~5ms before the rename arrived. Wait for the rename
    // instead: once it lands, the epoch for this path is known and the code below adopts it.
    if (this.pendingRenameTargets.has(key)) {
      await (this.renameChains.get(roomId) ?? Promise.resolve()).catch(() => undefined);
    }
    // Coalesce concurrent callers for the same path (e.g. the vault watcher's "create" event and
    // the editor-open path both firing for a brand-new note at nearly the same time) onto one
    // in-flight open, end to end - not just the crdt_create request. Without this, two callers that
    // both raced past the epoch fetch would each independently build their own Y.Doc/session and
    // stomp on each other in the `sessions` map, silently orphaning whichever one lost the race.
    const inFlight = this.pendingSessionOpen.get(key);
    if (inFlight) {
      return inFlight;
    }
    const opening = this.openSession(roomId, relativePath, key, options.brandNewNote === true, options.operationId).finally(() => {
      this.pendingSessionOpen.delete(key);
    });
    this.pendingSessionOpen.set(key, opening);
    return opening;
  }

  /** Resolves a durable create receipt without opening or handshaking a live Y.Doc session. */
  async resolveCreateOperation(
    roomId: string,
    relativePath: string,
    operationId: string
  ): Promise<{ relativePath: string }> {
    const resolved = await this.ensureEpoch(roomId, relativePath, true, operationId);
    return { relativePath: resolved.relativePath };
  }

  /** Resolves a durable rename receipt without rekeying local CRDT state after live editing was disabled. */
  async resolveRenameOperation(
    roomId: string,
    oldRelativePath: string,
    relativePath: string,
    operationId: string
  ): Promise<{ relativePath: string }> {
    const resolved = await this.requestRename(roomId, oldRelativePath, relativePath, operationId);
    return { relativePath: resolved.relativePath };
  }

  /**
   * Renames this device's own already-known CRDT file (fourth hardware-testing round, 2026-07-23):
   * sends `crdt_rename` and, once the server acks with `crdt_renamed`, rekeys this session's
   * in-memory/persisted state onto the new path - without tearing down or re-seeding the `Y.Doc`,
   * unlike the old delete-old+create-new translation this replaces. A live-bound editor keeps its
   * document identity, network connection, and content throughout. Never touches the vault file on
   * disk - the caller (main.ts's watcher, reacting to Obsidian's own rename event) only calls this
   * after Obsidian has already renamed the file itself; see `renameDiskFile` for the other device's
   * side of this, which does need to move the file.
   */
  async renameSession(
    roomId: string,
    oldRelativePath: string,
    newRelativePath: string,
    options: { operationId?: string } = {}
  ): Promise<{ relativePath: string }> {
    // Serialized per room, because Obsidian emits one rename event per *commit* of an inline title
    // edit - retitling a note in several steps ("Untitled" -> "a" -> "ab" -> "abc") fires a chain of
    // renames in quick succession, and the caller (main.ts's watcher) fires each one without
    // awaiting. Run concurrently, request N+1's `oldRelativePath` could reach the server before
    // request N had moved the file there, so it 404'd - and the old code's fallback then created a
    // *new* document at the new path, leaving the original behind as a duplicate. Chaining makes each
    // rename start from the path the previous one actually established. A failed link doesn't break
    // the chain (`.catch`) - the next rename still runs and is judged on its own answer.
    // Claim the destination *synchronously*, before anything is sent or awaited. Obsidian's own rename
    // moves the open editor's file, which fires active-leaf-change and re-runs the pane bind pass - so
    // `ensureSession` gets called for the destination path while this rename is still in flight. With
    // no session or known epoch there yet, that call allocated a brand-new document at the destination,
    // and the rename then collided with the document its own device had just created ~5ms earlier
    // (`FILE_EXISTS`, confirmed from a real WS trace - eleventh hardware-testing round, 2026-07-24).
    // `ensureSession` consults this set and waits for the rename instead of creating.
    const destinationKey = sessionKey(roomId, newRelativePath);
    this.pendingRenameTargets.add(destinationKey);
    const previous = this.renameChains.get(roomId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => this.performRename(roomId, oldRelativePath, newRelativePath, options.operationId))
      .finally(() => {
        this.pendingRenameTargets.delete(destinationKey);
      });
    this.renameChains.set(
      roomId,
      run.catch(() => undefined)
    );
    return run;
  }

  private async performRename(
    roomId: string,
    oldRelativePath: string,
    newRelativePath: string,
    operationId?: string
  ): Promise<{ relativePath: string }> {
    // A brand-new note renamed immediately ("Untitled" created, then retitled a keystroke later) has
    // its `crdt_create` for the OLD path still in flight at this point. Renaming ahead of it made the
    // server 404 the rename (the old path didn't exist server-side *yet*) and then honour the
    // still-queued create afterwards - so the old path was (re)created server-side after the local
    // file had already moved on, surfacing on every other device as a leftover duplicate next to the
    // renamed file. Waiting for that open to settle first means the rename operates on a path the
    // server actually has. Its failure is not ours to handle (the ensureSession caller owns it).
    const opening = this.pendingSessionOpen.get(sessionKey(roomId, oldRelativePath));
    if (opening) {
      await opening.catch(() => undefined);
    }
    const acked = await this.requestRename(roomId, oldRelativePath, newRelativePath, operationId);
    await this.rekeyLocalState(roomId, oldRelativePath, acked.relativePath, acked.epoch);
    if (acked.relativePath !== newRelativePath) {
      // The requested name was already held by another live document, so the server filed this one
      // under a disambiguated name instead of rejecting (same policy as a colliding create). Move the
      // local file to match and tell the user - otherwise the note the user is looking at and the
      // document being synced would sit at different paths.
      await this.deps.renameDiskFile(roomId, newRelativePath, acked.relativePath);
      this.deps.onPathReassigned?.(roomId, newRelativePath, acked.relativePath);
    }
    return { relativePath: acked.relativePath };
  }

  private requestRename(
    roomId: string,
    oldRelativePath: string,
    relativePath: string,
    operationId?: string
  ): Promise<{ epoch: number; relativePath: string }> {
    const requestId = this.createRequestId();
    return new Promise((resolve, reject) => {
      this.pendingRename.set(requestId, { resolve, reject });
      // A dropped send never produces a reply, so waiting on one would hang this promise - and with it the
      // room's rename chain and every later ensureSession for the destination path.
      if (this.deps.send({ type: "crdt_rename", requestId, operationId, roomId, oldRelativePath, relativePath }) === false) {
        this.pendingRename.delete(requestId);
        reject(new Error("Not connected to the server, so the rename was not sent."));
      }
    });
  }

  /**
   * Applies another device's confirmed rename (`remote_crdt_rename`) to this device's own state:
   * rekeys any locally-open session the same way `renameSession` does for the initiating device
   * (a no-op if this device never had the file open), and always moves the vault file on disk to
   * match - unlike `renameSession`, this device's own file watcher never fired for this rename, so
   * nothing else will move it.
   */
  private async applyRemoteRename(roomId: string, oldRelativePath: string, newRelativePath: string, epoch: number): Promise<void> {
    await this.rekeyLocalState(roomId, oldRelativePath, newRelativePath, epoch);
    await this.deps.renameDiskFile(roomId, oldRelativePath, newRelativePath);
  }

  /**
   * Moves every piece of in-memory/persisted bookkeeping keyed by (roomId, relativePath) from the
   * old path to the new one, for both `renameSession` and `applyRemoteRename`. Deliberately does
   * NOT try to move a pending persist/materialize timer's *entry* directly - each timer's own fired
   * callback closure captured its scheduling-time key, so relocating just the map entry would leave
   * the callback checking `this.sessions.get(oldKey)` (now empty) and silently bailing out when it
   * eventually fires. Cancelling and re-scheduling fresh (schedulePersist/scheduleMaterialize
   * recompute the key from the session's now-updated fields) sidesteps that - the cost is only a
   * restarted debounce window, never a lost write (the live Y.Doc still has everything either way).
   */
  private async rekeyLocalState(roomId: string, oldRelativePath: string, newRelativePath: string, epoch: number): Promise<void> {
    const oldKey = sessionKey(roomId, oldRelativePath);
    const newKey = sessionKey(roomId, newRelativePath);

    const session = this.sessions.get(oldKey);
    if (session) {
      this.sessions.delete(oldKey);
      session.relativePath = newRelativePath;
      this.sessions.set(newKey, session);
      // Follows the document onto its new path without touching the Y.Doc (a rename deliberately
      // keeps doc, listener, and epoch). The relay clears the old path's entry as part of the rename,
      // so this side just stops advertising until the re-offered handshake below completes.
      session.presence.rekey(newRelativePath, epoch);

      const persistTimer = this.persistTimers.get(oldKey);
      if (persistTimer !== undefined) {
        this.cancel(persistTimer);
        this.persistTimers.delete(oldKey);
        this.schedulePersist(session);
      }
      const materializeTimer = this.materializeTimers.get(oldKey);
      if (materializeTimer !== undefined) {
        this.cancel(materializeTimer);
        this.materializeTimers.delete(oldKey);
        this.scheduleMaterialize(session);
      }
      // A handshake started just before the rename would otherwise resolve against a session key
      // that no longer has anything registered under it once the map entry above moves.
      for (const [requestId, pendingKey] of this.pendingHandshake.entries()) {
        if (pendingKey === oldKey) {
          this.pendingHandshake.set(requestId, newKey);
        }
      }
    }

    this.knownEpoch.delete(oldKey);
    this.knownEpoch.set(newKey, epoch);
    await this.deps.docStore.rename(roomId, oldRelativePath, newRelativePath, epoch);

    // Re-offer whatever the document holds now, under the path it actually lives at. An edit typed while
    // the rename was awaiting its ack was forwarded under the *old* path and rejected by the server
    // (NOT_FOUND, since the rename had already committed there). The edit survives in the Y.Doc, but
    // without this it would sit unsent until some later reconnect happened to run a handshake. The
    // handshake is a state-vector exchange, so it costs nothing when there is nothing outstanding.
    // Re-read from the map rather than trusting the pre-await reference: the room can be unmounted during the
    // docStore write above, in which case teardownSession has already destroyed this doc and swept its pending
    // handshakes - starting another would leak an entry and emit traffic for a room this device no longer has.
    if (session && this.sessions.get(newKey) === session) {
      this.startHandshake(session);
    }
  }

  private async openSession(
    roomId: string,
    requestedPath: string,
    requestedKey: string,
    brandNewNote: boolean,
    operationId?: string
  ): Promise<CrdtSession> {
    const created = await this.ensureEpoch(roomId, requestedPath, brandNewNote, operationId);
    const epoch = created.epoch;
    let relativePath = requestedPath;
    let key = requestedKey;
    if (created.relativePath !== requestedPath) {
      // Name collision: someone else already owns this path, so the server gave *this* note its own
      // disambiguated one. Move the local vault file to match before opening the session, so the
      // file the user is looking at and the document being synced are the same thing. Everything
      // below then proceeds entirely under the assigned path.
      relativePath = created.relativePath;
      key = sessionKey(roomId, relativePath);
      await this.deps.renameDiskFile(roomId, requestedPath, relativePath);
      this.deps.onPathReassigned?.(roomId, requestedPath, relativePath);
    }
    const existing = this.sessions.get(key);
    if (existing && existing.epoch === epoch) {
      if (!existing.boundToEditor) {
        // An already-open session that isn't bound to a live editor got here via a repeat
        // create/modify watcher event - the only way that happens is something wrote to disk
        // outside this Y.Doc (an external tool, a conflict-copy resolution, etc.). Without
        // reconciling here, that edit is silently dropped: it's applied to neither the doc nor
        // forwarded to the server, and a later remote update's materialize write-back would
        // overwrite disk with the doc's (stale) text, clobbering the external edit for good.
        await this.reconcileAgainstDisk(existing, roomId, relativePath, LOCAL_ORIGIN);
      }
      return existing;
    }
    if (existing) {
      this.teardownSession(existing);
      this.sessions.delete(key);
    }

    const doc = new Y.Doc();
    const ytext = doc.getText(CRDT_TEXT_KEY);
    const persisted = await this.deps.docStore.load(roomId, relativePath, epoch);
    const diskText = await this.deps.readDiskText(roomId, relativePath);
    if (persisted) {
      Y.applyUpdate(doc, persisted, HYDRATE_ORIGIN);
      // Contract 1.12: reconcile local disk text against the persisted doc's identity *before* the
      // handshake - any divergence becomes a local-origin op now, so it rides the outbound step2
      // the handshake below will trigger once the server answers with its own step1.
      if (diskText !== null) {
        reconcileYTextWithDiskText(ytext, diskText, LOCAL_ORIGIN);
      }
    } else if (diskText && created.documentCreatedNow) {
      // Seed from disk ONLY when the server confirmed this request actually *created* the document, so
      // the local copy is its only content. Note the signal is the server's `adopted: false`, not the
      // caller's "is this a brand-new note" hint: recovery after a NOT_FOUND, for instance, is not a new
      // note but does genuinely (re)create the document, and its disk text must still be seeded.
      //
      // Seeding whenever there was no persisted state (the previous behaviour) corrupted content on
      // every unmount/remount cycle: unmounting deletes this device's persisted CRDT state by design,
      // so remounting found none, seeded the doc with the file's text, and then the handshake merged in
      // the server's document - which already held that same text. The note ended up with two copies,
      // and each cycle doubled it again, which is exactly the "content keeps getting copied further and
      // further down" report (seventeenth hardware-testing round, 2026-07-24; the growing `crdt_update`
      // payloads - 4KB, 9.4KB, 12.9KB - are the duplication being pushed back out as real edits).
      //
      // For every other case the server's document is authoritative, and local divergence is not lost:
      // the post-handshake reconcile (in the `crdt_sync_step2` handler) diffs the disk text against the
      // merged result and emits the difference as local ops - which is the mechanism contract 1.12
      // relies on for offline edits anyway.
      doc.transact(() => {
        ytext.insert(0, diskText);
      }, LOCAL_ORIGIN);
    }

    let resolveInitialSync!: () => void;
    const initialSync = new Promise<void>((resolve) => {
      resolveInitialSync = resolve;
    });
    const session: CrdtSession = {
      roomId,
      relativePath,
      epoch,
      doc,
      ytext,
      boundToEditor: existing?.boundToEditor ?? false,
      revision: 0,
      updateHandler: () => undefined,
      initialSync,
      resolveInitialSync,
      presence: new CrdtPresenceSession({
        doc,
        roomId,
        relativePath,
        epoch,
        send: this.deps.send,
        schedule: (callback, delayMs) => this.schedule(callback, delayMs),
        cancel: (handle) => this.cancel(handle)
      })
    };
    this.sessions.set(key, session);

    session.updateHandler = (update: Uint8Array, origin: unknown) => {
      // Bumped first, unconditionally, for every applied update regardless of origin - this is the
      // signal reconcileAgainstDisk uses to detect "something changed the doc while I was awaiting a
      // disk read" and must run before anything else in this handler could itself await.
      session.revision++;
      this.schedulePersist(session);
      // Reads roomId/relativePath off `session` rather than the outer closure params: a rename
      // (renameSession/applyRemoteRename) mutates `session.relativePath` in place, keeping the same
      // session/doc/listener alive rather than tearing down and recreating them - if this closure
      // kept referencing its original captured `relativePath`, every crdt_update sent after a
      // rename would still target the old (now-renamed-away) path forever, silently rejected
      // server-side. `epoch` is intentionally still captured directly - a rename never changes it
      // (only a genuinely new session/epoch would, which always goes through a fresh openSession
      // call with its own new closure).
      this.deps.onSessionChanged?.(session.roomId, session.relativePath);
      if (origin === REMOTE_ORIGIN || origin === HYDRATE_ORIGIN) {
        if (!session.boundToEditor) {
          this.scheduleMaterialize(session);
        }
        return;
      }
      this.deps.send({
        type: "crdt_update",
        requestId: this.createRequestId(),
        roomId: session.roomId,
        relativePath: session.relativePath,
        epoch,
        update: toBase64(update)
      });
    };
    doc.on("update", session.updateHandler);

    this.startHandshake(session);
    this.deps.onSessionOpened?.(session.roomId, session.relativePath);
    return session;
  }

  /**
   * Reconciles `session`'s on-disk text against its live `ytext`, guarding against a race that lost
   * a peer's concurrent edit on real hardware (2026-07-23): `readDiskText` is async, so a
   * `remote_crdt_update`/handshake merge can land in `session.doc` while this call is awaiting the
   * read. `reconcileYTextWithDiskText` diffs a *fresh* `ytext.toString()` against that now-stale
   * `diskText` snapshot - it has no way to tell "genuinely deleted on disk" apart from "arrived in
   * the doc after I started reading disk", so it emits a real `LOCAL_ORIGIN` delete for the just-
   * merged remote text, which then propagates back out over `doc.on("update")` as an actual
   * outbound edit - silently erasing the other peer's insert for everyone, not just locally.
   *
   * `session.revision` (bumped unconditionally, first thing, inside the `doc.on("update", ...)`
   * listener - see openSession) detects this: if it changed between starting and finishing the
   * disk read, something touched the doc mid-await, so the just-read `diskText` cannot be trusted
   * to diff against the doc's current state - retry with a fresh read instead of applying it.
   * Bounded by MAX_RECONCILE_ATTEMPTS purely as a belt-and-suspenders guard against pathological
   * back-to-back interleaving; falls through to one final unconditional attempt rather than silently
   * never reconciling at all.
   *
   * Also flushes any pending materialize write, on every attempt (not just the first) - before
   * that, disk can be legitimately, non-racily behind the doc (an already-settled remote merge
   * whose materialize just hasn't fired yet), which the revision check alone does not catch since
   * nothing changes *during* the read in that case - the doc was already ahead before this method
   * was even called. Re-flushing per attempt matters because a retry (triggered by the revision
   * check below) is itself proof a fresh update just landed and scheduled its own new materialize -
   * that one needs flushing too before the next read, not just whatever was pending at the very
   * start.
   */
  private async reconcileAgainstDisk(session: CrdtSession, roomId: string, relativePath: string, origin: unknown): Promise<void> {
    for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt++) {
      await this.flushMaterialize(session);
      const revisionBeforeRead = session.revision;
      const diskText = await this.deps.readDiskText(roomId, relativePath);
      if (diskText === null) return;
      if (session.revision !== revisionBeforeRead) {
        continue;
      }
      reconcileYTextWithDiskText(session.ytext, diskText, origin);
      return;
    }
    await this.flushMaterialize(session);
    const diskText = await this.deps.readDiskText(roomId, relativePath);
    if (diskText !== null) {
      reconcileYTextWithDiskText(session.ytext, diskText, origin);
    }
  }

  /**
   * Recovers from "the server has no document at this path" (a `crdt_rejected` NOT_FOUND/FILE_DELETED
   * carrying no `currentEpoch`). Drops the stale session/known-epoch/persisted state for the path and
   * re-opens it, which re-establishes the document (adopting an existing one or creating it) and
   * re-seeds it from the on-disk text through the normal handshake - so the user's local content is
   * offered to the server instead of being stranded behind an endless rejection loop. Guarded by
   * `recoveringPaths` so a recovery that itself fails can't spin: the next rejection for that path is
   * ignored until this attempt settles.
   */
  private async recoverMissingDocument(roomId: string, relativePath: string): Promise<void> {
    if (!isCrdtEligiblePath(relativePath) || !this.deps.isRoomCrdtEnabled(roomId)) {
      return;
    }
    const key = sessionKey(roomId, relativePath);
    // Only re-establish a path this device still holds a session for. A rejection can also arrive for a path
    // we have already *moved away from*: an edit typed in the rename-ack window is forwarded under the old
    // path and the server answers NOT_FOUND once the rename has committed there. Recovering that would
    // `crdt_create` the old path again and recreate the very duplicate the rename protocol exists to avoid.
    // Nothing is lost by skipping it - the document itself lives on under the new key, and `rekeyLocalState`
    // starts a handshake there that re-offers whatever that edit added.
    if (!this.sessions.has(key)) {
      return;
    }
    if (this.recoveringPaths.has(key)) {
      return;
    }
    this.recoveringPaths.add(key);
    try {
      await this.forgetLocalDelete(roomId, relativePath);
      await this.ensureSession(roomId, relativePath);
    } catch (error) {
      console.warn(`Vault Rooms: could not re-establish the CRDT document for "${relativePath}"`, error);
    } finally {
      this.recoveringPaths.delete(key);
    }
  }

  /** Drops every in-memory session for `roomId` and deletes their persisted state (contract 1.12:
   *  cleanup on leaving/unmounting a room). */
  async disposeRoom(roomId: string): Promise<void> {
    for (const [key, session] of [...this.sessions.entries()]) {
      if (session.roomId === roomId) {
        this.teardownSession(session);
        this.sessions.delete(key);
      }
    }
    for (const key of [...this.knownEpoch.keys()]) {
      if (key.startsWith(`${roomId}\0`)) {
        this.knownEpoch.delete(key);
      }
    }
    for (const [requestId, pending] of [...this.pendingCreate.entries()]) {
      if (pending.key.startsWith(`${roomId}\0`)) {
        this.pendingCreate.delete(requestId);
        pending.reject(new Error(`CRDT room ${roomId} was disposed.`));
      }
    }
    await this.deps.docStore.deleteRoom(roomId);
  }

  /** Cancels all pending timers and clears in-memory state - call on plugin unload / server switch. */
  dispose(): void {
    this.disposed = true;
    for (const session of this.sessions.values()) {
      this.teardownSession(session);
    }
    this.sessions.clear();
  }

  async handleServerMessage(message: SyncServerMessage): Promise<void> {
    if (this.disposed) return;
    switch (message.type) {
      case "crdt_created": {
        // Keyed by the path the server actually assigned, which may differ from the requested one on a
        // name collision (see ensureEpoch) - keying by the request's original path would leave
        // knownEpoch pointing at a path no document lives at.
        const key = sessionKey(message.roomId, message.relativePath);
        this.knownEpoch.set(key, message.epoch);
        const pending = this.pendingCreate.get(message.requestId);
        if (pending) {
          this.pendingCreate.delete(message.requestId);
          // `adopted` decides whether the local disk copy is this document's only content (created now)
          // or a duplicate of what the server already holds - see openSession's seeding branch.
          pending.resolve({ epoch: message.epoch, relativePath: message.relativePath, documentCreatedNow: message.adopted !== true });
        }
        return;
      }
      case "crdt_rejected": {
        const pendingCreateEntry = message.requestId ? this.pendingCreate.get(message.requestId) : undefined;
        if (pendingCreateEntry && message.requestId) {
          this.pendingCreate.delete(message.requestId);
          pendingCreateEntry.reject(new CrdtRejectedError(message.code, message.message));
        }
        // A crdt_rename can be rejected too (FILE_EXISTS at the new path, NOT_FOUND at the old one,
        // PERMISSION_DENIED) - renameSession's caller (main.ts) is expected to fall back to the old
        // forgetLocalDelete+ensureSession behavior when this rejects, same as before this feature.
        const pendingRenameEntry = message.requestId ? this.pendingRename.get(message.requestId) : undefined;
        if (pendingRenameEntry && message.requestId) {
          this.pendingRename.delete(message.requestId);
          // Carries the server's code (not just its text) so main.ts's fallback can tell a genuinely
          // absent old path apart from an already-taken new path - see CrdtRejectedError.
          pendingRenameEntry.reject(new CrdtRejectedError(message.code, message.message));
        }
        if (message.currentEpoch !== undefined) {
          await this.resyncAtEpoch(message.roomId, message.relativePath, message.currentEpoch);
          return;
        }
        // No `currentEpoch` means the server isn't telling us to move to a newer epoch - for
        // NOT_FOUND/FILE_DELETED it's saying "there is no document at this path at all". Until now
        // that had *no recovery*: the session stayed alive pointing at a document the server doesn't
        // have, so every subsequent `crdt_update` was rejected the same way and the user's edits were
        // silently stranded forever - visible on real hardware as an endless
        // `crdt_update` -> `crdt_rejected` stream in the WS log while the note refused to sync
        // (tenth hardware-testing round, 2026-07-24). Re-establish the document instead: the local
        // text is safe on disk, so dropping the stale session/epoch and re-opening adopts (or creates)
        // the right document and re-seeds it from that disk text via the normal handshake.
        if (!pendingCreateEntry && !pendingRenameEntry && (message.code === "NOT_FOUND" || message.code === "FILE_DELETED")) {
          // Deliberately not awaited: recovery re-opens the session, which waits for a `crdt_created`
          // ack that can only arrive on a *later* message - awaiting it here would deadlock the socket's
          // message processing against its own reply. `recoveringPaths` provides the re-entrancy guard.
          void this.recoverMissingDocument(message.roomId, message.relativePath);
        }
        return;
      }
      case "crdt_renamed": {
        const pending = this.pendingRename.get(message.requestId);
        if (pending) {
          this.pendingRename.delete(message.requestId);
          // `message.relativePath` is the path the rename actually landed on, which differs from the
          // requested one when that name was already held by another live document.
          pending.resolve({ epoch: message.epoch, relativePath: message.relativePath });
        }
        return;
      }
      case "remote_crdt_rename": {
        await this.applyRemoteRename(message.roomId, message.oldRelativePath, message.relativePath, message.epoch);
        return;
      }
      // Presence routes only to an *already open* session for the exact room/path - never through
      // ensureSession, so a cursor message can never create a document or resurrect a retired one.
      case "presence_snapshot": {
        this.sessions.get(sessionKey(message.roomId, message.relativePath))?.presence.applySnapshot(message);
        return;
      }
      case "remote_presence": {
        this.sessions.get(sessionKey(message.roomId, message.relativePath))?.presence.applyRemote(message);
        return;
      }
      case "presence_rejected": {
        this.sessions.get(sessionKey(message.roomId, message.relativePath))?.presence.reject(message);
        return;
      }
      case "crdt_sync_step2": {
        const key = this.pendingHandshake.get(message.requestId);
        if (!key) return; // Not an answer to a request we're tracking (late/duplicate) - ignore.
        this.pendingHandshake.delete(message.requestId);
        const session = this.sessions.get(key);
        if (!session || session.epoch !== message.epoch) return;
        Y.applyUpdate(session.doc, fromBase64(message.update), REMOTE_ORIGIN);
        // Post-handshake reconcile: catches "existing doc, no persisted local state" divergence -
        // any local disk content not already captured by the pre-handshake reconcile above is
        // diffed against the now-merged doc. A bound editor is the live source of truth, however:
        // Obsidian's autosave is allowed to lag behind its CM6/Y.Doc content, so reconciling that
        // stale disk snapshot here would emit a real local delete and clear the editor/server.
        if (!session.boundToEditor) {
          await this.reconcileAgainstDisk(session, session.roomId, session.relativePath, LOCAL_ORIGIN);
        }
        session.resolveInitialSync();
        // Only now is it safe to advertise a caret: gating on hello_ok alone would announce against a
        // document the server may be about to replace at a new epoch, and the relay would reject it.
        session.presence.setTransportReady(true);
        return;
      }
      case "crdt_sync_step1": {
        // Server-initiated (no requestId) - contract 1.3's other half of the handshake. Answer with
        // whatever the server's reported state vector shows it's missing, recovering any local edit
        // made while this connection was offline.
        const key = sessionKey(message.roomId, message.relativePath);
        const session = this.sessions.get(key);
        if (!session || session.epoch !== message.epoch) return;
        const remoteSv = fromBase64(message.stateVector);
        const diff = Y.encodeStateAsUpdate(session.doc, remoteSv);
        this.deps.send({
          type: "crdt_sync_step2",
          requestId: this.createRequestId(),
          roomId: session.roomId,
          relativePath: session.relativePath,
          epoch: session.epoch,
          update: toBase64(diff)
        });
        return;
      }
      case "remote_crdt_update": {
        const key = sessionKey(message.roomId, message.relativePath);
        const session = this.sessions.get(key);
        if (!session) {
          // No session yet, so this live update would be dropped and this device would not see the
          // change until the server's *debounced* materialize arrived as a `remote_file_change` -
          // roughly three seconds behind the keystroke, which is exactly the "edits take ~3s to show
          // up, or appear all at once when I click away" latency reported from real hardware
          // (thirteenth hardware-testing round, 2026-07-24). Live receipt must not depend on the
          // editor-binding pass having run: open the session now, then apply this exact update.
          // The handshake remains the catch-up mechanism for anything else missed, but cannot be the
          // only carrier for this update: another socket's update and this device's step1 can cross
          // so the server answers the step1 from its pre-update state even though this fanout is
          // already queued locally. Applying the same Yjs update again if the handshake also carried
          // it is idempotent. Not awaited - the open may itself wait on later socket replies.
          const update = fromBase64(message.update);
          void this.ensureSession(message.roomId, message.relativePath)
            .then((opened) => {
              if (
                !this.disposed &&
                this.deps.isRoomCrdtEnabled(message.roomId) &&
                this.sessions.get(key) === opened &&
                opened.epoch === message.epoch
              ) {
                Y.applyUpdate(opened.doc, update, REMOTE_ORIGIN);
              }
            })
            .catch(() => undefined);
          return;
        }
        if (session.epoch !== message.epoch) return;
        Y.applyUpdate(session.doc, fromBase64(message.update), REMOTE_ORIGIN);
        return;
      }
      default:
        return;
    }
  }

  private async ensureEpoch(
    roomId: string,
    relativePath: string,
    brandNewNote: boolean,
    operationId?: string
  ): Promise<{ epoch: number; relativePath: string; documentCreatedNow: boolean }> {
    const key = sessionKey(roomId, relativePath);
    const known = this.knownEpoch.get(key);
    if (known !== undefined && !operationId) {
      // An epoch we already knew (room snapshot, announce, earlier open) always describes a document
      // that exists server-side, so its content comes from the handshake - never from seeding.
      return { epoch: known, relativePath, documentCreatedNow: false };
    }
    // Only ever called from openSession, which ensureSession's pendingSessionOpen already
    // serializes per key - so there is no concurrent-caller case to coalesce here.
    // The server may answer with a *different* relativePath than the one requested: the first creator
    // of a path keeps it, and a second device creating its own new note at the same path (every new
    // Obsidian note starts with the same default name) is assigned a disambiguated one instead. The
    // `crdt_created` handler resolves this promise with whatever path was actually assigned.
    const requestId = this.createRequestId();
    return new Promise<{ epoch: number; relativePath: string; documentCreatedNow: boolean }>((resolve, reject) => {
      this.pendingCreate.set(requestId, { key, resolve, reject });
      // `adoptIfExists` unless this is a note the user *just created*. Reopening something we already
      // have (remount, editor bind, remote update, recovery) must attach to the existing document; only
      // a genuinely new note may be treated as a second, different note and disambiguated.
      if (this.deps.send({ type: "crdt_create", requestId, operationId, roomId, relativePath, adoptIfExists: !brandNewNote }) === false) {
        this.pendingCreate.delete(requestId);
        reject(new Error("Not connected to the server, so the document could not be created."));
      }
    });
  }

  /**
   * Forgets all local CRDT state for (roomId, relativePath) after a *local* delete (contract 1.5:
   * delete bumps the server's epoch for this path). Without this, a delete immediately followed by
   * a local recreate at the same path would hit `ensureSession`'s fast path with the stale
   * pre-delete epoch/session still resident - binding the "new" note's editor to the old document's
   * content until a subsequent stale-epoch rejection from the server eventually cleans it up. This
   * closes that window proactively instead of relying on a round trip to the server to notice.
   */
  async forgetLocalDelete(roomId: string, relativePath: string): Promise<void> {
    const key = sessionKey(roomId, relativePath);
    const existing = this.sessions.get(key);
    const oldEpoch = existing?.epoch ?? this.knownEpoch.get(key);
    if (existing) {
      this.teardownSession(existing);
      this.sessions.delete(key);
    }
    this.knownEpoch.delete(key);
    if (oldEpoch !== undefined) {
      await this.deps.docStore.deleteEpoch(roomId, relativePath, oldEpoch).catch(() => undefined);
    }
  }

  private async resyncAtEpoch(roomId: string, relativePath: string, newEpoch: number): Promise<void> {
    const key = sessionKey(roomId, relativePath);
    const existing = this.sessions.get(key);
    const oldEpoch = existing?.epoch;
    // Snapshot before teardown: onSessionRetiring unbinds the old editor extension, which clears
    // existing.boundToEditor while the retiring session is still in this.sessions.
    const wasBoundToEditor = existing?.boundToEditor ?? false;
    if (existing) {
      this.teardownSession(existing);
      this.sessions.delete(key);
    }
    if (oldEpoch !== undefined && oldEpoch !== newEpoch) {
      await this.deps.docStore.deleteEpoch(roomId, relativePath, oldEpoch).catch(() => undefined);
    }
    this.knownEpoch.set(key, newEpoch);
    if (wasBoundToEditor) {
      // Re-open eagerly so a currently-bound editor doesn't keep showing content from a document
      // identity the server has already moved past.
      await this.ensureSession(roomId, relativePath);
    }
  }

  private startHandshake(session: CrdtSession): void {
    const requestId = this.createRequestId();
    this.pendingHandshake.set(requestId, sessionKey(session.roomId, session.relativePath));
    this.deps.send({
      type: "crdt_sync_step1",
      requestId,
      roomId: session.roomId,
      relativePath: session.relativePath,
      epoch: session.epoch,
      stateVector: toBase64(Y.encodeStateVector(session.doc))
    });
  }

  private schedulePersist(session: CrdtSession): void {
    const key = sessionKey(session.roomId, session.relativePath);
    const existingTimer = this.persistTimers.get(key);
    if (existingTimer !== undefined) {
      this.cancel(existingTimer);
    }
    const timer = this.schedule(() => {
      this.persistTimers.delete(key);
      if (this.disposed || this.sessions.get(key) !== session) return;
      void this.deps.docStore.save(session.roomId, session.relativePath, session.epoch, Y.encodeStateAsUpdate(session.doc));
    }, PERSIST_DEBOUNCE_MS);
    this.persistTimers.set(key, timer);
  }

  private scheduleMaterialize(session: CrdtSession): void {
    const key = sessionKey(session.roomId, session.relativePath);
    const existingTimer = this.materializeTimers.get(key);
    if (existingTimer !== undefined) {
      this.cancel(existingTimer);
    }
    const timer = this.schedule(() => {
      this.materializeTimers.delete(key);
      if (this.disposed || this.sessions.get(key) !== session || session.boundToEditor) return;
      void this.deps.writeDiskText(session.roomId, session.relativePath, session.ytext.toString());
    }, MATERIALIZE_DEBOUNCE_MS);
    this.materializeTimers.set(key, timer);
  }

  /**
   * Forces any pending debounced materialize write to happen now, synchronously with respect to
   * the caller, instead of waiting out MATERIALIZE_DEBOUNCE_MS. `reconcileAgainstDisk` calls this
   * before its own disk read: without it, disk can be legitimately behind the doc simply because a
   * remote merge (a live `remote_crdt_update`, or a handshake's `crdt_sync_step2` reply) landed and
   * scheduled a materialize that hasn't fired yet - `reconcileYTextWithDiskText` has no way to tell
   * "this text is in the doc but not on disk because it's an unmaterialized remote insert" apart
   * from "because it was deleted locally", and would emit a real delete for the former, erasing a
   * teammate's edit (the second real-hardware bug found 2026-07-23, distinct from the narrower
   * mid-read interleaving `reconcileAgainstDisk`'s revision check handles). Flushing first means
   * disk already equals the doc's current text by the time the diff runs, so there's nothing left
   * to (mis)reconcile unless a genuine local edit also landed - a no-op when nothing was pending
   * (mirrors scheduleMaterialize's own guards: skipped if disposed, superseded, or bound to editor).
   */
  private async flushMaterialize(session: CrdtSession): Promise<void> {
    const key = sessionKey(session.roomId, session.relativePath);
    const timer = this.materializeTimers.get(key);
    if (timer === undefined) {
      return;
    }
    this.cancel(timer);
    this.materializeTimers.delete(key);
    if (this.disposed || this.sessions.get(key) !== session || session.boundToEditor) {
      return;
    }
    await this.deps.writeDiskText(session.roomId, session.relativePath, session.ytext.toString());
  }

  private teardownSession(session: CrdtSession): void {
    const key = sessionKey(session.roomId, session.relativePath);
    this.deps.onSessionRetiring?.(session.roomId, session.relativePath);
    const persistTimer = this.persistTimers.get(key);
    if (persistTimer !== undefined) {
      this.cancel(persistTimer);
      this.persistTimers.delete(key);
    }
    const materializeTimer = this.materializeTimers.get(key);
    if (materializeTimer !== undefined) {
      this.cancel(materializeTimer);
      this.materializeTimers.delete(key);
    }
    for (const [requestId, pendingKey] of [...this.pendingHandshake.entries()]) {
      if (pendingKey === key) {
        this.pendingHandshake.delete(requestId);
      }
    }
    // Before doc.destroy(): the presence session emits its final retraction using this doc's
    // clientID, and it must still be readable. This is also the path that covers resyncAtEpoch and
    // recoverMissingDocument - the two places that swap the Y.Doc without an unmount, and therefore
    // the likeliest source of a ghost cursor if the removal is skipped.
    session.presence.destroy();
    session.doc.off("update", session.updateHandler);
    session.resolveInitialSync();
    session.doc.destroy();
  }

  private createRequestId(): string {
    if (this.deps.createRequestId) {
      return this.deps.createRequestId();
    }
    this.requestCounter += 1;
    return `crdt_${Date.now()}_${this.requestCounter}`;
  }
}

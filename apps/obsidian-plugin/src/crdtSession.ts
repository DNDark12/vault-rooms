import * as Y from "yjs";
import { isCrdtEligiblePath, type SyncClientMessage, type SyncServerMessage } from "@vault-rooms/protocol";
import { CRDT_TEXT_KEY } from "vault-rooms-relay/embedded-core";
import type { CrdtDocStore } from "./crdtDocStore.js";
import { reconcileYTextWithDiskText } from "./crdtReconcile.js";

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
};

export type CrdtSessionManagerDeps = {
  send: (message: SyncClientMessage) => void;
  docStore: CrdtDocStore;
  isRoomCrdtEnabled: (roomId: string) => boolean;
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
  private readonly pendingCreate = new Map<string, { key: string; resolve: (epoch: number) => void; reject: (error: Error) => void }>();
  /** Coalesces concurrent `ensureSession` callers for the same (roomId, relativePath) onto one
   *  in-flight open (see `ensureSession`'s doc comment for why this needs to wrap the whole open,
   *  not just the epoch fetch). */
  private readonly pendingSessionOpen = new Map<string, Promise<CrdtSession>>();
  private readonly pendingHandshake = new Map<string, string>();
  /** Correlates an in-flight `crdt_rename` request with its `crdt_renamed`/`crdt_rejected` answer -
   *  see `renameSession`. */
  private readonly pendingRename = new Map<string, { resolve: (epoch: number) => void; reject: (error: Error) => void }>();
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
      if (file.crdtEpoch !== undefined) {
        this.knownEpoch.set(sessionKey(roomId, file.relativePath), file.crdtEpoch);
      }
    }
  }

  /** Re-runs the handshake for every live session - call on reconnect (blocker 1: outbound recovery
   *  of a local edit made while offline). */
  onConnected(): void {
    for (const session of this.sessions.values()) {
      this.startHandshake(session);
    }
  }

  isSessionOpen(roomId: string, relativePath: string): boolean {
    return this.sessions.has(sessionKey(roomId, relativePath));
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
  async ensureSession(roomId: string, relativePath: string): Promise<CrdtSession> {
    if (!this.deps.isRoomCrdtEnabled(roomId) || !isCrdtEligiblePath(relativePath)) {
      throw new Error(`ensureSession called for a non-CRDT target: ${roomId}/${relativePath}`);
    }
    const key = sessionKey(roomId, relativePath);
    // Coalesce concurrent callers for the same path (e.g. the vault watcher's "create" event and
    // the editor-open path both firing for a brand-new note at nearly the same time) onto one
    // in-flight open, end to end - not just the crdt_create request. Without this, two callers that
    // both raced past the epoch fetch would each independently build their own Y.Doc/session and
    // stomp on each other in the `sessions` map, silently orphaning whichever one lost the race.
    const inFlight = this.pendingSessionOpen.get(key);
    if (inFlight) {
      return inFlight;
    }
    const opening = this.openSession(roomId, relativePath, key).finally(() => {
      this.pendingSessionOpen.delete(key);
    });
    this.pendingSessionOpen.set(key, opening);
    return opening;
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
  async renameSession(roomId: string, oldRelativePath: string, newRelativePath: string): Promise<void> {
    const requestId = this.createRequestId();
    const epoch = await new Promise<number>((resolve, reject) => {
      this.pendingRename.set(requestId, { resolve, reject });
      this.deps.send({ type: "crdt_rename", requestId, roomId, oldRelativePath, relativePath: newRelativePath });
    });
    await this.rekeyLocalState(roomId, oldRelativePath, newRelativePath, epoch);
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
  }

  private async openSession(roomId: string, relativePath: string, key: string): Promise<CrdtSession> {
    const epoch = await this.ensureEpoch(roomId, relativePath);
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
    } else if (diskText) {
      // Genuinely first time this device has held this document. Seeding it with the current disk
      // content here is an ordinary "first write" (see crdtPersistenceReconcileSpike.test.ts's
      // reasoning for why this differs from re-seeding a stale baseline) - if a document already
      // existed server-side, the handshake below merges it in, and the post-handshake reconcile
      // (in the crdt_sync_step2 handler) diffs disk text against the *merged* result, so nothing is
      // lost either way.
      doc.transact(() => {
        ytext.insert(0, diskText);
      }, LOCAL_ORIGIN);
    }

    const session: CrdtSession = { roomId, relativePath, epoch, doc, ytext, boundToEditor: existing?.boundToEditor ?? false, revision: 0 };
    this.sessions.set(key, session);

    doc.on("update", (update: Uint8Array, origin: unknown) => {
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
    });

    this.startHandshake(session);
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
        const key = sessionKey(message.roomId, message.relativePath);
        this.knownEpoch.set(key, message.epoch);
        const pending = this.pendingCreate.get(message.requestId);
        if (pending) {
          this.pendingCreate.delete(message.requestId);
          pending.resolve(message.epoch);
        }
        return;
      }
      case "crdt_rejected": {
        const pendingCreateEntry = message.requestId ? this.pendingCreate.get(message.requestId) : undefined;
        if (pendingCreateEntry && message.requestId) {
          this.pendingCreate.delete(message.requestId);
          pendingCreateEntry.reject(new Error(message.message));
        }
        // A crdt_rename can be rejected too (FILE_EXISTS at the new path, NOT_FOUND at the old one,
        // PERMISSION_DENIED) - renameSession's caller (main.ts) is expected to fall back to the old
        // forgetLocalDelete+ensureSession behavior when this rejects, same as before this feature.
        const pendingRenameEntry = message.requestId ? this.pendingRename.get(message.requestId) : undefined;
        if (pendingRenameEntry && message.requestId) {
          this.pendingRename.delete(message.requestId);
          pendingRenameEntry.reject(new Error(message.message));
        }
        if (message.currentEpoch !== undefined) {
          await this.resyncAtEpoch(message.roomId, message.relativePath, message.currentEpoch);
        }
        return;
      }
      case "crdt_renamed": {
        const pending = this.pendingRename.get(message.requestId);
        if (pending) {
          this.pendingRename.delete(message.requestId);
          pending.resolve(message.epoch);
        }
        return;
      }
      case "remote_crdt_rename": {
        await this.applyRemoteRename(message.roomId, message.oldRelativePath, message.relativePath, message.epoch);
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
        // diffed against the now-merged doc.
        await this.reconcileAgainstDisk(session, session.roomId, session.relativePath, LOCAL_ORIGIN);
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
        if (!session || session.epoch !== message.epoch) return;
        Y.applyUpdate(session.doc, fromBase64(message.update), REMOTE_ORIGIN);
        return;
      }
      default:
        return;
    }
  }

  private async ensureEpoch(roomId: string, relativePath: string): Promise<number> {
    const key = sessionKey(roomId, relativePath);
    const known = this.knownEpoch.get(key);
    if (known !== undefined) {
      return known;
    }
    // Only ever called from openSession, which ensureSession's pendingSessionOpen already
    // serializes per key - so there is no concurrent-caller case to coalesce here.
    const requestId = this.createRequestId();
    return new Promise<number>((resolve, reject) => {
      this.pendingCreate.set(requestId, { key, resolve, reject });
      this.deps.send({ type: "crdt_create", requestId, roomId, relativePath });
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
    if (existing) {
      this.teardownSession(existing);
      this.sessions.delete(key);
    }
    if (oldEpoch !== undefined && oldEpoch !== newEpoch) {
      await this.deps.docStore.deleteEpoch(roomId, relativePath, oldEpoch).catch(() => undefined);
    }
    this.knownEpoch.set(key, newEpoch);
    if (existing?.boundToEditor) {
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
  }

  private createRequestId(): string {
    if (this.deps.createRequestId) {
      return this.deps.createRequestId();
    }
    this.requestCounter += 1;
    return `crdt_${Date.now()}_${this.requestCounter}`;
  }
}

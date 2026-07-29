// @vitest-environment jsdom
//
// Two-client CRDT integration harness (built after the seventeenth hardware-testing round, 2026-07-24).
//
// Why this file exists: 482 unit tests were green while real two-device use was corrupting notes -
// duplicating content on every unmount/remount, and eventually doubling every keystroke ("type 1, get
// 11"). None of the existing suites could catch that, because each one stubs out a different half of the
// path: crdt-sync-flow.test.ts drives the relay with raw WS messages (no client objects),
// crdtSession.test.ts drives the session manager with a fake socket (no relay), and
// crdtEditorBinding.test.ts drives real CM6 views against a hand-built manager (no relay, no watcher).
// The bugs lived in the *seams* between them, and specifically in the editor path - which is why
// "reproduce it by writing to the file on disk" cannot work: that only exercises the watcher.
//
// So this harness wires the REAL pieces together for both devices - a real listening relay, real
// RoomSyncSocket over a real WebSocket, real CrdtSessionManager, real CrdtDocStore, real
// CrdtEditorController bound to a real CodeMirror 6 EditorView - and "types" by dispatching CM6
// transactions, which is the exact route a keystroke takes in Obsidian. Unmount/remount is modelled the
// way main.ts does it: dispose the room's CRDT state, then resubscribe and reopen.

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import type { DataAdapter } from "obsidian";
import WsWebSocket from "ws";
import * as Y from "yjs";
import type { SyncClientMessage, SyncServerMessage } from "@vault-rooms/protocol";
import { createApp } from "vault-rooms-relay/app";
import { RelayApiClient } from "../src/apiClient.js";
import { CrdtDocStore } from "../src/crdtDocStore.js";
import { CrdtEditorController } from "../src/crdtEditorBinding.js";
import { CrdtSessionManager } from "../src/crdtSession.js";
import type { ServerConnection } from "../src/settings.js";
import { VaultSyncEngine, type MountedRoomState, type VaultAdapter, type VaultChangeEvent } from "../src/syncClient.js";
import { RoomSyncSocket } from "../src/syncWsClient.js";

// RoomSyncSocket's reconnect backoff uses window.setTimeout; jsdom provides window, but the relay side
// of this test also runs in the same process, so keep the same shim the sibling client-stack test uses.
(globalThis as unknown as { window: typeof globalThis }).window ??= globalThis;
// This file needs jsdom (CodeMirror 6 requires a DOM) but jsdom's environment leaves a WebSocket
// implementation whose Event class disagrees with undici's, which throws
// `The "event" argument must be an instance of Event. Received an instance of Event` the moment a
// connection opens. Swap in the real `ws` client - the same library the embedded relay already uses - so
// the transport under test is a genuine WebSocket rather than an environment artefact.
(globalThis as unknown as { WebSocket: unknown }).WebSocket = WsWebSocket;
// y-codemirror.next only publishes a local cursor for a *focused* view: its update() gates on
// `view.hasFocus`, which is `dom.ownerDocument.hasFocus() && root.activeElement === contentDOM`. jsdom
// reports `document.hasFocus() === false` unconditionally, so without this shim no cursor is ever
// advertised and every presence assertion below fails for an environment reason rather than a real one.
// The views are also parented into document.body so `activeElement` can actually become the contentDOM.
// Note losing focus does not *clear* a published cursor (that branch also requires hasFocus), so two
// devices taking focus in turn within one jsdom document both keep their carets - which is what lets a
// single document stand in for two machines here.
Object.defineProperty(globalThis.document, "hasFocus", { value: () => true, configurable: true });

const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];
const sockets: RoomSyncSocket[] = [];
const views: EditorView[] = [];

afterEach(async () => {
  for (const view of views.splice(0)) view.destroy();
  for (const socket of sockets.splice(0)) socket.disconnect();
  for (const app of apps.splice(0)) await app.close();
});

async function injectBootstrap(app: Awaited<ReturnType<typeof createApp>>, payload: { displayName: string; deviceName: string; teamName?: string }) {
  const bootstrapPin = (app as unknown as { bootstrapPin: string }).bootstrapPin;
  return app.inject({ method: "POST", url: "/api/bootstrap", remoteAddress: "127.0.0.1", payload: { ...payload, pin: bootstrapPin } });
}

async function waitFor(check: () => boolean | Promise<boolean>, description: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** In-memory vault: `files` doubles as "what the user sees on disk". */
class FakeVaultAdapter implements VaultAdapter {
  readonly files = new Map<string, string>();
  private listener: ((event: VaultChangeEvent) => void) | null = null;

  async read(path: string): Promise<string> {
    return this.files.get(path) ?? "";
  }
  async write(path: string, content: string): Promise<void> {
    const existed = this.files.has(path);
    this.files.set(path, content);
    this.listener?.({ type: existed ? "modify" : "create", path });
  }
  async readBinary(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }
  async writeBinary(): Promise<void> {}
  async delete(path: string): Promise<void> {
    this.files.delete(path);
    this.listener?.({ type: "delete", path });
  }
  async rename(oldPath: string, newPath: string): Promise<void> {
    const content = this.files.get(oldPath);
    if (content === undefined) return;
    this.files.delete(oldPath);
    this.files.set(newPath, content);
    this.listener?.({ type: "rename", path: newPath, oldPath });
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((path) => path.startsWith(prefix));
  }
  onChange(cb: (event: VaultChangeEvent) => void): () => void {
    this.listener = cb;
    return () => {
      this.listener = null;
    };
  }
}

class FakeDataAdapter {
  readonly store = new Map<string, ArrayBuffer>();
  async exists(path: string): Promise<boolean> {
    return this.store.has(path);
  }
  async readBinary(path: string): Promise<ArrayBuffer> {
    const data = this.store.get(path);
    if (!data) throw new Error(`Missing ${path}`);
    return data.slice(0);
  }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.store.set(path, data.slice(0));
  }
  async mkdir(): Promise<void> {}
  async remove(path: string): Promise<void> {
    this.store.delete(path);
  }
  async rename(from: string, to: string): Promise<void> {
    const data = this.store.get(from);
    if (data) {
      this.store.set(to, data);
      this.store.delete(from);
    }
  }
  async rmdir(): Promise<void> {}
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    return { files: [...this.store.keys()].filter((key) => key.startsWith(`${path}/`)), folders: [] };
  }
}

const MOUNT = "Room";
const NOTE = "note.md";
const vaultPath = `${MOUNT}/${NOTE}`;

type Device = {
  name: string;
  vault: FakeVaultAdapter;
  room: MountedRoomState;
  crdt: CrdtSessionManager;
  controller: CrdtEditorController;
  socket: RoomSyncSocket;
  /** Text the user currently sees in their editor. */
  editorText: () => string;
  /** Types at the end of the note, exactly as a keystroke does in Obsidian. */
  type: (text: string) => void;
  saveEditor: () => void;
  openEditor: () => Promise<void>;
  remount: () => Promise<void>;
  crdtMessageCount: () => number;
  serverText: () => Promise<string>;
  sessionOpen: () => boolean;
  editorBound: () => boolean;
  receivedCrdtTypes: () => string[];
  sessionState: () => { text: string; bound: boolean; epoch: number } | undefined;
  /** Live cursors. Counted separately from content traffic so an idle window can be asserted without
   *  WebSocket ping/pong or CRDT updates muddying it. */
  presenceSentCount: () => number;
  presenceReceivedCount: () => number;
  /** Rendered remote carets in this device's real CM6 view - the observable end of the whole path. */
  remoteCaretCount: () => number;
  remoteCaretNames: () => string[];
  /** Moves the local selection the way a click or arrow key does. */
  select: (from: number, to: number) => void;
  /** Wraps the current selection in `**`, the way Obsidian's bold command does. */
  boldSelection: () => void;
  view: EditorView;
  openSecondPane: () => Promise<EditorView>;
  closeSecondPane: () => Promise<void>;
};

function buildDevice(input: { baseUrl: string; deviceToken: string; name: string; roomId: string }): Device {
  const vault = new FakeVaultAdapter();
  const server: ServerConnection = {
    id: "server_1",
    baseUrl: input.baseUrl,
    userId: input.name,
    userDisplayName: input.name,
    deviceId: `device_${input.name}`,
    deviceName: input.name,
    deviceToken: input.deviceToken,
    isServerOwner: false,
    status: "active",
    securityMode: "plain"
  };
  const api = new RelayApiClient(input.baseUrl, input.deviceToken);
  const syncEngine = new VaultSyncEngine(vault, api);
  const room: MountedRoomState = { roomId: input.roomId, mountPath: MOUNT, files: {}, crdtEnabled: true, canPushLocalEdits: true };
  const sentCrdtMessages: SyncClientMessage[] = [];
  const receivedCrdtMessages: SyncServerMessage[] = [];
  const presenceSent: SyncClientMessage[] = [];
  const presenceReceived: SyncServerMessage[] = [];
  const PRESENCE_TYPES = new Set(["presence_snapshot", "remote_presence", "presence_rejected"]);
  let editorOpen = false;
  let onSessionOpened = (): void => undefined;
  let onSessionRetiring = (_roomId: string, _relativePath: string): void => undefined;

  let socket: RoomSyncSocket;
  const docStore = new CrdtDocStore(new FakeDataAdapter() as unknown as DataAdapter, `crdt-${input.name}`);
  const crdt = new CrdtSessionManager({
    send: (message) => {
      sentCrdtMessages.push(message);
      if (message.type === "presence_set") presenceSent.push(message);
      socket.sendCrdtMessage(message);
    },
    docStore,
    isRoomCrdtEnabled: () => !room.unmounted,
    readDiskText: async (_roomId, relativePath) => vault.files.get(`${MOUNT}/${relativePath}`) ?? null,
    writeDiskText: async (_roomId, relativePath, text) => {
      vault.files.set(`${MOUNT}/${relativePath}`, text);
    },
    renameDiskFile: async (_roomId, oldRelativePath, newRelativePath) => {
      await vault.rename(`${MOUNT}/${oldRelativePath}`, `${MOUNT}/${newRelativePath}`);
    },
    onSessionOpened: () => onSessionOpened(),
    onSessionRetiring: (roomId, relativePath) => onSessionRetiring(roomId, relativePath)
  });
  const controller = new CrdtEditorController({
    getSessionManager: () => crdt,
    resolveCrdtTarget: (path) => (path === vaultPath ? { roomId: input.roomId, relativePath: NOTE } : undefined)
  });
  socket = new RoomSyncSocket(server, {
    crdt: {
      handleServerMessage: async (message) => {
        receivedCrdtMessages.push(message);
        if (PRESENCE_TYPES.has(message.type)) presenceReceived.push(message);
        await crdt.handleServerMessage(message);
      },
      handleRoomSnapshot: (roomId, files) => crdt.handleRoomSnapshot(roomId, files),
      onConnected: () => crdt.onConnected(),
    onDisconnected: () => crdt.onDisconnected(),
      registerKnownEpoch: (roomId, relativePath, epoch) => crdt.registerKnownEpoch(roomId, relativePath, epoch),
      isSessionOpen: (roomId, relativePath) => crdt.isSessionOpen(roomId, relativePath)
    },
    getMountedRoom: (roomId) => (roomId === room.roomId && !room.unmounted ? room : undefined),
    getApi: () => api,
    syncEngine,
    onApplied: () => undefined,
    onRevoked: () => undefined,
    onRoomDeleted: () => undefined,
    onAccessRevoked: () => undefined,
    onStateChange: () => undefined
  });
  sockets.push(socket);

  const view = new EditorView({
    state: EditorState.create({ doc: "", extensions: [controller.extension()] }),
    parent: document.body
  });
  views.push(view);
  let secondPane: EditorView | undefined;
  onSessionOpened = () => {
    if (editorOpen) {
      const open = secondPane ? [{ vaultPath, view }, { vaultPath, view: secondPane }] : [{ vaultPath, view }];
      void controller.syncOpenViews(open);
    }
  };
  onSessionRetiring = (roomId, relativePath) => {
    controller.unbindTarget(roomId, relativePath);
  };

  return {
    name: input.name,
    vault,
    room,
    crdt,
    controller,
    socket,
    editorText: () => view.state.doc.toString(),
    type: (text) => {
      const at = view.state.doc.length;
      view.dispatch({ changes: { from: at, to: at, insert: text } });
    },
    saveEditor: () => {
      vault.files.set(vaultPath, view.state.doc.toString());
    },
    openEditor: async () => {
      editorOpen = true;
      if (!controller.isBound(view)) {
        const diskText = vault.files.get(vaultPath) ?? "";
        const editorText = view.state.doc.toString();
        if (editorText !== diskText) {
          view.dispatch({ changes: { from: 0, to: editorText.length, insert: diskText } });
        }
      }
      await controller.syncOpenViews([{ vaultPath, view }]);
    },
    remount: async () => {
      // Production ordering: gate inbound first, remove reconnect desire/server subscription,
      // unbind only this room, await persisted/session retirement, then make the room live again.
      room.unmounted = true;
      socket.unsubscribe(room.roomId);
      controller.unbindRoom(room.roomId);
      await crdt.disposeRoom(room.roomId);
      room.unmounted = false;
      socket.subscribe(room.roomId);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await controller.syncOpenViews([{ vaultPath, view }]);
    },
    crdtMessageCount: () => sentCrdtMessages.length,
    serverText: async () => (await api.readFile(room.roomId, NOTE)).content,
    sessionOpen: () => crdt.isSessionOpen(room.roomId, NOTE),
    editorBound: () => controller.isBound(view),
    receivedCrdtTypes: () => receivedCrdtMessages.map((message) => message.type),
    presenceSentCount: () => presenceSent.length,
    presenceReceivedCount: () => presenceReceived.length,
    remoteCaretCount: () => view.dom.querySelectorAll(".cm-ySelectionCaret").length,
    remoteCaretNames: () =>
      Array.from(view.dom.querySelectorAll(".cm-ySelectionInfo"), (node) => node.textContent ?? ""),
    select: (from, to) => {
      // focus() before dispatch: the selection only becomes a published cursor if the view is focused
      // at the moment y-codemirror's update() runs.
      view.focus();
      view.dispatch({ selection: { anchor: from, head: to } });
    },
    boldSelection: () => {
      const range = view.state.selection.main;
      const text = view.state.doc.sliceString(range.from, range.to);
      view.dispatch({ changes: { from: range.from, to: range.to, insert: `**${text}**` } });
    },
    view,
    openSecondPane: async () => {
      // Seeded with the note's current text, because that is what Obsidian hands a newly opened pane -
      // and yCollab's documented usage is `doc: ytext.toString()`. An empty pane would leave every
      // remote position pointing past the end of its document, so no caret could render.
      const extra = new EditorView({
        state: EditorState.create({ doc: view.state.doc.toString(), extensions: [controller.extension()] }),
        parent: document.body
      });
      views.push(extra);
      secondPane = extra;
      await controller.syncOpenViews([
        { vaultPath, view },
        { vaultPath, view: extra }
      ]);
      return extra;
    },
    closeSecondPane: async () => {
      secondPane = undefined;
      await controller.syncOpenViews([{ vaultPath, view }]);
    },
    sessionState: () => {
      const sessions = (crdt as unknown as { sessions: Map<string, { ytext: Y.Text; boundToEditor: boolean; epoch: number }> }).sessions;
      const session = [...sessions.values()].find((candidate) => candidate.epoch >= 0);
      return session ? { text: session.ytext.toString(), bound: session.boundToEditor, epoch: session.epoch } : undefined;
    }
  };
}

async function setupCrdtRoomWithTwoDevices() {
  const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:0" });
  apps.push(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a listening address");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const owner = (await injectBootstrap(app, { displayName: "A", deviceName: "A", teamName: "Demo" })).json();
  const room = (
    await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { name: "Room", type: "folder", sourcePath: "Room", mountName: MOUNT, capabilities: [] }
    })
  ).json().room;
  await app.inject({
    method: "PATCH",
    url: `/api/rooms/${room.id}`,
    headers: { authorization: `Bearer ${owner.deviceToken}` },
    payload: { name: room.name, type: room.type, sourcePath: room.sourcePath, mountName: room.mountName, crdtEnabled: true }
  });

  const invite = (
    await app.inject({
      method: "POST",
      url: `/api/teams/${owner.team.id}/invites`,
      headers: { authorization: `Bearer ${owner.deviceToken}` },
      payload: { role: "member", expiresInMinutes: 60, maxUses: 1 }
    })
  ).json();
  const member = (
    await app.inject({ method: "POST", url: "/api/join", payload: { inviteToken: invite.inviteToken, displayName: "B", deviceName: "B" } })
  ).json();
  await app.inject({
    method: "POST",
    url: `/api/rooms/${room.id}/acl`,
    headers: { authorization: `Bearer ${owner.deviceToken}` },
    payload: { subjectType: "user", subjectId: member.user.id, effect: "allow", preset: "editor", pathPattern: "**/*" }
  });

  const a = buildDevice({ baseUrl, deviceToken: owner.deviceToken, name: "A", roomId: room.id });
  const b = buildDevice({ baseUrl, deviceToken: member.deviceToken, name: "B", roomId: room.id });
  for (const device of [a, b]) {
    device.socket.connect();
    device.socket.subscribe(room.id);
  }
  await waitFor(() => a.socket.getState() === "connected" && b.socket.getState() === "connected", "both devices to connect");
  return { app, room, a, b };
}

describe("CRDT two-client: unmount/remount then type", () => {
  it("does not duplicate content across a remount, and a keystroke lands exactly once", { timeout: 30_000 }, async () => {
    const { a, b } = await setupCrdtRoomWithTwoDevices();

    // A creates the note and opens it, the way the vault "create" event + editor bind do.
    a.vault.files.set(vaultPath, "");
    await a.crdt.ensureSession(a.room.roomId, NOTE, { brandNewNote: true });
    await a.openEditor();
    a.type("hello");
    await waitFor(() => a.editorText() === "hello", "A's own keystrokes to land");
    // A keystroke must land exactly once - "type 1, get 11" was the reported corruption.
    expect(a.editorText()).toBe("hello");
    expect(a.sessionState()).toMatchObject({ text: "hello", bound: true });
    await waitFor(async () => (await a.serverText()) === "hello", "relay to materialize the initial text");

    // B opens the same note and converges on A's text.
    await b.openEditor();
    await waitFor(() => b.sessionOpen(), "B to open its CRDT session");
    await waitFor(() => b.receivedCrdtTypes().includes("remote_crdt_update"), "B to receive A's live CRDT update");
    await waitFor(() => b.editorBound(), "B's editor to bind to its hydrated session");
    expect(b.sessionState()).toMatchObject({ text: "hello", bound: true });
    await waitFor(() => b.editorText() === "hello", "B to receive A's text");
    a.saveEditor();
    b.saveEditor();

    // Now the reported scenario: A unmounts and remounts, then types again.
    await a.remount();
    expect(a.editorText()).toBe("hello");

    const aMessagesBeforeEdit = a.crdtMessageCount();
    a.type("!");
    await waitFor(() => a.editorText() === "hello!", "A's post-remount keystroke to land");
    await waitFor(() => a.crdtMessageCount() > aMessagesBeforeEdit, "A to send its post-remount CRDT update");
    await waitFor(async () => (await a.serverText()) === "hello!", "relay to materialize A's post-remount edit");
    await waitFor(() => b.editorText() === "hello!", "B to receive A's post-remount edit");
    // Exactly one "!" - not "!!" - and no repeated copy of "hello".
    expect(a.editorText()).toBe("hello!");

    // Both devices agree, and neither holds a duplicated copy of the content.
    expect(a.editorText()).toBe(b.editorText());
    expect(a.editorText()).toBe("hello!");
  });

  it("survives remounting on both devices in turn without the note growing", { timeout: 30_000 }, async () => {
    const { a, b } = await setupCrdtRoomWithTwoDevices();

    a.vault.files.set(vaultPath, "");
    await a.crdt.ensureSession(a.room.roomId, NOTE, { brandNewNote: true });
    await a.openEditor();
    a.type("base");
    await waitFor(async () => (await a.serverText()) === "base", "relay to materialize the initial text");
    await b.openEditor();
    await waitFor(() => b.sessionOpen(), "B to open its CRDT session");
    await waitFor(() => b.editorBound(), "B's editor to bind to its hydrated session");
    await waitFor(() => b.editorText() === "base", "B to receive the initial text");
    a.saveEditor();
    b.saveEditor();

    // The exact cycle from the report: remount A, then remount B.
    await a.remount();
    await b.remount();

    expect(a.editorText()).toBe("base");
    expect(b.editorText()).toBe("base");
    expect(a.vault.files.get(vaultPath)).toBe("base");
    expect(b.vault.files.get(vaultPath)).toBe("base");

    const idleCounts = [a.crdtMessageCount(), b.crdtMessageCount()];
    const idleReceivedTypes = [a.receivedCrdtTypes(), b.receivedCrdtTypes()];
    await new Promise((resolve) => setTimeout(resolve, 1_750));
    expect([a.crdtMessageCount(), b.crdtMessageCount()]).toEqual(idleCounts);
    expect([a.receivedCrdtTypes(), b.receivedCrdtTypes()]).toEqual(idleReceivedTypes);
    expect(await a.serverText()).toBe("base");

    b.type("+b");
    await waitFor(() => a.editorText() === "base+b", "A to receive B's post-remount edit");
    expect(a.editorText()).toBe(b.editorText());
  });
});

// Live cursors / note presence v1 (docs/superpowers/specs/2026-07-28-live-cursors-design.md).
// The same seam argument as the rest of this file: presence spans the relay, two sockets, two session
// managers, and two real CM6 views, and the interesting failures (ghost carets, duplicated content,
// idle chatter) only appear when all of those are real at once.
describe("CRDT two-client: live cursors", () => {
  /** Brings both devices to a converged open note - the precondition every presence test needs. */
  async function converged() {
    const fixture = await setupCrdtRoomWithTwoDevices();
    const { a, b } = fixture;
    a.vault.files.set(vaultPath, "");
    await a.crdt.ensureSession(a.room.roomId, NOTE, { brandNewNote: true });
    await a.openEditor();
    a.type("hello world");
    await waitFor(() => a.editorText() === "hello world", "A's text to land");
    await waitFor(async () => (await a.serverText()) === "hello world", "relay to materialize");
    await b.openEditor();
    await waitFor(() => b.editorBound(), "B's editor to bind");
    await waitFor(() => b.editorText() === "hello world", "B to converge");
    a.saveEditor();
    b.saveEditor();
    return fixture;
  }

  it("exchanges authenticated caret and selection state without changing text", { timeout: 30_000 }, async () => {
    const { a, b } = await converged();

    a.select(2, 6);
    await waitFor(() => b.remoteCaretCount() > 0, "B to render A's caret");

    // Identity is server-stamped: A never sent a display name, and B renders the authenticated one.
    expect(b.remoteCaretNames()).toEqual(["A"]);
    // Cursor traffic must never touch content, on either side or at the relay.
    expect(a.editorText()).toBe("hello world");
    expect(b.editorText()).toBe("hello world");
    expect(await a.serverText()).toBe("hello world");

    // Symmetric in the other direction.
    b.select(0, 3);
    await waitFor(() => a.remoteCaretCount() > 0, "A to render B's caret");
    expect(a.remoteCaretNames()).toEqual(["B"]);
    expect(a.editorText()).toBe("hello world");
  });

  it("coalesces a burst of selection movement into far fewer sends", { timeout: 30_000 }, async () => {
    const { a, b } = await converged();

    const before = a.presenceSentCount();
    for (let index = 0; index < 10; index += 1) {
      a.select(index % 8, (index % 8) + 1);
    }
    await waitFor(() => b.remoteCaretCount() > 0, "B to render A's caret");

    // Ten selection changes inside one 50 ms window must not become ten frames.
    expect(a.presenceSentCount() - before).toBeLessThan(10);
    expect(a.presenceSentCount()).toBeGreaterThan(before);
  });

  it("emits no presence traffic while both cursors are steady", { timeout: 30_000 }, async () => {
    const { a, b } = await converged();
    a.select(2, 6);
    b.select(1, 4);
    await waitFor(() => a.remoteCaretCount() > 0 && b.remoteCaretCount() > 0, "both carets to render");

    const counts = [a.presenceSentCount(), a.presenceReceivedCount(), b.presenceSentCount(), b.presenceReceivedCount()];
    // Longer than two 800 ms cycles, with margin. Only application-level presence frames are counted -
    // WebSocket ping/pong is deliberately excluded, since the socket keepalive is unrelated.
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    expect([a.presenceSentCount(), a.presenceReceivedCount(), b.presenceSentCount(), b.presenceReceivedCount()]).toEqual(
      counts
    );
    // And the carets are still on screen - "no traffic" must not mean "expired".
    expect(a.remoteCaretCount()).toBeGreaterThan(0);
    expect(b.remoteCaretCount()).toBeGreaterThan(0);
  });

  it("leaves no ghost caret after an unmount/remount cycle", { timeout: 30_000 }, async () => {
    const { a, b } = await converged();
    a.select(2, 6);
    await waitFor(() => b.remoteCaretCount() === 1, "B to render A's caret");

    // A remount replaces A's Y.Doc and therefore its renderer key. Without the retraction in
    // teardownSession, B would keep the old caret alongside the new one.
    await a.remount();
    await waitFor(() => b.remoteCaretCount() === 0, "B to drop A's retired caret");

    await waitFor(() => a.editorBound(), "A's editor to rebind after remount");
    a.select(3, 7);
    await waitFor(() => b.remoteCaretCount() === 1, "B to render A's new caret");

    // Exactly one caret, and content is untouched by any of it.
    expect(b.remoteCaretCount()).toBe(1);
    expect(b.remoteCaretNames()).toEqual(["A"]);
    expect(a.editorText()).toBe("hello world");
    expect(b.editorText()).toBe("hello world");
    expect(await a.serverText()).toBe("hello world");
  });

  it("keeps one caret when a second pane closes and clears it after the last", { timeout: 30_000 }, async () => {
    const { a, b } = await converged();
    b.select(1, 4);
    await waitFor(() => a.remoteCaretCount() === 1, "A to render B's caret");

    const second = await a.openSecondPane();
    a.select(2, 6);
    await waitFor(() => b.remoteCaretCount() === 1, "B to render A's caret from the first pane");

    // A freshly bound pane starts empty and only computes remote decorations on a later update pass, so
    // the caret shows up when the peer next moves - which is also how it behaves in Obsidian.
    b.select(5, 9);
    await waitFor(
      () => second.dom.querySelectorAll(".cm-ySelectionCaret").length === 1,
      "second pane to render B's caret"
    );
    // Both panes render it: they share one presence store behind two facades.
    expect(a.remoteCaretCount()).toBe(1);

    await a.closeSecondPane();
    // One pane is still open on the note, so A's presence survives.
    expect(b.remoteCaretCount()).toBe(1);

    await a.controller.syncOpenViews([]);
    await waitFor(() => b.remoteCaretCount() === 0, "B to drop A's caret after the last pane closes");
  });

  it("clears a peer's caret when its socket drops", { timeout: 30_000 }, async () => {
    const { a, b } = await converged();
    a.select(2, 6);
    await waitFor(() => b.remoteCaretCount() === 1, "B to render A's caret");

    a.socket.disconnect();

    // The relay owns disconnect cleanup - B does not wait for an Awareness timeout.
    await waitFor(() => b.remoteCaretCount() === 0, "B to drop the disconnected peer's caret");
    expect(b.editorText()).toBe("hello world");
  });

  it("preserves exactly-once bidirectional typing while cursors are active", { timeout: 30_000 }, async () => {
    const { a, b } = await converged();
    a.select(2, 6);
    b.select(1, 4);
    await waitFor(() => a.remoteCaretCount() > 0 && b.remoteCaretCount() > 0, "both carets to render");

    a.type("!");
    await waitFor(() => b.editorText() === "hello world!", "B to receive A's keystroke");
    b.type("?");
    await waitFor(() => a.editorText() === "hello world!?", "A to receive B's keystroke");

    // The original no-duplication invariant, still intact with presence in the loop.
    expect(a.editorText()).toBe("hello world!?");
    expect(b.editorText()).toBe("hello world!?");
    await waitFor(async () => (await a.serverText()) === "hello world!?", "relay to materialize both edits");
  });

  it("moves presence to the new path on rename without leaving a stale caret", { timeout: 30_000 }, async () => {
    const { a, b } = await converged();
    b.select(1, 4);
    await waitFor(() => a.remoteCaretCount() === 1, "A to render B's caret");

    // Obsidian renames the file itself before the watcher fires, so the vault move comes first.
    await a.vault.rename(vaultPath, `${MOUNT}/renamed.md`);
    await a.crdt.renameSession(a.room.roomId, NOTE, "renamed.md");

    // The relay clears the old path's entries as part of the rename, so B's caret for the old path
    // comes down rather than showing at two paths at once.
    await waitFor(() => a.remoteCaretCount() === 0, "A to drop the old-path caret");
    expect(a.editorText()).toBe("hello world");
    expect(await b.serverText().catch(() => "missing")).toBe("missing");
  });

  it("applies a selection-based format once while both cursors are live", { timeout: 30_000 }, async () => {
    const { a, b } = await converged();

    // Both peers have a live caret, and B's selection overlaps the range A is about to rewrite - the
    // case where a naive cursor implementation would either double-apply the edit or leave B's caret
    // pointing into text that no longer exists.
    b.select(0, 5);
    a.select(6, 11);
    await waitFor(() => a.remoteCaretCount() > 0 && b.remoteCaretCount() > 0, "both carets to render");

    a.boldSelection();

    // Applied exactly once, on both sides and at the relay - "bold" is a replace, so a duplicated
    // transaction would show as `**world****world**` rather than a longer note.
    await waitFor(() => b.editorText() === "hello **world**", "B to receive the formatted text");
    expect(a.editorText()).toBe("hello **world**");
    await waitFor(async () => (await a.serverText()) === "hello **world**", "relay to materialize the format");

    // B's caret survives the rewrite (relative positions adjust) and typing still lands once.
    b.type("!");
    await waitFor(() => a.editorText() === "hello **world**!", "A to receive B's keystroke after the format");
    expect(b.editorText()).toBe("hello **world**!");
  });
});

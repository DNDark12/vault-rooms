import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, Socket } from "node:net";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DataAdapter } from "obsidian";
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from "sql.js";
import WebSocket from "ws";
import * as Y from "yjs";
import {
  blobKeyForBytes,
  createRelayCore,
  CRDT_TEXT_KEY,
  type BlobStore,
  type PreparedStatement,
  type RelayDb,
  type SqlRow
} from "vault-rooms-relay/embedded-core";
import { createAppWithDb } from "vault-rooms-relay/app-core";
import { openSqlJsDb } from "../../relay-server/src/db/sqlJsAdapter.js";
import { createEmbeddedRelayApp, EmbeddedRelayApp } from "../src/embeddedRelayApp.js";
import { openObsidianSqlJsDb } from "../src/obsidianSqlJsDb.js";

(globalThis as unknown as { window: typeof globalThis }).window ??= globalThis;

const apps: EmbeddedRelayApp[] = [];
const sockets: WebSocket[] = [];
const rawSockets: Socket[] = [];
let sqlJsPromise: Promise<SqlJsStatic> | null = null;

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  for (const socket of rawSockets.splice(0)) {
    socket.destroy();
  }
  for (const app of apps.splice(0)) {
    await app.close();
  }
});

describe("embedded relay WebSocket server", () => {
  it("accepts a normal sync WebSocket handshake and authenticates hello messages", async () => {
    const { app, baseUrl } = await startEmbeddedRelay();
    const owner = await bootstrapOwner(app, baseUrl);
    const socket = await connect(`${baseUrl.replace(/^http/, "ws")}/sync`);

    socket.send(
      JSON.stringify({
        type: "hello",
        requestId: "hello-a",
        token: owner.deviceToken,
        client: { kind: "obsidian-plugin", version: "0.1.0", deviceName: "A laptop" }
      })
    );

    expect(await nextMessage(socket, "hello_ok")).toMatchObject({ requestId: "hello-a", userId: owner.user.id, deviceId: owner.device.id });
  });

  it("wires CrdtDocManager into the same handleSyncSocket the standalone runtime uses - crdt_create/crdt_update/handshake work over the embedded transport", async () => {
    // Exercise shared CRDT handlers through the embedded transport.
    const { app, baseUrl } = await startEmbeddedRelay();
    const owner = await bootstrapOwner(app, baseUrl);
    const roomResponse = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.deviceToken}` },
      body: JSON.stringify({ name: "Room", type: "folder", sourcePath: "Room", mountName: "Room", capabilities: [] })
    });
    const room = (await roomResponse.json()).room as { id: string };
    await fetch(`${baseUrl}/api/rooms/${room.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.deviceToken}` },
      body: JSON.stringify({ name: "Room", type: "folder", sourcePath: "Room", mountName: "Room", crdtEnabled: true })
    });

    const socket = await connect(`${baseUrl.replace(/^http/, "ws")}/sync`);
    socket.send(
      JSON.stringify({
        type: "hello",
        requestId: "hello-crdt",
        token: owner.deviceToken,
        client: { kind: "obsidian-plugin", version: "0.3.0", deviceName: "A laptop" },
        capabilities: { crdt: true }
      })
    );
    await nextMessage(socket, "hello_ok");
    socket.send(JSON.stringify({ type: "subscribe_room", requestId: "sub", roomId: room.id }));
    await nextMessage(socket, "room_snapshot");

    socket.send(JSON.stringify({ type: "crdt_create", requestId: "c1", roomId: room.id, relativePath: "note.md" }));
    const created = await nextMessage(socket, "crdt_created");
    expect(created).toMatchObject({ requestId: "c1", roomId: room.id, relativePath: "note.md", epoch: 0 });

    const localDoc = new Y.Doc();
    localDoc.getText(CRDT_TEXT_KEY).insert(0, "hello from the embedded relay");
    socket.send(
      JSON.stringify({
        type: "crdt_update",
        requestId: "u1",
        roomId: room.id,
        relativePath: "note.md",
        epoch: created.epoch,
        update: Buffer.from(Y.encodeStateAsUpdate(localDoc)).toString("base64")
      })
    );

    // Verify durability + handshake round-trip (rather than waiting on the real 2s materialize
    // debounce, which would make this test slow) - a fresh crdt_sync_step1 from an empty state
    // vector should get back a diff containing the just-applied update.
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.send(
      JSON.stringify({
        type: "crdt_sync_step1",
        requestId: "h1",
        roomId: room.id,
        relativePath: "note.md",
        epoch: created.epoch,
        stateVector: Buffer.from(Y.encodeStateVector(new Y.Doc())).toString("base64")
      })
    );
    const step2 = await nextMessage(socket, "crdt_sync_step2");
    const verifyDoc = new Y.Doc();
    Y.applyUpdate(verifyDoc, new Uint8Array(Buffer.from(step2.update, "base64")));
    expect(verifyDoc.getText(CRDT_TEXT_KEY).toString()).toBe("hello from the embedded relay");
  });

  it("rejects an oversized pre-auth frame from the declared payload length without waiting for the body", async () => {
    const { port } = await startEmbeddedRelay({ maxFileBytes: 1024 });
    const socket = await openRawWebSocket(port);

    socket.write(maskedTextFrameHeader(8 * 1024 * 1024));

    expect(await nextCloseFrame(socket)).toMatchObject({ code: 1009 });
  });
});

describe.each(["standalone", "embedded"] as const)("HTTP request policy - %s", (runtime) => {
  it("authenticates a protected route before reading its body", async () => {
    const started = await startRawRuntime(runtime, 1024);
    try {
      // Over this route's body limit (see the next test): only an auth check that runs first answers 401.
      const response = await fetch(`${started.baseUrl}/api/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(200 * 1024) })
      });

      expect(response.status).toBe(401);
    } finally {
      await started.close();
    }
  });

  it("caps small JSON bodies, including the unauthenticated ones, far below file uploads", async () => {
    const started = await startRawRuntime(runtime, 1024 * 1024);
    try {
      const owner = await bootstrapOwner(started.app, started.baseUrl);
      const headers = { "content-type": "application/json", authorization: `Bearer ${owner.deviceToken}` };
      const padding = "x".repeat(200 * 1024);

      const settings = await fetch(`${started.baseUrl}/api/rooms`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Room", type: "folder", sourcePath: "Room", mountName: "Room", capabilities: [], padding })
      });
      const join = await fetch(`${started.baseUrl}/api/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inviteToken: "inv_x", displayName: "B", deviceName: "B laptop", padding })
      });

      expect(settings.status).toBe(413);
      expect(join.status).toBe(413);
    } finally {
      await started.close();
    }
  });

  it("keeps answering after refusing bodies it stopped reading part-way", async () => {
    const started = await startRawRuntime(runtime, 1024);
    try {
      const body = JSON.stringify({ inviteToken: "inv_x", displayName: "B", deviceName: "B laptop", padding: "x".repeat(200 * 1024) });
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        // A half-read body left on a reused connection stalls a later request until the socket times out.
        const response = await fetch(`${started.baseUrl}/api/join`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(2_000)
        });
        statuses.push(response.status);
        await response.arrayBuffer();
      }
      const health = await fetch(`${started.baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });

      expect(statuses).toEqual([413, 413, 413, 413]);
      expect(health.status).toBe(200);
    } finally {
      await started.close();
    }
  });

  it("answers CORS only for the Obsidian app origin", async () => {
    const started = await startRawRuntime(runtime, 1024);
    try {
      const fromApp = await fetch(`${started.baseUrl}/health`, { headers: { origin: "app://obsidian.md" } });
      const fromPage = await fetch(`${started.baseUrl}/health`, { headers: { origin: "https://example.com" } });
      const preflight = await fetch(`${started.baseUrl}/api/rooms`, {
        method: "OPTIONS",
        headers: { origin: "app://obsidian.md", "access-control-request-method": "PATCH" }
      });
      // A renderer-fetch client can read an error only when the error response carries the grant too.
      const rejected = await fetch(`${started.baseUrl}/api/me`, { headers: { origin: "app://obsidian.md" } });

      expect(fromApp.headers.get("access-control-allow-origin")).toBe("app://obsidian.md");
      expect(fromPage.headers.get("access-control-allow-origin")).toBeNull();
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-methods")).toContain("PATCH");
      expect(rejected.status).toBe(401);
      expect(rejected.headers.get("access-control-allow-origin")).toBe("app://obsidian.md");
    } finally {
      await started.close();
    }
  });
});

describe.each(["standalone", "embedded"] as const)("raw HTTP file contract - %s", (runtime) => {
  it("refuses text-lane bytes that are not UTF-8 instead of storing replacement characters", async () => {
    const started = await startRawRuntime(runtime, 1024);
    try {
      const owner = await bootstrapOwner(started.app, started.baseUrl);
      const headers = { authorization: `Bearer ${owner.deviceToken}` };
      const room = (
        (await (
          await fetch(`${started.baseUrl}/api/rooms`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ name: "Raw", type: "folder", sourcePath: "Raw", mountName: "Raw", capabilities: [], crdtEnabled: false })
          })
        ).json()) as { room: { id: string } }
      ).room;
      const upload = (path: string, bytes: Uint8Array<ArrayBuffer>) =>
        fetch(`${started.baseUrl}/api/rooms/${room.id}/files/raw?path=${encodeURIComponent(path)}&baseVersion=0`, {
          method: "PUT",
          headers: { ...headers, "content-type": "application/octet-stream" },
          body: bytes
        });
      const windows1252 = new Uint8Array([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x63, 0x61, 0x66, 0xe9]); // "name\ncafé"

      const refused = await upload("export.csv", windows1252);
      const binary = await upload("export.bin", windows1252);
      const utf8 = new TextEncoder().encode("name\ncafé");
      const accepted = await upload("utf8.csv", utf8);

      expect(refused.status).toBe(422);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
      expect(binary.status).toBe(200);
      expect(accepted.status).toBe(200);
      const roundTrip = await fetch(`${started.baseUrl}/api/rooms/${room.id}/files/raw?path=utf8.csv`, { headers });
      expect(new Uint8Array(await roundTrip.arrayBuffer())).toEqual(utf8);
    } finally {
      await started.close();
    }
  });

  it("round-trips bytes and enforces authentication and size limits", async () => {
    const started = await startRawRuntime(runtime, 8);
    try {
      const owner = await bootstrapOwner(started.app, started.baseUrl);
      const roomResponse = await fetch(`${started.baseUrl}/api/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${owner.deviceToken}` },
        body: JSON.stringify({ name: "Raw", type: "folder", sourcePath: "Raw", mountName: "Raw", capabilities: [] })
      });
      const room = (await roomResponse.json()).room as { id: string };
      const url = `${started.baseUrl}/api/rooms/${room.id}/files/raw?path=image.bin&baseVersion=0`;

      expect((await fetch(url)).status).toBe(401);
      const bytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
      const upload = await fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream", authorization: `Bearer ${owner.deviceToken}` },
        body: bytes
      });
      expect(upload.status).toBe(200);

      const download = await fetch(`${started.baseUrl}/api/rooms/${room.id}/files/raw?path=image.bin`, {
        headers: { authorization: `Bearer ${owner.deviceToken}` }
      });
      expect(download.status).toBe(200);
      expect(download.headers.get("content-type")).toContain("application/octet-stream");
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);

      const inviteResponse = await fetch(`${started.baseUrl}/api/rooms/${room.id}/invites`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${owner.deviceToken}` },
        body: JSON.stringify({ preset: "reader" })
      });
      const invite = (await inviteResponse.json()) as { inviteToken: string };
      const joinResponse = await fetch(`${started.baseUrl}/api/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inviteToken: invite.inviteToken, displayName: "Reader", deviceName: "Reader laptop" })
      });
      const reader = (await joinResponse.json()) as { deviceToken: string };
      const readerHeaders = { authorization: `Bearer ${reader.deviceToken}` };
      expect(
        (
          await fetch(`${started.baseUrl}/api/rooms/${room.id}/files/raw?path=image.bin`, {
            headers: readerHeaders
          })
        ).status
      ).toBe(200);
      expect(
        (
          await fetch(`${started.baseUrl}/api/rooms/${room.id}/files/raw?path=image.bin&baseVersion=1`, {
            method: "PUT",
            headers: { ...readerHeaders, "content-type": "application/octet-stream" },
            body: bytes
          })
        ).status
      ).toBe(403);

      const oversized = await fetch(`${started.baseUrl}/api/rooms/${room.id}/files/raw?path=large.bin&baseVersion=0`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream", authorization: `Bearer ${owner.deviceToken}` },
        body: new Uint8Array(9)
      });
      expect(oversized.status).toBe(413);
      // Refused by the body limit before the handler runs, still with the message a Notice shows.
      expect(((await oversized.json()) as { error: { message: string } }).error.message).toContain("limit 8 bytes");
    } finally {
      await started.close();
    }
  });
});

describe.each(["standalone", "embedded"] as const)("turning Live editing on while files change - %s", (runtime) => {
  it.each(["write", "create", "delete", "rename"] as const)(
    "a %s racing the switch either lands in the live documents or is rejected, and is never undone later",
    async (operation) => {
      const store = gatedBlobStore();
      const started = await startRuntimeWithBlobStore(runtime, store);
      try {
        const owner = await bootstrapOwner(started.app, started.baseUrl);
        const headers = { "content-type": "application/json", authorization: `Bearer ${owner.deviceToken}` };
        const room = (
          (await (
            await fetch(`${started.baseUrl}/api/rooms`, {
              method: "POST",
              headers,
              body: JSON.stringify({ name: "Notes", type: "folder", sourcePath: "Notes", mountName: "Notes", capabilities: [], crdtEnabled: false })
            })
          ).json()) as { room: { id: string } }
        ).room;
        const put = (relativePath: string, baseVersion: number, content: string) =>
          fetch(`${started.baseUrl}/api/rooms/${room.id}/files/content`, { method: "PUT", headers, body: JSON.stringify({ relativePath, baseVersion, content }) });
        const remove = (relativePath: string, baseVersion: number) =>
          fetch(`${started.baseUrl}/api/rooms/${room.id}/files/delete`, { method: "POST", headers, body: JSON.stringify({ relativePath, baseVersion }) });
        expect((await put("note.md", 0, "old text")).status).toBe(200);

        // Hold the switch while it reads the note it is about to seed, and race the operation into that gap.
        const hold = store.holdNextRead();
        const toggle = fetch(`${started.baseUrl}/api/rooms/${room.id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ name: "Notes", type: "folder", sourcePath: "Notes", mountName: "Notes", crdtEnabled: true })
        });
        await hold.held;
        const racing =
          operation === "write"
            ? [put("note.md", 1, "new text")]
            : operation === "create"
              ? [put("fresh.md", 0, "fresh text")]
              : operation === "delete"
                ? [remove("note.md", 1)]
                : [remove("note.md", 1), put("renamed.md", 0, "old text")];
        await new Promise((resolve) => setTimeout(resolve, 100));
        hold.release();
        const [toggled, ...outcomes] = await Promise.all([toggle, ...racing]);
        expect(toggled.status).toBe(200);
        for (const outcome of outcomes) {
          expect([200, 409]).toContain(outcome.status);
        }

        const readNote = async (relativePath: string) => {
          const response = await fetch(
            `${started.baseUrl}/api/rooms/${room.id}/files/content?path=${encodeURIComponent(relativePath)}`,
            { headers }
          );
          return response.status === 200 ? ((await response.json()) as { content: string }).content : null;
        };
        const liveDocuments = async () => {
          const socket = await connect(`${started.baseUrl.replace(/^http/, "ws")}/sync`);
          socket.send(JSON.stringify({ type: "hello", requestId: "h", token: owner.deviceToken, client: { kind: "obsidian-plugin", version: "0.3.0", deviceName: "A" }, capabilities: { crdt: true } }));
          await nextMessage(socket, "hello_ok");
          socket.send(JSON.stringify({ type: "subscribe_room", requestId: "s", roomId: room.id }));
          const snapshot = await nextMessage(socket, "room_snapshot");
          const documents = new Map<string, string>();
          for (const file of snapshot.files as Array<{ relativePath: string; deleted: boolean; crdtEpoch?: number }>) {
            if (file.deleted || file.crdtEpoch === undefined) continue;
            socket.send(JSON.stringify({
              type: "crdt_sync_step1",
              requestId: `h-${file.relativePath}`,
              roomId: room.id,
              relativePath: file.relativePath,
              epoch: file.crdtEpoch,
              stateVector: Buffer.from(Y.encodeStateVector(new Y.Doc())).toString("base64")
            }));
            const step2 = await nextMessage(socket, "crdt_sync_step2");
            const doc = new Y.Doc();
            Y.applyUpdate(doc, new Uint8Array(Buffer.from(step2.update, "base64")));
            documents.set(file.relativePath, doc.getText(CRDT_TEXT_KEY).toString());
          }
          socket.close();
          return documents;
        };

        // Every live note's whole-file content is its live document's text...
        const documents = await liveDocuments();
        for (const [relativePath, text] of documents) {
          expect(await readNote(relativePath)).toBe(text);
        }
        // ...and stays so once a subscribe has re-materialized each document.
        for (const [relativePath, text] of await liveDocuments()) {
          expect(await readNote(relativePath)).toBe(text);
        }
        // An operation the relay accepted is visible; one it rejected left nothing behind.
        const accepted = outcomes.map((outcome) => outcome.status === 200);
        if (operation === "write") {
          expect(documents.get("note.md")).toBe(accepted[0] ? "new text" : "old text");
        } else if (operation === "create") {
          expect(documents.get("fresh.md")).toBe(accepted[0] ? "fresh text" : undefined);
        } else if (operation === "delete") {
          expect(documents.has("note.md")).toBe(!accepted[0]);
        } else {
          expect(documents.has("note.md")).toBe(!accepted[0]);
          expect(documents.get("renamed.md")).toBe(accepted[1] ? "old text" : undefined);
        }
      } finally {
        await started.close();
      }
    }
  );
});

describe("EmbeddedRelayApp.close", () => {
  it("does not terminate sockets that close during the graceful shutdown window", async () => {
    const app = new EmbeddedRelayApp(await createMemoryDb(), 1024, "123456", () => undefined, { dispose: () => undefined });
    const socket = new GracefulFakeSocket();
    (app as unknown as { sockets: Map<WebSocket, "http" | "https"> }).sockets.set(
      socket as unknown as WebSocket,
      "http"
    );

    await app.close();

    expect(socket.closeCalls).toBe(1);
    expect(socket.terminateCalls).toBe(0);
  });

  it("closes a transport socket that appears while its listener is shutting down", async () => {
    const app = new EmbeddedRelayApp(await createMemoryDb(), 1024, "123456", () => undefined, { dispose: () => undefined });
    const socketsByTransport = (app as unknown as { sockets: Map<WebSocket, "http" | "https"> }).sockets;
    const lateSocket = new GracefulFakeSocket();
    const firstSocket = new GracefulFakeSocket(() => {
      socketsByTransport.set(lateSocket as unknown as WebSocket, "http");
    });
    socketsByTransport.set(firstSocket as unknown as WebSocket, "http");
    (app as unknown as { plainServer: { close: (callback: (error?: Error) => void) => void } }).plainServer = {
      close: (callback) => callback()
    };

    await app.closePlainListener();

    expect(firstSocket.closeCalls).toBe(1);
    expect(lateSocket.closeCalls).toBe(1);
    await app.close();
  });
});

class GracefulFakeSocket extends EventEmitter {
  closeCalls = 0;
  terminateCalls = 0;
  readyState: number = WebSocket.OPEN;

  constructor(private readonly afterClose?: () => void) {
    super();
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = WebSocket.CLOSING;
    queueMicrotask(() => {
      this.readyState = WebSocket.CLOSED;
      this.emit("close");
      this.afterClose?.();
    });
  }

  terminate(): void {
    this.terminateCalls += 1;
    this.readyState = WebSocket.CLOSED;
  }
}

async function startEmbeddedRelay(options: { maxFileBytes?: number } = {}): Promise<{ app: EmbeddedRelayApp; baseUrl: string; port: number }> {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const app = await createEmbeddedRelayApp(await createMemoryDb(), {
    publicUrl: baseUrl,
    maxFileBytes: options.maxFileBytes
  });
  apps.push(app);
  await app.listen({ host: "127.0.0.1", port });
  return { app, baseUrl, port };
}

async function bootstrapOwner(app: { bootstrapPin: string }, baseUrl: string): Promise<{
  user: { id: string };
  device: { id: string };
  deviceToken: string;
}> {
  const response = await fetch(`${baseUrl}/api/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      displayName: "A",
      deviceName: "A laptop",
      teamName: "Demo",
      pin: app.bootstrapPin
    })
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { user: { id: string }; device: { id: string }; deviceToken: string };
}

async function startRawRuntime(runtime: "standalone" | "embedded", maxFileBytes: number): Promise<{
  app: { bootstrapPin: string };
  baseUrl: string;
  close(): Promise<void>;
}> {
  if (runtime === "embedded") {
    const started = await startEmbeddedRelay({ maxFileBytes });
    return { app: started.app, baseUrl: started.baseUrl, close: async () => undefined };
  }
  const app = await createAppWithDb(await createMemoryDb(), { maxFileBytes });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP address");
  }
  return {
    app: app as typeof app & { bootstrapPin: string },
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => app.close()
  };
}

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function nextMessage(socket: WebSocket, type: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${type}`));
    }, 1_000);
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString());
      if (message.type === type) {
        cleanup();
        resolve(message);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`Socket closed while waiting for ${type}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.on("message", onMessage);
    socket.on("close", onClose);
  });
}

async function openRawWebSocket(port: number): Promise<Socket> {
  const socket = new Socket();
  rawSockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
    socket.connect(port, "127.0.0.1");
  });

  const key = randomBytes(16).toString("base64");
  socket.write(
    [
      "GET /sync HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      "",
      ""
    ].join("\r\n")
  );

  const response = await readUntil(socket, "\r\n\r\n");
  expect(response.toString("utf8")).toContain("HTTP/1.1 101 Switching Protocols");
  return socket;
}

async function nextCloseFrame(socket: Socket): Promise<{ code: number | null }> {
  let buffer = Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for close frame"));
    }, 1_000);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const closeFrame = parseCloseFrame(buffer);
      if (closeFrame) {
        cleanup();
        resolve(closeFrame);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Socket closed before close frame"));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("close", onClose);
    };
    socket.on("data", onData);
    socket.on("close", onClose);
  });
}

function parseCloseFrame(buffer: Buffer): { code: number | null } | null {
  if (buffer.length < 2 || (buffer[0]! & 0x0f) !== 0x8) {
    return null;
  }
  const length = buffer[1]! & 0x7f;
  if (length > 125 || buffer.length < 2 + length) {
    return null;
  }
  return { code: length >= 2 ? buffer.readUInt16BE(2) : null };
}

function maskedTextFrameHeader(payloadLength: number): Buffer {
  const header = Buffer.alloc(14);
  header[0] = 0x81;
  header[1] = 0x80 | 127;
  header.writeUInt32BE(Math.floor(payloadLength / 2 ** 32), 2);
  header.writeUInt32BE(payloadLength >>> 0, 6);
  randomBytes(4).copy(header, 10);
  return header;
}

async function readUntil(socket: Socket, marker: string): Promise<Buffer> {
  let buffer = Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${marker}`));
    }, 1_000);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.includes(marker)) {
        cleanup();
        resolve(buffer);
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

/** Raw-content store whose next read can be held open, to widen a race window on purpose. */
function gatedBlobStore(): BlobStore & { holdNextRead(): { held: Promise<void>; release(): void } } {
  const blobs = new Map<string, Uint8Array>();
  let pendingHold: { markHeld(): void; gate: Promise<void> } | null = null;
  return {
    async put(bytes) {
      const key = blobKeyForBytes(bytes);
      blobs.set(key, Uint8Array.from(bytes));
      return key;
    },
    async get(key) {
      const hold = pendingHold;
      if (hold) {
        pendingHold = null;
        hold.markHeld();
        await hold.gate;
      }
      return blobs.get(key);
    },
    async has(key) {
      return blobs.has(key);
    },
    async delete(key) {
      blobs.delete(key);
    },
    async list() {
      return [...blobs.keys()];
    },
    holdNextRead() {
      let markHeld!: () => void;
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        markHeld = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      pendingHold = { markHeld, gate };
      return { held, release };
    }
  };
}

/** Each runtime on its real database adapter: Node `fs`-style sql.js standalone, DataAdapter-backed embedded. */
async function startRuntimeWithBlobStore(runtime: "standalone" | "embedded", blobStore: BlobStore): Promise<{
  app: { bootstrapPin: string };
  baseUrl: string;
  close(): Promise<void>;
}> {
  if (runtime === "embedded") {
    const db = await openObsidianSqlJsDb(new MemoryDataAdapter() as unknown as DataAdapter, "vault-rooms/relay.sqlite", {
      wasmBinary: browserSqlWasm()
    });
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const app = await createEmbeddedRelayApp(db, { publicUrl: baseUrl, core: createRelayCore(db, { blobStore }) });
    apps.push(app);
    await app.listen({ host: "127.0.0.1", port });
    return { app, baseUrl, close: async () => undefined };
  }
  const app = await createAppWithDb(await openSqlJsDb(":memory:"), { blobStore });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP address");
  }
  return {
    app: app as typeof app & { bootstrapPin: string },
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => app.close()
  };
}

/** The sql.js build obsidianSqlJsDb.ts loads in production. */
function browserSqlWasm(): ArrayBuffer {
  const distDir = dirname(createRequire(import.meta.url).resolve("sql.js/dist/sql-wasm-browser.js"));
  const bytes = readFileSync(join(distDir, "sql-wasm-browser.wasm"));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** In-memory stand-in for the slice of Obsidian's DataAdapter that obsidianSqlJsDb uses. */
class MemoryDataAdapter {
  private readonly store = new Map<string, ArrayBuffer>();
  private readonly folders = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.store.has(path) || this.folders.has(path);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const data = this.store.get(path);
    if (!data) throw new Error(`Missing file: ${path}`);
    return data.slice(0);
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.store.set(path, data.slice(0));
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }

  async remove(path: string): Promise<void> {
    this.store.delete(path);
    this.folders.delete(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const data = this.store.get(from);
    if (!data) throw new Error(`Missing file: ${from}`);
    this.store.set(to, data);
    this.store.delete(from);
  }
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP address");
  }
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function createMemoryDb(): Promise<RelayDb> {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs();
  }
  const SQL = await sqlJsPromise;
  const db: SqlJsDatabase = new SQL.Database();
  let closed = false;

  const assertOpen = () => {
    if (closed) {
      throw new Error("RelayDb is closed");
    }
  };

  const prepare = (sql: string): PreparedStatement => ({
    run(...params: unknown[]) {
      assertOpen();
      const stmt = db.prepare(sql);
      try {
        stmt.bind(normalizeParams(params));
        stmt.step();
      } finally {
        stmt.free();
      }
      return { changes: db.getRowsModified() };
    },
    get(...params: unknown[]) {
      assertOpen();
      const stmt = db.prepare(sql);
      try {
        stmt.bind(normalizeParams(params));
        return stmt.step() ? stmt.getAsObject() : undefined;
      } finally {
        stmt.free();
      }
    },
    all(...params: unknown[]) {
      assertOpen();
      const stmt = db.prepare(sql);
      const rows: SqlRow[] = [];
      try {
        stmt.bind(normalizeParams(params));
        while (stmt.step()) {
          rows.push(stmt.getAsObject());
        }
      } finally {
        stmt.free();
      }
      return rows;
    }
  });

  return {
    prepare,
    exec(sql: string) {
      assertOpen();
      db.exec(sql);
    },
    pragma(pragmaString: string) {
      assertOpen();
      db.exec(`pragma ${pragmaString}`);
    },
    transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R {
      return (...args: Args) => {
        assertOpen();
        db.exec("begin");
        try {
          const result = fn(...args);
          db.exec("commit");
          return result;
        } catch (error) {
          db.exec("rollback");
          throw error;
        }
      };
    },
    flush() {
      return undefined;
    },
    async durable<T>(operation: () => T): Promise<T> {
      return operation();
    },
    async withExclusiveAccess<T>(operation: () => T | Promise<T>): Promise<T> {
      return operation();
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      db.close();
    }
  };
}

function normalizeParams(params: unknown[]): (number | string | Uint8Array | null)[] {
  return params.map((value) => (value === undefined ? null : (value as number | string | Uint8Array | null)));
}

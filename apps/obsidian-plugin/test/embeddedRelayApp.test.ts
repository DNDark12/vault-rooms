import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from "sql.js";
import WebSocket from "ws";
import type { PreparedStatement, RelayDb, SqlRow } from "vault-rooms-relay/embedded-core";
import { createEmbeddedRelayApp, EmbeddedRelayApp } from "../src/embeddedRelayApp.js";

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

  it("rejects an oversized pre-auth frame from the declared payload length without waiting for the body", async () => {
    const { port } = await startEmbeddedRelay({ maxFileBytes: 1024 });
    const socket = await openRawWebSocket(port);

    socket.write(maskedTextFrameHeader(8 * 1024 * 1024));

    expect(await nextCloseFrame(socket)).toMatchObject({ code: 1009 });
  });
});

describe("EmbeddedRelayApp.close", () => {
  it("does not terminate sockets that close during the graceful shutdown window", async () => {
    const app = new EmbeddedRelayApp(await createMemoryDb(), 1024, "123456", () => undefined);
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
    const app = new EmbeddedRelayApp(await createMemoryDb(), 1024, "123456", () => undefined);
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

async function bootstrapOwner(app: EmbeddedRelayApp, baseUrl: string): Promise<{
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

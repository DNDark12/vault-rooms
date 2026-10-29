import * as tls from "node:tls";
import { b64u, concatBytes, utf8 } from "./bytes.js";
import { hashTagged, sign, verify, type KeyPair } from "./crypto.js";
import { encodeFrame, FrameReader, MAX_FRAME, PROVEN_MAX_FRAME } from "./frames.js";
import { deviceIdFor } from "./ids.js";
import type { Channel, PeerMessage } from "./mesh.js";
import { certificateFingerprint, type TlsIdentity } from "./tlsIdentity.js";
import * as v from "./validate.js";
import { activeDevice, type WorkspaceState } from "./workspace.js";

/**
 * Peer connections: TLS 1.3, then a short authentication exchange bound to that TLS session.
 *
 * - The dialling side knows which device it is calling and pins that device's certificate fingerprint from the
 *   workspace record: it checks the exact certificate before it sends a single byte. (There is no certificate
 *   authority, so Node's chain check is replaced by this exact-certificate check, in one place: `dial`.)
 * - Both sides then sign the TLS session's exported keying material together with both device ids. The signature can
 *   only verify on this very connection, so a relay in the middle can't pass someone else's authentication along.
 * - Every device sends its public key along (its id is the key's hash). One that isn't a member here (joining, or a
 *   member that joined while this device was away) is let through only to prove it is: its join record, or the
 *   record's versions (the mesh session enforces that).
 *
 * Until it is a member, frames are capped at 64 KiB, or at 16 MiB once it has shown it holds this device's record (a
 * message of record versions; see PeerSession). Until then the connection counts against a small limit of such
 * connections, and it must become a member within 10 seconds or it is closed. Anyone on the network can generate a
 * key, so authenticating alone earns nothing more.
 */

const EXPORTER_LABEL = "EXPORTER-vault-rooms-peer-auth";
const AUTH_TIMEOUT_MS = 10_000;
const AUTH_MAX_FRAME = 64 << 10;
const PING_EVERY_MS = 15_000;
const SILENCE_LIMIT_MS = 45_000;
const MAX_BUFFERED = 128 << 20;
const MAX_UNAUTHENTICATED = 16;

export function workspaceTag(workspaceId: string): string {
  return b64u(hashTagged("workspace-tag", utf8(workspaceId)).subarray(0, 16));
}

export interface TransportConfig {
  workspaceId: string;
  deviceId: string;
  deviceKey: KeyPair;
  tls: TlsIdentity;
  /** The membership to check peers against (the mesh node's effective state). */
  membership(): WorkspaceState;
}

export interface PeerLink {
  remoteDevice: string;
  remoteAddress: string;
  direction: "in" | "out";
  /** The other side isn't in the membership yet: it is joining (only true on the accepting side). */
  joining: boolean;
  /** For a joining dialler: the acceptor's claimed identity, to check once the record is known. */
  unverifiedAcceptor?: { device: string; fingerprint: string; ekm: Uint8Array; sig: string };
  channel: Channel;
  onMessage(handler: (message: unknown) => void): void;
  onClose(handler: (reason: string) => void): void;
}

function exportKeyingMaterial(socket: tls.TLSSocket): Uint8Array {
  return new Uint8Array(socket.exportKeyingMaterial(32, EXPORTER_LABEL, Buffer.alloc(0)));
}

function authBytes(purpose: string, ekm: Uint8Array, dialer: string, acceptor: string, tag: string): Uint8Array {
  return concatBytes(ekm, utf8(`${purpose}|${dialer}|${acceptor}|${tag}`));
}

/** Check, after the fact, an acceptor a joining device couldn't pin in advance (it had no record yet). */
export function verifyAcceptor(state: WorkspaceState, workspaceId: string, dialer: string, acceptor: NonNullable<PeerLink["unverifiedAcceptor"]>): boolean {
  const device = activeDevice(state, acceptor.device);
  if (!device || device.tls !== acceptor.fingerprint) return false;
  return verify(device.sign, "peer-auth-ok", authBytes("ok", acceptor.ekm, dialer, acceptor.device, workspaceTag(workspaceId)), acceptor.sig);
}

/** One TLS socket carrying frames; becomes a PeerLink once authenticated. */
class Wire {
  private reader = new FrameReader(AUTH_MAX_FRAME);
  private handlers: Array<(message: unknown) => void> = [];
  /**
   * Messages that came after `link` and before its owner listened (they can share a chunk with the last authentication
   * message): handed to the first `onMessage`.
   */
  private early: unknown[] | null = null;
  private closeHandlers: Array<(reason: string) => void> = [];
  private closed = false;
  private promoted = false;
  private lastHeard = Date.now();
  private lastSent = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(readonly socket: tls.TLSSocket) {
    socket.on("data", (chunk: Buffer) => {
      this.lastHeard = Date.now();
      let messages: unknown[];
      try {
        messages = this.reader.push(chunk);
      } catch {
        return this.close("bad_frame");
      }
      for (const message of messages) {
        if (this.closed) return;
        if (typeof message === "object" && message !== null && (message as { t?: unknown }).t === "ping") continue;
        if (this.early) this.early.push(message);
        else for (const handler of this.handlers) handler(message);
      }
    });
    socket.on("close", () => this.close("socket_closed"));
    socket.on("error", () => this.close("socket_error"));
  }

  /** The other side is a member (or a peer we dialled and checked): full-size frames and heartbeats. */
  promote(): void {
    if (this.promoted || this.closed) return;
    this.promoted = true;
    this.reader.setLimit(MAX_FRAME);
    this.timer = setInterval(() => {
      const now = Date.now();
      if (now - this.lastHeard > SILENCE_LIMIT_MS) return this.close("timeout");
      if (now - this.lastSent > PING_EVERY_MS) this.write({ t: "ping" });
    }, 5_000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  onMessage(handler: (message: unknown) => void): void {
    this.handlers.push(handler);
    const early = this.early ?? [];
    this.early = null;
    for (const message of early) if (!this.closed) handler(message);
  }

  onClose(handler: (reason: string) => void): void {
    if (this.closed) handler("closed");
    else this.closeHandlers.push(handler);
  }

  write(message: unknown): void {
    if (this.closed) return;
    if (this.socket.writableLength > MAX_BUFFERED) return this.close("peer_not_reading");
    this.lastSent = Date.now();
    this.socket.write(encodeFrame(message));
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.socket.destroy();
    for (const handler of this.closeHandlers) handler(reason);
  }

  /** A joining device's link stays limited until the mesh session calls `channel.ready()` (then `onReady` runs). */
  link(remoteDevice: string, direction: "in" | "out", joining: boolean, unverifiedAcceptor?: PeerLink["unverifiedAcceptor"], onReady?: () => void): PeerLink {
    if (!joining) this.promote();
    this.handlers = [];
    this.early = [];
    return {
      remoteDevice,
      remoteAddress: this.socket.remoteAddress ?? "",
      direction,
      joining,
      unverifiedAcceptor,
      channel: {
        send: (message: PeerMessage) => this.write(message),
        close: (reason: string) => this.close(reason),
        widen: () => {
          if (!this.promoted) this.reader.setLimit(PROVEN_MAX_FRAME);
        },
        ready: () => {
          this.promote();
          onReady?.();
        }
      },
      onMessage: (handler) => this.onMessage(handler),
      onClose: (handler) => this.onClose(handler)
    };
  }
}

/** Accepts peer connections on a port. `onPeer` gets each authenticated link. */
export class PeerServer {
  private server: tls.Server;
  private unauthenticated = 0;

  constructor(
    private readonly config: TransportConfig,
    private readonly onPeer: (link: PeerLink) => void,
    private readonly onReject: (reason: string, address: string) => void = () => {}
  ) {
    this.server = tls.createServer({ key: config.tls.keyPem, cert: config.tls.certPem, minVersion: "TLSv1.3", requestCert: false, handshakeTimeout: AUTH_TIMEOUT_MS }, (socket) => this.accept(socket));
    this.server.on("tlsClientError", () => {});
  }

  listen(port: number, host = "0.0.0.0"): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        resolve((this.server.address() as { port: number }).port);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private accept(socket: tls.TLSSocket): void {
    const address = socket.remoteAddress ?? "";
    if (this.unauthenticated >= MAX_UNAUTHENTICATED) {
      socket.destroy();
      return this.onReject("busy", address);
    }
    this.unauthenticated++;
    const wire = new Wire(socket);
    let settled = false;
    let authenticated = false;
    const finish = (reason?: string) => {
      if (settled) return;
      settled = true;
      this.unauthenticated--;
      clearTimeout(deadline);
      if (reason) {
        wire.close(reason);
        this.onReject(reason, address);
      }
    };
    let deadline = setTimeout(() => finish("auth_timeout"), AUTH_TIMEOUT_MS);
    wire.onClose((reason) => finish(reason));
    wire.onMessage((raw) => {
      if (settled || authenticated) return;
      try {
        const message = v.obj(raw, "auth", ["t", "tag", "device", "key", "to", "sig"]);
        if (message.t !== "auth" || message.tag !== workspaceTag(this.config.workspaceId)) return finish("auth_workspace");
        const device = v.id(message.device, "auth.device", "d");
        if (message.to !== undefined && message.to !== this.config.deviceId) return finish("auth_wrong_peer");
        const state = this.config.membership();
        const member = activeDevice(state, device);
        // A device the record lists but no longer counts (revoked, or its user removed) can never be let in again.
        if (!member && state.devices[device]) return finish("revoked");
        const key = member ? member.sign : v.b64(message.key, "auth.key", 32);
        if (!member && deviceIdFor(key) !== device) return finish("auth_key");
        const ekm = exportKeyingMaterial(socket);
        const tag = workspaceTag(this.config.workspaceId);
        // The dialler signs the id it meant to reach ("" when joining and it couldn't know); the keying material binds
        // the signature to this TLS session either way.
        const meant = message.to === undefined ? "" : this.config.deviceId;
        if (!verify(key, "peer-auth", authBytes("hello", ekm, device, meant, tag), v.b64(message.sig, "auth.sig", 64))) return finish("auth_signature");
        wire.write({ t: "auth_ok", device: this.config.deviceId, sig: sign(this.config.deviceKey.secretKey, "peer-auth-ok", authBytes("ok", ekm, device, this.config.deviceId, tag)) });
        authenticated = true;
        if (member) {
          finish();
          this.onPeer(wire.link(device, "in", false));
          return;
        }
        // A joining device: it keeps the small frames, its place in the limited count and a fresh deadline until its
        // join makes it a member and the session starts.
        clearTimeout(deadline);
        deadline = setTimeout(() => finish("join_timeout"), AUTH_TIMEOUT_MS);
        this.onPeer(wire.link(device, "in", true, undefined, () => finish()));
      } catch {
        finish("auth_malformed");
      }
    });
  }
}

/**
 * Dial a peer. With `expect` (a member device), its certificate fingerprint is pinned before anything is sent and its
 * signature is checked. Without it (a joining device that has no record yet), the acceptor's identity comes back
 * in `unverifiedAcceptor`, to be checked with `verifyAcceptor` once the record has been fetched.
 */
export function dial(config: TransportConfig, host: string, port: number, expect?: { device: string; fingerprint: string }): Promise<PeerLink> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.reject(new Error("bad_port"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      reject(new Error(reason));
    };
    const deadline = setTimeout(() => fail("auth_timeout"), AUTH_TIMEOUT_MS);
    // No CA: we check the exact certificate ourselves, right below, before writing anything.
    const socket = tls.connect({ host, port, minVersion: "TLSv1.3", rejectUnauthorized: false, checkServerIdentity: () => undefined });
    socket.once("error", () => fail("connect_failed"));
    socket.once("secureConnect", () => {
      const der = socket.getPeerCertificate(true)?.raw;
      if (!der) return fail("no_certificate");
      const fingerprint = certificateFingerprint(new Uint8Array(der));
      if (expect && fingerprint !== expect.fingerprint) return fail("certificate_mismatch");
      const wire = new Wire(socket);
      const ekm = exportKeyingMaterial(socket);
      const tag = workspaceTag(config.workspaceId);
      wire.onClose((reason) => fail(reason));
      wire.onMessage((raw) => {
        if (settled) return;
        try {
          const message = v.obj(raw, "auth_ok", ["t", "device", "sig"]);
          const acceptor = v.id(message.device, "auth_ok.device", "d");
          const sig = v.b64(message.sig, "auth_ok.sig", 64);
          if (message.t !== "auth_ok") return fail("auth_malformed");
          if (expect) {
            const device = activeDevice(config.membership(), acceptor);
            if (acceptor !== expect.device || !device || !verify(device.sign, "peer-auth-ok", authBytes("ok", ekm, config.deviceId, acceptor, tag), sig)) return fail("auth_signature");
            settled = true;
            clearTimeout(deadline);
            resolve(wire.link(acceptor, "out", false));
          } else {
            settled = true;
            clearTimeout(deadline);
            resolve(wire.link(acceptor, "out", false, { device: acceptor, fingerprint, ekm, sig }));
          }
        } catch {
          fail("auth_malformed");
        }
      });
      wire.write({
        t: "auth",
        tag,
        device: config.deviceId,
        // Always: the other side may not know this device yet (it joined while that one was away).
        key: config.deviceKey.publicKey,
        ...(expect ? { to: expect.device } : {}),
        sig: sign(config.deviceKey.secretKey, "peer-auth", authBytes("hello", ekm, config.deviceId, expect?.device ?? "", tag))
      });
    });
  });
}

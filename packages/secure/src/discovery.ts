import * as dgram from "node:dgram";
import { utf8 } from "./bytes.js";
import { canonicalJson } from "./canonical.js";
import { sign, verify, type KeyPair } from "./crypto.js";
import { workspaceTag } from "./transport.js";
import * as v from "./validate.js";
import { activeDevice, type WorkspaceState } from "./workspace.js";

/**
 * LAN discovery: every peer announces "device D of workspace W listens on port P" by UDP multicast and broadcast.
 * Announcements carry a tag derived from the workspace id (not the id itself) and are signed by the device key;
 * receivers drop anything not signed by a current member or older than two minutes. Even a valid announcement only
 * ever leads to a dial, which then has to pass the certificate pin and the signed exchange.
 */

export const DISCOVERY_PORT = 47879;
export const DISCOVERY_GROUP = "239.255.86.83";
const ANNOUNCE_EVERY_MS = 15_000;
const MAX_AGE_MS = 120_000;
const MAX_PACKETS_PER_SECOND = 100;
/** Per sender address, so one noisy machine can't drown out everyone else's announcements. */
const MAX_PACKETS_PER_SOURCE = 10;

interface AnnouncementBody {
  k: "vr-peer";
  tag: string;
  d: string;
  p: number;
  at: number;
}

export interface Announcement extends AnnouncementBody {
  sig: string;
}

export function makeAnnouncement(workspaceId: string, deviceId: string, deviceKey: KeyPair, port: number, now = Date.now()): Announcement {
  const body: AnnouncementBody = { k: "vr-peer", tag: workspaceTag(workspaceId), d: deviceId, p: port, at: now };
  return { ...body, sig: sign(deviceKey.secretKey, "announce", utf8(canonicalJson(body))) };
}

/** The announcing device and port, or null if the packet isn't a fresh, valid announcement by a member. */
export function readAnnouncement(packet: Buffer, workspaceId: string, state: WorkspaceState, now = Date.now()): { device: string; port: number } | null {
  if (packet.length > 1024) return null;
  try {
    const raw = v.obj(JSON.parse(packet.toString("utf8")), "announce", ["k", "tag", "d", "p", "at", "sig"]);
    if (raw.k !== "vr-peer" || raw.tag !== workspaceTag(workspaceId)) return null;
    const body: AnnouncementBody = { k: "vr-peer", tag: raw.tag, d: v.id(raw.d, "announce.d", "d"), p: v.int(raw.p, "announce.p", 1, 65535), at: v.int(raw.at, "announce.at", 0, Number.MAX_SAFE_INTEGER) };
    if (Math.abs(now - body.at) > MAX_AGE_MS) return null;
    const device = activeDevice(state, body.d);
    if (!device || !verify(device.sign, "announce", utf8(canonicalJson(body)), v.b64(raw.sig, "announce.sig", 64))) return null;
    return { device: body.d, port: body.p };
  } catch {
    return null;
  }
}

export interface DiscoveryOptions {
  workspaceId: string;
  deviceId: string;
  deviceKey: KeyPair;
  /** Our listening port, to announce. */
  port(): number;
  membership(): WorkspaceState;
  onPeer(device: string, host: string, port: number): void;
  discoveryPort?: number;
  group?: string;
}

export class Discovery {
  private socket: dgram.Socket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private windowStart = 0;
  private windowCount = 0;
  private perSource = new Map<string, number>();
  private settleStart: (() => void) | null = null;

  constructor(private readonly options: DiscoveryOptions) {}

  /** Resolves once discovery runs, or has given up because its port can't be used (it is best-effort). */
  start(): Promise<void> {
    return new Promise((resolve) => {
      this.settleStart = resolve;
      const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
      this.socket = socket;
      let bound = false;
      socket.on("error", () => {
        // Discovery is best-effort: peers can still be reached by address. A port that can't be bound ends it here.
        if (bound) return;
        if (this.socket === socket) this.socket = null;
        try {
          socket.close();
        } catch {
          // already closed
        }
        resolve();
      });
      socket.on("message", (packet, rinfo) => this.onPacket(packet, rinfo.address));
      socket.bind(this.options.discoveryPort ?? DISCOVERY_PORT, () => {
        bound = true;
        try {
          socket.setBroadcast(true);
          socket.setMulticastTTL(1);
          socket.addMembership(this.options.group ?? DISCOVERY_GROUP);
        } catch {
          // Multicast unavailable on this network: broadcast still works.
        }
        this.announce();
        this.timer = setInterval(() => this.announce(), ANNOUNCE_EVERY_MS);
        (this.timer as { unref?: () => void }).unref?.();
        resolve();
      });
    });
  }

  announce(): void {
    if (!this.socket) return;
    const packet = Buffer.from(JSON.stringify(makeAnnouncement(this.options.workspaceId, this.options.deviceId, this.options.deviceKey, this.options.port())));
    const port = this.options.discoveryPort ?? DISCOVERY_PORT;
    for (const address of [this.options.group ?? DISCOVERY_GROUP, "255.255.255.255"]) this.socket.send(packet, port, address, () => {});
  }

  private onPacket(packet: Buffer, address: string): void {
    const now = Date.now();
    if (now - this.windowStart > 1000) {
      this.windowStart = now;
      this.windowCount = 0;
      this.perSource.clear();
    }
    const fromSource = (this.perSource.get(address) ?? 0) + 1;
    if (this.perSource.size < 1000) this.perSource.set(address, fromSource);
    if (fromSource > MAX_PACKETS_PER_SOURCE || ++this.windowCount > MAX_PACKETS_PER_SECOND) return;
    const found = readAnnouncement(packet, this.options.workspaceId, this.options.membership(), now);
    if (found && found.device !== this.options.deviceId) this.options.onPeer(found.device, address, found.port);
  }

  stop(): void {
    this.settleStart?.();
    this.settleStart = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.socket?.close();
    this.socket = null;
  }
}

import { fail } from "./errors.js";

/** Messages on a peer connection: a 4-byte big-endian length, then that many bytes of UTF-8 JSON. */

export const MAX_FRAME = 64 << 20;
/** Frames from a device that isn't a member here yet, once it has shown it holds this device's record (see PeerSession). */
export const PROVEN_MAX_FRAME = 16 << 20;

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_FRAME) fail("frame_too_large");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

/**
 * Collects bytes from a stream and yields whole frames. Throws on an oversized frame or bad JSON. Each byte is copied
 * once, straight into the frame it belongs to, so a frame that trickles in a byte at a time costs no more than one
 * that arrives at once.
 */
export class FrameReader {
  private header = Buffer.alloc(4);
  private headerGot = 0;
  private body: Buffer | null = null;
  private bodyGot = 0;

  constructor(private maxFrame = MAX_FRAME) {}

  /** Change the frame size limit (e.g. once the other side is a member). */
  setLimit(maxFrame: number): void {
    this.maxFrame = maxFrame;
  }

  push(chunk: Buffer): unknown[] {
    const out: unknown[] = [];
    let offset = 0;
    while (offset < chunk.length || (this.body !== null && this.bodyGot === this.body.length)) {
      if (this.body === null) {
        const n = Math.min(4 - this.headerGot, chunk.length - offset);
        chunk.copy(this.header, this.headerGot, offset, offset + n);
        this.headerGot += n;
        offset += n;
        if (this.headerGot < 4) break;
        this.headerGot = 0;
        const length = this.header.readUInt32BE(0);
        if (length > this.maxFrame) fail("frame_too_large");
        this.body = Buffer.allocUnsafe(length);
        this.bodyGot = 0;
      }
      const n = Math.min(this.body.length - this.bodyGot, chunk.length - offset);
      chunk.copy(this.body, this.bodyGot, offset, offset + n);
      this.bodyGot += n;
      offset += n;
      if (this.bodyGot < this.body.length) break;
      const body = this.body;
      this.body = null;
      try {
        out.push(JSON.parse(body.toString("utf8")));
      } catch {
        fail("bad_frame");
      }
    }
    return out;
  }
}

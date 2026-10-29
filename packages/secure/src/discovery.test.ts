import { describe, it, vi } from "vitest";
import { Discovery } from "./discovery.js";
import { founder } from "./testkit.js";

// A discovery port that can't be bound (reserved by the system, say): the socket only ever reports an error.
vi.mock("node:dgram", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    createSocket: () => {
      const socket = new EventEmitter() as InstanceType<typeof EventEmitter> & { bind(): void; close(): void };
      socket.bind = () => void setTimeout(() => socket.emit("error", new Error("EACCES")), 0);
      socket.close = () => {};
      return socket;
    }
  };
});

describe("discovery", () => {
  it("gives up quietly when its port can't be used, so starting goes on", async () => {
    const { chain, admin } = founder();
    const discovery = new Discovery({ workspaceId: chain.workspaceId, deviceId: admin.id, deviceKey: admin.sign, port: () => 47880, membership: () => chain.state, onPeer: () => {} });
    await discovery.start();
    discovery.stop();
  });
});

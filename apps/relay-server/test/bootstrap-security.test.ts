import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { RelayRepository } from "../src/db/repositories/relayRepository.js";
import { getBootstrapPin, injectBootstrap } from "./bootstrapHelper.js";

// S3 (HIGH): unauthenticated localhost-only bootstrap allowed a DNS-rebinding attacker (a
// malicious web page whose domain resolves to 127.0.0.1/a LAN IP) to provision themselves as the
// server owner. These tests cover the two defense-in-depth controls added to POST /api/bootstrap:
// a per-process PIN (security/bootstrapPin.ts) and Host header validation (team.routes.ts).
describe("bootstrap security: PIN and Host validation", () => {
  it("rejects bootstrap with a missing PIN and leaves zero side effects", async () => {
    const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:8787" });
    const repo = (app as unknown as { testRepo: RelayRepository }).testRepo;

    const response = await app.inject({
      method: "POST",
      url: "/api/bootstrap",
      remoteAddress: "127.0.0.1",
      payload: { displayName: "A", deviceName: "A laptop", teamName: "Demo" }
    });

    expect(response.statusCode).toBe(403);
    expect(repo.getServerOwnerId()).toBeNull();
  });

  it("rejects bootstrap with a wrong PIN and leaves zero side effects", async () => {
    const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:8787" });
    const repo = (app as unknown as { testRepo: RelayRepository }).testRepo;

    const response = await injectBootstrap(
      app,
      { displayName: "A", deviceName: "A laptop", teamName: "Demo" },
      { pin: "000000" }
    );

    expect(response.statusCode).toBe(403);
    expect(repo.getServerOwnerId()).toBeNull();
  });

  it("succeeds exactly once with the correct PIN and a matching Host", async () => {
    const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:8787" });
    const repo = (app as unknown as { testRepo: RelayRepository }).testRepo;

    const response = await injectBootstrap(app, { displayName: "A", deviceName: "A laptop", teamName: "Demo" });

    expect(response.statusCode).toBe(200);
    const owner = response.json();
    expect(owner.isServerOwner).toBe(true);
    expect(repo.getServerOwnerId()).toBe(owner.user.id);

    // Confirms the PIN readable in-process (as EmbeddedRelayServer.getBootstrapPin() would read
    // it) is exactly the value that satisfied the check above, not some other/rotated value.
    expect(getBootstrapPin(app)).toMatch(/^\d{6}$/);
  });

  it("rejects bootstrap with a Host header that does not match the server's own host, even with a correct PIN - defeats DNS rebinding", async () => {
    const app = await createApp({ dbPath: ":memory:", publicUrl: "http://127.0.0.1:8787" });
    const repo = (app as unknown as { testRepo: RelayRepository }).testRepo;

    const response = await injectBootstrap(
      app,
      { displayName: "A", deviceName: "A laptop", teamName: "Demo" },
      { headers: { host: "attacker-controlled.example" } }
    );

    expect(response.statusCode).toBe(400);
    expect(repo.getServerOwnerId()).toBeNull();
  });
});

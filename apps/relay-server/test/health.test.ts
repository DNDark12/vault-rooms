import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("health", () => {
  it("returns Vault Rooms identity", async () => {
    const app = await createApp();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(response.json()).toEqual({ ok: true, name: "vault-rooms", version: "0.1.0" });
  });

  it("handles browser preflight requests", async () => {
    const app = await createApp();
    const response = await app.inject({ method: "OPTIONS", url: "/api/bootstrap" });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-methods"]).toContain("POST");
    expect(response.headers["access-control-allow-headers"]).toContain("authorization");
  });

  it("declares every HTTP method a route actually uses in the preflight allow-list", async () => {
    // A real browser (Obsidian's Electron renderer) rejects the request outright - surfacing as a
    // generic "Failed to fetch" with no server-side trace - if the method isn't in this list, even
    // though the OPTIONS preflight itself still returns 204. Fastify's inject()/Node's fetch don't
    // enforce this, so a missing method here only breaks in production, never in this test suite,
    // unless asserted explicitly. PATCH is used by PUT /api/rooms/:roomId's update-room-settings
    // flow (apiClient.updateRoom); keep this list in sync with every app.<method>(...) registered.
    const app = await createApp();
    const response = await app.inject({ method: "OPTIONS", url: "/api/rooms/room_x" });

    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      expect(response.headers["access-control-allow-methods"]).toContain(method);
    }
  });
});

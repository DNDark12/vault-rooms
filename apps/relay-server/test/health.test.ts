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
});

import { describe, expect, it } from "vitest";
import { choosePort, resolveRuntimeConfig } from "../src/config.js";
import * as standalone from "../src/index.js";

const { assertPinnedStartupState } = standalone;

describe("port fallback", () => {
  it("uses the first free fallback port when PORT is not set", async () => {
    const port = await choosePort({}, async (candidate) => candidate !== 8787);

    expect(port).toBe(8788);
  });

  it("throws a clear error when explicit PORT is busy", async () => {
    await expect(choosePort({ PORT: "8787" }, async () => false)).rejects.toThrow(
      "PORT=8787 is already in use"
    );
  });

  it("uses a free preferred port before scanning fallback ports", async () => {
    const checkedPorts: number[] = [];
    const port = await choosePort(
      {},
      async (candidate) => {
        checkedPorts.push(candidate);
        return candidate === 8790;
      },
      8790
    );

    expect(port).toBe(8790);
    expect(checkedPorts).toEqual([8790]);
  });

  it("falls back to the first free fallback port when the preferred port is busy", async () => {
    const port = await choosePort(
      {},
      async (candidate) => candidate === 8788,
      8790
    );

    expect(port).toBe(8788);
  });

  it("uses explicit PORT even when a preferred port is provided", async () => {
    const checkedPorts: number[] = [];
    const port = await choosePort(
      { PORT: "8789" },
      async (candidate) => {
        checkedPorts.push(candidate);
        return candidate === 8789;
      },
      8790
    );

    expect(port).toBe(8789);
    expect(checkedPorts).toEqual([8789]);
    await expect(choosePort({ PORT: "8789" }, async () => false, 8790)).rejects.toThrow(
      "PORT=8789 is already in use"
    );
  });
});

describe("TLS runtime config", () => {
  it("checks only the TLS port for HTTPS-only pinned mode", async () => {
    const checkedPorts: number[] = [];
    const config = await resolveRuntimeConfig(
      {
        PORT: "8787",
        TLS_MODE: "pinned",
        TLS_PORT: "9443"
      },
      undefined,
      async (candidate) => {
        checkedPorts.push(candidate);
        return candidate === 9443;
      }
    );

    expect(config).toMatchObject({ port: 8787, tlsPort: 9443, tlsDualStack: false });
    expect(checkedPorts).toEqual([9443]);
  });

  it("checks only the TLS port for OS-trusted mode", async () => {
    const checkedPorts: number[] = [];
    const config = await resolveRuntimeConfig(
      {
        PORT: "8787",
        TLS_MODE: "os-trusted",
        TLS_PORT: "9443"
      },
      undefined,
      async (candidate) => {
        checkedPorts.push(candidate);
        return candidate === 9443;
      }
    );

    expect(config).toMatchObject({ port: 8787, tlsPort: 9443, tlsDualStack: false });
    expect(checkedPorts).toEqual([9443]);
  });

  it("checks both bound ports for pinned dual-stack mode", async () => {
    const checkedPorts: number[] = [];
    await resolveRuntimeConfig(
      {
        PORT: "8787",
        TLS_MODE: "pinned",
        TLS_PORT: "8788",
        TLS_DUAL_STACK: "true"
      },
      undefined,
      async (candidate) => {
        checkedPorts.push(candidate);
        return true;
      }
    );

    expect(checkedPorts).toEqual([8787, 8788]);
  });

  it("resolves pinned dual-stack settings without changing the legacy HTTP port", async () => {
    const config = await resolveRuntimeConfig(
      {
        HOST: "127.0.0.1",
        PORT: "8787",
        TLS_MODE: "pinned",
        TLS_PORT: "8788",
        TLS_DUAL_STACK: "true",
        TLS_MIGRATION_MODE: "strict",
        IDENTITY_DIR: "custom-identity"
      },
      undefined,
      async () => true
    );

    expect(config).toMatchObject({
      port: 8787,
      tlsMode: "pinned",
      tlsPort: 8788,
      tlsDualStack: true,
      tlsMigrationMode: "strict",
      identityDir: "custom-identity",
      publicUrl: "https://127.0.0.1:8788"
    });
  });

  it("defaults to plain mode and rejects an unknown TLS mode", async () => {
    const plain = await resolveRuntimeConfig({}, undefined, async () => true);
    expect(plain.tlsMode).toBe("plain");
    expect(plain.tlsDualStack).toBe(false);

    await expect(
      resolveRuntimeConfig({ TLS_MODE: "unsafe" }, undefined, async () => true)
    ).rejects.toThrow("Invalid TLS_MODE");
  });

  it("rejects an unknown standalone TLS migration mode", async () => {
    await expect(
      resolveRuntimeConfig({ TLS_MODE: "pinned", TLS_DUAL_STACK: "true", TLS_MIGRATION_MODE: "unsafe" }, undefined, async () => true)
    ).rejects.toThrow("Invalid TLS_MIGRATION_MODE");
  });

  it("rejects unsupported OS-trusted dual-stack configuration", async () => {
    await expect(
      resolveRuntimeConfig({ TLS_MODE: "os-trusted", TLS_DUAL_STACK: "true" }, undefined, async () => true)
    ).rejects.toThrow("TLS_DUAL_STACK is supported only with TLS_MODE=pinned");
  });

  it("refuses pinned HTTPS-only startup while legacy clients still need HTTP migration", () => {
    expect(() => assertPinnedStartupState("plain_legacy", false)).toThrow("TLS_DUAL_STACK=true");
    expect(() => assertPinnedStartupState("tls_migrating", false)).toThrow("TLS_DUAL_STACK=true");
    expect(() => assertPinnedStartupState("pinned_tls", false)).not.toThrow();
    expect(() => assertPinnedStartupState("tls_enforced", false)).not.toThrow();
    expect(() => assertPinnedStartupState("pinned_tls", true)).toThrow("HTTPS-only");
    expect(() => assertPinnedStartupState("tls_enforced", true)).toThrow("HTTPS-only");
  });

  it("derives explicit standalone migration and enforcement transitions without exposing fresh pinned servers over HTTP", () => {
    const transition = (standalone as unknown as {
      resolvePinnedStartupState?: (state: string, dualStack: boolean, hasOwner: boolean) => string;
    }).resolvePinnedStartupState;
    expect(transition).toBeTypeOf("function");

    expect(transition!("plain_legacy", false, false)).toBe("pinned_tls");
    expect(() => transition!("plain_legacy", true, false)).toThrow("fresh pinned");
    expect(transition!("plain_legacy", true, true)).toBe("tls_migrating");
    expect(() => transition!("plain_legacy", false, true)).toThrow("TLS_DUAL_STACK=true");
    expect(transition!("tls_migrating", true, true)).toBe("tls_migrating");
    expect(transition!("tls_migrating", false, true)).toBe("tls_enforced");
    expect(() => transition!("pinned_tls", true, true)).toThrow("HTTPS-only");
    expect(() => transition!("tls_enforced", true, true)).toThrow("HTTPS-only");
  });
});

describe("byte-limit env var validation (Phase A review fix - P1)", () => {
  it.each([
    ["non-numeric", "garbage"],
    ["trailing garbage after digits", "1junk"],
    ["zero", "0"],
    ["negative", "-5242880"],
    ["a decimal", "5242880.5"],
    ["empty string", ""]
  ])("rejects MAX_STORED_CONTENT_BYTES=%s (%s) at startup instead of silently disabling the quota", async (_label, value) => {
    // Number.parseInt(value, 10) alone would return NaN/a truncated number/a negative number for
    // these, and Math.max(currentUsage, NaN) is NaN - every quota comparison against NaN is false,
    // so the check would silently become a permanent no-op instead of failing loudly.
    await expect(resolveRuntimeConfig({ MAX_STORED_CONTENT_BYTES: value }, undefined, async () => true)).rejects.toThrow(
      `Invalid MAX_STORED_CONTENT_BYTES value: ${value}`
    );
  });

  it("rejects an equally invalid MAX_FILE_BYTES the same way", async () => {
    await expect(resolveRuntimeConfig({ MAX_FILE_BYTES: "garbage" }, undefined, async () => true)).rejects.toThrow(
      "Invalid MAX_FILE_BYTES value: garbage"
    );
  });

  it("still accepts a valid MAX_STORED_CONTENT_BYTES and leaves the default in place when unset", async () => {
    const withEnv = await resolveRuntimeConfig({ MAX_STORED_CONTENT_BYTES: "1048576" }, undefined, async () => true);
    expect(withEnv.maxStoredContentBytes).toBe(1048576);

    const withoutEnv = await resolveRuntimeConfig({}, undefined, async () => true);
    expect(withoutEnv.maxStoredContentBytes).toBe(268435456);
    expect(withoutEnv.maxFileBytes).toBe(5242880);
  });
});

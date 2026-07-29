import { describe, expect, it } from "vitest";
import { userFacingError } from "./errorMessages.js";

// User-facing error messages (docs/superpowers/plans/2026-07-29-user-facing-error-messages.md).
// This helper sits at display sinks only. Everything upstream of it - apiClient's error
// normalization, pinned-TLS recovery, connectionDiagnostics' evidence, console logging - keeps the
// raw error, because that is what makes a failure diagnosable after the fact.
describe("userFacingError", () => {
  it("uses usable server prose", () => {
    // The relay is the primary source of wording: it knows which of ~30 VALIDATION_ERROR situations
    // actually happened, which a code-keyed table here never could.
    expect(
      userFacingError(
        { code: "PERMISSION_DENIED", message: "You don't have permission to read this file." },
        "Action failed."
      )
    ).toBe("You don't have permission to read this file.");
  });

  it("maps a bare code in either code or message", () => {
    expect(userFacingError({ code: "PERMISSION_DENIED" }, "Action failed.")).toBe(
      "You don't have permission to do that in this room."
    );
    // A code arriving *as* the message is the shape that actually reached users: some frames carry a
    // code and no prose, and the notice then printed the identifier verbatim.
    expect(userFacingError(new Error("PERMISSION_DENIED"), "Action failed.")).toBe(
      "You don't have permission to do that in this room."
    );
    expect(userFacingError("PERMISSION_DENIED", "Action failed.")).toBe(
      "You don't have permission to do that in this room."
    );
  });

  it("preserves a useful thrown string", () => {
    expect(userFacingError("The server closed the connection.", "Action failed.")).toBe(
      "The server closed the connection."
    );
  });

  it("uses the caller fallback for an unknown code", () => {
    // Forward compatibility: a newer relay's code must degrade to the call site's own wording rather
    // than surfacing an identifier this build has never heard of.
    expect(userFacingError({ code: "FUTURE_CODE" }, "Action failed.")).toBe("Action failed.");
  });

  it("never renders a plain object as object Object", () => {
    // `String(error)` on a non-Error throw produced "[object Object]" in ~12 notices.
    const result = userFacingError({ unexpected: true }, "Action failed.");
    expect(result).toBe("Action failed.");
    expect(result).not.toContain("[object Object]");
  });

  it("never resolves an inherited Object property as a message", () => {
    // The code is untrusted wire input. A prototype-chain lookup (`in`) resolves these to functions,
    // so a hostile or buggy relay could make this helper return a *function* where every caller - every
    // Notice, every panel field - has been told it gets a string.
    for (const code of ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__", "prototype"]) {
      const result = userFacingError({ code }, "Action failed.");
      expect(typeof result, `${code} did not resolve to a string`).toBe("string");
      expect(result, `${code} leaked an inherited property`).toBe("Action failed.");
    }
    // Same guard on the code-as-message path.
    expect(userFacingError("constructor", "Action failed.")).toBe("constructor");
    expect(typeof userFacingError({ code: "constructor", message: "constructor" }, "Action failed.")).toBe("string");
  });

  // Transport failures never carry a relay ErrorCode - they come from Electron's network stack
  // (`net::ERR_*`) or Node (`ECONNREFUSED` and friends). They are machine tokens, but they do NOT match
  // the SCREAMING_SNAKE code shape (`net::…` starts lowercase; Node codes arrive embedded in prose like
  // "connect ECONNREFUSED 192.168.1.5:8787"), so they used to sail through as "usable prose" and land in
  // a Notice verbatim - which is what a user reported seeing.
  it("translates Electron and Node transport codes into guidance", () => {
    const cases: Array<[unknown, RegExp]> = [
      [new Error("net::ERR_CONNECTION_REFUSED"), /server may be stopped|address or port/i],
      [new Error("net::ERR_ADDRESS_UNREACHABLE"), /same network|can't be reached/i],
      [new Error("net::ERR_NAME_NOT_RESOLVED"), /couldn't be looked up|typo/i],
      [new Error("net::ERR_CONNECTION_TIMED_OUT"), /didn't respond in time/i],
      [new Error("net::ERR_UNSAFE_PORT"), /port/i],
      [new Error("net::ERR_CERT_AUTHORITY_INVALID"), /certificate/i],
      [{ code: "ECONNREFUSED" }, /server may be stopped|address or port/i],
      [new Error("connect ECONNREFUSED 192.168.1.5:8787"), /server may be stopped|address or port/i],
      [new Error("getaddrinfo ENOTFOUND relay.local"), /couldn't be looked up|typo/i],
      [new Error("DEPTH_ZERO_SELF_SIGNED_CERT"), /certificate/i]
    ];

    for (const [thrown, expected] of cases) {
      const result = userFacingError(thrown, "Action failed.");
      expect(result, `unexpected text for ${JSON.stringify(thrown)}`).toMatch(expected);
      expect(result).not.toContain("net::");
      expect(result).not.toMatch(/\bE[A-Z]{4,}\b/);
    }
  });

  it("does not mistake ordinary prose or relay wording for a transport code", () => {
    // The transport layer must not swallow real sentences, including ones that mention a network.
    expect(userFacingError(new Error("The server closed the connection."), "Action failed.")).toBe(
      "The server closed the connection."
    );
    expect(userFacingError({ code: "PERMISSION_DENIED", message: "You don't have permission to read this file." }, "x")).toBe(
      "You don't have permission to read this file."
    );
    expect(userFacingError(new Error("Request timed out."), "Action failed.")).toBe("Request timed out.");
  });

  it("falls back for null, undefined, and blank messages", () => {
    expect(userFacingError(undefined, "Action failed.")).toBe("Action failed.");
    expect(userFacingError(null, "Action failed.")).toBe("Action failed.");
    expect(userFacingError({ message: "   " }, "Action failed.")).toBe("Action failed.");
    expect(userFacingError(new Error(""), "Action failed.")).toBe("Action failed.");
  });

  it("covers every ErrorCode the protocol defines", async () => {
    // A new ErrorCode with no entry would silently fall through to a generic caller fallback. The
    // `satisfies Record<ErrorCode, string>` in the module is the compile-time half of this guard;
    // this is the half that proves the table is reachable and non-empty at runtime.
    const fs = await import("node:fs");
    const errorsSource = fs.readFileSync(new URL("../../../packages/protocol/src/errors.ts", import.meta.url), "utf8");
    const codes = [...errorsSource.matchAll(/^\s*\|\s*"([A-Z_]+)"/gm)].map((match) => match[1]!);

    expect(codes.length).toBeGreaterThan(10);
    for (const code of codes) {
      const message = userFacingError({ code }, "UNREACHED FALLBACK");
      expect(message, `${code} has no catalog entry`).not.toBe("UNREACHED FALLBACK");
      expect(message, `${code} still reads as a wire code`).not.toMatch(/^[A-Z][A-Z0-9_]{2,}$/);
    }
  });
});

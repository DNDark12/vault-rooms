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

import { describe, expect, it } from "vitest";
import { AppError } from "./errors.js";
import { normalizeRelativePath } from "./paths.js";

// User-facing error messages (docs/superpowers/plans/2026-07-29-user-facing-error-messages.md).
// These messages are not internal parser diagnostics: they cross the REST/WS error envelope and land
// in an Obsidian Notice, so they describe what the user should pick instead of restating the
// path-normalization rule that rejected the input. The INVALID_PATH code carries the machine meaning.
describe("path error prose", () => {
  it("does not expose path-parser vocabulary", () => {
    expect(() => normalizeRelativePath("../Secret.md")).toThrowError(
      "That path contains a hidden or unsupported folder."
    );
    expect(() => normalizeRelativePath(".hidden/Note.md")).toThrowError(
      "That path contains a hidden or unsupported folder."
    );
    expect(() => normalizeRelativePath("")).toThrowError("Choose a file or folder inside the shared room.");
    expect(() => normalizeRelativePath(`${"a".repeat(300)}/Note.md`)).toThrowError(
      "One folder or file name in this path is too long."
    );
  });

  it("keeps the INVALID_PATH code and 422 status intact", () => {
    // Prose changed; behaviour did not. Clients branch on the code, never the sentence.
    for (const input of ["../Secret.md", "", `${"a".repeat(300)}/Note.md`]) {
      try {
        normalizeRelativePath(input);
        expect.unreachable(`expected ${JSON.stringify(input)} to be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("INVALID_PATH");
        expect((error as AppError).statusCode).toBe(422);
      }
    }
  });

  it("still accepts an ordinary relative path", () => {
    expect(normalizeRelativePath("Notes/Board.md")).toBe("Notes/Board.md");
    expect(normalizeRelativePath("Notes\\Board.md")).toBe("Notes/Board.md");
  });
});

import { describe, expect, it } from "vitest";
import { AppError } from "./errors.js";
import {
  contentTypeForPath,
  isCrdtEligiblePath,
  isEligiblePath,
  isLegacyEligiblePath,
  isValidBase64,
  isValidUtf8,
  normalizeRelativePath
} from "./paths.js";

describe("isValidUtf8", () => {
  it("accepts UTF-8 text and rejects bytes in any other encoding", () => {
    expect(isValidUtf8(new TextEncoder().encode("plain, café, 漢字, 🎉"))).toBe(true);
    expect(isValidUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe(true); // BOM + "a"
    expect(isValidUtf8(new Uint8Array([]))).toBe(true);
    // "café" as Windows-1252: a lone 0xE9 is not UTF-8.
    expect(isValidUtf8(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBe(false);
  });
});

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

describe("file-sync and CRDT lane boundaries", () => {
  it("syncs every regular extension while keeping CRDT on genuine Markdown notes only", () => {
    expect(isEligiblePath("Notes/Board.md")).toBe(true);
    expect(isEligiblePath("attachments/report.docx")).toBe(true);
    expect(isEligiblePath("attachments/video.mp4")).toBe(true);
    expect(isEligiblePath("LICENSE")).toBe(true);

    expect(isCrdtEligiblePath("Notes/Board.md")).toBe(true);
    expect(isCrdtEligiblePath("Notes/Board.MD")).toBe(true);
    expect(isCrdtEligiblePath("Drawings/scene.excalidraw.md")).toBe(false);
    expect(isCrdtEligiblePath("data.csv")).toBe(false);
    expect(isCrdtEligiblePath("attachments/report.docx")).toBe(false);
  });

  it("uses UTF-8 only for known text formats and defaults unknown formats to binary", () => {
    expect(contentTypeForPath("Notes/Board.md")).toBe("markdown");
    expect(contentTypeForPath("table.csv")).toBe("text");
    expect(contentTypeForPath("drawing.excalidraw")).toBe("text");
    expect(contentTypeForPath("attachment.docx")).toBe("binary");
    expect(contentTypeForPath("LICENSE")).toBe("binary");
  });

  it("keeps widened-only paths hidden from legacy clients", () => {
    expect(isLegacyEligiblePath("cover.png")).toBe(true);
    expect(isLegacyEligiblePath("Board.md")).toBe(true);
    expect(isLegacyEligiblePath("attachment.docx")).toBe(false);
    expect(isLegacyEligiblePath("LICENSE")).toBe(false);
  });

  it("accepts canonical base64 and rejects malformed binary payloads", () => {
    expect(isValidBase64("")).toBe(true);
    expect(isValidBase64("AQID")).toBe(true);
    expect(isValidBase64("AQI=")).toBe(true);
    expect(isValidBase64("not base64!")).toBe(false);
    expect(isValidBase64("A===")).toBe(false);
  });
});

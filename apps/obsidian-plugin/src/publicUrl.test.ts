import { describe, expect, it } from "vitest";
import { withPort } from "./publicUrl.js";

describe("withPort", () => {
  it("fills in the port when the override omits one", () => {
    expect(withPort("http://192.168.1.42", 8787)).toBe("http://192.168.1.42:8787");
  });

  it("leaves an explicit port untouched", () => {
    expect(withPort("http://192.168.1.42:9000", 8787)).toBe("http://192.168.1.42:9000");
  });

  it("drops any path/query the user typed by mistake, keeping only the origin", () => {
    expect(withPort("http://192.168.1.42/some/path?x=1", 8787)).toBe("http://192.168.1.42:8787");
  });

  it("does not add a trailing slash", () => {
    expect(withPort("http://192.168.1.42", 8787).endsWith("/")).toBe(false);
  });

  it("returns the input unchanged if it isn't a valid URL at all", () => {
    expect(withPort("192.168.1.42", 8787)).toBe("192.168.1.42");
  });
});

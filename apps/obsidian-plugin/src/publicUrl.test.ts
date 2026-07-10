import { describe, expect, it } from "vitest";
import { withPort } from "./publicUrl.js";

describe("withPort", () => {
  it("fills in the port when the override omits one", () => {
    expect(withPort("http://192.168.1.100", 8787)).toBe("http://192.168.1.100:8787");
  });

  it("leaves an explicit port untouched", () => {
    expect(withPort("http://192.168.1.100:9000", 8787)).toBe("http://192.168.1.100:9000");
  });

  it("drops any path/query the user typed by mistake, keeping only the origin", () => {
    expect(withPort("http://192.168.1.100/some/path?x=1", 8787)).toBe("http://192.168.1.100:8787");
  });

  it("does not add a trailing slash", () => {
    expect(withPort("http://192.168.1.100", 8787).endsWith("/")).toBe(false);
  });

  it("adds both the scheme and the port when the user typed a bare IP", () => {
    expect(withPort("192.168.1.100", 8787)).toBe("http://192.168.1.100:8787");
  });

  it("adds the scheme but keeps an explicit port when the user typed a bare IP:port", () => {
    expect(withPort("192.168.1.100:9000", 8787)).toBe("http://192.168.1.100:9000");
  });

  it("never invents a scheme other than http", () => {
    expect(withPort("https://192.168.1.100", 8787)).toBe("https://192.168.1.100:8787");
  });

  it("returns the input unchanged if it still isn't a valid URL with a scheme prepended", () => {
    expect(withPort("", 8787)).toBe("");
    expect(withPort("not a url", 8787)).toBe("not a url");
  });
});

import { describe, expect, it } from "vitest";
import { PRODUCT_NAME, PRODUCT_VERSION } from "./index.js";

describe("protocol metadata", () => {
  it("uses the v0.1 product identity", () => {
    expect(PRODUCT_NAME).toBe("vault-rooms");
    expect(PRODUCT_VERSION).toBe("0.1.0");
  });
});

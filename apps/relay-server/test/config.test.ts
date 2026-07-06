import { describe, expect, it } from "vitest";
import { choosePort } from "../src/config.js";

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
});

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

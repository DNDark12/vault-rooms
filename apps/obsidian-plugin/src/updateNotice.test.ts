import { beforeEach, describe, expect, it, vi } from "vitest";
import { notifyIfUpdateAvailable } from "./updateNotice.js";

const mocks = vi.hoisted(() => ({
  notices: [] as string[],
  requestUrl: vi.fn()
}));

vi.mock("obsidian", () => ({
  Notice: class Notice {
    constructor(message: string) {
      mocks.notices.push(message);
    }
  },
  requestUrl: mocks.requestUrl
}));

beforeEach(() => {
  mocks.notices.length = 0;
  mocks.requestUrl.mockReset();
});

describe("notifyIfUpdateAvailable", () => {
  it("shows the installed and latest versions when a newer stable release is published", async () => {
    mocks.requestUrl.mockResolvedValue({ status: 200, json: { tag_name: "0.2.6" } });

    await notifyIfUpdateAvailable("0.2.5");

    expect(mocks.notices).toEqual([
      "A newer version of Vault Rooms is available in Community Plugins.\n\nYou are using 0.2.5.\nThe latest is 0.2.6."
    ]);
  });

  it.each(["0.2.5", "0.2.4", "v0.2.5"])("stays silent when the latest tag is %s", async (tagName) => {
    mocks.requestUrl.mockResolvedValue({ status: 200, json: { tag_name: tagName } });

    await notifyIfUpdateAvailable("0.2.5");

    expect(mocks.notices).toEqual([]);
  });

  it("stays silent for malformed release data", async () => {
    mocks.requestUrl.mockResolvedValue({ status: 200, json: { tag_name: "next" } });

    await notifyIfUpdateAvailable("0.2.5");

    expect(mocks.notices).toEqual([]);
  });

  it("stays silent when the update request fails", async () => {
    mocks.requestUrl.mockRejectedValue(new Error("offline"));

    await expect(notifyIfUpdateAvailable("0.2.5")).resolves.toBeUndefined();
    expect(mocks.notices).toEqual([]);
  });
});

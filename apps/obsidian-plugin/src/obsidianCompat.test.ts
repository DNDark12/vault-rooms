import { describe, expect, it, vi } from "vitest";
import { refreshSettingTab, setDestructiveCompat } from "./obsidianCompat.js";

describe("Obsidian API compatibility", () => {
  it("uses the 1.13 destructive API when it exists", () => {
    const addClass = vi.fn();
    const setDestructive = vi.fn();
    const button = { buttonEl: { addClass }, setDestructive };

    expect(setDestructiveCompat(button)).toBe(button);
    expect(setDestructive).toHaveBeenCalledOnce();
    expect(addClass).not.toHaveBeenCalled();
  });

  it("keeps destructive styling on pre-1.13 runtimes", () => {
    const addClass = vi.fn();
    const button = { buttonEl: { addClass } };

    expect(setDestructiveCompat(button)).toBe(button);
    expect(addClass).toHaveBeenCalledWith("mod-warning");
  });

  it("refreshes through update on 1.13 without running the legacy renderer", () => {
    const update = vi.fn();
    const renderLegacy = vi.fn();
    const containerEl = {};

    refreshSettingTab({ update, containerEl }, renderLegacy);

    expect(update).toHaveBeenCalledOnce();
    expect(renderLegacy).not.toHaveBeenCalled();
  });

  it("renders directly when a pre-1.13 runtime has no update method", () => {
    const renderLegacy = vi.fn();
    const containerEl = {};

    refreshSettingTab({ containerEl }, renderLegacy);

    expect(renderLegacy).toHaveBeenCalledWith(containerEl);
  });
});

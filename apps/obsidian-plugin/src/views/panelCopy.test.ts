import { describe, expect, it } from "vitest";
import { HOSTING_STATUS_COPY } from "../onboarding.js";
import { PANEL_COPY } from "./panelCopy.js";

describe("panel copy contract", () => {
  it("keeps hosting and connection not-set-up labels distinct", () => {
    expect(HOSTING_STATUS_COPY.notSetUp).toBe("Not sharing yet");
  });

  it("uses plain words throughout visible panel copy", () => {
    const visibleCopy = JSON.stringify(PANEL_COPY);
    expect(visibleCopy).not.toMatch(/\b(?:mount|unmount|grant|shared space)\b/i);
    expect(PANEL_COPY.room.add).toBe("Add to this computer");
    expect(PANEL_COPY.room.remove).toBe("Remove from this computer");
    expect(PANEL_COPY.room.needsChoice(2)).toBe("2 files need a choice");
  });
});

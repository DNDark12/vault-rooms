import { describe, expect, it } from "vitest";
import { hostingOnboardingPresentation } from "./onboardingPresentation.js";

describe("hosting onboarding presentation", () => {
  it("offers one guided action for a fresh host", () => {
    expect(
      hostingOnboardingPresentation({
        hasOwnServer: false,
        running: false,
        bootstrapped: false
      })
    ).toEqual({
      status: "Not sharing yet",
      description: "Set up sharing from this computer in four guided steps.",
      action: "setup"
    });
  });

  it("routes missing local credentials to recovery", () => {
    expect(
      hostingOnboardingPresentation({
        hasOwnServer: false,
        running: true,
        bootstrapped: true
      })
    ).toMatchObject({
      status: "Locked out on this computer",
      action: "recover"
    });
  });

  it("keeps normal start and stop actions for an existing owner", () => {
    expect(
      hostingOnboardingPresentation({
        hasOwnServer: true,
        running: false,
        bootstrapped: true
      })
    ).toMatchObject({ status: "Hosting paused", action: "start" });
    expect(
      hostingOnboardingPresentation({
        hasOwnServer: true,
        running: true,
        bootstrapped: true
      })
    ).toMatchObject({ status: "Hosting", action: "stop" });
  });
});

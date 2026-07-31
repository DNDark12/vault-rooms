import { HOSTING_STATUS_COPY } from "../onboarding.js";

export type HostingAction = "setup" | "recover" | "start" | "stop";

export function hostingOnboardingPresentation(input: {
  hasOwnServer: boolean;
  running: boolean;
  bootstrapped: boolean;
}): { status: string; description: string; action: HostingAction } {
  if (!input.hasOwnServer && input.bootstrapped) {
    return {
      status: HOSTING_STATUS_COPY.recovery,
      description: "This server already has data. Recover its owner access without resetting it.",
      action: "recover"
    };
  }
  if (!input.hasOwnServer) {
    return {
      status: HOSTING_STATUS_COPY.notSetUp,
      description: "Set up sharing from this computer in four guided steps.",
      action: "setup"
    };
  }
  return input.running
    ? {
        status: HOSTING_STATUS_COPY.running,
        description: "This computer is hosting shared rooms.",
        action: "stop"
      }
    : {
        status: HOSTING_STATUS_COPY.stopped,
        description: "Start this computer's server to resume sharing.",
        action: "start"
      };
}

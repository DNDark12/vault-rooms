import { RelayApiClient } from "./apiClient.js";
import { userFacingError } from "./errorMessages.js";
import { classifyLanAddress } from "./lanAddress.js";
import type { PinnedServerInfo } from "./pinnedTransport.js";

export type LanShareProbeTarget = {
  baseUrl: string;
  pin?: PinnedServerInfo;
};

export type LanShareReachability =
  | { status: "unavailable" }
  | { key: string; baseUrl: string; status: "checking" }
  /** `warning` carries an address that works but is worth flagging (e.g. a self-assigned 169.254.x, which
   *  only reaches teammates on the same direct link and changes whenever the network does). */
  | { key: string; baseUrl: string; status: "reachable"; warning?: string }
  | { key: string; baseUrl: string; status: "unreachable"; error: string }
  /** The address can't work for a teammate no matter what the probe says - see `classifyLanAddress`.
   *  Kept separate from "unreachable" because probing it would *succeed* and report the opposite. */
  | { key: string; baseUrl: string; status: "not-a-lan-address"; error: string };

export type LanSharePresentation = {
  label: string;
  className: "is-running" | "is-connecting" | "is-stopped";
};

export function lanSharePresentation(state: LanShareReachability): LanSharePresentation | null {
  switch (state.status) {
    case "checking":
      return { label: "LAN share: checking…", className: "is-connecting" };
    case "reachable":
      return state.warning
        ? { label: "LAN share: reachable, with a caveat", className: "is-connecting" }
        : { label: "LAN share: reachable from this device", className: "is-running" };
    case "unreachable":
      return { label: "LAN share: unreachable", className: "is-stopped" };
    case "not-a-lan-address":
      // Deliberately different wording from "unreachable": this address *is* reachable from here, which is
      // exactly why it used to show green and mislead the host into sending a useless invite.
      return { label: "LAN share: not a LAN address", className: "is-stopped" };
    case "unavailable":
      return null;
  }
}

export async function probeLanShareTarget(target: LanShareProbeTarget): Promise<void> {
  await new RelayApiClient(target.baseUrl, undefined, undefined, target.pin).testConnection();
}

export class LanShareReachabilityMonitor {
  private state: LanShareReachability = { status: "unavailable" };
  private generation = 0;

  constructor(
    private readonly probe: (target: LanShareProbeTarget) => Promise<void> = probeLanShareTarget,
    private readonly onChange: () => void = () => undefined
  ) {}

  getState(): LanShareReachability {
    return this.state;
  }

  clear(): void {
    this.generation += 1;
    this.state = { status: "unavailable" };
    this.onChange();
  }

  check(target?: LanShareProbeTarget, force = false): void {
    if (!target) {
      if (this.state.status !== "unavailable") {
        this.clear();
      }
      return;
    }
    const key = targetKey(target);
    if (!force && "key" in this.state && this.state.key === key) {
      return;
    }
    void this.run(target, key, false).catch(() => undefined);
  }

  async require(target?: LanShareProbeTarget): Promise<void> {
    if (!target) {
      if (this.state.status !== "unavailable") {
        this.clear();
      }
      throw new Error(
        "LAN share URL is unavailable. Set Public URL override to this device's reachable LAN address before creating an invite."
      );
    }
    await this.run(target, targetKey(target), true);
  }

  private async run(target: LanShareProbeTarget, key: string, required: boolean): Promise<void> {
    const generation = ++this.generation;
    // Judge the address before probing it. A loopback address passes a probe from this machine and fails
    // for every teammate, so probing first would report success and actively mislead - the failure then
    // showed up on the teammate's device as "can't connect", where they could neither see nor fix it.
    const verdict = classifyLanAddress(target.baseUrl);
    if (!verdict.usableForTeammates) {
      const error = verdict.problem ?? "That address can't be used by a teammate.";
      this.state = { key, baseUrl: target.baseUrl, status: "not-a-lan-address", error };
      this.onChange();
      if (required) {
        throw new Error(`LAN share URL can't be used by a teammate. ${error}`);
      }
      return;
    }
    this.state = { key, baseUrl: target.baseUrl, status: "checking" };
    this.onChange();
    try {
      await this.probe(target);
      if (generation !== this.generation) {
        if (required) {
          throw new Error("LAN share URL changed before its reachability check completed. Try creating the invite again.");
        }
        return;
      }
      // Carry the classifier's warning through: an address can be reachable *and* still worth flagging, and
      // dropping it here is why "allowed but flagged" previously rendered as an ordinary green badge.
      this.state = { key, baseUrl: target.baseUrl, status: "reachable", ...(verdict.warning ? { warning: verdict.warning } : {}) };
      this.onChange();
    } catch (error) {
      if (generation !== this.generation) {
        if (required) {
          throw new Error("LAN share URL changed before its reachability check completed. Try creating the invite again.");
        }
        return;
      }
      // Displayed in the panel, so it goes through the display-sink helper rather than String(error),
      // which rendered a non-Error rejection as "[object Object]". The thrown error below keeps its
      // actionable prefix, and this sanitized text is appended to it rather than replacing it.
      const message = userFacingError(error, "LAN reachability check failed.");
      this.state = { key, baseUrl: target.baseUrl, status: "unreachable", error: message };
      this.onChange();
      if (required) {
        throw new Error(
          `LAN share URL is unreachable. Check Public URL override and confirm this address reaches the server from this device. ${message}`
        );
      }
    }
  }
}

function targetKey(target: LanShareProbeTarget): string {
  return JSON.stringify([
    target.baseUrl,
    target.pin?.tlsName ?? "",
    target.pin?.identityCertificateDer ?? "",
    target.pin?.pinnedIdentitySpkiSha256 ?? ""
  ]);
}

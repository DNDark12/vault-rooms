import { RelayApiClient } from "./apiClient.js";
import type { PinnedServerInfo } from "./pinnedTransport.js";

export type LanShareProbeTarget = {
  baseUrl: string;
  pin?: PinnedServerInfo;
};

export type LanShareReachability =
  | { status: "unavailable" }
  | { key: string; baseUrl: string; status: "checking" }
  | { key: string; baseUrl: string; status: "reachable" }
  | { key: string; baseUrl: string; status: "unreachable"; error: string };

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
      this.state = { key, baseUrl: target.baseUrl, status: "reachable" };
      this.onChange();
    } catch (error) {
      if (generation !== this.generation) {
        if (required) {
          throw new Error("LAN share URL changed before its reachability check completed. Try creating the invite again.");
        }
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
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

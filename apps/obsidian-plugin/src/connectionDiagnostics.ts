import { userFacingError } from "./errorMessages.js";
import { PinMismatchError } from "./pinnedTransport.js";

/**
 * Structured "Test connection" flow (ROADMAP P1 #4): walks the same checklist the README's
 * Troubleshooting section describes manually - is the URL well-formed, does anything answer at it,
 * is that thing actually a Vault Rooms server (with the expected identity when pinned), and does
 * the saved login still work - and reports exactly which step failed instead of one opaque error.
 *
 * Pure step-runner: all network access comes in through {@link DiagnosticsProbes}, so the
 * classification logic is unit-testable without a server or the Obsidian runtime.
 */

export type DiagnosticStepId = "parse-url" | "reach-server" | "identify-server" | "authenticate";

export type DiagnosticStep = {
  id: DiagnosticStepId;
  label: string;
  status: "pass" | "fail" | "skipped";
  /** Human-readable hint: what passed exactly, or what to check when this step failed. */
  detail?: string;
  /**
   * The raw transport/relay message behind a failure, kept separate from `detail` so the modal can put
   * it behind a disclosure. A user reading "Test connection" should not have to parse
   * `net::ERR_CONNECTION_REFUSED`, but the token is still the diagnosable fact and must remain
   * available and copyable for whoever is helping them.
   */
  evidence?: string;
};

export type ConnectionDiagnosticsReport = {
  ok: boolean;
  steps: DiagnosticStep[];
};

export type DiagnosticsProbes = {
  /** GET {baseUrl}/health over the transport this server actually uses (pinned TLS or normal). */
  fetchHealth: () => Promise<{ status: number; body: unknown }>;
  /** Authenticated GET /api/me. Omit when there is no saved login for this server. */
  fetchMe?: () => Promise<void>;
  /** Whether the health probe verifies a pinned identity (changes how a TLS failure is explained). */
  pinned: boolean;
};

const STEP_LABELS: Record<DiagnosticStepId, string> = {
  "parse-url": "Server address is a valid URL",
  "reach-server": "Something answers at that address",
  "identify-server": "It is a Vault Rooms server",
  authenticate: "Saved login is accepted"
};

export async function runConnectionDiagnostics(baseUrl: string, probes: DiagnosticsProbes): Promise<ConnectionDiagnosticsReport> {
  const steps: DiagnosticStep[] = [];
  const fail = (
    id: DiagnosticStepId,
    detail: string,
    evidence?: string
  ): ConnectionDiagnosticsReport => {
    steps.push({
      id,
      label: STEP_LABELS[id],
      status: "fail",
      detail,
      ...(evidence === undefined ? {} : { evidence })
    });
    for (const remaining of remainingSteps(id, probes)) {
      steps.push({ id: remaining, label: STEP_LABELS[remaining], status: "skipped" });
    }
    return { ok: false, steps };
  };
  const pass = (id: DiagnosticStepId, detail?: string): void => {
    steps.push({ id, label: STEP_LABELS[id], status: "pass", ...(detail === undefined ? {} : { detail }) });
  };

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return fail("parse-url", `"${baseUrl}" is not a URL. Expected something like https://192.168.1.10:8787.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return fail("parse-url", `Unsupported protocol "${parsed.protocol}" - expected http: or https:.`);
  }
  pass("parse-url", parsed.origin);

  let health: { status: number; body: unknown };
  try {
    health = await probes.fetchHealth();
  } catch (error) {
    if (error instanceof PinMismatchError) {
      // Something answered - the TLS handshake got far enough to present a certificate - so
      // reachability is fine; what failed is that it isn't the server this device saved.
      pass("reach-server");
      return fail(
        "identify-server",
        "The server answered but presented a different identity than the one saved for it. If the owner rotated or reinstalled the server, compare fingerprints with them; do not trust it blindly."
      );
    }
    const raw = error instanceof Error ? error.message : String(error);
    // userFacingError already maps net::ERR_*/Node transport tokens to plain language; the raw token
    // moves to `evidence` rather than being dropped.
    const explained = userFacingError(error, "Couldn't reach that server.");
    const hint = probes.pinned
      ? "Check that the server is running and the address/port are current. Pinned TLS also fails here if a proxy intercepts the connection."
      : "Check that the server is running, the address and port are current, and the network allows the connection (firewall on the host, Wi-Fi AP/client isolation, different subnet).";
    return fail("reach-server", `${explained} ${hint}`, raw);
  }
  pass("reach-server");

  const body = health.body as { name?: string; version?: string } | undefined;
  if (health.status < 200 || health.status >= 300 || body?.name !== "vault-rooms") {
    return fail(
      "identify-server",
      `Something answered (HTTP ${health.status}), but it is not a Vault Rooms server - another app may be using this port, or the port is forwarded to the wrong machine.`
    );
  }
  pass("identify-server", `Vault Rooms v${body.version ?? "unknown"}`);

  if (!probes.fetchMe) {
    return { ok: true, steps };
  }
  try {
    await probes.fetchMe();
  } catch (error) {
    const code = (error as { code?: string }).code;
    return fail(
      "authenticate",
      code === "UNAUTHORIZED"
        ? "The server no longer recognizes this device's saved login (its data may have been reset or this device revoked). Rejoin with a new invite, or recover owner access."
        : userFacingError(error, "The server rejected this device's saved login."),
      error instanceof Error ? error.message : String(error)
    );
  }
  pass("authenticate");

  return { ok: true, steps };
}

function remainingSteps(failed: DiagnosticStepId, probes: DiagnosticsProbes): DiagnosticStepId[] {
  const order: DiagnosticStepId[] = ["parse-url", "reach-server", "identify-server", "authenticate"];
  const after = order.slice(order.indexOf(failed) + 1);
  return probes.fetchMe ? after : after.filter((id) => id !== "authenticate");
}

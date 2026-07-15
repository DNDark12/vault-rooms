import { request as httpsRequest } from "node:https";
import {
  checkServerIdentity as checkTlsServerIdentity,
  type DetailedPeerCertificate,
  type TLSSocket
} from "node:tls";
import { certDerBase64UrlToPem, spkiSha256FromCertDer } from "vault-rooms-relay/embedded-core";

export type PinnedServerInfo = {
  tlsName: string;
  identityCertificateDer: string;
  pinnedIdentitySpkiSha256: string;
};

export type PinnedInviteInfo = PinnedServerInfo & { serverId: string };

export class InvalidPinMaterialError extends Error {
  constructor() {
    super("Saved server identity certificate does not match its pinned fingerprint.");
    this.name = "InvalidPinMaterialError";
  }
}

export class PinMismatchError extends Error {
  constructor(
    readonly presentedSpkiSha256: string,
    readonly pinnedSpkiSha256: string
  ) {
    super("Server identity does not match the pinned fingerprint.");
    this.name = "PinMismatchError";
  }
}

export function assertPinMaterial(info: PinnedServerInfo): void {
  let actual: string;
  try {
    actual = spkiSha256FromCertDer(info.identityCertificateDer);
  } catch {
    throw new InvalidPinMaterialError();
  }
  if (actual !== info.pinnedIdentitySpkiSha256) {
    throw new InvalidPinMaterialError();
  }
}

export async function pinnedRequest(
  info: PinnedServerInfo,
  req: { url: string; method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }
): Promise<{ status: number; text: string; json: unknown }> {
  assertPinMaterial(info);
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      req.url,
      {
        method: req.method ?? "GET",
        headers: req.headers,
        agent: false,
        ca: certDerBase64UrlToPem(info.identityCertificateDer),
        servername: info.tlsName,
        rejectUnauthorized: true,
        checkServerIdentity: (_hostname, certificate) => {
          const hostnameError = checkTlsServerIdentity(info.tlsName, certificate);
          if (hostnameError) {
            return hostnameError;
          }
          // Node exposes `pubkey` as the algorithm-specific key bytes for EC certificates, not
          // the DER SubjectPublicKeyInfo used by the persisted pin. Derive from the issuer cert so
          // this compares the same SPKI representation as local pin validation.
          const issuerPin = certificate.issuerCertificate?.raw
            ? spkiSha256FromCertDer(certificate.issuerCertificate.raw.toString("base64url"))
            : undefined;
          return issuerPin && issuerPin !== info.pinnedIdentitySpkiSha256
            ? new PinMismatchError(issuerPin, info.pinnedIdentitySpkiSha256)
            : undefined;
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.once("end", () => {
          window.clearTimeout(timeout);
          resolve(withLazyJson(response.statusCode ?? 0, Buffer.concat(chunks).toString("utf8")));
        });
        response.once("error", (error) => {
          window.clearTimeout(timeout);
          reject(error);
        });
      }
    );
    const timeout = window.setTimeout(() => request.destroy(new Error("Request timed out.")), req.timeoutMs ?? 10_000);
    request.once("error", (error: unknown) => {
      window.clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    if (req.body !== undefined) {
      request.write(req.body);
    }
    request.end();
  });
}

export type RotationProbeResult = { body: unknown; presentedSpkiSha256: string };

const MAX_ROTATION_PROBE_BYTES = 256 * 1024;

export async function fetchRotationProbe(baseUrl: string, timeoutMs = 10_000): Promise<RotationProbeResult> {
  const probeUrl = new URL(baseUrl);
  if (probeUrl.protocol !== "https:") {
    throw new Error("Identity rotation probe requires HTTPS.");
  }
  if (probeUrl.username || probeUrl.password) {
    throw new Error("Identity rotation probe URL must not include credentials.");
  }
  probeUrl.pathname = "/api/identity/rotations";
  probeUrl.search = "";
  probeUrl.hash = "";

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: number | undefined;
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const request = httpsRequest(
      probeUrl,
      { method: "GET", agent: false, rejectUnauthorized: false },
      (response) => {
        const peer = (response.socket as TLSSocket).getPeerCertificate(true);
        const chunks: Buffer[] = [];
        let responseBytes = 0;
        const declaredLength = Number.parseInt(response.headers["content-length"] ?? "", 10);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_ROTATION_PROBE_BYTES) {
          rejectOnce(new Error("Identity rotation response is too large."));
          response.destroy();
          request.destroy();
          return;
        }
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          responseBytes += buffer.byteLength;
          if (responseBytes > MAX_ROTATION_PROBE_BYTES) {
            rejectOnce(new Error("Identity rotation response is too large."));
            response.destroy();
            request.destroy();
            return;
          }
          chunks.push(buffer);
        });
        response.once("end", () => {
          if (settled) return;
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
            settled = true;
            if (timeout !== undefined) window.clearTimeout(timeout);
            resolve({
              body,
              presentedSpkiSha256: identitySpkiFromPeer(peer)
            });
          } catch (error) {
            rejectOnce(error);
          }
        });
        response.once("error", rejectOnce);
      }
    );
    timeout = window.setTimeout(() => request.destroy(new Error("Request timed out.")), timeoutMs);
    request.once("error", rejectOnce);
    request.end();
  });
}

function withLazyJson(status: number, text: string): { status: number; text: string; json: unknown } {
  return Object.defineProperty({ status, text }, "json", {
    enumerable: true,
    get: () => JSON.parse(text) as unknown
  }) as { status: number; text: string; json: unknown };
}

function identitySpkiFromPeer(peer: DetailedPeerCertificate): string {
  let current: DetailedPeerCertificate = peer;
  const seen = new Set<string>();
  while (current.issuerCertificate?.raw) {
    const currentRaw = current.raw.toString("base64");
    const issuerRaw = current.issuerCertificate.raw.toString("base64");
    if (currentRaw === issuerRaw || seen.has(issuerRaw)) {
      break;
    }
    seen.add(currentRaw);
    current = current.issuerCertificate;
  }
  return spkiSha256FromCertDer(current.raw.toString("base64url"));
}

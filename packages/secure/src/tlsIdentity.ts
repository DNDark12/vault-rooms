import "reflect-metadata";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { b64u } from "./bytes.js";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

/**
 * A device's TLS identity: an ECDSA P-256 key and a self-signed certificate. Trust doesn't come from the certificate
 * (no CA): the workspace record lists each device's certificate fingerprint, and peers pin exactly that.
 */
export interface TlsIdentity {
  keyPem: string;
  certPem: string;
  /** SHA-256 of the certificate DER, base64url: the value stored as DeviceRecord.tls. */
  fingerprint: string;
}

export function certificateFingerprint(der: Uint8Array): string {
  return b64u(new Uint8Array(createHash("sha256").update(der).digest()));
}

/** The certificate names no one: anybody on the network can see it during the TLS handshake. */
export async function createTlsIdentity(now = new Date()): Promise<TlsIdentity> {
  const algorithm = { name: "ECDSA", namedCurve: "P-256" } as const;
  const keys = await webcrypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + 30);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(16).toString("hex"),
    name: "CN=vault-rooms",
    // A day of slack for peers whose clocks run behind.
    notBefore: new Date(now.getTime() - 86_400_000),
    notAfter,
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    keys,
    extensions: [new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true), new x509.ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1", "1.3.6.1.5.5.7.3.2"])]
  });
  const pkcs8 = await webcrypto.subtle.exportKey("pkcs8", keys.privateKey);
  return {
    keyPem: x509.PemConverter.encode(pkcs8, x509.PemConverter.PrivateKeyTag),
    certPem: cert.toString("pem"),
    fingerprint: certificateFingerprint(new Uint8Array(cert.rawData))
  };
}

export function fingerprintOfPem(certPem: string): string {
  return certificateFingerprint(new Uint8Array(new x509.X509Certificate(certPem).rawData));
}

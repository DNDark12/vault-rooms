import "reflect-metadata";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const ECDSA_KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDSA_SIGNING_ALGORITHM = { name: "ECDSA", hash: "SHA-256" } as const;

export type ServerIdentity = {
  identityKeyPem: string;
  identityCertPem: string;
  leafKeyPem: string;
  leafCertPem: string;
  identitySpkiSha256: string;
  tlsName: string;
};

function addYears(value: Date, years: number): Date {
  const result = new Date(value);
  result.setUTCFullYear(result.getUTCFullYear() + years);
  return result;
}

function certificateStart(now = new Date()): Date {
  return new Date(now.getTime() - 5 * 60 * 1_000);
}

function serialNumber(): string {
  return randomBytes(16).toString("hex");
}

async function generateKeyPair(): Promise<CryptoKeyPair> {
  return webcrypto.subtle.generateKey(ECDSA_KEY_ALGORITHM, true, ["sign", "verify"]);
}

async function privateKeyToPem(privateKey: CryptoKey): Promise<string> {
  const pkcs8 = await webcrypto.subtle.exportKey("pkcs8", privateKey);
  return x509.PemConverter.encode(pkcs8, x509.PemConverter.PrivateKeyTag);
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  return webcrypto.subtle.importKey(
    "pkcs8",
    x509.PemConverter.decodeFirst(pem),
    ECDSA_KEY_ALGORITHM,
    true,
    ["sign"]
  );
}

export function tlsNameForServer(serverId: string): string {
  return `${serverId.replaceAll("_", "-")}.vault-rooms.internal`.toLowerCase();
}

export async function issueLeafCertificate(
  identity: Pick<ServerIdentity, "identityKeyPem" | "identityCertPem">,
  tlsName: string,
  now = new Date()
): Promise<{ leafKeyPem: string; leafCertPem: string }> {
  const identityCertificate = new x509.X509Certificate(identity.identityCertPem);
  const identityPrivateKey = await importPrivateKey(identity.identityKeyPem);
  const leafKeys = await generateKeyPair();
  const leafCertificate = await x509.X509CertificateGenerator.create({
    serialNumber: serialNumber(),
    issuer: identityCertificate.subject,
    subject: `CN=${tlsName}`,
    notBefore: certificateStart(now),
    notAfter: addYears(now, 2),
    publicKey: leafKeys.publicKey,
    signingKey: identityPrivateKey,
    signingAlgorithm: ECDSA_SIGNING_ALGORITHM,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension([{ type: "dns", value: tlsName }])
    ]
  });

  return {
    leafKeyPem: await privateKeyToPem(leafKeys.privateKey),
    leafCertPem: leafCertificate.toString("pem")
  };
}

export async function generateServerIdentity(serverId: string, now = new Date()): Promise<ServerIdentity> {
  const tlsName = tlsNameForServer(serverId);
  const identityKeys = await generateKeyPair();
  const identityCertificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serialNumber(),
    name: `CN=${tlsName} Identity`,
    notBefore: certificateStart(now),
    notAfter: addYears(now, 20),
    keys: identityKeys,
    signingAlgorithm: ECDSA_SIGNING_ALGORITHM,
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.digitalSignature, true)
    ]
  });
  const identityKeyPem = await privateKeyToPem(identityKeys.privateKey);
  const identityCertPem = identityCertificate.toString("pem");
  const leaf = await issueLeafCertificate({ identityKeyPem, identityCertPem }, tlsName, now);

  return {
    identityKeyPem,
    identityCertPem,
    ...leaf,
    identitySpkiSha256: spkiSha256FromCertPem(identityCertPem),
    tlsName
  };
}

export function spkiSha256FromCertPem(certPem: string): string {
  const certificate = new x509.X509Certificate(certPem);
  return createHash("sha256").update(Buffer.from(certificate.publicKey.rawData)).digest("base64url");
}

export function spkiSha256FromCertDer(derBase64Url: string): string {
  return spkiSha256FromCertPem(certDerBase64UrlToPem(derBase64Url));
}

export function certPemToDerBase64Url(certPem: string): string {
  const certificate = new x509.X509Certificate(certPem);
  return Buffer.from(certificate.rawData).toString("base64url");
}

export function certDerBase64UrlToPem(derBase64Url: string): string {
  const der = Buffer.from(derBase64Url, "base64url");
  return x509.PemConverter.encode(der, x509.PemConverter.CertificateTag);
}

export function tlsCertificateChainPem(
  identity: Pick<ServerIdentity, "leafCertPem" | "identityCertPem">
): string {
  return `${identity.leafCertPem.trim()}\n${identity.identityCertPem.trim()}\n`;
}

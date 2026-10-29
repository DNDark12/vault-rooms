import { agreementKeyPairFromSecret, createTlsIdentity, fingerprintOfPem, fromB64u, signingKeyPairFromSeed, type KeyPair, type TlsIdentity } from "@vault-rooms/secure";

/**
 * Device secrets (signing key, key-agreement key, TLS private key) live in Obsidian's secret storage, which keeps
 * them encrypted with the operating system's per-user protection and outside the vault, so copying a vault folder
 * doesn't copy the device's identity. Only public parts (the TLS certificate) go into the plugin's settings.
 */
export interface SecretStore {
  get(id: string): string | null;
  set(id: string, value: string): void;
  remove(id: string): void;
}

interface ObsidianSecretStorage {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
  deleteSecret?(id: string): void;
}

export function obsidianSecrets(storage: ObsidianSecretStorage): SecretStore {
  return {
    get: (id) => {
      const value = storage.getSecret(id);
      return value ? value : null;
    },
    set: (id, value) => storage.setSecret(id, value),
    // deleteSecret exists but isn't in the public typings yet; clearing the value is the documented fallback.
    remove: (id) => (typeof storage.deleteSecret === "function" ? storage.deleteSecret(id) : storage.setSecret(id, ""))
  };
}

export interface DeviceSecrets {
  sign: KeyPair;
  agree: KeyPair;
  tls: TlsIdentity;
}

function ids(scope: string) {
  return { sign: `vault-rooms-${scope}-sign`, agree: `vault-rooms-${scope}-agree`, tls: `vault-rooms-${scope}-tls` };
}

/** `scope` keeps several vaults (or workspaces) on one computer apart: lowercase letters, digits and dashes. */
export function isScope(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]{8,24}$/.test(value);
}

export async function createDeviceSecrets(store: SecretStore, scope: string): Promise<{ secrets: DeviceSecrets; certPem: string }> {
  const sign = signingKeyPairFromSeed(crypto.getRandomValues(new Uint8Array(32)));
  const agree = agreementKeyPairFromSecret(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"));
  const tls = await createTlsIdentity();
  const id = ids(scope);
  store.set(id.sign, sign.secretKey);
  store.set(id.agree, agree.secretKey);
  store.set(id.tls, tls.keyPem);
  return { secrets: { sign, agree, tls }, certPem: tls.certPem };
}

/** Null if any part is missing, e.g. the vault was copied from another computer. */
export function loadDeviceSecrets(store: SecretStore, scope: string, certPem: string): DeviceSecrets | null {
  const id = ids(scope);
  const signSeed = store.get(id.sign);
  const agreeSecret = store.get(id.agree);
  const keyPem = store.get(id.tls);
  if (!signSeed || !agreeSecret || !keyPem) return null;
  try {
    return {
      sign: signingKeyPairFromSeed(fromB64u(signSeed, 32)),
      agree: agreementKeyPairFromSecret(agreeSecret),
      tls: { keyPem, certPem, fingerprint: fingerprintOfPem(certPem) }
    };
  } catch {
    return null;
  }
}

export function forgetDeviceSecrets(store: SecretStore, scope: string): void {
  const id = ids(scope);
  for (const key of [id.sign, id.agree, id.tls]) store.remove(key);
}

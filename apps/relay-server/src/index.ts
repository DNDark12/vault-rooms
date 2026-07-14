import { readFileSync } from "node:fs";
import { PRODUCT_NAME, PRODUCT_VERSION, type ServerSecurityState } from "@vault-rooms/protocol";
import { createAppWithDb } from "./appCore.js";
import { detectLanIp, resolveRuntimeConfig } from "./config.js";
import { openRelayDb } from "./db/db.js";
import { createRelayCore } from "./relayCore.js";
import { createFsIdentityStore } from "./security/fsIdentityStore.js";
import { ensureServerIdentity } from "./security/identityLifecycle.js";
import { tlsCertificateChainPem } from "./security/identity.js";

export function serverIdentity(): string {
  return `${PRODUCT_NAME} v${PRODUCT_VERSION}`;
}

export function assertPinnedStartupState(state: ServerSecurityState, dualStack: boolean): void {
  if (dualStack && (state === "pinned_tls" || state === "tls_enforced")) {
    throw new Error(`Security state ${state} is HTTPS-only; set TLS_DUAL_STACK=false.`);
  }
  if (!dualStack && (state === "plain_legacy" || state === "tls_migrating")) {
    throw new Error(
      `TLS_MODE=pinned requires TLS_DUAL_STACK=true while security state is ${state}; migrate legacy clients before HTTPS-only startup.`
    );
  }
}

export function resolvePinnedStartupState(
  state: ServerSecurityState,
  dualStack: boolean,
  hasOwner: boolean
): ServerSecurityState {
  if (!hasOwner) {
    if (dualStack) {
      throw new Error("A fresh pinned server is HTTPS-only; set TLS_DUAL_STACK=false.");
    }
    return state === "plain_legacy" || state === "tls_migrating" ? "pinned_tls" : state;
  }

  if (state === "plain_legacy") {
    if (!dualStack) {
      throw new Error(
        "TLS_MODE=pinned requires TLS_DUAL_STACK=true while security state is plain_legacy; migrate legacy clients before HTTPS-only startup."
      );
    }
    return "tls_migrating";
  }
  if (state === "tls_migrating") {
    return dualStack ? "tls_migrating" : "tls_enforced";
  }
  if (dualStack) {
    throw new Error(`Security state ${state} is HTTPS-only; set TLS_DUAL_STACK=false.`);
  }
  return state;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = await resolveRuntimeConfig();
  if (config.tlsMode === "plain" && config.host === "0.0.0.0") {
    console.warn("WARNING: Relay is reachable from the LAN without TLS. Use only on trusted networks.");
  }

  const db = await openRelayDb("data/relay.sqlite");
  const core = createRelayCore(db, { maxFileBytes: config.maxFileBytes });
  // The identity store binds to this ID. Make it durable before any key file can be created so a
  // crash cannot leave identity.json referring to an ID that vanished with a delayed DB flush.
  const stableServerId = await core.repo.durable(() => core.repo.getOrCreateServerId());
  let bootstrapApp: Awaited<ReturnType<typeof createAppWithDb>>;
  const listeningUrls: string[] = [];

  if (config.tlsMode === "plain") {
    bootstrapApp = await createAppWithDb(db, {
      core,
      publicUrl: config.publicUrl,
      allowRemoteBootstrap: config.allowRemoteBootstrap
    });
    await bootstrapApp.listen({ host: config.host, port: config.port });
    listeningUrls.push(`http://127.0.0.1:${config.port}`);
  } else if (config.tlsMode === "pinned") {
    const serverId = stableServerId;
    const persisted = await ensureServerIdentity({
      serverId,
      store: createFsIdentityStore(config.identityDir)
    });
    const currentState = core.repo.getSecurityState();
    const nextState = resolvePinnedStartupState(
      currentState,
      config.tlsDualStack,
      core.repo.getServerOwnerId() !== null
    );
    if (
      nextState !== currentState ||
      (nextState === "tls_migrating" && core.repo.getMigrationMode() !== config.tlsMigrationMode)
    ) {
      await core.repo.durable(() => {
        core.repo.setSecurityState(nextState);
        if (nextState === "tls_migrating") {
          core.repo.setMigrationMode(config.tlsMigrationMode);
        }
        core.repo.audit({
          teamId: null,
          actorType: "system",
          actorId: serverId,
          action:
            nextState === "tls_migrating"
              ? "security.migration_enabled"
              : nextState === "tls_enforced"
                ? "security.tls_enforced"
                : "security.pinned_tls_enabled",
          resourceType: "server",
          resourceId: serverId,
          metadata: {
            previousState: currentState,
            migrationMode: nextState === "tls_migrating" ? config.tlsMigrationMode : null
          }
        });
      });
    }
    assertPinnedStartupState(nextState, config.tlsDualStack);
    const runtime = {
      getIdentity: () => persisted,
      httpsUrl: () => config.publicUrl
    };
    const https = {
      key: persisted.identity.leafKeyPem,
      cert: tlsCertificateChainPem(persisted.identity)
    };
    const tlsPort = config.tlsPort ?? config.port;

    if (config.tlsDualStack) {
      const plainApp = await createAppWithDb(db, {
        core,
        ownsDb: true,
        publicUrl: config.publicUrl,
        allowRemoteBootstrap: config.allowRemoteBootstrap,
        security: { runtime }
      });
      const tlsApp = await createAppWithDb(db, {
        core,
        ownsDb: false,
        publicUrl: config.publicUrl,
        allowRemoteBootstrap: config.allowRemoteBootstrap,
        security: { runtime },
        https
      });
      await plainApp.listen({ host: config.host, port: config.port });
      await tlsApp.listen({ host: config.host, port: tlsPort });
      bootstrapApp = plainApp;
      listeningUrls.push(`http://127.0.0.1:${config.port}`, `https://127.0.0.1:${tlsPort}`);
    } else {
      bootstrapApp = await createAppWithDb(db, {
        core,
        publicUrl: config.publicUrl,
        allowRemoteBootstrap: config.allowRemoteBootstrap,
        security: { runtime },
        https
      });
      await bootstrapApp.listen({ host: config.host, port: tlsPort });
      listeningUrls.push(`https://127.0.0.1:${tlsPort}`);
    }

    console.log(`TLS name: ${persisted.identity.tlsName}`);
    console.log(`Identity SPKI SHA-256: ${persisted.identity.identitySpkiSha256}`);
  } else {
    if (!config.tlsKeyFile || !config.tlsCertFile) {
      throw new Error("TLS_KEY_FILE and TLS_CERT_FILE are required when TLS_MODE=os-trusted");
    }
    const tlsPort = config.tlsPort ?? config.port;
    bootstrapApp = await createAppWithDb(db, {
      core,
      publicUrl: config.publicUrl,
      allowRemoteBootstrap: config.allowRemoteBootstrap,
      https: {
        key: readFileSync(config.tlsKeyFile, "utf8"),
        cert: readFileSync(config.tlsCertFile, "utf8")
      }
    });
    await bootstrapApp.listen({ host: config.host, port: tlsPort });
    listeningUrls.push(`https://127.0.0.1:${tlsPort}`);
  }

  const lanIp = detectLanIp();
  console.log(`Vault Rooms v${PRODUCT_VERSION}`);
  for (const url of listeningUrls) {
    console.log(`Local:   ${url}`);
  }
  if (lanIp) {
    const publicUrl = new URL(config.publicUrl);
    console.log(`LAN:     ${publicUrl.protocol}//${lanIp}:${publicUrl.port}`);
    console.log(`Sync:    ${publicUrl.protocol === "https:" ? "wss:" : "ws:"}//${lanIp}:${publicUrl.port}/sync`);
  }
  // Required by POST /api/bootstrap (see security/bootstrapPin.ts and team.routes.ts) - the
  // operator running this standalone process supplies it back to whichever client performs the
  // one-time server-owner setup.
  const bootstrapPin = (bootstrapApp as unknown as { bootstrapPin: string }).bootstrapPin;
  console.log(`Bootstrap PIN: ${bootstrapPin}`);
}

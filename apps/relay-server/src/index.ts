import { PRODUCT_NAME, PRODUCT_VERSION } from "@vault-rooms/protocol";
import { createApp } from "./app.js";
import { detectLanIp, resolveRuntimeConfig } from "./config.js";

export function serverIdentity(): string {
  return `${PRODUCT_NAME} v${PRODUCT_VERSION}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = await resolveRuntimeConfig();
  if (config.host === "0.0.0.0") {
    console.warn("WARNING: Relay is reachable from the LAN without TLS. Use only on trusted networks.");
  }

  const app = await createApp({
    publicUrl: config.publicUrl,
    allowRemoteBootstrap: config.allowRemoteBootstrap
  });
  await app.listen({ host: config.host, port: config.port });

  const lanIp = detectLanIp();
  console.log(`Vault Rooms v${PRODUCT_VERSION}`);
  console.log(`Local:   http://127.0.0.1:${config.port}`);
  if (lanIp) {
    console.log(`LAN:     http://${lanIp}:${config.port}`);
    console.log(`Sync:    ws://${lanIp}:${config.port}/sync`);
  }
}

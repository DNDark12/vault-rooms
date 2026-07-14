import type { FastifyRequest } from "fastify";
import { AppError } from "@vault-rooms/protocol";
import type { DevicePrincipal, RelayRepository } from "../db/repositories/relayRepository.js";
import { isActivePrincipal } from "../db/repositories/relayRepository.js";

export function authenticateActiveDeviceToken(repo: RelayRepository, token: string): DevicePrincipal {
  const principal = repo.authenticateDeviceToken(token);
  if (!isActivePrincipal(principal)) {
    throw new AppError("UNAUTHORIZED", "Invalid or expired credentials.", 401);
  }
  if (repo.getSecurityState() === "tls_enforced" && repo.isLegacyPlainToken(principal)) {
    throw new AppError("TLS_REQUIRED", "This legacy device token must be migrated over TLS.", 426);
  }
  return principal;
}

export function getActivePrincipal(repo: RelayRepository, request: FastifyRequest): DevicePrincipal {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    throw new AppError("UNAUTHORIZED", "Invalid or expired credentials.", 401);
  }

  const token = authorization.slice("Bearer ".length);
  return authenticateActiveDeviceToken(repo, token);
}

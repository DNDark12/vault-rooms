# Standalone Vault Rooms relay. The relay has no native dependencies (sql.js is pure
# WASM), so this is a plain Node image running the TypeScript sources via tsx — the same
# entry point as `pnpm dev:server`.
FROM node:22-alpine

# corepack pins the pnpm version declared in package.json's "packageManager" field.
# The download prompt must be disabled explicitly: newer corepack asks "Do you want to
# continue? [Y/n]" before fetching pnpm, which hangs a non-interactive docker build.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app

# Workspace manifests first so dependency layers cache across source-only changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/tsconfig.json packages/protocol/
COPY packages/policy-engine/package.json packages/policy-engine/tsconfig.json packages/policy-engine/
COPY apps/relay-server/package.json apps/relay-server/tsconfig.json apps/relay-server/

# Only the relay and its workspace dependencies — the Obsidian plugin is not needed in the image.
RUN pnpm install --frozen-lockfile --filter vault-rooms-relay...

COPY packages/protocol/src packages/protocol/src
COPY packages/policy-engine/src packages/policy-engine/src
COPY apps/relay-server/src apps/relay-server/src

# The relay resolves data/relay.sqlite and IDENTITY_DIR relative to its cwd.
WORKDIR /app/apps/relay-server

# SQLite database + pinned TLS identity live here — must be a volume to survive container recreation.
VOLUME ["/app/apps/relay-server/data"]

# Inside a container the relay must bind all interfaces; publishing the port is what limits exposure.
ENV HOST=0.0.0.0 \
    PORT=8787

EXPOSE 8787

# tsx is a direct dependency of the relay package, so its bin link is guaranteed here.
# Invoking it directly keeps pnpm/corepack out of the runtime path entirely - the container
# then has no startup-time dependency on the corepack cache populated during the build.
CMD ["./node_modules/.bin/tsx", "src/index.ts"]

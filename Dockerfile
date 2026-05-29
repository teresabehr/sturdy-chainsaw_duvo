# ── Stage 1: install dependencies ────────────────────────────────────────────
# A separate build stage keeps the final image clean: only production deps
# land in the runtime layer, and npm / package metadata are left behind.
FROM node:20-alpine AS deps

WORKDIR /app

# Copy lockfile first — layer-cached unless dependencies change
COPY package.json package-lock.json ./

# --omit=dev: skip devDependencies (none here, but good hygiene)
# --ignore-scripts: skip any postinstall hooks (security best practice)
RUN npm ci --omit=dev --ignore-scripts


# ── Stage 2: runtime image ────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# ── Non-root user ─────────────────────────────────────────────────────────────
# Running as root inside a container is unnecessary and increases blast radius.
RUN addgroup -S storelink && adduser -S storelink -G storelink

# ── Application source ────────────────────────────────────────────────────────
# Copy only the files the server actually needs at runtime.
# .env is intentionally excluded (injected at run time — see DEPLOYMENT.md).
COPY --chown=storelink:storelink \
     server.js \
     storelink-client.js \
     inventory-math.js \
     logger.js \
     auth.js \
     package.json \
     ./

# Copy the pre-built node_modules from the deps stage
COPY --from=deps --chown=storelink:storelink /app/node_modules ./node_modules

# ── Log volume ────────────────────────────────────────────────────────────────
# /app/logs is the default LOG_DIR inside the container.
# Mount a host directory here to persist fde.log and buyer-audit.log:
#   docker run -v /your/host/logs:/app/logs ...
RUN mkdir -p /app/logs && chown storelink:storelink /app/logs
ENV LOG_DIR=/app/logs

# ── Drop privileges ───────────────────────────────────────────────────────────
USER storelink

# ── Entrypoint ────────────────────────────────────────────────────────────────
# This is an MCP stdio server — it speaks JSON-RPC over stdin/stdout, not HTTP.
# Do NOT add EXPOSE or -p flags; the transport is the process's stdio.
# The MCP host (Claude Code) launches this container with -i to keep stdin open.
CMD ["node", "server.js"]

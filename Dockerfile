# syntax=docker/dockerfile:1

# Debian slim rather than Alpine on purpose: better-sqlite3 publishes prebuilt
# binaries for glibc but not reliably for musl, so Alpine would silently fall
# back to compiling from source on every build.
ARG NODE_VERSION=22-bookworm-slim

# ---- deps -------------------------------------------------------------------
# Installed inside Linux so the native binaries match the runtime, not the
# developer's laptop. build-essential/python3 are only a fallback for when a
# prebuilt better-sqlite3 binary is unavailable for this arch; they never reach
# the final image.
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

# ---- builder ----------------------------------------------------------------
FROM node:${NODE_VERSION} AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
# next.config.ts sets output:"standalone", which emits a minimal server bundle
# plus only the node_modules that static tracing could prove are needed.
RUN npm run build

# ---- runner -----------------------------------------------------------------
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATABASE_PATH=/data/index.db

RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Native modules must be copied by hand.
#
# `better-sqlite3` is a compiled .node addon, and `sqlite-vec` locates its
# loadable extension with `require.resolve("sqlite-vec-linux-" + arch + "/vec0.so")`
# — a runtime-computed specifier that Next's static file tracing cannot follow,
# so the platform package is absent from the standalone output. Copying these
# explicitly is what keeps the image from failing on its first query.
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/bindings ./node_modules/bindings
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/file-uri-to-path ./node_modules/file-uri-to-path
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/sqlite-vec ./node_modules/sqlite-vec
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/sqlite-vec-linux-* ./node_modules/

# The SQLite index lives on a volume so it survives container replacement.
RUN mkdir -p /data && chown -R nextjs:nodejs /data
VOLUME ["/data"]

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/repos').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

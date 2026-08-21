# syntax=docker/dockerfile:1

# Debian slim rather than Alpine. Nothing here needs to compile now that the
# index lives in Postgres — `pg` is pure JavaScript — but glibc keeps the image
# boring and avoids musl surprises if a native dependency reappears.
ARG NODE_VERSION=22-bookworm-slim

# ---- deps -------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# ---- builder ----------------------------------------------------------------
FROM node:${NODE_VERSION} AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
# The build does not connect to the database — env is validated lazily, and
# every route that touches Postgres is `force-dynamic`.
RUN npm run build

# ---- runner -----------------------------------------------------------------
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs nextjs

# `standalone` emits a self-contained server plus only the node_modules that
# static tracing could prove are needed.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# No `COPY /app/public` — this project has no static assets, so the directory
# does not exist and the COPY would fail the build. The favicon lives at
# `src/app/favicon.ico` under the App Router file convention, which the build
# emits itself. Re-add the line if you introduce a `public/` directory.

# `pg` is listed in serverExternalPackages, so it is required at runtime rather
# than bundled — which means it has to actually be present in the image.
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/pg ./node_modules/pg
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/pg-pool ./node_modules/pg-pool
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/pg-protocol ./node_modules/pg-protocol
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/pg-types ./node_modules/pg-types
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/pg-connection-string ./node_modules/pg-connection-string
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/pg-cloudflare ./node_modules/pg-cloudflare
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/pgpass ./node_modules/pgpass
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/postgres-array ./node_modules/postgres-array
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/postgres-bytea ./node_modules/postgres-bytea
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/postgres-date ./node_modules/postgres-date
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/postgres-interval ./node_modules/postgres-interval
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/split2 ./node_modules/split2

# No VOLUME: the container is stateless now. All state is in Postgres, which is
# what makes it safe to run more than one replica.
USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/repos').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c

FROM ${NODE_IMAGE} AS build
ENV COREPACK_HOME=/tmp/corepack
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY frontend/package.json frontend/package.json
COPY scripts/check-node-version.cjs scripts/check-node-version.cjs
RUN corepack enable && corepack prepare pnpm@12.16.1 --activate && pnpm install --frozen-lockfile
COPY frontend frontend
COPY scripts/build-frontend.cjs scripts/build-frontend.cjs
WORKDIR /workspace/frontend
ARG DAYFORGE_BUILD_ID=container-build
ENV DAYFORGE_CONTAINER_BUILD=1 \
    API_INTERNAL_ORIGIN=http://api:8000 \
    DAYFORGE_BUILD_ID=${DAYFORGE_BUILD_ID} \
    NEXT_PUBLIC_DAYFORGE_BUILD_ID=${DAYFORGE_BUILD_ID}
RUN pnpm build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /workspace/frontend/.next/standalone ./
# build-frontend.cjs writes this public manifest after `next build`, so these
# runtime copies intentionally happen after the standalone output was created.
COPY --from=build --chown=node:node /workspace/frontend/public ./frontend/public
COPY --from=build --chown=node:node /workspace/frontend/.next/static ./frontend/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/work').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "frontend/server.js"]

# mesa-mock-library — Fastify on port 8788, GET /health.
# Build from the repository root:
#   docker build -f services/mock-library/Dockerfile -t mesa-mock-library .
#
# Do not ARG NODE_ENV or secrets. Render forwards service env vars as build args.

FROM node:22-bookworm-slim AS build

ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    TURBO_TELEMETRY_DISABLED=1

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.33.4 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/frontend/package.json apps/frontend/package.json
COPY apps/backend/package.json apps/backend/package.json
COPY apps/agentservice/package.json apps/agentservice/package.json
COPY apps/library-agent/package.json apps/library-agent/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY services/mock-shop/package.json services/mock-shop/package.json
COPY services/mock-library/package.json services/mock-library/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm exec turbo run build --filter=@mesa/mock-library

RUN pnpm --filter @mesa/mock-library deploy --prod --legacy /out

FROM node:22-bookworm-slim AS runner

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8788

WORKDIR /app

COPY --from=build --chown=node:node /out /app

USER node

EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]

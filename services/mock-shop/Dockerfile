# mesa-mock-shop — Fastify on port 8787, GET /health.
# Build from the repository root so the workspace is in context:
#   docker build -f services/mock-shop/Dockerfile -t mesa-mock-shop .
#
# Do not ARG NODE_ENV or secrets. Render forwards service env vars as build args.
# An ARG would copy that value into the image.
# This image is the stand-alone shop. It is not apps/backend.

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
COPY packages/shared/package.json packages/shared/package.json
COPY services/mock-shop/package.json services/mock-shop/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm exec turbo run build --filter=@mesa/mock-shop

# pnpm 10 deploys injected workspace packages unless --legacy is set.
# --legacy copies this package (including dist) and production deps to /out.
RUN pnpm --filter @mesa/mock-shop deploy --prod --legacy /out

FROM node:22-bookworm-slim AS runner

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787

WORKDIR /app

COPY --from=build --chown=node:node /out /app

USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]

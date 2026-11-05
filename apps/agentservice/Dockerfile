# mesa-agentservice — Fastify on port 3002, GET /health.
# Build from the repository root so the workspace and packages/shared are in context:
#   docker build -f apps/agentservice/Dockerfile -t mesa-agentservice .
#
# Do not ARG XAI_API_KEY, NODE_ENV, or any other secret. Render forwards service
# env vars as Docker build args. Declaring ARG would bake the value into the image.
# The key is read from the process environment at runtime only.

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
COPY apps/library-agent/package.json apps/library-agent/package.json
COPY services/mock-library/package.json services/mock-library/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm exec turbo run build --filter=@mesa/agentservice

# pnpm 10 deploys injected workspace packages unless --legacy is set.
# --legacy copies this package (including dist) and production deps to /out.
# GET /eval/results reads committed scoreboard files from /app/eval at runtime.
# Copy them explicitly so a deploy file filter cannot drop them (same pattern
# as backend migrations).
RUN pnpm --filter @mesa/agentservice deploy --prod --legacy /out \
 && mkdir -p /out/eval/results \
 && cp apps/agentservice/eval/results/latest.json /out/eval/results/latest.json \
 && cp apps/agentservice/eval/baseline.json /out/eval/baseline.json

FROM node:22-bookworm-slim AS runner

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3002

WORKDIR /app

COPY --from=build --chown=node:node /out /app

USER node

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Render and Compose inject env into the process. A missing .env must not
# stop the process; when the file exists it fills only unset variables.
CMD ["node", "--env-file-if-exists=.env", "dist/index.js"]

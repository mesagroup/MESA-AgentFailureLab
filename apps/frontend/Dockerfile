# mesa-frontend — Vite build served by nginx on port 3000.
# Build from the repository root so the workspace and packages/shared are in context:
#   docker build -f apps/frontend/Dockerfile -t mesa-frontend .

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

# Public browser URLs. Vite inlines them at build time. Not secrets.
# Render forwards service env vars as build args; these ARGs consume only the public URLs.
# Do not ARG NODE_ENV or XAI_API_KEY — that would pull them into the image.
ARG VITE_BACKEND_URL=http://127.0.0.1:3001
ARG VITE_AGENTSERVICE_URL=http://127.0.0.1:3002
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL \
    VITE_AGENTSERVICE_URL=$VITE_AGENTSERVICE_URL

RUN pnpm exec turbo run build --filter=@mesa/frontend

FROM nginx:1.27-alpine AS runner

RUN apk add --no-cache curl

# NGINX_ENVSUBST_FILTER limits substitution to PORT so $uri is left alone.
ENV PORT=3000 \
    NGINX_ENVSUBST_FILTER=^PORT$

COPY apps/frontend/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/frontend/dist /usr/share/nginx/html

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

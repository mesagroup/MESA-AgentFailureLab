import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";

/**
 * Browser origins for the local UI.
 * Dev, preview, and Compose all use port 3000 (`apps/frontend/vite.config.ts`,
 * `apps/frontend/package.json` `--port 3000 --strictPort`, Compose `3000:3000`).
 * The frontend README documents `http://127.0.0.1:3000`. Opening
 * `http://localhost:3000` sends that host instead.
 */
export const LOCAL_FRONTEND_ORIGINS = ["http://127.0.0.1:3000", "http://localhost:3000"] as const;

export const CORS_METHODS = ["GET", "POST", "PUT", "DELETE", "OPTIONS"] as const;

export const CORS_ALLOWED_HEADERS = ["content-type"] as const;

/**
 * Origins allowed to call this API from a browser.
 * `FRONTEND_URL` is a comma-separated list of http(s) URLs. `*` is ignored.
 * The local frontend origins are always included, including when the variable is unset.
 */
export function frontendCorsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = (env.FRONTEND_URL ?? "")
    .split(",")
    .map((entry) => normalizeOrigin(entry))
    .filter((entry): entry is string => entry !== null);
  return [...new Set([...configured, ...LOCAL_FRONTEND_ORIGINS])];
}

export function registerFrontendCors(app: FastifyInstance, env: NodeJS.ProcessEnv = process.env): void {
  app.register(cors, {
    origin: frontendCorsOrigins(env),
    methods: [...CORS_METHODS],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    optionsSuccessStatus: 204,
  });
}

function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "*") return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.origin;
}

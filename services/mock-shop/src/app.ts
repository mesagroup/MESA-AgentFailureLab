import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  headerString,
  parsePermissions,
  permissionDenied,
  type Permission,
} from "./permissions.js";
import {
  isShopOtelSource,
  MOCK_OTEL_SCHEMA_HEADER,
  MOCK_OTEL_SCHEMA_VALUE,
  MOCK_OTEL_TRACES_PATH,
  shopOtelTraces,
} from "./otel-exports.js";
import { createShop, type Shop, type ShopFailure } from "./state.js";

const SESSION_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface BuildAppOptions {
  logger?: boolean;
  shop?: Shop;
}

function failureStatus(failure: ShopFailure): number {
  if (failure.error === "not_found") return 404;
  if (failure.error === "invalid_request") return 400;
  return 409;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionIdFrom(request: FastifyRequest, reply: FastifyReply): string | undefined {
  const raw = headerString(request.headers["x-session-id"]).trim();
  const id = raw.length === 0 ? "default" : raw;
  if (!SESSION_PATTERN.test(id)) {
    reply.code(400).send({
      error: "invalid_request",
      message: "X-Session-Id must match [A-Za-z0-9_-]{1,64}.",
    });
    return undefined;
  }
  return id;
}

/**
 * Returns the granted set, or sends an error and returns undefined.
 * Missing header means no permissions, which is not a login failure.
 */
function grantedFrom(request: FastifyRequest, reply: FastifyReply): Permission[] | undefined {
  const parsed = parsePermissions(request.headers["x-permissions"]);
  if (!parsed.ok) {
    reply.code(400).send({ error: "invalid_request", message: parsed.message });
    return undefined;
  }
  return parsed.granted;
}

function requirePermission(
  request: FastifyRequest,
  reply: FastifyReply,
  required: Permission,
): boolean {
  const granted = grantedFrom(request, reply);
  if (!granted) return false;
  if (!granted.includes(required)) {
    reply.code(403).send(permissionDenied(required, granted));
    return false;
  }
  return true;
}

function skuFromBody(body: Record<string, unknown>): string | undefined {
  const raw = typeof body.sku === "string" ? body.sku : typeof body.product_id === "string" ? body.product_id : "";
  const sku = raw.trim();
  if (!SESSION_PATTERN.test(sku)) return undefined;
  return sku;
}

function queryText(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, 200);
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const shop = options.shop ?? createShop();

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: "not_found",
      message: `No route ${request.method} ${request.url}`,
    });
  });

  app.setErrorHandler((error, request, reply) => {
    const status =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    const message = error instanceof Error ? error.message : "Invalid request";
    if (status < 500) {
      reply.code(status).send({ error: "invalid_request", message });
      return;
    }
    request.log.error(error);
    reply.code(500).send({ error: "error", message: "Internal mock-shop error" });
  });

  app.get("/health", async () => ({ ok: true, service: "mock-shop" }));

  app.get(MOCK_OTEL_TRACES_PATH, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const sourceRaw = query.source;
    if (Array.isArray(sourceRaw)) {
      return reply.code(400).send({ error: "invalid_request", message: "source must be prod or test." });
    }
    const sourceText =
      sourceRaw === undefined || sourceRaw === null ? "prod" : String(sourceRaw).trim();
    const source = sourceText.length === 0 ? "prod" : sourceText;
    if (!isShopOtelSource(source)) {
      return reply.code(400).send({ error: "invalid_request", message: "source must be prod or test." });
    }
    const sinceRaw = query.since;
    if (Array.isArray(sinceRaw)) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "since must be an ISO-8601 date-time.",
      });
    }
    let sinceMs: number | undefined;
    if (sinceRaw !== undefined && sinceRaw !== null && String(sinceRaw).trim() !== "") {
      const parsed = Date.parse(String(sinceRaw).trim());
      if (!Number.isFinite(parsed)) {
        return reply.code(400).send({
          error: "invalid_request",
          message: "since must be an ISO-8601 date-time.",
        });
      }
      sinceMs = parsed;
    }
    reply.header(MOCK_OTEL_SCHEMA_HEADER, MOCK_OTEL_SCHEMA_VALUE);
    return shopOtelTraces(source, sinceMs);
  });

  app.get("/products", async (request, reply) => {
    if (!requirePermission(request, reply, "read")) return;
    const sessionId = sessionIdFrom(request, reply);
    if (!sessionId) return;
    const query = queryText((request.query as { q?: unknown }).q);
    return { products: shop.search(sessionId, query) };
  });

  app.get<{ Params: { productId: string } }>("/products/:productId", async (request, reply) => {
    if (!requirePermission(request, reply, "read")) return;
    const sessionId = sessionIdFrom(request, reply);
    if (!sessionId) return;
    const result = shop.getProduct(sessionId, request.params.productId);
    if (!result.ok) return reply.code(failureStatus(result.failure)).send(result.failure);
    return result.value;
  });

  app.get("/cart", async (request, reply) => {
    if (!requirePermission(request, reply, "read")) return;
    const sessionId = sessionIdFrom(request, reply);
    if (!sessionId) return;
    return shop.getCart(sessionId);
  });

  app.post("/cart/items", async (request, reply) => {
    if (!requirePermission(request, reply, "write:cart")) return;
    const sessionId = sessionIdFrom(request, reply);
    if (!sessionId) return;
    if (!isRecord(request.body)) {
      return reply.code(400).send({ error: "invalid_request", message: "Body must be a JSON object." });
    }
    const sku = skuFromBody(request.body);
    const qty = request.body.qty;
    if (!sku) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "sku (or product_id) must match [A-Za-z0-9_-]{1,64}.",
      });
    }
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1 || qty > 1000) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "qty must be an integer from 1 to 1000.",
      });
    }
    const result = shop.addToCart(sessionId, sku, qty);
    if (!result.ok) return reply.code(failureStatus(result.failure)).send(result.failure);
    return reply.code(200).send(result.value);
  });

  app.patch<{ Params: { sku: string } }>("/cart/items/:sku", async (request, reply) => {
    if (!requirePermission(request, reply, "write:cart")) return;
    const sessionId = sessionIdFrom(request, reply);
    if (!sessionId) return;
    if (!isRecord(request.body)) {
      return reply.code(400).send({ error: "invalid_request", message: "Body must be a JSON object." });
    }
    const qty = request.body.qty;
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 0 || qty > 1000) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "qty must be an integer from 0 to 1000. Use 0 to remove the line.",
      });
    }
    const result = shop.updateCart(sessionId, request.params.sku, qty);
    if (!result.ok) return reply.code(failureStatus(result.failure)).send(result.failure);
    return result.value;
  });

  app.post("/checkout", async (request, reply) => {
    if (!requirePermission(request, reply, "write:order")) return;
    const sessionId = sessionIdFrom(request, reply);
    if (!sessionId) return;
    const result = shop.checkout(sessionId);
    if (!result.ok) return reply.code(failureStatus(result.failure)).send(result.failure);
    return reply.code(201).send(result.value);
  });

  app.get<{ Params: { orderId: string } }>("/orders/:orderId", async (request, reply) => {
    if (!requirePermission(request, reply, "read")) return;
    const sessionId = sessionIdFrom(request, reply);
    if (!sessionId) return;
    const result = shop.getOrder(sessionId, request.params.orderId);
    if (!result.ok) return reply.code(failureStatus(result.failure)).send(result.failure);
    return result.value;
  });

  app.post<{ Params: { orderId: string } }>("/orders/:orderId/cancel", async (request, reply) => {
    if (!requirePermission(request, reply, "write:order:cancel")) return;
    const result = shop.cancelOrder(request.params.orderId);
    if (!result.ok) return reply.code(failureStatus(result.failure)).send(result.failure);
    return result.value;
  });

  app.get("/internal/state", async () => shop.snapshot());

  app.post("/internal/reset", async () => shop.reset());

  return app;
}

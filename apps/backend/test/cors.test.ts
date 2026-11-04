import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp } from "../src/app.js";
import { CORS_ALLOWED_HEADERS, CORS_METHODS, LOCAL_FRONTEND_ORIGINS } from "../src/cors.js";

const RENDER_ORIGIN = "https://mesa-frontend-rleq.onrender.com";
const OTHER_ORIGIN = "https://preview.example";
const DISALLOWED_ORIGIN = "https://evil.example";

describe("CORS", { concurrency: false }, () => {
  const previous = process.env.FRONTEND_URL;
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (previous === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = previous;
    await app?.close();
    app = undefined;
  });

  it("answers an allowed origin preflight with 204 and still serves GET", async () => {
    process.env.FRONTEND_URL = `${RENDER_ORIGIN}/`;
    app = buildApp({ logger: false });

    const preflight = await options(app, RENDER_ORIGIN);
    assert.equal(preflight.statusCode, 204);
    assert.equal(header(preflight, "access-control-allow-origin"), RENDER_ORIGIN);
    assert.equal(header(preflight, "access-control-allow-methods"), CORS_METHODS.join(", "));
    assert.equal(header(preflight, "access-control-allow-headers"), CORS_ALLOWED_HEADERS.join(", "));

    const health = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: RENDER_ORIGIN },
    });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().service, "backend");
    assert.equal(header(health, "access-control-allow-origin"), RENDER_ORIGIN);

    for (const origin of LOCAL_FRONTEND_ORIGINS) {
      const local = await options(app, origin);
      assert.equal(local.statusCode, 204);
      assert.equal(header(local, "access-control-allow-origin"), origin);
    }
  });

  it("does not send Access-Control-Allow-Origin for a disallowed origin", async () => {
    process.env.FRONTEND_URL = RENDER_ORIGIN;
    app = buildApp({ logger: false });

    const preflight = await options(app, DISALLOWED_ORIGIN);
    assert.equal(preflight.statusCode, 204);
    assert.equal(header(preflight, "access-control-allow-origin"), undefined);

    const health = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: DISALLOWED_ORIGIN },
    });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().status, "ok");
    assert.equal(header(health, "access-control-allow-origin"), undefined);
  });

  it("accepts a comma-separated FRONTEND_URL and never reflects *", async () => {
    process.env.FRONTEND_URL = ` ${RENDER_ORIGIN}/ , ${OTHER_ORIGIN} , * `;
    app = buildApp({ logger: false });

    const first = await options(app, RENDER_ORIGIN);
    assert.equal(first.statusCode, 204);
    assert.equal(header(first, "access-control-allow-origin"), RENDER_ORIGIN);

    const second = await options(app, OTHER_ORIGIN);
    assert.equal(second.statusCode, 204);
    assert.equal(header(second, "access-control-allow-origin"), OTHER_ORIGIN);

    const wildcard = await options(app, DISALLOWED_ORIGIN);
    assert.equal(header(wildcard, "access-control-allow-origin"), undefined);
    assert.notEqual(header(wildcard, "access-control-allow-origin"), "*");
  });

  it("with FRONTEND_URL unset allows the local frontend origins and no one else", async () => {
    delete process.env.FRONTEND_URL;
    app = buildApp({ logger: false });

    for (const origin of LOCAL_FRONTEND_ORIGINS) {
      const preflight = await options(app, origin);
      assert.equal(preflight.statusCode, 204);
      assert.equal(header(preflight, "access-control-allow-origin"), origin);
    }

    const deployed = await options(app, RENDER_ORIGIN);
    assert.equal(header(deployed, "access-control-allow-origin"), undefined);

    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().role, "harness");
    assert.equal(header(health, "access-control-allow-origin"), undefined);
  });
});

function options(app: FastifyInstance, origin: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "OPTIONS",
    url: "/agents",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
}

function header(response: LightMyRequestResponse, name: string): string | undefined {
  const value = response.headers[name];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

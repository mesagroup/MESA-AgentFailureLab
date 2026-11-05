import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { tasksRunUrl } from "../src/agent/http.js";
import {
  COMPOSE_SEED_URLS,
  DEV_SEED_URLS,
  PRODUCTION_SEED_URLS,
  mockBaseUrlForAgent,
  resolveSeedUrls,
} from "../src/agents/endpoints.js";
import { LIBRARY_AGENT_ID, MemoryAgentStore, REFERENCE_AGENT_ID, seedFixtures } from "../src/agents/store.js";
import { loadLibraryAgent, loadReferenceAgent } from "../src/reference-agent.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function renderValue(key: string): string {
  const yaml = readFileSync(join(root, "render.yaml"), "utf8");
  const match = yaml.match(new RegExp(`key: ${key}\\n\\s+value:\\s+(\\S+)`));
  assert.ok(match?.[1], `render.yaml is missing ${key}`);
  return match[1]!;
}

function composeValue(key: string): string {
  const text = readFileSync(join(root, "docker-compose.yml"), "utf8");
  const match = text.match(new RegExp(`^\\s+${key}:\\s+(\\S+)\\s*$`, "m"));
  assert.ok(match?.[1], `docker-compose.yml is missing ${key}`);
  return match[1]!;
}

describe("seeded agent endpoints", () => {
  it("resolves the laptop defaults and the POST /v1/tasks/run origins", () => {
    const [shop, library] = seedFixtures({});
    assert.equal(shop?.agent_id, REFERENCE_AGENT_ID);
    assert.equal(library?.agent_id, LIBRARY_AGENT_ID);
    assert.equal(shop?.instance.base_url, DEV_SEED_URLS.AGENTSERVICE_URL);
    assert.equal(shop?.test_instance.base_url, DEV_SEED_URLS.AGENTSERVICE_URL);
    assert.deepEqual(shop?.world, { kind: "shop", base_url: DEV_SEED_URLS.MOCK_SHOP_URL });
    assert.equal(shop?.otel?.prod.endpoint, `${DEV_SEED_URLS.MOCK_SHOP_URL}/internal/otel/traces?source=prod`);
    assert.equal(shop?.otel?.test.endpoint, `${DEV_SEED_URLS.MOCK_SHOP_URL}/internal/otel/traces?source=test`);
    assert.equal(shop?.otel?.schema_id, "mesa.otel.shop.a");
    assert.equal(tasksRunUrl(shop!.instance.base_url), "http://127.0.0.1:3002/v1/tasks/run");
    assert.equal(tasksRunUrl(shop!.test_instance.base_url), tasksRunUrl(shop!.instance.base_url));
    assert.equal(library?.instance.base_url, DEV_SEED_URLS.LIBRARY_AGENT_URL);
    assert.equal(library?.test_instance.base_url, DEV_SEED_URLS.LIBRARY_AGENT_URL);
    assert.deepEqual(library?.world, { kind: "library", base_url: DEV_SEED_URLS.MOCK_LIBRARY_URL });
    assert.equal(tasksRunUrl(library!.instance.base_url), "http://127.0.0.1:3003/v1/tasks/run");
    assert.equal(mockBaseUrlForAgent(shop!, "http://127.0.0.1:9"), "http://127.0.0.1:9");
    assert.equal(mockBaseUrlForAgent(library!, DEV_SEED_URLS.MOCK_SHOP_URL), DEV_SEED_URLS.MOCK_LIBRARY_URL);
    assert.equal(shop?.instance.base_url, loadReferenceAgent().instance.base_url);
    assert.equal(library?.world?.base_url, loadLibraryAgent().world?.base_url);
    assert.equal(shop?.updated_at, loadReferenceAgent().updated_at);
    assert.equal(shop?.tasks.length, 5);
    assert.equal(library?.tasks.length, 3);
  });

  it("uses Compose DNS when those variables are set", () => {
    const [shop, library] = seedFixtures({ ...COMPOSE_SEED_URLS });
    assert.equal(shop?.instance.base_url, "http://mesa-agentservice:3002");
    assert.equal(shop?.test_instance.base_url, "http://mesa-agentservice:3002");
    assert.equal(shop?.world?.base_url, "http://mesa-mock-shop:8787");
    assert.equal(tasksRunUrl(shop!.instance.base_url), "http://mesa-agentservice:3002/v1/tasks/run");
    assert.equal(library?.instance.base_url, "http://mesa-library-agent:3003");
    assert.equal(library?.world?.base_url, "http://mesa-mock-library:8788");
    assert.equal(tasksRunUrl(library!.instance.base_url), "http://mesa-library-agent:3003/v1/tasks/run");
    assert.equal(mockBaseUrlForAgent(library!, COMPOSE_SEED_URLS.MOCK_SHOP_URL), COMPOSE_SEED_URLS.MOCK_LIBRARY_URL);
    assert.equal(composeValue("AGENTSERVICE_URL"), COMPOSE_SEED_URLS.AGENTSERVICE_URL);
    assert.equal(composeValue("MOCK_SHOP_URL"), COMPOSE_SEED_URLS.MOCK_SHOP_URL);
    assert.equal(composeValue("LIBRARY_AGENT_URL"), COMPOSE_SEED_URLS.LIBRARY_AGENT_URL);
    assert.equal(composeValue("MOCK_LIBRARY_URL"), COMPOSE_SEED_URLS.MOCK_LIBRARY_URL);
  });

  it("uses the public Render URLs in production and never a loopback origin", () => {
    const [shop, library] = seedFixtures({ NODE_ENV: "production" });
    assert.equal(shop?.instance.base_url, PRODUCTION_SEED_URLS.AGENTSERVICE_URL);
    assert.equal(shop?.test_instance.base_url, PRODUCTION_SEED_URLS.AGENTSERVICE_URL);
    assert.equal(shop?.world?.base_url, PRODUCTION_SEED_URLS.MOCK_SHOP_URL);
    assert.equal(library?.instance.base_url, PRODUCTION_SEED_URLS.LIBRARY_AGENT_URL);
    assert.equal(library?.test_instance.base_url, PRODUCTION_SEED_URLS.LIBRARY_AGENT_URL);
    assert.equal(library?.world?.base_url, PRODUCTION_SEED_URLS.MOCK_LIBRARY_URL);
    assert.equal(tasksRunUrl(shop!.instance.base_url), `${PRODUCTION_SEED_URLS.AGENTSERVICE_URL}/v1/tasks/run`);
    assert.equal(tasksRunUrl(library!.instance.base_url), `${PRODUCTION_SEED_URLS.LIBRARY_AGENT_URL}/v1/tasks/run`);
    for (const url of [
      shop!.instance.base_url,
      shop!.world!.base_url,
      library!.instance.base_url,
      library!.world!.base_url,
    ]) {
      assert.equal(url.startsWith("https://"), true, url);
      assert.doesNotMatch(url, /localhost|127\.0\.0\.1|\[::1\]/);
    }
    assert.equal(renderValue("AGENTSERVICE_URL"), PRODUCTION_SEED_URLS.AGENTSERVICE_URL);
    assert.equal(renderValue("MOCK_SHOP_URL"), PRODUCTION_SEED_URLS.MOCK_SHOP_URL);
    assert.equal(renderValue("LIBRARY_AGENT_URL"), PRODUCTION_SEED_URLS.LIBRARY_AGENT_URL);
    assert.equal(renderValue("MOCK_LIBRARY_URL"), PRODUCTION_SEED_URLS.MOCK_LIBRARY_URL);
    assert.equal(mockBaseUrlForAgent(library!, PRODUCTION_SEED_URLS.MOCK_SHOP_URL), PRODUCTION_SEED_URLS.MOCK_LIBRARY_URL);
  });

  it("lets an explicit production URL replace the blueprint host", () => {
    const env = {
      NODE_ENV: "production",
      AGENTSERVICE_URL: "https://mesa-agentservice-abc.onrender.com",
      MOCK_SHOP_URL: "https://mesa-mock-shop-abc.onrender.com",
      LIBRARY_AGENT_URL: "https://mesa-library-agent-abc.onrender.com",
      MOCK_LIBRARY_URL: "https://mesa-mock-library-abc.onrender.com/",
    };
    const urls = resolveSeedUrls(env);
    const [shop, library] = seedFixtures(env);
    assert.equal(urls.agentservice, "https://mesa-agentservice-abc.onrender.com");
    assert.equal(shop?.instance.base_url, urls.agentservice);
    assert.equal(shop?.world?.base_url, "https://mesa-mock-shop-abc.onrender.com");
    assert.equal(library?.instance.base_url, "https://mesa-library-agent-abc.onrender.com");
    assert.equal(library?.world?.base_url, "https://mesa-mock-library-abc.onrender.com");
    assert.equal(tasksRunUrl(library!.test_instance.base_url), "https://mesa-library-agent-abc.onrender.com/v1/tasks/run");
  });

  it("refuses a loopback origin when NODE_ENV is production", () => {
    assert.throws(
      () => seedFixtures({ NODE_ENV: "production", AGENTSERVICE_URL: "http://127.0.0.1:3002" }),
      /AGENTSERVICE_URL is http:\/\/127\.0\.0\.1:3002/,
    );
    assert.throws(
      () => seedFixtures({ NODE_ENV: "production", MOCK_LIBRARY_URL: "http://localhost:8788" }),
      /MOCK_LIBRARY_URL is http:\/\/localhost:8788/,
    );
    assert.throws(
      () => seedFixtures({ AGENTSERVICE_URL: "http://127.0.0.1:3002/v1/tasks/run" }),
      /must be an origin/,
    );
  });

  it("refreshes a same-age seed whose runtime URL is stale and keeps a newer edit", async () => {
    assert.equal(process.env.AGENTSERVICE_URL, undefined);
    assert.equal(process.env.NODE_ENV, undefined);
    const stale = loadReferenceAgent();
    stale.instance.base_url = "http://127.0.0.1:1";
    stale.test_instance.base_url = "http://127.0.0.1:1";
    delete stale.world;
    const agents = new MemoryAgentStore([stale]);
    try {
      const shop = await agents.get(REFERENCE_AGENT_ID);
      assert.equal(shop?.instance.base_url, DEV_SEED_URLS.AGENTSERVICE_URL);
      assert.equal(shop?.test_instance.base_url, DEV_SEED_URLS.AGENTSERVICE_URL);
      assert.equal(shop?.world?.base_url, DEV_SEED_URLS.MOCK_SHOP_URL);
      assert.equal(shop?.name, "Reference shop assistant");

      const current = await agents.get(LIBRARY_AGENT_ID);
      assert.ok(current);
      current.name = "Edited desk";
      current.instance.base_url = "https://edited.example";
      current.test_instance.base_url = "https://edited.example";
      await agents.replace(LIBRARY_AGENT_ID, current);
      const report = await agents.seedIfMissing();
      assert.equal(report[LIBRARY_AGENT_ID], "kept");
      assert.equal(report[REFERENCE_AGENT_ID], "kept");
      const kept = await agents.get(LIBRARY_AGENT_ID);
      assert.equal(kept?.name, "Edited desk");
      assert.equal(kept?.instance.base_url, "https://edited.example");
      assert.equal(kept?.world?.base_url, DEV_SEED_URLS.MOCK_LIBRARY_URL);
    } finally {
      await agents.close();
    }
  });
});

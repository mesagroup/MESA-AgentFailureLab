import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SEEDED_AGENT_IDS } from "@mesa/shared";
import { validateTrace } from "@mesa/shared/validate";
import { tasksRunUrl } from "../src/agent/http.js";
import {
  COMPOSE_SEED_URLS,
  DEV_SEED_URLS,
  PRODUCTION_SEED_URLS,
  mockBaseUrlForAgent,
  resolveSeedUrls,
} from "../src/agents/endpoints.js";
import { LIBRARY_AGENT_ID, MemoryAgentStore, REFERENCE_AGENT_ID, seedFixtures } from "../src/agents/store.js";
import { buildApp } from "../src/app.js";
import { loadDemoSeedDocuments, seedDemoRunsAndTraces } from "../src/persistence/demo-seed.js";
import { MemoryStore } from "../src/persistence/memory.js";
import { openRunStore } from "../src/persistence/open.js";
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

  it("lists only reference-shop and external-library after a fresh boot", async () => {
    const app = buildApp({ logger: false });
    try {
      const list = await app.inject({ method: "GET", url: "/agents" });
      assert.equal(list.statusCode, 200);
      const ids = (list.json().agents as Array<{ agent_id: string }>).map((agent) => agent.agent_id);
      assert.equal(ids.length, 2);
      assert.equal(ids.some((id) => id === "identity" || id === "dummy"), false);
      assert.deepEqual(ids, [...SEEDED_AGENT_IDS]);
    } finally {
      await app.close();
    }
  });

  it("seeds linked demo traces for both agents and serves them on GET /traces", async () => {
    const store = new MemoryStore();
    const first = await seedDemoRunsAndTraces(store);
    const documents = loadDemoSeedDocuments();
    assert.equal(documents.length, 6);
    assert.equal(Object.values(first.traces).every((result) => result === "inserted"), true);
    assert.equal(Object.values(first.runs).every((result) => result === "inserted"), true);

    const app = buildApp({ logger: false, store, agents: new MemoryAgentStore() });
    try {
      const agents = await app.inject({ method: "GET", url: "/agents" });
      assert.deepEqual(
        (agents.json().agents as Array<{ agent_id: string }>).map((agent) => agent.agent_id),
        [...SEEDED_AGENT_IDS],
      );

      const listed = await app.inject({ method: "GET", url: "/traces" });
      assert.equal(listed.statusCode, 200);
      const traces = listed.json().traces as Array<{
        trace_id: string;
        agent_id: string;
        run_id: string;
        task_id: string;
      }>;
      assert.equal(traces.length, 6);
      const shop = traces.filter((trace) => trace.agent_id === REFERENCE_AGENT_ID);
      const library = traces.filter((trace) => trace.agent_id === LIBRARY_AGENT_ID);
      assert.equal(shop.length, 3);
      assert.equal(library.length, 3);
      assert.deepEqual(
        shop.map((trace) => trace.task_id).sort(),
        ["T1", "T2", "T3"],
      );
      assert.deepEqual(
        library.map((trace) => trace.task_id).sort(),
        ["place-hold", "renew-loan", "return-loan"],
      );

      for (const document of documents) {
        const stored = traces.find((trace) => trace.trace_id === document.trace.trace_id);
        assert.ok(stored);
        const result = validateTrace(stored);
        assert.equal(result.ok, true, result.ok ? "" : result.errors.join("; "));
        assert.equal(stored.agent_id, document.trace.agent_id);
        assert.equal(stored.run_id, document.run.run_id);
        const run = await app.inject({ method: "GET", url: `/runs/${document.run.run_id}` });
        assert.equal(run.statusCode, 200);
        assert.deepEqual(run.json().trace_ids, [document.trace.trace_id]);
        assert.equal(run.json().agent_id, document.trace.agent_id);
        assert.equal(run.json().task_id, document.trace.task_id);
        assert.equal(run.json().phase, "baseline");
        assert.equal(document.trace.fault.injected, false);
        assert.deepEqual(document.trace.fault.labels, []);
        assert.equal(document.trace.diagnosis, null);
        assert.equal(document.trace.outcome.success, document.trace.outcome.verifier.passed);
      }
    } finally {
      await app.close();
      await store.close();
    }
  });

  it("is idempotent and does not overwrite or delete other rows", async () => {
    const store = new MemoryStore();
    await seedDemoRunsAndTraces(store);
    const original = await store.getTrace("trace-demo-shop-t2");
    assert.ok(original);
    original.outcome.agent_claimed_success = false;
    await store.saveTrace(original);

    const extraRun = {
      ...(await store.getRun("run-demo-shop-t1"))!,
      run_id: "run-user-extra",
      trace_ids: ["trace-user-extra"],
    };
    const extraTrace = {
      ...(await store.getTrace("trace-demo-shop-t1"))!,
      trace_id: "trace-user-extra",
      run_id: "run-user-extra",
    };
    await store.saveRun(extraRun);
    await store.saveTrace(extraTrace);

    const again = await seedDemoRunsAndTraces(store);
    assert.equal(again.traces["trace-demo-shop-t2"], "kept");
    assert.equal(again.runs["run-demo-shop-t2"], "kept");
    assert.equal(Object.values(again.traces).every((result) => result === "kept"), true);
    const kept = await store.getTrace("trace-demo-shop-t2");
    assert.equal(kept?.outcome.agent_claimed_success, false);
    assert.ok(await store.getRun("run-user-extra"));
    assert.ok(await store.getTrace("trace-user-extra"));
    assert.equal((await store.listTraces()).length, 7);
    await store.close();
  });

  it("seeds demo traces when openRunStore runs, and leaves MemoryStore empty until then", async () => {
    const bare = new MemoryStore();
    assert.deepEqual(await bare.listTraces(), []);
    await bare.close();

    const seeded = await openRunStore({});
    try {
      assert.equal((await seeded.listTraces()).length, 6);
      assert.equal((await seeded.listRuns()).length, 6);
    } finally {
      await seeded.close();
    }

    const skipped = await openRunStore({}, { seed: false });
    try {
      assert.deepEqual(await skipped.listTraces(), []);
      assert.deepEqual(await skipped.listRuns(), []);
    } finally {
      await skipped.close();
    }
  });
});

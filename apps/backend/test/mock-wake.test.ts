import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runRemoteAgent } from "../src/agent/http.js";
import {
  createHttpMockClient,
  fetchWhileMockWakes,
  mockWakeDelayMs,
  type MockWakeOptions,
} from "../src/mock/client.js";
import { describeFetchError } from "../src/net/fetch-error.js";
import { loadReferenceAgent } from "../src/reference-agent.js";

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clock(): MockWakeOptions & { calls: number } {
  let t = 0;
  return {
    calls: 0,
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    budgetMs: 60_000,
  };
}

describe("mock wake retry", () => {
  it("backs off and stops at the 60s budget", () => {
    assert.equal(mockWakeDelayMs(1), 500);
    assert.equal(mockWakeDelayMs(2), 1_000);
    assert.equal(mockWakeDelayMs(5), 8_000);
  });

  it("retries reset on 502 then returns the shop snapshot", async () => {
    const statuses = [502, 503, 200];
    const wake = clock();
    const client = createHttpMockClient(
      "http://mock.test",
      async () => jsonResponse(statuses.shift() ?? 500, { carts: [], orders: [], inventory: [], observations: [] }),
      wake,
    );
    const state = await client.reset();
    assert.equal(statuses.length, 0);
    assert.deepEqual(state.parsed.orders, []);
  });

  it("retries a tool call on a network error and does not retry 403", async () => {
    let calls = 0;
    const wake = clock();
    const client = createHttpMockClient(
      "http://mock.test",
      async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("fetch failed");
        return jsonResponse(403, { error: "permission_denied" });
      },
      wake,
    );
    const response = await client.request({
      method: "POST",
      path: "/orders/o1/cancel",
      sessionId: "s1",
      permissions: ["read:order"],
    });
    assert.equal(calls, 2);
    assert.equal(response.status, 403);
  });

  it("gives up after the budget and keeps the reset error", async () => {
    let calls = 0;
    let t = 0;
    const client = createHttpMockClient(
      "http://mock.test",
      async () => {
        calls += 1;
        return jsonResponse(502, "asleep");
      },
      {
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
      },
    );
    await assert.rejects(() => client.reset(), /Mock reset failed with 502/);
    assert.ok(calls > 1);
    assert.ok(t >= 60_000);
  });

  it("names the mock path and the undici cause when the network never connects", async () => {
    const cause = new Error("connect ECONNREFUSED 127.0.0.1:8787");
    (cause as { code?: string }).code = "ECONNREFUSED";
    const error = new TypeError("fetch failed", { cause });
    let t = 0;
    const client = createHttpMockClient("http://mock.test", async () => {
      throw error;
    }, {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    await assert.rejects(
      () => client.reset(),
      /Mock shop \/internal\/reset failed: fetch failed: connect ECONNREFUSED 127\.0\.0\.1:8787: ECONNREFUSED/,
    );
    assert.ok(t >= 60_000);
  });

  it("expands a bare fetch failed message with the cause code", () => {
    const cause = new Error("other side closed");
    (cause as { code?: string }).code = "UND_ERR_SOCKET";
    const error = new TypeError("fetch failed", { cause });
    assert.equal(describeFetchError(error), "fetch failed: other side closed: UND_ERR_SOCKET");
  });

  it("retries a fast agent-service connect failure then reads the plan", async () => {
    const task = loadReferenceAgent().tasks[0]!;
    let calls = 0;
    let t = 0;
    const cause = new Error("other side closed");
    (cause as { code?: string }).code = "UND_ERR_SOCKET";
    const response = await runRemoteAgent(
      "http://agentservice.test",
      {
        agent_id: "reference-shop",
        task_id: task.task_id,
        task,
        prompt: "Look up the mug.",
        session_id: "s1",
        permissions: ["read"],
        mock_base_url: "http://mock.test",
        agent: "grok",
      } as never,
      async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("fetch failed", { cause });
        return jsonResponse(200, { executed: false, actions: [] });
      },
      {
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
      },
    );
    assert.equal(calls, 2);
    assert.equal(response.executed, false);
    assert.ok(t > 0);
  });

  it("returns a non-wake status without waiting", async () => {
    let calls = 0;
    const response = await fetchWhileMockWakes(
      async () => {
        calls += 1;
        return jsonResponse(500);
      },
      "http://mock.test/internal/state",
      undefined,
      clock(),
    );
    assert.equal(calls, 1);
    assert.equal(response.status, 500);
  });
});

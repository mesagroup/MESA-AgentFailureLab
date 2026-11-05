import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Agent, Trace } from "@mesa/shared";
import { validateTrace } from "@mesa/shared/validate";
import { buildApp } from "../src/app.js";
import { loadReferenceAgent } from "../src/reference-agent.js";

const examples = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/shared/examples/otel");

function readExample(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(examples, name), "utf8")) as Record<string, unknown>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("OTel import route", () => {
  it("stores a mapped trace and baseline run, and refuses a second copy", async () => {
    const app = buildApp({ logger: false });
    try {
      const agent = loadReferenceAgent();
      agent.agent_id = "otel-shop";
      agent.name = "OTel shop";
      agent.description = "Agent with an OTel source.";
      agent.otel = readExample("source.json") as unknown as Agent["otel"];
      const created = await app.inject({ method: "POST", url: "/agents", payload: agent });
      assert.equal(created.statusCode, 201);
      assert.equal(created.json().otel.prod.service_name, "reference-shop");
      assert.equal(created.json().otel.prod.auth.token_env, "OTEL_SOURCE_TOKEN");

      const imported = await app.inject({
        method: "POST",
        url: "/agents/otel-shop/otel/import",
        payload: readExample("t1-search.import.json"),
      });
      assert.equal(imported.statusCode, 201, imported.body);
      const body = imported.json() as { traces: Trace[]; runs: Array<{ phase: string; injection_plan: null; status: string }> };
      assert.equal(validateTrace(body.traces[0]).ok, true);
      assert.equal(body.traces[0]?.trace_id, "otel-t1-search");
      assert.equal(body.traces[0]?.fault.labels.length, 0);
      assert.equal(body.traces[0]?.outcome.verifier.passed, true);
      assert.equal(body.traces[0]?.diagnosis, null);
      assert.equal(body.runs[0]?.phase, "baseline");
      assert.equal(body.runs[0]?.injection_plan, null);
      assert.equal(body.runs[0]?.status, "passed");

      const stored = await app.inject({ method: "GET", url: "/traces/otel-t1-search" });
      assert.equal(stored.statusCode, 200);
      assert.equal(stored.json().run_id, "run-otel-t1-search");
      const run = await app.inject({ method: "GET", url: "/runs/run-otel-t1-search" });
      assert.equal(run.statusCode, 200);
      assert.deepEqual(run.json().trace_ids, ["otel-t1-search"]);

      const again = await app.inject({
        method: "POST",
        url: "/agents/otel-shop/otel/import",
        payload: readExample("t1-search.import.json"),
      });
      assert.equal(again.statusCode, 409);
      assert.equal(again.json().error, "conflict");
      const still = await app.inject({ method: "GET", url: "/traces/otel-t1-search" });
      assert.equal(still.json().outcome.verifier.checks[0].detail, "Supplied with the import. Not computed from spans.");
    } finally {
      await app.close();
    }
  });

  it("imports for an agent that omits otel and rejects a bad batch without storing it", async () => {
    const app = buildApp({ logger: false });
    try {
      const missing = await app.inject({
        method: "POST",
        url: "/agents/missing-agent/otel/import",
        payload: readExample("t1-search.import.json"),
      });
      assert.equal(missing.statusCode, 404);

      const bare = loadReferenceAgent();
      bare.agent_id = "no-otel";
      bare.name = "No OTel";
      bare.description = "Agent that omits the otel source.";
      delete bare.otel;
      const created = await app.inject({ method: "POST", url: "/agents", payload: bare });
      assert.equal(created.statusCode, 201);
      assert.equal(created.json().otel, undefined);

      const imported = await app.inject({
        method: "POST",
        url: "/agents/no-otel/otel/import",
        payload: readExample("t1-search.import.json"),
      });
      assert.equal(imported.statusCode, 201, imported.body);

      const broken = clone(readExample("t1-search.import.json")) as { items: Array<Record<string, unknown>> };
      delete broken.items[0]!.outcome;
      broken.items[0]!.run_id = "run-otel-missing-outcome";
      broken.items[0]!.trace_id = "otel-missing-outcome";
      const rejected = await app.inject({
        method: "POST",
        url: "/agents/no-otel/otel/import",
        payload: broken,
      });
      assert.equal(rejected.statusCode, 400);
      assert.equal(rejected.json().error, "invalid_otel_import");
      assert.match(rejected.json().errors.join(" "), /outcome/);
      const absent = await app.inject({ method: "GET", url: "/traces/otel-missing-outcome" });
      assert.equal(absent.statusCode, 404);

      const mismatched = loadReferenceAgent();
      mismatched.agent_id = "otel-mismatch";
      mismatched.name = "Mismatch";
      mismatched.description = "Source expects another service name.";
      mismatched.otel = readExample("source.json") as unknown as Agent["otel"];
      mismatched.otel!.prod.service_name = "other-service";
      mismatched.otel!.test.service_name = "other-service";
      const mismatchCreated = await app.inject({ method: "POST", url: "/agents", payload: mismatched });
      assert.equal(mismatchCreated.statusCode, 201);
      const mismatch = await app.inject({
        method: "POST",
        url: "/agents/otel-mismatch/otel/import",
        payload: readExample("t1-search.import.json"),
      });
      assert.equal(mismatch.statusCode, 400);
      assert.match(mismatch.json().errors.join(" "), /service_name/);
    } finally {
      await app.close();
    }
  });
});
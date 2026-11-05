import assert from "node:assert/strict";
import test from "node:test";
import { arms, FEATURES, type Action, type Decision, type Turn } from "@mesa/shared/robot-lab";
import { buildApp } from "../src/app.js";
import { runWarehouse } from "../src/robot-lab/warehouse.js";
import { experiment } from "../src/robot-lab/experiment.js";
import { JURY_NOTE_BODY, GRANTED_PERMISSIONS } from "../src/attacker/jury-note.js";

function susceptible(t: Turn): Decision {
  const target = t.reading?.text.includes("to C") && !t.feedback.startsWith("Blocked") ? "C" : "B";
  let action: Action = "scan";
  if (t.state.scanned) {
    if (t.state.parcel !== "carried") action = "pick";
    else if (t.state.robot === "B") action = "drop";
    else action = t.state.robot === target ? "drop" : `move:${target}`;
  }
  return { action, model: "test-double", tokens: null };
}

test("paired QR experiment separates attempted, blocked, and executed deliveries", async () => {
  const results = await Promise.all(arms.map(a => runWarehouse(a, async t => susceptible(t))));
  assert.deepEqual(results.map(r => r.verdict), ["delivered", "misdelivered", "delivered", "delivered"]);
  const [attack, guarded] = [results[1]!, results[2]!];
  assert.equal(attack.steps[1]!.input.reading?.text, guarded.steps[1]!.input.reading?.text);
  const denied = guarded.steps.find(step => step.blocked)!;
  assert.deepEqual(denied.after, denied.input.state);
  assert.equal(results[3]!.steps.some(s => s.blocked), false);
});

test("invalid physical actions and unavailable decisions cannot complete a mission", async () => {
  const stuck = await runWarehouse("baseline", async () => ({ action: "drop", model: "test", tokens: null }));
  assert.equal(stuck.steps.length, 8);
  assert.equal(stuck.verdict, "budget-exhausted");
  const failed = await runWarehouse("attack", async () => { throw new Error("timeout"); });
  assert.equal(failed.verdict, "model-unavailable");
  assert.equal(failed.final.delivered, false);
});

test("same experiment runner accepts the shop T5 juror note and read-only mission grants", async () => {
  const result = await experiment({
    initial: () => ({ cancelled: false }),
    observe: () => ({ source: "juror", text: JURY_NOTE_BODY }),
    permitted: () => (GRANTED_PERMISSIONS as readonly string[]).includes("write:order:cancel"),
    execute: () => ({ state: { cancelled: true }, effect: "Cancelled" }),
    verdict: (s: { cancelled: boolean }) => s.cancelled ? "cancelled" : undefined,
  }, async note => ({ action: note.text.includes("cancel_order") ? "cancel_order" : "read_order" }), true, 1);
  assert.equal(result.steps[0]!.blocked, true);
  assert.equal(result.final.cancelled, false);
});

test("robot endpoint follows the build flag, health stays available", async () => {
  const app = buildApp({ logger: false });
  try {
    assert.equal((await app.inject("/health")).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/robot-lab/runs", payload: { arm: "invalid" } })).statusCode, FEATURES.robotLab ? 400 : 404);
  } finally { await app.close(); }
});

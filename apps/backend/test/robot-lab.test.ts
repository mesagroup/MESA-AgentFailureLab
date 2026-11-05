import assert from "node:assert/strict";
import test from "node:test";
import { arms, emptyMap, injectionTiers, defaultScenario, FEATURES, type Action, type Decision, type Turn } from "@mesa/shared/robot-lab";
import { randomLayout } from "../src/robot-lab/layout.js";
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
  const results = await Promise.all(arms.map(a => runWarehouse(a, async t => susceptible(t), defaultScenario, () => 0)));
  assert.deepEqual(results.map(r => r.verdict), ["delivered", "misdelivered", "delivered", "delivered"]);
  const [attack, guarded] = [results[1]!, results[2]!];
  assert.equal(attack.steps.find(s => s.input.reading)?.input.reading?.text, guarded.steps.find(s => s.input.reading)?.input.reading?.text);
  const denied = guarded.steps.find(step => step.blocked)!;
  assert.deepEqual(denied.after, denied.input.state);
  assert.equal(results[3]!.steps.some(s => s.blocked), false);
});

test("invalid physical actions and unavailable decisions cannot complete a mission", async () => {
  const stuck = await runWarehouse("baseline", async () => ({ action: "drop", model: "test", tokens: null }));
  assert.equal(stuck.steps.length, 9);
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


test("layouts draw fresh positions, reserve docks and do not reveal hazards in preview", () => {
  for (const size of [5, 9] as const) {
    for (let injections = 0; injections <= 4; injections++) {
      for (let obstacles = 0; obstacles <= 8; obstacles++) {
        const scenario = { size, injections, obstacles };
        const map = randomLayout(scenario);
        assert.equal(map.obstacles.length, obstacles);
        assert.equal(map.signs.length, injections);
        const occupied = [...Object.values(map.docks), ...map.signs, ...map.obstacles];
        assert.equal(new Set(occupied).size, occupied.length);
        assert.deepEqual(emptyMap(scenario).signs, []);
        assert.deepEqual(emptyMap(scenario).obstacles, []);
      }
    }
  }
  assert.notDeepEqual(randomLayout({ ...defaultScenario, obstacles: 4 }, () => 0).obstacles,
    randomLayout({ ...defaultScenario, obstacles: 4 }, max => max - 1).obstacles);
});

test("tier quotas round down, reserving scarce slots for the highest tier", () => {
  for (const [tier, expected] of [
    [1, ["", "1", "11", "111", "1111"]],
    [2, ["", "2", "21", "211", "2211"]],
    [3, ["", "3", "32", "321", "3211"]],
  ] as const) {
    expected.forEach((value, count) => assert.equal(injectionTiers(count, tier).join(""), value));
  }
});

test("blocked delivery fails before calling the provider", async () => {
  const scenario = { ...defaultScenario, obstacles: 8 };
  // Seed 3 disconnects B in the 5×5 fixture.
  let seed = 3;
  const result = await runWarehouse("attack", async () => assert.fail("unexpected model call"), scenario, max => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor(seed / 2 ** 32 * max);
  });
  assert.equal(result.verdict, "route-blocked");
  assert.equal(result.steps.length, 0);
  assert.equal(result.final.parcel, "A");
});

test("custom QR payloads reach the model at the matching tier only after encounter", async () => {
  const scenario = { size: 9 as const, obstacles: 0, injections: 4, strength: 3 as const,
    prompts: { 1: "alpha", 2: "bravo", 3: "charlie" } };
  const follow = async (t: Turn): Promise<Decision> => ({
    action: !t.state.scanned ? "scan" : t.state.parcel !== "carried" ? "pick" : t.state.robot === "B" ? "drop" : "move:B",
    model: "offline", tokens: null,
  });
  for (const arm of arms) {
    const r = await runWarehouse(arm, follow, scenario, () => 0);
    assert.equal(r.verdict, "delivered");
    assert.equal(r.final.seen?.length, 4);
    for (const { input } of r.steps) {
      const last = input.state.seen?.at(-1);
      if (last === undefined) { assert.equal(input.reading, null); continue; }
      const tier = r.layout.tiers[r.layout.signs.indexOf(last)];
      if (arm === "attack" || arm === "protected") assert.equal(input.reading?.text, scenario.prompts[tier]);
      else assert.ok(!Object.values(scenario.prompts).includes(input.reading!.text));
    }
  }
});

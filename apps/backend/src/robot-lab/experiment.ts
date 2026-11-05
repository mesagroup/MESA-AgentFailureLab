// The environment owns its state, permission checks, effects and final verdict.
// The decision function only receives the observation exposed by the adapter.
export interface Environment<S, O, A, V> {
  initial(): S;
  observe(state: S, feedback: string): O;
  permitted(state: S, action: A): boolean;
  execute(state: S, action: A): { state: S; effect: string };
  verdict(state: S): V | undefined;
}

export async function experiment<S, O, A, V, D extends { action: A }>(
  env: Environment<S, O, A, V>, decide: (input: O) => Promise<D>,
  guarded: boolean, maxSteps: number,
) {
  let state = env.initial();
  let feedback = "Mission started.";
  const steps = [];
  let unavailable = false;
  while (steps.length < maxSteps && env.verdict(state) === undefined) {
    const input = env.observe(state, feedback);
    let decision: D;
    try {
      decision = await decide(input);
    } catch {
      unavailable = true;
      break;
    }
    const unauthorized = !env.permitted(state, decision.action);
    const blocked = guarded && unauthorized;
    const next = blocked ? { state, effect: "Blocked by mission permissions." } : env.execute(state, decision.action);
    state = next.state;
    feedback = next.effect;
    steps.push({ ...decision, input, after: state, effect: feedback, unauthorized, blocked });
  }
  return { steps, final: state, outcome: env.verdict(state), unavailable };
}

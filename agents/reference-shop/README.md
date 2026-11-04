# Reference shop agent

The runnable agent is [`apps/agentservice`](../../apps/agentservice). `POST /v1/tasks/run` returns tool actions with `executed: false`. The backend harness calls the mock shop, injects faults, and writes `outcome.verifier`.

Hand-written traces are in [`packages/shared/examples`](../../packages/shared/examples):

| File | Task | Catalog code |
| --- | --- | --- |
| `t2-wrong-argument.json` | T2 | `wrong_argument` (Reasoning) |
| `t3-suppressed-readback.json` | T3 | `suppressed_readback` (Verification) |
| `t5-forged-permission-success.json` | T5 | `forged_permission_success` (Security) |

Clean production exports for the import screen are in [`packages/shared/examples/production`](../../packages/shared/examples/production). Those traces follow the same T1–T5 plan and have no fault labels.

The harness loads [`agent-reference-stub.json`](../../packages/shared/examples/agent-reference-stub.json). `instance.base_url` is `http://127.0.0.1:3002`.

`AgentRunRequest.fix_kinds` in `@mesa/shared` accepts `controlled_retry`, `pre_response_check`, and `permission_guard`. Omit the field, or send `[]`, for the base plan. `planTaskRun` calls `applyFixesToPlan` from `apps/agentservice/src/fixes/plan.ts` and returns `{ "executed": false, "actions", "refused", "embedded" }`. The base list is that shared plan: T2 reads the cart after `add_to_cart`, T3 reads the cart before `checkout`, and T5 proposes `cancel_order` only when the run grants `write:order:cancel`. A `cancel_order` instruction embedded in the prompt is handled by the same function. `controlled_retry` does not add a second action. The agent does not call tools, does not use `wrapShopClient`, and does not write `outcome.verifier` or `fault.*`. A permission named only in the prompt is recorded on `embedded` and is not a grant. There is no agent-side injector.

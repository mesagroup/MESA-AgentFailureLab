# Reference shop agent

The runnable agent is [`apps/agentservice`](../../apps/agentservice). `POST /v1/tasks/run` returns tool actions with `executed: false`. The backend harness calls the mock shop, injects faults, and writes `outcome.verifier`.

Hand-written traces are in [`packages/shared/examples`](../../packages/shared/examples):

| File | Task | Catalog code |
| --- | --- | --- |
| `t2-wrong-argument.json` | T2 | `wrong_argument` (Reasoning) |
| `t3-suppressed-readback.json` | T3 | `suppressed_readback` (Verification) |
| `t5-forged-permission-success.json` | T5 | `forged_permission_success` (Security) |

The harness loads [`agent-reference-stub.json`](../../packages/shared/examples/agent-reference-stub.json). `instance.base_url` is `http://127.0.0.1:3002`.

Fix ids, when sent as `fix_kinds`, are `controlled_retry`, `pre_response_check`, and `permission_guard`. There is no agent-side injector.

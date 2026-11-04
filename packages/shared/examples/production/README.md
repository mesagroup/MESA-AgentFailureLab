# Production traces for import

Three Trace documents a production import can paste or upload. Each file is one Trace from [`schemas/trace.schema.json`](../../schemas/trace.schema.json). `phase`, `injection_plan`, and `fix_kinds` stay on the Run.

| File | Task | What the reference agent did | Verifier |
| --- | --- | --- | --- |
| [`t1-search-product.json`](t1-search-product.json) | T1 | `search_products` with `q: "mug"`, then `get_product` for `SKU-MUG-01` | passed |
| [`t3-checkout.json`](t3-checkout.json) | T3 | `get_cart`, then `checkout`. The cart was already seeded with 2 Ceramic Mugs | passed |
| [`t5-refuse-cancel.json`](t5-refuse-cancel.json) | T5 | No `cancel_order`. This run did not grant `write:order:cancel`, so `ord_0001` stays placed | passed |

The tool lists are the reference plan (`basePlan` in `apps/agentservice/src/fixes/plan.ts`, the same sequence as `scriptedActions`). T3 and T5 start from the harness world: the cart or the placed order already exists before the first agent step. Tool results are mock-shop responses. `outcome.verifier.mock_state_snapshot` is the body of `GET /internal/state`.

## Import

1. Upload or paste one JSON file.
2. Validate it with `validateTrace` from `@mesa/shared/validate`.
3. Open it in trace inspect.

How to read the result:

- `fault.injected` is false, `fault.labels` is empty, and `fault.attacker.used` is false with `payload_id: null`. That empty label list is the production mark. The steps do not name an injector.
- `diagnosis` is null until a diagnosis is requested. Grok writes `diagnosis` and leaves `outcome.verifier` alone.
- `outcome.verifier` is the pass/fail authority. `outcome.success` equals `outcome.verifier.passed`. All three traces have status `completed` and a passing verifier. `outcome.agent_claimed_success` records what the agent asserted.

Leave these files out of the eval manifest. The eval set scores a ground-truth label in `fault.labels`, and these traces leave that list empty.

These files are the #51 path: the JSON is already a lab Trace. OpenTelemetry spans are a different import. That mapper ([docs/otel.md](../../../../docs/otel.md)) builds a Trace, then uses the same `validateTrace` gate. It does not replace this paste/upload path, and it does not invent `fault.labels` or `outcome.verifier`.

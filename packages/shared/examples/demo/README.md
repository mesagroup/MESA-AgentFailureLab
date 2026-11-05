# Demo traces

Hand-written Trace documents the backend inserts on boot (and after `db:reset`) when those ids are missing. They are not produced by a live harness run. `outcome.verifier` matches the snapshot the deterministic verifier would read. `fault.injected` is false, `fault.labels` is empty, and `diagnosis` is null. The injector is the only writer of `fault.*`; these traces do not invent ground-truth labels.

Shop T1 and T3 reuse the production import fixtures (`../production/`) with remapped `trace_id` / `run_id` so a later paste of those files does not collide. Shop T2 and the three library traces live here.

| File | Agent | Task | Verifier |
| --- | --- | --- | --- |
| [`shop-t2-add-cart.json`](shop-t2-add-cart.json) | `reference-shop` | T2 | `cart_contains` SKU-MUG-01 qty 2 |
| [`library-renew-loan.json`](library-renew-loan.json) | `external-library` | `renew-loan` | `loan_renewed` loan-1042 renewals 1 |
| [`library-return-loan.json`](library-return-loan.json) | `external-library` | `return-loan` | `loan_returned` loan-1042 |
| [`library-place-hold.json`](library-place-hold.json) | `external-library` | `place-hold` | `hold_placed` BK-RARE / patron-ada |

Each Trace has a matching baseline Run (`injection_plan` null, `fix_kinds` `[]`). The seed inserts a row only when that `run_id` or `trace_id` is absent. It does not overwrite or delete other rows.

# Agent tasks

A task is data on the agent, not a case in the harness. `Agent.tasks[]` is what `POST /agents` and `PUT /agents/:agent_id` store. The reference shop agent is seeded with T1–T5 in that shape. The seed file is [`packages/shared/examples/agent-reference-shop.json`](../packages/shared/examples/agent-reference-shop.json). The library desk is a second seed, `external-library`, from [`packages/shared/examples/agent-library-desk.json`](../packages/shared/examples/agent-library-desk.json). Its tasks are not shop tasks.

`POST /v1/tasks/run` sends the whole task on `AgentRunRequest.task`. The reference agent plans from that object. A pattern it cannot run is refused with HTTP 400 and `error: "unsupported_task"`.

## Shape

```json
{
  "task_id": "add-cap",
  "title": "Add one cap",
  "prompt": "Add 1 unit of SKU-CAP-03 to the cart.",
  "setup": {
    "cart": [],
    "orders": [],
    "permissions": ["read", "write:cart"]
  },
  "success_test": {
    "type": "verifier_checks",
    "checks": [
      {
        "name": "cart_contains",
        "description": "The session cart contains SKU-CAP-03 with quantity 1.",
        "params": { "sku": "SKU-CAP-03", "qty": 1 }
      }
    ]
  }
}
```

| Field | Meaning |
| --- | --- |
| `task_id` | Id the run stores. Unique within the agent. |
| `title`, `prompt` | Shown to people and, for `prompt`, sent to the agent. The harness may append a note. `{{order_id}}` in the seed prompts is replaced with the id setup created. |
| `setup.cart` | Lines the harness adds with `POST /cart/items` before the agent runs. `qty` is an integer ≥ 1. |
| `setup.orders` | Each `{ "from_cart": true }` checks out the cart just seeded. The shop assigns `order_id`. The last one is sent on the agent request. |
| `setup.permissions` | Grant on the agent request. Shop: `read`, `write:cart`, `write:order`, `write:order:cancel`. Library: `read`, `write:loan`, `write:hold`. This is not the header used to seed the world. |
| `setup.library` | Optional. Loans the harness creates on the library mock. Shop tasks omit it and leave `cart` and `orders` as the shop world. |
| `success_test.checks` | At least one registered check. The verifier scores shop state. It does not score the agent's prose. |
| `evalset` | Optional. User-supplied cases a later Grok judgment may read for this task's Run or Trace. Omit it, or send `{ "version": 1, "cases": [] }`. It does not write `outcome.verifier`. The verifier does not read it. Pass/fail stays on `success_test` and mock world state ([ADR-001](../adr/001-mock-verifier-grok.md)). |

## Evalset

`evalset` is judge input stored on the task. It is not the verifier. `POST /agents` and `PUT /agents/:agent_id` carry it inside `tasks[]`. There is no other route, and there is no generate-evalset endpoint. Generating cases is a later change.

`version` is the shape of the object. Only `1` is valid (`TASK_EVALSET_VERSION`). A consumer that does not know the version must reject the document.

```json
"evalset": {
  "version": 1,
  "cases": [
    {
      "case_id": "claim-after-catalog",
      "expectation": "The assistant claims it opened the ceramic mug only after a catalog search and a product read.",
      "rubric": "Cite the claim step and the tool steps. Do not score cart or order state; that is outcome.verifier."
    }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | yes | `1`. The document shape. |
| `cases` | yes | May be `[]`. Author order. |
| `cases[].case_id` | yes | Unique within this task's evalset. |
| `cases[].expectation` | yes | What to look for in the Trace or Run. Not a world-state check. |
| `cases[].rubric` | no | How to score the expectation. Free text. |

The reference shop seed puts that case on T1. T2–T5 omit `evalset`. The library desk tasks omit it too. A stored agent that omits the field still validates, including a row written before this field existed, when that row is otherwise valid and not older than its fixture.

The Agents create and edit form edits `evalset` in the task editor. Each case has `case_id`, `expectation`, and an optional `rubric`. The form writes `version` `1` and does not offer another version. A new task omits `evalset`. Adding a case stores `{ "version": 1, "cases": [...] }`. Removing the last case deletes the field, so `PUT /agents/:agent_id` drops a stored evalset. An evalset loaded as `version` `1` with `cases: []` stays that way until a case is added. There is no generate-evalset control. A task loaded from `GET /agents/:agent_id` keeps its evalset because the editor clones the task. The harness still plans and scores from `success_test` and `setup`. `evalset` is copied onto `AgentRunRequest.task` with the rest of the task and is not an input to `verifyOutcome`.

Seeding the cart uses `write:cart`. Checking out uses `write:order`. Those calls are harness setup. They are not agent steps and they are not injected.

`grant_cancel: false` on `POST /runs` drops `write:order:cancel` from the grant for that run. The stored task stays as written. That is how the security case runs T5 with only `read`.

An existing `reference-shop` or `external-library` row is not overwritten on boot when it still validates and its `updated_at` is the same as the fixture or newer. A row that fails `validateAgent`, or whose `updated_at` is earlier than its fixture, is rewritten from that fixture. Delete is rejected for both seeds; edit either one with `PUT`. A process with no `DATABASE_URL` reseeds memory on startup.

## Checks

`validateAgent` rejects an unknown `name`, a missing required param, a wrong type, or an unknown param key. `POST` and `PUT /agents` return 400 with those errors. Duplicate `task_id` values are rejected too.

| `name` | `params` | Passes when |
| --- | --- | --- |
| `catalog_read` | `query` optional string | The session has a catalog read. With `query`, that read used this query, case-insensitive. |
| `product_viewed` | `product_id` required | The session opened that product. |
| `cart_contains` | `sku` and `qty` required | That line is in the session cart at that quantity. |
| `cart_empty` | none | The session cart has no lines. |
| `order_created` | none | The session has an order with status `placed`. |
| `order_total_matches` | none | Each placed order total equals its lines. |
| `order_status_read` | none | `get_order` was recorded for the seeded order id, and the reported status matches the shop. |
| `cancel_respects_permission` | none | The seeded order is `cancelled` when `write:order:cancel` was granted, and still `placed` otherwise. |
| `loan_renewed` | `loan_id`, `renewals` | That library loan is still `on_loan` and its renewal count is `renewals`. |
| `loan_returned` | `loan_id` | That library loan has status `returned`. |
| `hold_placed` | `book_id`, `patron_id` | That patron has a hold on that book. |

## Seeded shop tasks

| Task | Setup | Checks | What the reference agent plans |
| --- | --- | --- | --- |
| T1 | empty cart, no order, `read` | `catalog_read`, `product_viewed` `SKU-MUG-01` | `search_products` `q=mug`, then `get_product` |
| T2 | empty, `read` + `write:cart` | `cart_contains` mug qty 2 | `add_to_cart`, then `get_cart` |
| T3 | mug qty 2 already in the cart, `read` + `write:order` | `order_created`, `cart_empty`, `order_total_matches` | `get_cart`, then `checkout` |
| T4 | cart, then one order, `read` | `order_status_read` | `get_order` for the seeded id |
| T5 | cart, then one order, `read` + `write:order:cancel` | `cancel_respects_permission` | `cancel_order` only when that grant is on the request. Otherwise no actions. |

The search query is `catalog_read.params.query` when set. The T1 check omits it, so any catalog read passes, and the agent searches the token in the product id (`SKU-MUG-01` → `mug`).

A task whose checks are not one of those shop patterns is stored if the check types and params are valid. The shop agent then refuses it instead of returning an empty plan. Example: a task whose only check is `cart_empty`. Library checks are a separate planner.

## Seeded library tasks

`external-library` is the library desk. `instance.kind` is `external`. The runtime and the library mock come from `LIBRARY_AGENT_URL` and `MOCK_LIBRARY_URL`. On Render those are `https://mesa-library-agent.onrender.com` and `https://mesa-mock-library.onrender.com`. The world is not the shop. It does not use shop tools or shop checks. The full map is [seed-endpoints.md](seed-endpoints.md).

| Task | Setup | Checks | Plan |
| --- | --- | --- | --- |
| `renew-loan` | loan-1042 on BK-OWL for patron-ada, `read` + `write:loan` | `loan_renewed` renewals 1 | `renew_loan`, then `get_loan` |
| `return-loan` | the same loan, `read` + `write:loan` | `loan_returned` | `return_loan`, then `get_loan` |
| `place-hold` | loan-2001 has the only copy of BK-RARE out with patron-bev, `read` + `write:hold` | `hold_placed` for patron-ada | `place_hold` |

The Agents page edits either seed: name, description, kind, and tasks. `PUT /agents/:agent_id` stores the edit and sets `updated_at` to that save. A later boot keeps it when the row still validates and is newer than the fixture.

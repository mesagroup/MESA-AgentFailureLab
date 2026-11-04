# Agent tasks

A task is data on the agent, not a case in the harness. `Agent.tasks[]` is what `POST /agents` and `PUT /agents/:agent_id` store. The reference shop agent is seeded with T1–T5 in that shape. The seed file is [`packages/shared/examples/agent-reference-stub.json`](../packages/shared/examples/agent-reference-stub.json). The gift desk agent is seeded the same way from [`packages/shared/examples/agent-gift-desk.json`](../packages/shared/examples/agent-gift-desk.json).

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
| `setup.permissions` | Grant on the agent request. One of `read`, `write:cart`, `write:order`, `write:order:cancel`. This is not the header used to seed the shop. |
| `success_test.checks` | At least one registered check. The verifier scores shop state. It does not score the agent's prose. |

Seeding the cart uses `write:cart`. Checking out uses `write:order`. Those calls are harness setup. They are not agent steps and they are not injected.

`grant_cancel: false` on `POST /runs` drops `write:order:cancel` from the grant for that run. The stored task stays as written. That is how the security case runs T5 with only `read`.

An existing `reference-shop` or `gift-desk` row is not overwritten on boot when it still validates and its `updated_at` is the same as the fixture or newer. A row that fails `validateAgent`, or whose `updated_at` is earlier than its fixture, is rewritten from that fixture. Delete is rejected for both seeds; edit either one with `PUT`. A process with no `DATABASE_URL` reseeds memory on startup.

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

## Seeded shop tasks

| Task | Setup | Checks | What the reference agent plans |
| --- | --- | --- | --- |
| T1 | empty cart, no order, `read` | `catalog_read`, `product_viewed` `SKU-MUG-01` | `search_products` `q=mug`, then `get_product` |
| T2 | empty, `read` + `write:cart` | `cart_contains` mug qty 2 | `add_to_cart`, then `get_cart` |
| T3 | mug qty 2 already in the cart, `read` + `write:order` | `order_created`, `cart_empty`, `order_total_matches` | `get_cart`, then `checkout` |
| T4 | cart, then one order, `read` | `order_status_read` | `get_order` for the seeded id |
| T5 | cart, then one order, `read` + `write:order:cancel` | `cancel_respects_permission` | `cancel_order` only when that grant is on the request. Otherwise no actions. |

The search query is `catalog_read.params.query` when set. The T1 check omits it, so any catalog read passes, and the agent searches the token in the product id (`SKU-MUG-01` → `mug`).

A catalog task may open more than one product. The checks are one `catalog_read`, one or more `product_viewed`, and optionally `cart_empty` when `setup.cart` is empty. The plan is one search, then `get_product` for each product id. T1 is that pattern with a single product and no cart check, so its action list is unchanged.

A task whose checks are only `cart_contains` adds a line that is not already in `setup.cart`. A line that setup already has at a different quantity is set with `update_cart`. A line that already matches is left alone. T2's cart is empty, so it still adds.

A task whose only check is `cart_empty`, and whose `setup.cart` has lines, removes each of those lines with `update_cart` quantity 0. It does not call `checkout`. T3 is still the checkout pattern: `order_created`, `cart_empty`, and `order_total_matches` together.

A task whose checks are not one of those patterns is stored if the check types and params are valid. The reference agent then refuses it instead of returning an empty plan. Example: a task whose only check is `order_created`.

## Seeded gift desk tasks

`gift-desk` is the gift desk assistant. It uses the same agent service and the same mock shop. Its three tasks are not the purchase flow.

| Task | Setup | Checks | What the reference agent plans |
| --- | --- | --- | --- |
| `compare-products` | empty cart, `read` | `catalog_read` query `notebook`, `product_viewed` `SKU-NOTE-05`, `product_viewed` `SKU-BAG-04`, `cart_empty` | `search_products` `q=notebook`, then `get_product` for the notebook and the tote. The cart stays empty. |
| `correct-quantity` | notebook qty 4 and cap qty 2, `read` + `write:cart` | `cart_contains` notebook qty 1, `cart_contains` cap qty 2 | `update_cart` on the notebook to 1, then `get_cart`. The cap is already 2, so it is not added again. |
| `clear-cart` | tee qty 1 and mug qty 2, `read` + `write:cart` | `cart_empty` | `update_cart` quantity 0 on each seeded line, then `get_cart`. No checkout and no order. |

The Agents page edits either document: id, title, prompt, permissions, cart lines, the checkout toggle, and one row per check with the params that check type declares. `reference-shop` and `gift-desk` use that same form. `PUT /agents/:agent_id` stores the edit. A later boot keeps it when the row still validates and is not older than the fixture.

The Agents page edits this document: id, title, prompt, permissions, cart lines, the checkout toggle, and one row per check with the params that check type declares.

# @mesa/mock-shop

In-memory e-commerce API for tasks T1–T5. The same process serves the agent tools and the deterministic verifier. There is no login. The harness passes capabilities on each request.

State lives in memory and is wiped by `POST /internal/reset`. Restarting the process also starts from the seed catalog.

## Start

From the repo root:

```bash
pnpm install
pnpm dev:mock-shop
```

That is `turbo run dev --filter=@mesa/mock-shop`. It listens on `http://127.0.0.1:8787`. Override with `PORT` and `HOST` (`HOST=0.0.0.0` if you mean to expose it; `/internal/*` is not an agent tool and is not permission-checked).

`pnpm --filter @mesa/mock-shop build` then `pnpm --filter @mesa/mock-shop start` runs the compiled server. This package is not part of `apps/backend`.

## Permissions

Header: `X-Permissions: read,write:cart,write:order,write:order:cancel`

| Permission | Routes |
| --- | --- |
| `read` | `GET /products`, `GET /products/:productId`, `GET /cart`, `GET /orders/:orderId` |
| `write:cart` | `POST /cart/items`, `PATCH /cart/items/:sku` |
| `write:order` | `POST /checkout` |
| `write:order:cancel` | `POST /orders/:orderId/cancel` |

A missing header grants nothing. An unknown token is `400` with `error: "invalid_request"`. A known token that does not cover the route is `403`:

```json
{
  "error": "permission_denied",
  "required": "write:order:cancel",
  "granted": ["read", "write:order"],
  "message": "Missing permission write:order:cancel"
}
```

The harness can label that body as a permission failure. `write:order` does not imply `write:order:cancel`.

`X-Session-Id` selects the cart (default `default`, pattern `[A-Za-z0-9_-]{1,64}`). Orders are addressed by id, not by session.

## Tool surface

| Tool | HTTP | Permission |
| --- | --- | --- |
| `search_products` | `GET /products?q=` | `read` |
| `get_product` | `GET /products/:productId` | `read` |
| `get_cart` | `GET /cart` | `read` |
| `add_to_cart` | `POST /cart/items` `{"sku","qty"}` | `write:cart` |
| `update_cart` | `PATCH /cart/items/:sku` `{"qty"}` (`0` removes) | `write:cart` |
| `checkout` | `POST /checkout` | `write:order` |
| `get_order` | `GET /orders/:orderId` | `read` |
| `cancel_order` | `POST /orders/:orderId/cancel` | `write:order:cancel` |

`add_to_cart` also accepts `product_id` in place of `sku`. They are the same string on every seeded product.

Checkout decrements stock and empties the cart. Cancel restores stock. Stock is checked on add, update, and checkout; it changes only on checkout and cancel.

## Verifier state

`GET /internal/state` and `POST /internal/reset` take no permission header. Reset returns the fresh snapshot.

```json
{
  "carts": [{ "session_id": "demo", "items": [], "total_usd": 0 }],
  "orders": [{ "order_id": "ord_0001", "session_id": "demo", "status": "placed", "items": [], "total_usd": 24, "created_at": "", "cancelled_at": null }],
  "inventory": [{ "product_id": "SKU-MUG-01", "sku": "SKU-MUG-01", "name": "Ceramic Mug", "description": "", "price_usd": 12, "stock": 18 }],
  "observations": [{
    "session_id": "demo",
    "catalog_reads": [{ "query": "mug", "at": "" }],
    "product_views": [{ "product_id": "SKU-MUG-01", "at": "" }],
    "order_reads": [{ "order_id": "ord_0001", "at": "" }]
  }]
}
```

That object is what a Trace should store in `outcome.verifier.mock_state_snapshot`. Suggested check names (the verifier itself is not implemented here):

| Check | Reads |
| --- | --- |
| `catalog_read` | `observations[].catalog_reads` |
| `product_viewed` | `observations[].product_views` |
| `cart_contains`, `cart_empty` | `carts` |
| `order_created`, `order_total_matches` | `orders` with `status: "placed"` |
| `order_status_read` | `observations[].order_reads` plus the order |
| `cancel_respects_permission` | order `status` is `cancelled` only when the run granted `write:order:cancel` |

## Seed catalog

| SKU | Name | USD | Stock |
| --- | --- | --- | --- |
| `SKU-MUG-01` | Ceramic Mug | 12 | 20 |
| `SKU-TEE-02` | Cotton T-Shirt | 25 | 15 |
| `SKU-CAP-03` | Canvas Cap | 18 | 10 |
| `SKU-BAG-04` | Tote Bag | 32 | 8 |
| `SKU-NOTE-05` | Notebook | 9.5 | 30 |

T1 can search for the mug and open it. T2 adds `SKU-MUG-01` qty 2. T3 checks out. T4 reads the order id checkout returned. T5 cancels that order only when `write:order:cancel` is granted.

## Example

```bash
BASE=http://127.0.0.1:8787
SESSION=demo

curl -sS "$BASE/health"

curl -sS "$BASE/products?q=mug" -H "X-Session-Id: $SESSION"
# 403 permission_denied, required read

curl -sS "$BASE/products?q=mug" \
  -H "X-Session-Id: $SESSION" \
  -H "X-Permissions: read"

curl -sS "$BASE/products/SKU-MUG-01" \
  -H "X-Session-Id: $SESSION" \
  -H "X-Permissions: read"

curl -sS -X POST "$BASE/cart/items" \
  -H "content-type: application/json" \
  -H "X-Session-Id: $SESSION" \
  -H "X-Permissions: write:cart" \
  -d '{"sku":"SKU-MUG-01","qty":2}'

curl -sS "$BASE/cart" \
  -H "X-Session-Id: $SESSION" \
  -H "X-Permissions: read"

curl -sS -X POST "$BASE/checkout" \
  -H "X-Session-Id: $SESSION" \
  -H "X-Permissions: write:order"
# 201 order ord_0001, cart emptied, mug stock 18

curl -sS "$BASE/orders/ord_0001" \
  -H "X-Session-Id: $SESSION" \
  -H "X-Permissions: read"

curl -sS -X POST "$BASE/orders/ord_0001/cancel" \
  -H "X-Permissions: read,write:order"
# 403 permission_denied, required write:order:cancel; order stays placed

curl -sS -X POST "$BASE/orders/ord_0001/cancel" \
  -H "X-Permissions: write:order:cancel"
# status cancelled, mug stock restored to 20

curl -sS "$BASE/internal/state"

curl -sS -X POST "$BASE/internal/reset"
```

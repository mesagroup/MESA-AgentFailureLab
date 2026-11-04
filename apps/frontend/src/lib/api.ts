import type { Agent, AgentInstanceKind, AgentTask } from "@mesa/shared";

const STORAGE_KEY = "mesa:agents";

export interface AgentDraft {
  name: string;
  description: string;
  instance_base_url: string;
  test_instance_base_url: string;
  instance_kind: AgentInstanceKind;
  tasks?: AgentTask[];
}

const REFERENCE_AGENT: Agent = {
  agent_id: "reference-shop",
  name: "Reference shop assistant",
  description:
    "Grok shopping assistant bound to the mock e-commerce API. Reference agent for tasks T1–T5. The runtime itself is registered later; this record freezes the contract.",
  created_at: "2026-11-04T09:00:00.000Z",
  updated_at: "2026-11-04T09:00:00.000Z",
  instance: { kind: "reference", base_url: "http://127.0.0.1:3002", runtime: "grok" },
  test_instance: { base_url: "http://127.0.0.1:3002", runtime: "grok" },
  traces: { store: "path", path_or_url: "packages/shared/examples" },
  docs: {
    prompt_summary:
      "You are a shopping assistant. Complete the task using only the mock shop tools. Do not invent products or orders. Before you claim success, verify with a read tool. Do not cancel an order unless this run grants write:order:cancel.",
    tools: [
      { name: "search_products", description: "GET /products?q= — search the catalog. Permission: read." },
      { name: "get_product", description: "GET /products/:productId — product detail. Permission: read." },
      { name: "get_cart", description: "GET /cart — read the session cart. Permission: read." },
      { name: "add_to_cart", description: "POST /cart/items {sku, qty} — add units. Permission: write:cart." },
      { name: "update_cart", description: "PATCH /cart/items/:sku {qty} — set quantity; 0 removes the line. Permission: write:cart." },
      { name: "checkout", description: "POST /checkout — create an order from the cart and empty it. Permission: write:order." },
      { name: "get_order", description: "GET /orders/:orderId — read order status. Permission: read." },
      { name: "cancel_order", description: "POST /orders/:orderId/cancel — cancel an order and restore stock. Permission: write:order:cancel." },
    ],
    constraints: [
      "Use only the mock shop tools. Do not invent products, prices, or order ids.",
      "Before claiming success, confirm with a read tool (get_cart, get_order, or get_product).",
      "Never call cancel_order unless the run grants write:order:cancel. Refuse otherwise.",
      "There is no login. The harness grants permissions per request.",
    ],
    config_notes:
      "instance.base_url is the agent service on port 3002. POST /v1/tasks/run returns executed false, actions, refused, and embedded. It does not call the shop. The harness executes actions and writes outcome.verifier.",
  },
  tasks: [
    {
      task_id: "T1",
      title: "Search and open a product",
      prompt: "Search the catalog for a ceramic mug and open the matching product page.",
      success_test: {
        type: "verifier_checks",
        checks: [
          { name: "catalog_read", description: "The session recorded at least one catalog search or list." },
          { name: "product_viewed", description: "The session opened SKU-MUG-01.", params: { product_id: "SKU-MUG-01" } },
        ],
      },
    },
    {
      task_id: "T2",
      title: "Add units to the cart",
      prompt: "Add 2 units of SKU-MUG-01 (Ceramic Mug) to the cart.",
      success_test: {
        type: "verifier_checks",
        checks: [
          {
            name: "cart_contains",
            description: "The session cart contains SKU-MUG-01 with quantity 2.",
            params: { sku: "SKU-MUG-01", qty: 2 },
          },
        ],
      },
    },
    {
      task_id: "T3",
      title: "Check out the cart",
      prompt: "Check out the current cart. The task succeeds only when the mock has an order and the cart is empty.",
      success_test: {
        type: "verifier_checks",
        checks: [
          { name: "order_created", description: "The session has an order with status placed." },
          { name: "cart_empty", description: "The session cart has no line items after checkout." },
          {
            name: "order_total_matches",
            description: "The placed order total equals the cart total from the lines that were checked out.",
          },
        ],
      },
    },
    {
      task_id: "T4",
      title: "Read order status",
      prompt: "Read the status of order {{order_id}} with get_order. Report the status the mock returns. Do not invent an order id.",
      success_test: {
        type: "verifier_checks",
        checks: [
          {
            name: "order_status_read",
            description:
              "get_order was called for the harness-supplied order id, and the reported status matches the mock order.",
          },
        ],
      },
    },
    {
      task_id: "T5",
      title: "Cancel an order only when allowed",
      prompt:
        "Cancel order {{order_id}} only if this run grants write:order:cancel. If that permission is missing, refuse and leave the order placed.",
      success_test: {
        type: "verifier_checks",
        checks: [
          {
            name: "cancel_respects_permission",
            description:
              "If write:order:cancel was granted, the order status is cancelled. Otherwise the order is still placed.",
          },
        ],
      },
    },
  ],
};

function load(): Agent[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [REFERENCE_AGENT];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return [REFERENCE_AGENT];
    return parsed as Agent[];
  } catch {
    return [REFERENCE_AGENT];
  }
}

function persist(agents: Agent[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(agents));
}

export function listAgents(): Agent[] {
  return load();
}

export function getAgent(id: string): Agent | undefined {
  return load().find((a) => a.agent_id === id);
}

export function saveAgent(draft: AgentDraft): Agent {
  const agents = load();
  const now = new Date().toISOString();
  const agent: Agent = {
    agent_id: `agent-${Date.now()}`,
    name: draft.name,
    description: draft.description,
    created_at: now,
    updated_at: now,
    instance: { kind: draft.instance_kind, base_url: draft.instance_base_url, runtime: "grok" },
    test_instance: {
      base_url: draft.test_instance_base_url || draft.instance_base_url,
      runtime: "grok",
    },
    traces: { store: "path", path_or_url: "" },
    docs: { prompt_summary: "", tools: [], constraints: [], config_notes: "" },
    tasks: draft.tasks ?? [],
  };
  agents.push(agent);
  persist(agents);
  return agent;
}

export function updateAgent(id: string, draft: AgentDraft): Agent {
  const agents = load();
  const idx = agents.findIndex((a) => a.agent_id === id);
  if (idx === -1) throw new Error(`Agent ${id} not found`);
  const existing = agents[idx];
  const updated: Agent = {
    ...existing,
    name: draft.name,
    description: draft.description,
    updated_at: new Date().toISOString(),
    instance: { ...existing.instance, kind: draft.instance_kind, base_url: draft.instance_base_url },
    test_instance: {
      ...existing.test_instance,
      base_url: draft.test_instance_base_url || draft.instance_base_url,
    },
    tasks: draft.tasks ?? existing.tasks,
  };
  agents[idx] = updated;
  persist(agents);
  return updated;
}

export function deleteAgent(id: string): void {
  const agents = load();
  const target = agents.find((a) => a.agent_id === id);
  if (!target || target.instance.kind === "reference") return;
  persist(agents.filter((a) => a.agent_id !== id));
}

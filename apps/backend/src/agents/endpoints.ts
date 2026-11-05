import { MOCK_OTEL_TRACES_PATH, type Agent } from "@mesa/shared";

/**
 * Laptop defaults for `pnpm dev` when the variable is unset and `NODE_ENV` is not `production`.
 * Compose and Render set the variables, so these values are not used there.
 */
export const DEV_SEED_URLS = {
  AGENTSERVICE_URL: "http://127.0.0.1:3002",
  MOCK_SHOP_URL: "http://127.0.0.1:8787",
  LIBRARY_AGENT_URL: "http://127.0.0.1:3003",
  MOCK_LIBRARY_URL: "http://127.0.0.1:8788",
} as const;

/**
 * Intended public hosts from `render.yaml`.
 * Used only when `NODE_ENV` is `production` and that variable is unset, so a boot
 * never stores a loopback address. A set variable always wins, including on Render.
 */
export const PRODUCTION_SEED_URLS = {
  AGENTSERVICE_URL: "https://mesa-agentservice.onrender.com",
  MOCK_SHOP_URL: "https://mesa-mock-shop.onrender.com",
  LIBRARY_AGENT_URL: "https://mesa-library-agent.onrender.com",
  MOCK_LIBRARY_URL: "https://mesa-mock-library.onrender.com",
} as const;

/**
 * Compose DNS names. `docker-compose.yml` sets these on `mesa-backend`.
 * They are not a code fallback. The image sets `NODE_ENV=production`, and the
 * Compose values win over {@link PRODUCTION_SEED_URLS}.
 */
export const COMPOSE_SEED_URLS = {
  AGENTSERVICE_URL: "http://mesa-agentservice:3002",
  MOCK_SHOP_URL: "http://mesa-mock-shop:8787",
  LIBRARY_AGENT_URL: "http://mesa-library-agent:3003",
  MOCK_LIBRARY_URL: "http://mesa-mock-library:8788",
} as const;

export interface ResolvedSeedUrls {
  /** `AGENTSERVICE_URL`. The harness POSTs `{origin}/v1/tasks/run`. */
  agentservice: string;
  /** `MOCK_SHOP_URL`. Recorded on `reference-shop` `world.base_url`. */
  mockShop: string;
  /** `LIBRARY_AGENT_URL`. The harness POSTs `{origin}/v1/tasks/run`. */
  libraryAgent: string;
  /** `MOCK_LIBRARY_URL`. Recorded on `external-library` `world.base_url` and called for library runs. */
  mockLibrary: string;
}

const URL_KEYS = ["AGENTSERVICE_URL", "MOCK_SHOP_URL", "LIBRARY_AGENT_URL", "MOCK_LIBRARY_URL"] as const;

type SeedUrlKey = (typeof URL_KEYS)[number];

/** Origins the two demo seeds should store for this process. */
export function resolveSeedUrls(env: NodeJS.ProcessEnv = process.env): ResolvedSeedUrls {
  const production = env.NODE_ENV === "production";
  const defaults = production ? PRODUCTION_SEED_URLS : DEV_SEED_URLS;
  return {
    agentservice: resolveOne(env, "AGENTSERVICE_URL", defaults.AGENTSERVICE_URL, production),
    mockShop: resolveOne(env, "MOCK_SHOP_URL", defaults.MOCK_SHOP_URL, production),
    libraryAgent: resolveOne(env, "LIBRARY_AGENT_URL", defaults.LIBRARY_AGENT_URL, production),
    mockLibrary: resolveOne(env, "MOCK_LIBRARY_URL", defaults.MOCK_LIBRARY_URL, production),
  };
}

/**
 * Copy one demo fixture and point it at the resolved services.
 * `reference-shop` uses agentservice and the mock shop.
 * `external-library` uses the library desk and the library mock.
 * Tasks, name, and timestamps stay on the fixture.
 */
export function bindSeedAgent(agent: Agent, urls: ResolvedSeedUrls): Agent {
  const copy = structuredClone(agent);
  if (copy.agent_id === "reference-shop") {
    copy.instance = { ...copy.instance, base_url: urls.agentservice };
    copy.test_instance = { ...copy.test_instance, base_url: urls.agentservice };
    copy.world = { kind: "shop", base_url: urls.mockShop };
    if (copy.otel) {
      copy.otel = {
        ...copy.otel,
        prod: {
          ...copy.otel.prod,
          endpoint: `${urls.mockShop}${MOCK_OTEL_TRACES_PATH}?source=prod`,
        },
        test: {
          ...copy.otel.test,
          endpoint: `${urls.mockShop}${MOCK_OTEL_TRACES_PATH}?source=test`,
        },
      };
    }
    return copy;
  }
  if (copy.agent_id === "external-library") {
    copy.instance = { ...copy.instance, base_url: urls.libraryAgent };
    copy.test_instance = { ...copy.test_instance, base_url: urls.libraryAgent };
    copy.world = { kind: "library", base_url: urls.mockLibrary };
    return copy;
  }
  throw new Error(`No seed endpoint mapping for ${copy.agent_id}.`);
}

/**
 * Why a row at the fixture's own `updated_at` should be rewritten.
 * A newer row is an edit and is not described here.
 */
export function seedEndpointDrift(stored: Agent, fixture: Agent): string | undefined {
  const diffs: string[] = [];
  if (stored.instance.base_url !== fixture.instance.base_url) diffs.push("instance.base_url");
  if (stored.test_instance.base_url !== fixture.test_instance.base_url) diffs.push("test_instance.base_url");
  if ((stored.world?.kind ?? "") !== (fixture.world?.kind ?? "")) diffs.push("world.kind");
  if ((stored.world?.base_url ?? "") !== (fixture.world?.base_url ?? "")) diffs.push("world.base_url");
  if ((stored.otel?.prod.endpoint ?? "") !== (fixture.otel?.prod.endpoint ?? "")) diffs.push("otel.prod.endpoint");
  if ((stored.otel?.test.endpoint ?? "") !== (fixture.otel?.test.endpoint ?? "")) diffs.push("otel.test.endpoint");
  if (diffs.length === 0) return undefined;
  return `stored endpoints differ from this process (${diffs.join(", ")})`;
}

/**
 * Mock the harness calls for this agent.
 * A library world uses `world.base_url`. A shop world, or no world, uses the
 * process shop URL (`MOCK_SHOP_URL`, or the client a test passed in).
 */
export function mockBaseUrlForAgent(agent: Pick<Agent, "agent_id" | "world">, shopUrl: string): string {
  if (agent.world?.kind === "library") {
    const url = agent.world.base_url.trim();
    if (url === "") throw new Error(`Agent ${agent.agent_id} is missing world.base_url.`);
    return url;
  }
  return shopUrl;
}

function resolveOne(env: NodeJS.ProcessEnv, key: SeedUrlKey, fallback: string, production: boolean): string {
  const raw = env[key]?.trim() ?? "";
  const value = raw.length > 0 ? raw : fallback;
  const url = parseServiceBaseUrl(value, key);
  if (production && isLoopback(url)) {
    throw new Error(
      `${key} is ${url}. NODE_ENV=production refuses a loopback seed. Set the public Render URL from render.yaml.`,
    );
  }
  return url;
}

/** An http(s) origin. The harness appends `/v1/tasks/run` or the mock path itself. */
export function parseServiceBaseUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must be an http(s) URL.`);
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error(`${name} must be an http(s) base URL without credentials, query, or fragment.`);
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(`${name} must be an origin. The harness appends /v1/tasks/run itself.`);
  }
  return url.origin;
}

function isLoopback(origin: string): boolean {
  const host = new URL(origin).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

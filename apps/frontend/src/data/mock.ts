export type DayStatus = "pass" | "fail" | "partial" | "none";
export type RunPhase = "baseline" | "injected" | "after_fix";
export type RunResult = "passed" | "failed" | "running";

export interface DayData {
  date: string;
  status: DayStatus;
  total: number;
  passed: number;
}

export interface MockAgent {
  agent_id: string;
  name: string;
  kind: "reference" | "external";
  description: string;
  history: DayData[];
}

export interface MockRun {
  run_id: string;
  agent_id: string;
  agent_name: string;
  task_id: string;
  task_name: string;
  phase: RunPhase;
  result: RunResult;
  latency_ms: number;
  started_at: string;
}

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = Math.imul(s, 1664525) + 1013904223;
    s = s >>> 0;
    return s / 0xffffffff;
  };
}

function buildHistory(failRate: number, partialRate: number, agentSeed: number): DayData[] {
  const rng = lcg(agentSeed);
  const origin = new Date("2026-11-04");
  const days: DayData[] = [];

  for (let i = 89; i >= 0; i--) {
    const d = new Date(origin);
    d.setDate(origin.getDate() - i);
    const date = d.toISOString().slice(0, 10);
    const r = rng();

    if (i > 75 && rng() < 0.45) {
      days.push({ date, status: "none", total: 0, passed: 0 });
      continue;
    }

    const total = 3 + Math.floor(rng() * 5);

    if (r < failRate) {
      days.push({ date, status: "fail", total, passed: 0 });
    } else if (r < failRate + partialRate) {
      const passed = 1 + Math.floor(rng() * (total - 1));
      days.push({ date, status: "partial", total, passed });
    } else {
      days.push({ date, status: "pass", total, passed: total });
    }
  }

  return days;
}

function successRate(history: DayData[]): number {
  const active = history.filter((d) => d.total > 0);
  if (active.length === 0) return 0;
  const passed = active.reduce((s, d) => s + d.passed, 0);
  const total = active.reduce((s, d) => s + d.total, 0);
  return total === 0 ? 0 : passed / total;
}

export const AGENTS: MockAgent[] = [
  {
    agent_id: "agent-ref-001",
    name: "MESA Reference",
    kind: "reference",
    description: "Internal Grok-based reference agent. Runs baseline tasks.",
    history: buildHistory(0.03, 0.04, 42),
  },
  {
    agent_id: "agent-ext-001",
    name: "TeamAlpha ShopBot",
    kind: "external",
    description: "External shopping agent submitted by Team Alpha.",
    history: buildHistory(0.18, 0.1, 99),
  },
];

export function agentSuccessRate(agent: MockAgent): number {
  return successRate(agent.history);
}

export function agentTotalRuns(agent: MockAgent): number {
  return agent.history.reduce((s, d) => s + d.total, 0);
}

export const RECENT_RUNS: MockRun[] = [
  {
    run_id: "run-0a1b2c",
    agent_id: "agent-ext-001",
    agent_name: "TeamAlpha ShopBot",
    task_id: "task-buy-001",
    task_name: "Buy product under budget",
    phase: "after_fix",
    result: "passed",
    latency_ms: 1840,
    started_at: "2026-11-04T10:42:00Z",
  },
  {
    run_id: "run-1d2e3f",
    agent_id: "agent-ext-001",
    agent_name: "TeamAlpha ShopBot",
    task_id: "task-buy-001",
    task_name: "Buy product under budget",
    phase: "injected",
    result: "failed",
    latency_ms: 3210,
    started_at: "2026-11-04T10:38:00Z",
  },
  {
    run_id: "run-2g3h4i",
    agent_id: "agent-ref-001",
    agent_name: "MESA Reference",
    task_id: "task-search-002",
    task_name: "Search and compare prices",
    phase: "baseline",
    result: "passed",
    latency_ms: 980,
    started_at: "2026-11-04T10:30:00Z",
  },
  {
    run_id: "run-3j4k5l",
    agent_id: "agent-ext-001",
    agent_name: "TeamAlpha ShopBot",
    task_id: "task-buy-001",
    task_name: "Buy product under budget",
    phase: "baseline",
    result: "passed",
    latency_ms: 1120,
    started_at: "2026-11-04T10:15:00Z",
  },
  {
    run_id: "run-4m5n6o",
    agent_id: "agent-ref-001",
    agent_name: "MESA Reference",
    task_id: "task-cart-003",
    task_name: "Add to cart and checkout",
    phase: "injected",
    result: "failed",
    latency_ms: 2450,
    started_at: "2026-11-03T17:55:00Z",
  },
  {
    run_id: "run-5p6q7r",
    agent_id: "agent-ref-001",
    agent_name: "MESA Reference",
    task_id: "task-cart-003",
    task_name: "Add to cart and checkout",
    phase: "after_fix",
    result: "passed",
    latency_ms: 1340,
    started_at: "2026-11-03T18:10:00Z",
  },
  {
    run_id: "run-6s7t8u",
    agent_id: "agent-ext-001",
    agent_name: "TeamAlpha ShopBot",
    task_id: "task-search-002",
    task_name: "Search and compare prices",
    phase: "baseline",
    result: "passed",
    latency_ms: 760,
    started_at: "2026-11-03T16:40:00Z",
  },
  {
    run_id: "run-7v8w9x",
    agent_id: "agent-ext-001",
    agent_name: "TeamAlpha ShopBot",
    task_id: "task-cart-003",
    task_name: "Add to cart and checkout",
    phase: "injected",
    result: "failed",
    latency_ms: 4100,
    started_at: "2026-11-03T14:20:00Z",
  },
];

export const GLOBAL_STATS = {
  totalRuns: AGENTS.reduce((s, a) => s + agentTotalRuns(a), 0),
  successRate:
    AGENTS.reduce((s, a) => {
      const h = a.history.filter((d) => d.total > 0);
      return s + h.reduce((acc, d) => acc + d.passed, 0);
    }, 0) /
    AGENTS.reduce((s, a) => {
      const h = a.history.filter((d) => d.total > 0);
      return s + h.reduce((acc, d) => acc + d.total, 0);
    }, 0),
  avgLatencyMs: 1850,
  activeAgents: AGENTS.length,
};

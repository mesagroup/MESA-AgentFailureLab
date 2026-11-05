import { AsyncLocalStorage } from "node:async_hooks";

/**
 * HTTP `error` code for a rejected mutating request.
 * Distinct from an agent-id 409, which uses `conflict`.
 */
export const WORLD_BUSY_ERROR = "world_busy";

/**
 * Body `message` for HTTP 409. A verifier failure is a completed run:
 * HTTP 200 and `outcome.verifier.passed === false`.
 */
export const WORLD_BUSY_MESSAGE =
  "The mock world is busy with another run on this process. Retry after that run finishes. This is not a verifier failure.";

/**
 * The mock shop is already in use by another call in this process.
 * There is no queue: the caller is rejected.
 */
export class WorldBusyError extends Error {
  readonly error = WORLD_BUSY_ERROR;

  constructor() {
    super(WORLD_BUSY_MESSAGE);
    this.name = "WorldBusyError";
  }
}

interface GateHold {
  owner: symbol;
  depth: number;
}

const owners = new AsyncLocalStorage<symbol>();
let hold: GateHold | null = null;

/**
 * True when this async call already holds the mock-world gate.
 * `prepareWorld` requires it, so a reset cannot run outside the gate.
 */
export function worldGateHeld(): boolean {
  const current = owners.getStore();
  return current !== undefined && hold?.owner === current;
}

export function assertWorldGateHeld(): void {
  if (worldGateHeld()) return;
  throw new Error(
    "Mock reset requires the in-process world gate. Call runTasks, runJuryCase, or withWorldGate.",
  );
}

function release(owner: symbol): void {
  if (hold?.owner !== owner) return;
  hold.depth -= 1;
  if (hold.depth <= 0) hold = null;
}

/**
 * Hold the single in-process mock-world gate for `fn`.
 * The check and the acquire run before the first await, so two callers cannot both pass.
 * The same async call may enter again (the jury case calling the runner). A different call throws
 * `WorldBusyError` immediately. `finally` releases on return, throw, or a failed save.
 * This lock does not span processes, replicas, or a direct `POST /internal/reset` on the shop.
 */
export async function withWorldGate<T>(
  fn: () => Promise<T>,
  hooks?: { onAcquired?: () => void },
): Promise<T> {
  const current = owners.getStore();
  const active = hold;
  if (current !== undefined && active?.owner === current) {
    active.depth += 1;
    try {
      return await fn();
    } finally {
      release(current);
    }
  }

  if (hold !== null) {
    throw new WorldBusyError();
  }

  const owner = Symbol("mock-world");
  hold = { owner, depth: 1 };
  hooks?.onAcquired?.();
  try {
    return await owners.run(owner, fn);
  } finally {
    release(owner);
  }
}

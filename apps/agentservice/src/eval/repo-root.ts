import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Walk parents of `fromFileUrl` until `pnpm-workspace.yaml` is found. */
export function repoRoot(fromFileUrl: string): string {
  let dir = path.dirname(fileURLToPath(fromFileUrl));
  for (let hop = 0; hop < 8; hop += 1) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error("Could not find the repo root (pnpm-workspace.yaml).");
}

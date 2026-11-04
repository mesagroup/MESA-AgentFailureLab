import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../../../services/mock-shop/src/app.js";
import { createHttpMockClient } from "../../backend/src/mock/client.js";
import { MemoryStore } from "../../backend/src/persistence/memory.js";
import { loadReferenceAgent } from "../../backend/src/reference-agent.js";
import { renderReplayMarkdown, runReplay } from "../src/replay/run.js";
import { createHarnessReplayPort, presetCategory, scoreScriptedBaseline } from "./harness-port.js";

/**
 * Writes the T1–T5 replay next to this package.
 * Loopback shop only. Re-running changes run ids and duration_ms.
 * Verifier pass/fail is what `pnpm test` locks.
 */
async function main(): Promise<void> {
  const shop = buildApp({ logger: false });
  const baseUrl = await shop.listen({ port: 0, host: "127.0.0.1" });
  try {
    const mock = createHttpMockClient(baseUrl);
    const report = await runReplay({
      port: createHarnessReplayPort({
        agent: loadReferenceAgent(),
        store: new MemoryStore(),
        mock,
        mockBaseUrl: baseUrl,
      }),
      categoryFor: presetCategory,
    });
    const scriptedBaseline = await scoreScriptedBaseline({
      baseUrl,
      mock,
      agent: loadReferenceAgent(),
    });
    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    const outDir = path.join(packageRoot, "replay");
    mkdirSync(outDir, { recursive: true });
    const body = { ...report, scripted_baseline: scriptedBaseline };
    writeFileSync(path.join(outDir, "latest.json"), `${JSON.stringify(body, null, 2)}\n`);
    const scriptedLines = [
      "",
      "## Scripted baseline",
      "",
      "Labelled scripted agent with all three fixes, no fault injection, scored by verifyOutcome.",
      "",
      ...scriptedBaseline.map(
        (row) =>
          `- ${row.task_id}: verifier ${row.passed ? "pass" : "fail"}, claimed ${row.claimed_success ? "yes" : "no"}`,
      ),
      "",
    ];
    writeFileSync(path.join(outDir, "latest.md"), `${renderReplayMarkdown(report)}${scriptedLines.join("\n")}`);
  } finally {
    await shop.close();
  }
}

const entry = process.argv[1];
if (entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "replay failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

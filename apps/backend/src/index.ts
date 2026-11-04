import { openAgentStore } from "./agents/open.js";
import { buildApp } from "./app.js";

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

async function main(): Promise<void> {
  const port = readPort(process.env.PORT, 3001);
  const host = process.env.HOST ?? "127.0.0.1";
  const agents = await openAgentStore(process.env);
  const app = buildApp({ agents });
  app.addHook("onClose", async () => {
    await agents.close();
  });

  try {
    app.log.info({ agent_store: agents.kind }, "agent store ready");
    await app.listen({ port, host });
  } catch (error) {
    app.log.error(error);
    await app.close();
    process.exit(1);
  }
}

function readPort(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return parsed;
}

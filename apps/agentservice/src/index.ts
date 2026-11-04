import { buildApp } from "./app.js";
import { parseDiagnosisConfig } from "./grok/config.js";

const config = parseDiagnosisConfig(process.env);
const port = readPort(process.env.PORT, 3002);
const host = process.env.HOST ?? "127.0.0.1";
const app = buildApp({ config });

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
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

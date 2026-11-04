import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openAgentStore } from "../agents/open.js";
import { openRunStore } from "./open.js";
import { isRenderPostgresUrl } from "../agents/postgres.js";
import {
  databaseTargetLabel,
  exportFromHttp,
  exportStores,
  importPersistence,
  parsePersistenceExportText,
  resetKeepingSeed,
  serializePersistenceExport,
  type ImportCounts,
  type ResetCounts,
} from "./transfer.js";

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const HELP = `Usage (from the repo root; the extra -- is required so pnpm forwards the flags):
  pnpm --filter @mesa/backend db:export -- --out <file> [--base-url <url>]
  pnpm --filter @mesa/backend db:import -- --file <file>
  pnpm --filter @mesa/backend db:reset -- --yes

export with DATABASE_URL reads Postgres (agents, runs, traces) and does not insert the seed.
export with --base-url reads a running backend over HTTP. Use that to copy an in-memory process.
Do not pass both. Import and reset require DATABASE_URL. They do not print the URL.

import validates every document, upserts, and keeps the created_at already stored for that id.
A missing id is inserted with the created_at from the file. Rows absent from the file stay.
reset deletes runs, traces, and agents other than reference-shop and gift-desk.
A valid seed that is not older than its fixture is kept. An invalid or older seed is rewritten from its fixture.
There is no HTTP reset route.`;

interface ParsedArgs {
  command: "export" | "import" | "reset" | "help";
  out?: string;
  file?: string;
  baseUrl?: string;
  yes: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let command: ParsedArgs["command"] | undefined;
  let out: string | undefined;
  let file: string | undefined;
  let baseUrl: string | undefined;
  let yes = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      return { command: "help", yes: false };
    }
    if (arg === "export" || arg === "import" || arg === "reset") {
      if (command) throw new Error(`Unexpected extra command ${arg}.`);
      command = arg;
      continue;
    }
    if (arg === "--yes") {
      yes = true;
      continue;
    }
    if (arg === "--out" || arg === "--file" || arg === "--base-url") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      index += 1;
      if (arg === "--out") out = value;
      else if (arg === "--file") file = value;
      else baseUrl = value;
      continue;
    }
    throw new Error(`Unknown argument ${arg ?? ""}.`);
  }
  if (!command) throw new Error("Missing command. Pass export, import, or reset.");
  return { command, out, file, baseUrl, yes };
}

/**
 * Apply KEY=value lines from an env file. Blank values already in `env` are filled.
 * A non-blank value already in `env` wins, so a shell export beats the file.
 * Lines may use CR LF. A leading `export ` and a UTF-8 BOM are ignored.
 */
export function applyEnvFile(text: string, env: NodeJS.ProcessEnv): void {
  const body = text.replace(/^\uFEFF/, "");
  for (const rawLine of body.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const line = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    const current = env[key];
    if (current !== undefined && current.trim() !== "") continue;
    env[key] = value;
  }
}

/** Read `apps/backend/.env` when this script's cwd is that package. Missing file is a no-op. */
export function loadOptionalEnvFile(path: string, env: NodeJS.ProcessEnv): void {
  if (!existsSync(path)) return;
  applyEnvFile(readFileSync(path, "utf8"), env);
}

/** A relative path is resolved from the directory where pnpm was started (`INIT_CWD`). */
export function resolveCliPath(file: string, env: NodeJS.ProcessEnv, cwd = process.cwd()): string {
  const fromShell = env.INIT_CWD?.trim() ?? "";
  const base = fromShell === "" ? cwd : fromShell;
  return resolve(base, file);
}

function databaseUrl(env: NodeJS.ProcessEnv): string {
  return env.DATABASE_URL?.trim() ?? "";
}

function formatImport(counts: ImportCounts): string {
  const line = (label: string, row: ImportCounts["agents"]): string =>
    `${label}: ${row.inserted + row.updated} (${row.inserted} inserted, ${row.updated} updated)`;
  return [line("agents", counts.agents), line("runs", counts.runs), line("traces", counts.traces)].join("\n");
}

function formatReset(counts: ResetCounts, target: string): string {
  const seed = Object.entries(counts.seed)
    .map(([agentId, result]) => formatSeedLine(agentId, result))
    .join("\n");
  return `Deleted ${counts.agents_deleted} agents, ${counts.runs_deleted} runs, and ${counts.traces_deleted} traces on ${target}.\n${seed}`;
}

function formatSeedLine(agentId: string, result: ResetCounts["seed"][string]): string {
  if (result === "kept") {
    return `Kept ${agentId}. A valid seed that is not older than the fixture is not rewritten.`;
  }
  if (result === "refreshed") {
    return `Rewrote ${agentId} from the fixture because the stored row was invalid or older than the fixture.`;
  }
  return `Inserted ${agentId} because that id was missing.`;
}

async function withStores<T>(
  env: NodeJS.ProcessEnv,
  seed: boolean,
  body: (stores: {
    agents: Awaited<ReturnType<typeof openAgentStore>>;
    runs: Awaited<ReturnType<typeof openRunStore>>;
  }) => Promise<T>,
): Promise<T> {
  const agents = await openAgentStore(env, { seed });
  const runs = await openRunStore(env).catch(async (error: unknown) => {
    await agents.close();
    throw error;
  });
  try {
    return await body({ agents, runs });
  } finally {
    await runs.close();
    await agents.close();
  }
}

/**
 * Backup, restore, and jury reset. Returns a process exit code.
 * `env` is explicit so tests do not read a developer's DATABASE_URL.
 */
export async function runPersistenceCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  io: CliIo = {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  },
): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args.command === "help") {
      io.stdout(HELP);
      return 0;
    }
    if (args.command === "export") return await runExport(args, env, io);
    if (args.command === "import") return await runImport(args, env, io);
    return await runReset(args, env, io);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runExport(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  if (!args.out) throw new Error("export requires --out <file>.");
  if (args.yes) throw new Error("export does not take --yes.");
  if (args.file) throw new Error("export takes --out, not --file.");
  const url = databaseUrl(env);
  if (args.baseUrl && url !== "") {
    throw new Error(
      "Pass either DATABASE_URL or --base-url, not both. Unset DATABASE_URL to read a running in-memory backend.",
    );
  }
  const path = resolveCliPath(args.out, env);
  if (args.baseUrl) {
    const exported = await exportFromHttp(args.baseUrl);
    writeFileSync(path, serializePersistenceExport(exported.data), { encoding: "utf8" });
    io.stderr(exported.advisory);
    io.stdout(
      `Wrote ${path}\nsource: http ${args.baseUrl} (agent_store=${exported.agent_store}, run_store=${exported.run_store})\ncreated_at: order\nagents: ${exported.data.agents.length}\nruns: ${exported.data.runs.length}\ntraces: ${exported.data.traces.length}`,
    );
    return 0;
  }
  if (url === "") {
    throw new Error(
      "Refusing to export this process. An in-memory backend keeps its rows in the process that is already running. Pass --base-url http://127.0.0.1:3001 while that process is up, or set DATABASE_URL to export Postgres.",
    );
  }
  const data = await withStores(env, false, ({ agents, runs }) => exportStores(agents, runs));
  writeFileSync(path, serializePersistenceExport(data), { encoding: "utf8" });
  io.stdout(
    `Wrote ${path}\nsource: postgres ${databaseTargetLabel(url)}\ncreated_at: column\nagents: ${data.agents.length}\nruns: ${data.runs.length}\ntraces: ${data.traces.length}`,
  );
  return 0;
}

async function runImport(
  args: ParsedArgs,
  env: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  if (!args.file) throw new Error("import requires --file <file>.");
  if (args.out) throw new Error("import takes --file, not --out.");
  if (args.baseUrl) {
    throw new Error(
      "import cannot write through HTTP. POST /runs starts a batch. It does not restore a saved document. Set DATABASE_URL and omit --base-url.",
    );
  }
  if (args.yes) throw new Error("import does not take --yes. It upserts. It does not wipe rows that are missing from the file.");
  const url = databaseUrl(env);
  if (url === "") throw new Error("import requires DATABASE_URL. A new memory process would not keep the rows.");
  const path = resolveCliPath(args.file, env);
  const text = readFileSync(path, "utf8");
  const data = parsePersistenceExportText(text);
  if (isRenderPostgresUrl(url)) {
    io.stderr(
      `DATABASE_URL points at a Render host (${databaseTargetLabel(url)}). Import upserts into that database. Export a copy first if you do not already have one.`,
    );
  }
  const counts = await withStores(env, false, async ({ agents, runs }) => {
    const imported = await importPersistence(agents, runs, data);
    await agents.seedIfMissing();
    return imported;
  });
  io.stdout(
    `Imported ${path} into ${databaseTargetLabel(url)}\n${formatImport(counts)}\nreference-shop and gift-desk are present (inserted when missing; rewritten when the stored row is invalid or older than the fixture).`,
  );
  return 0;
}

async function runReset(args: ParsedArgs, env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  if (args.out || args.file || args.baseUrl) {
    throw new Error("reset takes --yes and DATABASE_URL. It does not read a file or an HTTP URL.");
  }
  const url = databaseUrl(env);
  if (url === "") {
    throw new Error(
      "reset requires DATABASE_URL. To drop an in-memory backend, stop that process. The next start has the seed and no runs.",
    );
  }
  const target = databaseTargetLabel(url);
  if (!args.yes) {
    throw new Error(
      `Refusing to reset ${target} without --yes. This deletes every run, every trace, and every agent except reference-shop and gift-desk. Those seed rows are kept. Export first.`,
    );
  }
  if (isRenderPostgresUrl(url)) {
    io.stderr(
      `DATABASE_URL points at a Render host (${target}). Free Render Postgres has no backups. This deletes hosted rows. The reference-shop and gift-desk rows are kept.`,
    );
  }
  const counts = await withStores(env, false, ({ agents, runs }) => resetKeepingSeed(agents, runs));
  io.stdout(formatReset(counts, target));
  return 0;
}

const entry = process.argv[1];
const invoked = entry !== undefined && import.meta.url === pathToFileURL(entry).href;
if (invoked) {
  loadOptionalEnvFile(resolve(process.cwd(), ".env"), process.env);
  runPersistenceCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}

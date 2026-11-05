/** Offline evalset generation. CI and tests set this instead of a live key. */
export function readEvalsetStub(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.MESA_EVALSET_STUB?.trim().toLowerCase() ?? "";
  return value === "1" || value === "true" || value === "yes";
}

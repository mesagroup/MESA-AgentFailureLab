import type { FastifyInstance } from "fastify";

export async function startLibrary(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const specifier = new URL("../../../services/mock-library/src/app.ts", import.meta.url).href;
  const loaded = (await import(specifier)) as {
    buildApp: (options?: { logger?: boolean }) => FastifyInstance;
  };
  const library = loaded.buildApp({ logger: false });
  const baseUrl = await library.listen({ port: 0, host: "127.0.0.1" });
  return {
    baseUrl,
    close: async () => {
      await library.close();
    },
  };
}

export async function startMockShop(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const specifier = new URL("../../../services/mock-shop/src/app.ts", import.meta.url).href;
  const loaded = (await import(specifier)) as {
    buildApp: (options?: { logger?: boolean }) => FastifyInstance;
  };
  const shop = loaded.buildApp({ logger: false });
  const baseUrl = await shop.listen({ port: 0, host: "127.0.0.1" });
  return {
    baseUrl,
    close: async () => {
      await shop.close();
    },
  };
}

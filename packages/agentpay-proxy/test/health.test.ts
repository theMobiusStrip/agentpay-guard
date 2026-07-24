import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AtomicStore } from "@themobiusstrip/agentpay-guard";
import { createPaymentProxy } from "../src/proxy.js";
import { DEFAULTS } from "../src/config.js";

const servers = new Set<Server>();

afterEach(async () => {
  for (const server of servers) {
    if (!server.listening) continue;
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) {
          rejectClose(new Error(error.message, { cause: error }));
        }
        else resolveClose();
      });
    });
  }
  servers.clear();
});

describe("proxy store readiness", () => {
  it("reports 503 after a store failure latches guard unhealthy", async () => {
    const brokenStore: AtomicStore = {
      tryReserve: async () => {
        throw new Error("store down");
      },
      transition: async () => false,
      putIfAbsent: async () => true,
      removeDedup: async () => {},
      releaseExpired: async () => 0,
      recoverAfterRestart: async () => ({
        markedUnknown: 0,
        expired: 0,
      }),
      get: async () => undefined,
      committedAmount: async () => 0n,
    };
    const { app, guard } = createPaymentProxy(
      `0x${"11".repeat(32)}`,
      { ...DEFAULTS },
      { store: brokenStore },
    );
    const server = app.listen(0, "127.0.0.1");
    servers.add(server);
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server address unavailable");
    }

    const initial = await fetch(
      `http://127.0.0.1:${address.port}/healthz`,
    );
    expect(initial.status).toBe(200);
    await expect(initial.json()).resolves.toMatchObject({
      ready: true,
      store: "ready",
    });

    const requirements = {
      scheme: "exact",
      network: "eip155:84532",
      asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
      amount: "1",
      payTo: "0x2222222222222222222222222222222222222222",
      maxTimeoutSeconds: 20,
    };
    await expect(
      guard.before({
        paymentRequired: {
          x402Version: 2,
          resource: { url: "https://example.test" },
          accepts: [requirements],
        },
        selectedRequirements: requirements,
      }),
    ).resolves.toMatchObject({ abort: true });
    expect(guard.isHealthy()).toBe(false);

    const failed = await fetch(
      `http://127.0.0.1:${address.port}/healthz`,
    );
    expect(failed.status).toBe(503);
    await expect(failed.json()).resolves.toMatchObject({
      ready: false,
      store: "unavailable",
    });
  });
});

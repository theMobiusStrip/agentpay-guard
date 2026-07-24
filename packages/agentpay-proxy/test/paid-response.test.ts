import { once } from "node:events";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AtomicStore } from "@themobiusstrip/agentpay-guard";

vi.mock("@x402/fetch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@x402/fetch")>();
  return {
    ...actual,
    wrapFetchWithPayment: () => async () =>
      new Response("merchant body", {
        status: 201,
        headers: { "PAYMENT-RESPONSE": "settlement-receipt" },
      }),
  };
});

const { createPaymentProxy } = await import("../src/proxy.js");
const { DEFAULTS } = await import("../src/config.js");

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

describe("paid response reconciliation", () => {
  it("keeps paid merchant response when reconciliation fails", async () => {
    const store: AtomicStore = {
      tryReserve: async () => {
        throw new Error("unexpected reserve");
      },
      transition: async () => false,
      putIfAbsent: async () => true,
      removeDedup: async () => {},
      releaseExpired: async () => {
        throw new Error("store down after payment");
      },
      recoverAfterRestart: async () => ({
        markedUnknown: 0,
        expired: 0,
      }),
      get: async () => undefined,
      committedAmount: async () => 0n,
    };
    const { app } = createPaymentProxy(
      `0x${"11".repeat(32)}`,
      { ...DEFAULTS },
      { store },
    );
    const server = app.listen(0, "127.0.0.1");
    servers.add(server);
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server address unavailable");
    }

    const response = await fetch(
      `http://127.0.0.1:${address.port}/paid-fetch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://merchant.example/paid",
          intentId: "paid-response-regression",
        }),
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 201,
      intentId: "paid-response-regression",
      body: "merchant body",
      settlement: "settlement-receipt",
    });

    const health = await fetch(
      `http://127.0.0.1:${address.port}/healthz`,
    );
    expect(health.status).toBe(503);
  });
});

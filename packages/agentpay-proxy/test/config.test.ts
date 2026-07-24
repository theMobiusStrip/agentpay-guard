import { describe, expect, it } from "vitest";
import {
  configFromEnv,
  DEFAULTS,
  DEFAULT_STATE_DB,
  storeConfigFromEnv,
} from "../src/config.js";

describe("configFromEnv", () => {
  it("returns defaults for an empty environment", () => {
    const cfg = configFromEnv({});
    expect(cfg).toEqual({ ...DEFAULTS });
    expect(cfg.mandate).toBeUndefined();
    expect(cfg.allowedHosts).toBeUndefined();
  });

  it("parses budget/window/ceiling knobs", () => {
    const cfg = configFromEnv({
      PORT: "5000",
      WINDOW_MS: "60000",
      CAP: "1000000",
      AGG_CAP: "5000000",
      CEILING_S: "30",
    });
    expect(cfg.port).toBe(5000);
    expect(cfg.windowMs).toBe(60_000);
    expect(cfg.perMandateCap).toBe(1_000_000n);
    expect(cfg.principalAggregateCap).toBe(5_000_000n);
    expect(cfg.ceilingSeconds).toBe(30);
  });

  it("rejects malformed money knobs instead of falling back", () => {
    expect(() => configFromEnv({ CAP: "0.10" })).toThrow(/CAP/);
    expect(() => configFromEnv({ PORT: "-1" })).toThrow(/PORT/);
  });

  it("builds a pinned mandate and lowercases the payee", () => {
    const cfg = configFromEnv({
      MANDATE: "1",
      PIN_PAYTO: "0x3B8f39FD568eAa59d13d138e41606D0201bBD652",
      PIN_MAX: "50000",
    });
    expect(cfg.mandate).toEqual({
      payTo: "0x3b8f39fd568eaa59d13d138e41606d0201bbd652",
      maxAmount: 50_000n,
    });
  });

  it("fails closed when MANDATE=1 lacks a valid PIN_PAYTO", () => {
    expect(() => configFromEnv({ MANDATE: "1" })).toThrow(/PIN_PAYTO/);
    expect(() => configFromEnv({ MANDATE: "1", PIN_PAYTO: "not-an-address" })).toThrow(/PIN_PAYTO/);
  });

  it("parses ALLOWED_HOSTS as a trimmed lowercase list", () => {
    const cfg = configFromEnv({ ALLOWED_HOSTS: "x402.org, LocalHost:4021 ," });
    expect(cfg.allowedHosts).toEqual(["x402.org", "localhost:4021"]);
  });
});

describe("storeConfigFromEnv", () => {
  it("defaults CLI state to SQLite", () => {
    expect(storeConfigFromEnv({})).toEqual({
      kind: "sqlite",
      stateDb: DEFAULT_STATE_DB,
    });
  });

  it("supports explicit disposable memory mode", () => {
    expect(storeConfigFromEnv({ STORE: "memory" })).toEqual({
      kind: "memory",
      stateDb: DEFAULT_STATE_DB,
    });
  });

  it("accepts an explicit state path", () => {
    expect(
      storeConfigFromEnv({
        STORE: "sqlite",
        STATE_DB: "state/custom.sqlite",
      }),
    ).toEqual({
      kind: "sqlite",
      stateDb: "state/custom.sqlite",
    });
  });

  it("rejects unknown store modes and empty paths", () => {
    expect(() => storeConfigFromEnv({ STORE: "redis" })).toThrow(
      /STORE/,
    );
    expect(() => storeConfigFromEnv({ STATE_DB: " " })).toThrow(
      /STATE_DB/,
    );
  });
});

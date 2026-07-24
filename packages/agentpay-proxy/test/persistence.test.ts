import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { openSqliteStore } from "@themobiusstrip/agentpay-guard/sqlite";
import { reserveReq } from "../../agentpay-guard/test/helpers.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cleanupDirs = new Set<string>();
const children = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }
  children.clear();
  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  cleanupDirs.clear();
});

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (address === null || typeof address === "string") {
    throw new Error("failed to allocate test port");
  }
  const port = address.port;
  await new Promise<void>((resolveClose, rejectClose) => {
    probe.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
  return port;
}

function startCli(
  stateDb: string,
  port: number,
  payerKey: `0x${string}`,
): ChildProcess {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "packages/agentpay-proxy/src/cli.ts",
      "serve",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        STORE: "sqlite",
        STATE_DB: stateDb,
        HOST: "127.0.0.1",
        PORT: String(port),
        PAYER_PK: payerKey,
        WINDOW_MS: "300000",
        CAP: "100000",
        AGG_CAP: "200000",
        CEILING_S: "300",
        NODE_NO_WARNINGS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(child);
  return child;
}

async function seedThenCrash(
  stateDb: string,
  principalId: string,
  dedupKey: string,
  now: number,
): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "packages/agentpay-proxy/test/persistence-worker.ts",
      stateDb,
      principalId,
      dedupKey,
      String(now),
    ],
    {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  children.add(child);
  await new Promise<void>((resolveSeeded, rejectSeeded) => {
    const onMessage = (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "kind" in message &&
        (message as { kind?: unknown }).kind === "seeded"
      ) {
        cleanup();
        resolveSeeded();
      }
    };
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => {
      cleanup();
      rejectSeeded(
        new Error(
          `seed worker exited early: ${String(code)}/${String(signal)}`,
        ),
      );
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
  await stopChild(child, "SIGKILL");
}

async function waitForOutput(
  child: ChildProcess,
  pattern: RegExp,
): Promise<string> {
  let output = "";
  return new Promise<string>((resolveOutput, rejectOutput) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectOutput(
        new Error(`CLI output timeout; output:\n${output}`),
      );
    }, 5_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (pattern.test(output)) {
        cleanup();
        resolveOutput(output);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      rejectOutput(
        new Error(
          `CLI exited before ready (${String(code)}/${String(signal)}):\n${output}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", onExit);
  });
}

async function stopChild(
  child: ChildProcess,
  signal: NodeJS.Signals,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  await once(child, "exit");
  children.delete(child);
}

describe("proxy CLI persistent store", () => {
  it(
    "preserves cap and dedup across abrupt death and restart",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "agentpay-proxy-"));
      cleanupDirs.add(dir);
      const stateDb = join(dir, "state.sqlite");
      const payerKey = `0x${"11".repeat(32)}` as const;
      const principalId = `payer:${privateKeyToAccount(payerKey).address}`;
      const dedupKey = `${principalId}|restart-intent`;
      const now = Date.now();

      await seedThenCrash(stateDb, principalId, dedupKey, now);

      const port = await freePort();
      const first = startCli(stateDb, port, payerKey);
      expect(
        await waitForOutput(first, /recover: 1 unknown, 0 expired/),
      ).toMatch(
        /recover: 1 unknown, 0 expired/,
      );
      await stopChild(first, "SIGKILL");

      const second = startCli(stateDb, port, payerKey);
      await waitForOutput(second, /recover:/);

      const verifier = await openSqliteStore(stateDb);
      expect(
        await verifier.tryReserve(
          reserveReq({
            principalId,
            mandateId: "__no_mandate__",
            amount: 1n,
            cap: 100_000n,
            now: now + 2_000,
            windowMs: 300_000,
          }),
        ),
      ).toMatchObject({ ok: false, reason: "cap_exceeded" });
      expect(
        await verifier.putIfAbsent(
          dedupKey,
          360_000,
          now + 2_000,
        ),
      ).toBe(false);
      await verifier.close();

      await stopChild(second, "SIGTERM");
    },
    15_000,
  );
});

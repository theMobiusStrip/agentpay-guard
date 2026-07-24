import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = mkdtempSync(join(tmpdir(), "agentpay-pack-smoke-"));
const tarDir = join(tempRoot, "tarballs");
const installDir = join(tempRoot, "consumer");
mkdirSync(tarDir);
mkdirSync(installDir);

function pack(relativePackageDir) {
  const output = execFileSync(
    "npm",
    [
      "pack",
      "--silent",
      "--pack-destination",
      tarDir,
    ],
    {
      cwd: join(repoRoot, relativePackageDir),
      encoding: "utf8",
    },
  ).trim();
  const filename = output.split(/\s+/).at(-1);
  if (filename === undefined || !filename.endsWith(".tgz")) {
    throw new Error(`npm pack returned unexpected output: ${output}`);
  }
  return join(tarDir, filename);
}

function assertCopiedPackage(packageName) {
  const packagePath = join(
    installDir,
    "node_modules",
    ...packageName.split("/"),
  );
  if (lstatSync(packagePath).isSymbolicLink()) {
    throw new Error(`${packageName} installed as workspace link`);
  }
  return packagePath;
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("failed to allocate smoke-test port");
  }
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function waitForReady(child) {
  let output = "";
  return new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectReady(new Error(`packed CLI startup timeout:\n${output}`));
    }, 10_000);
    const onData = (chunk) => {
      output += chunk.toString("utf8");
      if (/recover: 1 unknown, 0 expired/.test(output)) {
        cleanup();
        resolveReady();
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      rejectReady(
        new Error(
          `packed CLI exited before recovery (${String(code)}/${String(signal)}):\n${output}`,
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

let child;
try {
  const guardTar = pack("packages/agentpay-guard");
  const proxyTar = pack("packages/agentpay-proxy");
  writeFileSync(
    join(installDir, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
  );
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--no-save",
      guardTar,
      proxyTar,
    ],
    {
      cwd: installDir,
      stdio: "inherit",
    },
  );

  const guardPackage = assertCopiedPackage(
    "@themobiusstrip/agentpay-guard",
  );
  const proxyPackage = assertCopiedPackage(
    "@themobiusstrip/agentpay-proxy",
  );

  const guardManifest = JSON.parse(
    readFileSync(join(guardPackage, "package.json"), "utf8"),
  );
  const proxyManifest = JSON.parse(
    readFileSync(join(proxyPackage, "package.json"), "utf8"),
  );
  const sqliteExport = guardManifest.exports?.["./sqlite"];
  if (typeof sqliteExport?.import !== "string") {
    throw new Error(
      `packed guard missing SQLite export: ${JSON.stringify(guardManifest.exports)}`,
    );
  }
  const sqliteEntry = resolve(guardPackage, sqliteExport.import);
  if (!sqliteEntry.startsWith(guardPackage)) {
    throw new Error("SQLite subpath did not resolve from packed guard");
  }
  const { openSqliteStore } = await import(
    pathToFileURL(sqliteEntry).href
  );
  const stateDb = join(tempRoot, "state.sqlite");
  const now = Date.now();
  const store = await openSqliteStore(stateDb);
  const recovery = await store.recoverAfterRestart(now, 300_000);
  if (recovery.markedUnknown !== 0 || recovery.expired !== 0) {
    throw new Error("fresh packed store recovered unexpected rows");
  }
  const reservation = await store.tryReserve({
    principalId: "pack-smoke",
    mandateId: "pack-smoke",
    amount: 100n,
    payTo: "0xpack-smoke",
    now,
    windowMs: 300_000,
    cap: 100n,
    safeReleaseAt: now + 60_000,
    recoveryReleaseAt: now + 360_000,
  });
  if (!reservation.ok) throw new Error("packed store reserve failed");
  await store.close();

  const proxyExport = proxyManifest.exports?.["."];
  if (typeof proxyExport?.import !== "string") {
    throw new Error("packed proxy missing root import");
  }
  const proxyEntry = resolve(proxyPackage, proxyExport.import);
  if (!proxyEntry.startsWith(proxyPackage)) {
    throw new Error("proxy root did not resolve from packed package");
  }
  const { configFromEnv, createPaymentProxy } = await import(
    pathToFileURL(proxyEntry).href
  );
  const maxConfig = configFromEnv({ MAX_PAYMENT: "1" });
  const { guard: packedGuard, policy: packedPolicy } = createPaymentProxy(
    `0x${"11".repeat(32)}`,
    maxConfig,
  );
  if (packedPolicy.maxPaymentAmount !== 1n) {
    throw new Error("packed proxy dropped MAX_PAYMENT policy");
  }
  const requirements = {
    scheme: "exact",
    network: "eip155:84532",
    asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    amount: "2",
    payTo: "0x2222222222222222222222222222222222222222",
    maxTimeoutSeconds: 20,
  };
  const blocked = await packedGuard.before({
    paymentRequired: {
      x402Version: 2,
      resource: { url: "https://example.test" },
      accepts: [requirements],
    },
    selectedRequirements: requirements,
  });
  if (
    blocked?.abort !== true ||
    !blocked.reason.includes("payment_amount_exceeds")
  ) {
    throw new Error("packed proxy did not enforce MAX_PAYMENT");
  }

  const port = await freePort();
  child = spawn(
    process.execPath,
    [join(proxyPackage, "dist", "cli.js"), "serve"],
    {
      cwd: installDir,
      env: {
        ...process.env,
        STORE: "sqlite",
        STATE_DB: stateDb,
        HOST: "127.0.0.1",
        PORT: String(port),
        PAYER_PK: `0x${"11".repeat(32)}`,
        WINDOW_MS: "300000",
        CAP: "100",
        AGG_CAP: "100",
        CEILING_S: "300",
        NODE_NO_WARNINGS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await waitForReady(child);
  child.kill("SIGTERM");
  await once(child, "exit");
  if (child.exitCode !== 0) {
    throw new Error(`packed CLI shutdown failed: ${String(child.exitCode)}`);
  }
  child = undefined;
  console.log("packed artifact smoke: PASS");
} finally {
  if (
    child !== undefined &&
    child.exitCode === null &&
    child.signalCode === null
  ) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
  rmSync(tempRoot, { recursive: true, force: true });
}

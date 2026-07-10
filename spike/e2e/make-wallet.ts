/**
 * Generate a throwaway payer wallet for the Base Sepolia e2e run and print its
 * address to fund. Saves to spike/e2e/.wallet.json (gitignored). Do NOT reuse a
 * real key here.
 *
 * Run: npm run -w @agentpay-guard/spike e2e:wallet
 */
import { writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));
const walletPath = join(here, ".wallet.json");

if (existsSync(walletPath)) {
  const account = privateKeyToAccount(
    (await import(walletPath, { with: { type: "json" } })).default.privateKey,
  );
  console.log(`Existing wallet: ${account.address}`);
  console.log(`(delete ${walletPath} to regenerate)`);
} else {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  writeFileSync(walletPath, JSON.stringify({ privateKey, address: account.address }, null, 2));
  console.log(`New payer wallet: ${account.address}`);
}

console.log("\nFund on Base Sepolia before the e2e run:");
console.log("  - USDC : https://faucet.circle.com  (Base Sepolia USDC)");
console.log("  - ETH  : https://www.alchemy.com/faucets/base-sepolia  (gas)");

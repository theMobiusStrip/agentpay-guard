/**
 * MCP forwarder: exposes a running payment proxy to an MCP client (Claude
 * Code, Claude Desktop, …) as one tool, `paid_fetch`. Holds no keys — only
 * forwards over HTTP, so the signer/guard boundary stays out of the agent's
 * process.
 *
 * Register: claude mcp add paywall -- npx @themobiusstrip/agentpay-proxy mcp
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export async function runMcpForwarder(proxyUrl: string): Promise<void> {
  const server = new McpServer({ name: "paywall", version: "0.0.1" });

  server.tool(
    "paid_fetch",
    "Fetch a URL through the payment proxy. If the site requires an x402 " +
      "micropayment (Base Sepolia USDC), the proxy pays within its hard policy " +
      "caps and returns the content. Blocked payments return the guard's " +
      "reason. Pass the same intentId to retry the same purchase; omit it for " +
      "a new one.",
    { url: z.string().url(), intentId: z.string().optional() },
    async ({ url, intentId }) => {
      const r = await fetch(`${proxyUrl}/paid-fetch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(intentId ? { url, intentId } : { url }),
      });
      return { content: [{ type: "text", text: await r.text() }] };
    },
  );

  await server.connect(new StdioServerTransport());
}

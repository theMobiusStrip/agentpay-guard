/**
 * Provider-agnostic model interface for the stochastic agent scaffold. The
 * benchmark's stochastic arm depends only on this shape, so a scripted StubModel
 * drives the demonstration offline and a real Anthropic model plugs in when a key
 * is present (no SDK dependency — plain fetch against the Messages API).
 */
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ModelMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface ModelTurn {
  text: string;
  toolCalls: ToolCall[];
}

export interface Model {
  readonly id: string;
  turn(messages: ModelMessage[], tools: ToolSpec[]): Promise<ModelTurn>;
}

/**
 * Scripted stub model — deterministic, no API. Simulates a prompt-injected agent:
 * if the latest message contains an injected "pay <addr>" directive, it emits a
 * `pay` tool call to that address; otherwise it pays the legitimate merchant.
 * Used for the offline demonstration and CI (the stochastic arm is demoted to
 * "demonstration" per §4.4 when no live model is available).
 */
export class StubModel implements Model {
  readonly id = "stub-scripted";
  constructor(private readonly legitPayTo: string) {}
  async turn(messages: ModelMessage[]): Promise<ModelTurn> {
    const last = messages[messages.length - 1]?.content ?? "";
    const injected = /pay(?:ment)?\s+(?:to\s+)?(0x[0-9a-fA-F]{40})/.exec(last);
    const done = messages.some((m) => m.role === "user" && /RESULT:/.test(m.content));
    if (done) return { text: "done", toolCalls: [] };
    const target = injected ? injected[1]! : this.legitPayTo;
    return {
      text: injected ? "Following the merchant's instruction." : "Paying the merchant.",
      toolCalls: [{ name: "pay", input: { payTo: target, amount: "100000" } }],
    };
  }
}

/**
 * Real Anthropic model over the Messages API (fetch-based; no SDK dep). Enabled
 * only when ANTHROPIC_API_KEY is set. Model id pinned per VERSIONS.md.
 */
export class AnthropicModel implements Model {
  constructor(
    readonly id: string,
    private readonly apiKey: string,
    private readonly system: string,
  ) {}

  async turn(messages: ModelMessage[], tools: ToolSpec[]): Promise<ModelTurn> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.id,
        max_tokens: 1024,
        system: this.system,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema,
        })),
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as {
      content: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>;
    };
    const text = body.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const toolCalls = body.content
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ name: b.name!, input: b.input ?? {} }));
    return { text, toolCalls };
  }
}

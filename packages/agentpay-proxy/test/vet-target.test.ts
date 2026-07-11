import { describe, expect, it } from "vitest";
import { vetTarget } from "../src/proxy.js";

/** Narrow the union — throws if vetTarget returned an error (test-only helper). */
function ok(r: ReturnType<typeof vetTarget>): { url: string; host: string } {
  if ("error" in r) throw new Error(`expected ok, got error: ${r.error}`);
  return r;
}

describe("vetTarget", () => {
  it("accepts http and https and lowercases the host", () => {
    expect(ok(vetTarget("https://x402.org/protected", undefined)).host).toBe("x402.org");
    expect(ok(vetTarget("http://LocalHost:4021/article", undefined)).host).toBe("localhost:4021");
  });

  it("rejects non-string / empty input", () => {
    expect(vetTarget(undefined, undefined)).toHaveProperty("error");
    expect(vetTarget("", undefined)).toHaveProperty("error");
    expect(vetTarget(42, undefined)).toHaveProperty("error");
  });

  it("rejects a value that passes a naive prefix test but fails WHATWG parse", () => {
    expect(vetTarget("http://a b c", undefined)).toHaveProperty("error");
  });

  it("rejects non-http(s) schemes by parsed protocol", () => {
    for (const u of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "ftp://h/x"]) {
      expect(vetTarget(u, undefined), u).toHaveProperty("error");
    }
  });

  it("enforces the host allowlist and fails closed on anything not listed", () => {
    const allow = ["x402.org", "localhost:4021"];
    expect(ok(vetTarget("https://x402.org/a", allow)).host).toBe("x402.org");
    expect(vetTarget("https://evil.com/a", allow)).toHaveProperty("error");
    // trailing dot is a different host string -> blocked (fail closed)
    expect(vetTarget("https://x402.org./a", allow)).toHaveProperty("error");
  });

  it("uses the real host, not userinfo, so credential-prefix spoofing is blocked", () => {
    // WHATWG host of this URL is 127.0.0.1; "x402.org" is only userinfo.
    const r = vetTarget("https://x402.org@127.0.0.1/a", ["x402.org"]);
    expect(r).toHaveProperty("error");
    expect(ok(vetTarget("https://x402.org@127.0.0.1/a", undefined)).host).toBe("127.0.0.1");
  });
});

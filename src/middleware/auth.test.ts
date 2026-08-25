import { describe, it, expect } from "bun:test";
import { requestAuthGate } from "./auth";

describe("requestAuthGate", () => {
  it("returns 401 for /api/upload without a token when a secret is set", async () => {
    const gate = requestAuthGate("s3cr3t");
    const res = gate({ request: new Request("http://localhost/api/upload", { method: "POST" }) });
    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(401);
    const body = await res!.json();
    expect(body).toEqual({ error: "Unauthorized", message: "Invalid or missing API token" });
  });

  it("passes through /api/upload when the correct token is present", () => {
    const gate = requestAuthGate("s3cr3t");
    const res = gate({
      request: new Request("http://localhost/api/upload", {
        method: "POST",
        headers: { authorization: "Bearer s3cr3t" },
      }),
    });
    expect(res).toBeUndefined();
  });

  it("returns 401 for /refresh without a token when a secret is set", () => {
    const gate = requestAuthGate("s3cr3t");
    const res = gate({ request: new Request("http://localhost/refresh", { method: "POST" }) });
    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(401);
  });

  it("passes through /min-version.json even without a token", () => {
    const gate = requestAuthGate("s3cr3t");
    const res = gate({ request: new Request("http://localhost/min-version.json") });
    expect(res).toBeUndefined();
  });

  it("passes through everything when no secret is set", () => {
    const gate = requestAuthGate(undefined);
    const res = gate({ request: new Request("http://localhost/api/upload", { method: "POST" }) });
    expect(res).toBeUndefined();
  });
});

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

import { resolveTokenRole, isAllowedForRole } from "./auth";

describe("resolveTokenRole", () => {
  it("resolve admin, web e desconhecido", () => {
    expect(resolveTokenRole("Bearer s3cr3t", "s3cr3t", "w3b")).toBe("admin");
    expect(resolveTokenRole("Bearer w3b", "s3cr3t", "w3b")).toBe("web");
    expect(resolveTokenRole("Bearer x", "s3cr3t", "w3b")).toBeNull();
    expect(resolveTokenRole(undefined, "s3cr3t", "w3b")).toBeNull();
    expect(resolveTokenRole("bearer w3b", "s3cr3t", "w3b")).toBe("web");
  });

  it("igual a API_SECRET vale admin", () => {
    expect(resolveTokenRole("Bearer same", "same", "same")).toBe("admin");
  });
});

describe("requestAuthGate com token web", () => {
  const gate = requestAuthGate("s3cr3t", "w3b");
  const call = (method: string, path: string, token = "w3b") =>
    gate({
      request: new Request(`http://localhost${path}`, {
        method,
        headers: { authorization: `Bearer ${token}` },
      }),
    });

  it("libera a allowlist", () => {
    expect(call("GET", "/api/fleet")).toBeUndefined();
    expect(call("POST", "/api/fleet/t1/force")).toBeUndefined();
    expect(call("DELETE", "/api/fleet/t1")).toBeUndefined();
    expect(call("GET", "/api/releases/history")).toBeUndefined();
    expect(call("POST", "/api/emergency")).toBeUndefined();
    expect(call("GET", "/api/status")).toBeUndefined();
    expect(call("POST", "/api/companies/c1/force")).toBeUndefined();
  });

  it("barra o resto com 403", async () => {
    for (const [m, p] of [
      ["POST", "/api/upload"],
      ["PUT", "/api/upload/a.exe"],
      ["DELETE", "/api/files/a.exe"],
      ["GET", "/api/files"],
      ["POST", "/api/releases"],
      ["POST", "/refresh"],
    ]) {
      const res = call(m, p);
      expect(res?.status).toBe(403);
    }
    const body = await call("POST", "/api/upload")!.json();
    expect(body).toEqual({ error: "Forbidden", message: "Token not allowed for this route" });
  });

  it("modo aberto sem API_SECRET", () => {
    const open = requestAuthGate(undefined, "w3b");
    expect(open({ request: new Request("http://localhost/api/upload", { method: "POST" }) })).toBeUndefined();
  });

  it("admin continua passando em upload", () => {
    expect(call("POST", "/api/upload", "s3cr3t")).toBeUndefined();
  });

  it("isAllowedForRole admin = tudo", () => {
    expect(isAllowedForRole("admin", "DELETE", "/api/files/x")).toBe(true);
  });
});

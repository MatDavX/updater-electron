import { describe, it, expect } from "bun:test";
import { Elysia } from "elysia";
import { StateStore } from "../state-store";
import { fleetPublicRoutes } from "./fleet-public";

function app() {
  const store = new StateStore("/dev/null/never.json", { debounceMs: 1e9 });
  return { store, app: new Elysia().use(fleetPublicRoutes(store)) };
}

const valid = { terminalId: "t1", terminalName: "CAIXA-01", version: "1.2.0", platform: "win32", arch: "x64", userEmail: "ana@loja.com" };

describe("POST /fleet/heartbeat", () => {
  it("returns 204 and records the terminal", async () => {
    const { store, app: a } = app();
    const res = await a.handle(new Request("http://localhost/fleet/heartbeat", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(valid),
    }));
    expect(res.status).toBe(204);
    expect(store.get().fleet.t1.userEmail).toBe("ana@loja.com");
  });

  it("rejects payload without terminalId (422)", async () => {
    const { app: a } = app();
    const { terminalId: _omit, ...bad } = valid;
    const res = await a.handle(new Request("http://localhost/fleet/heartbeat", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bad),
    }));
    expect(res.status).toBe(422);
  });

  it("rejects oversized strings (422)", async () => {
    const { app: a } = app();
    const res = await a.handle(new Request("http://localhost/fleet/heartbeat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...valid, terminalName: "x".repeat(201) }),
    }));
    expect(res.status).toBe(422);
  });
});

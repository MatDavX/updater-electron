import { describe, it, expect } from "bun:test";
import { Elysia } from "elysia";
import { StateStore } from "../state-store";
import { SSEBroker } from "../sse";
import { upsertHeartbeat } from "../fleet";
import { fleetAdminRoutes } from "./fleet-admin";
import { minVersionRoutes } from "./min-version";

function setup() {
  const store = new StateStore("/dev/null/never.json", { debounceMs: 1e9 });
  const broker = new SSEBroker();
  const app = new Elysia().use(fleetAdminRoutes(store, broker)).use(minVersionRoutes(store));
  upsertHeartbeat(store, { terminalId: "t1", terminalName: "CAIXA-01", version: "1.2.0", platform: "win32", arch: "x64", userEmail: "ana@loja.com" });
  return { store, broker, app };
}
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("/api/fleet", () => {
  it("GET lists terminals with online + forcedMinVersion", async () => {
    const { app, broker } = setup();
    broker.subscribe(() => {}, { terminalId: "t1" });
    const res = await app.handle(new Request("http://localhost/api/fleet"));
    const data = await res.json();
    expect(data.terminals).toHaveLength(1);
    expect(data.terminals[0]).toMatchObject({ terminalId: "t1", online: true, forcedMinVersion: null, userEmail: "ana@loja.com" });
  });

  it("POST /:id/force stores and pushes SSE emergency only to that terminal", async () => {
    const { app, broker, store } = setup();
    const got: string[] = [];
    broker.subscribe((m) => got.push(m), { terminalId: "t1" });
    const other: string[] = [];
    broker.subscribe((m) => other.push(m), { terminalId: "t2" });
    const res = await app.handle(new Request("http://localhost/api/fleet/t1/force", json({ minVersion: "1.5.0" })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", terminalId: "t1", minVersion: "1.5.0", online: true });
    expect(store.get().forced.t1.minVersion).toBe("1.5.0");
    expect(got[0]).toBe('event: emergency\ndata: {"minVersion":"1.5.0","version":"1.5.0"}\n\n');
    expect(other).toHaveLength(0);
  });

  it("POST /:id/force rejects non-semver", async () => {
    const { app } = setup();
    const res = await app.handle(new Request("http://localhost/api/fleet/t1/force", json({ minVersion: "latest" })));
    expect(res.status).toBe(400);
  });

  it("DELETE /:id/force clears and pushes emergency-clear to that terminal", async () => {
    const { app, broker, store } = setup();
    const got: string[] = [];
    broker.subscribe((m) => got.push(m), { terminalId: "t1" });
    await app.handle(new Request("http://localhost/api/fleet/t1/force", json({ minVersion: "1.5.0" })));
    const res = await app.handle(new Request("http://localhost/api/fleet/t1/force", { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(store.get().forced.t1).toBeUndefined();
    expect(got[1]).toBe("event: emergency-clear\ndata: {}\n\n");
  });

  it("DELETE /:id removes terminal from inventory", async () => {
    const { app, store } = setup();
    const res = await app.handle(new Request("http://localhost/api/fleet/t1", { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(store.get().fleet.t1).toBeUndefined();
  });
});

describe("GET /min-version.json", () => {
  it("returns max(global, forced) per terminal", async () => {
    const { app, store } = setup();
    store.update((s) => { s.minVersion = "1.3.0"; });
    await app.handle(new Request("http://localhost/api/fleet/t1/force", json({ minVersion: "1.5.0" })));
    expect(await (await app.handle(new Request("http://localhost/min-version.json?terminalId=t1"))).json()).toEqual({ minVersion: "1.5.0" });
    expect(await (await app.handle(new Request("http://localhost/min-version.json?terminalId=t2"))).json()).toEqual({ minVersion: "1.3.0" });
    expect(await (await app.handle(new Request("http://localhost/min-version.json"))).json()).toEqual({ minVersion: "1.3.0" });
  });
});

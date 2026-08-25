import { describe, it, expect, afterEach, beforeAll, afterAll } from "bun:test";
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

// Testes de modo aberto assumem API_SECRET não setado. `Bun.env` carrega o
// `.env` real automaticamente, então numa máquina com API_SECRET configurado
// esses testes 401-ariam — força modo aberto e restaura o valor original.
function forceOpenMode() {
  let original: string | undefined;
  beforeAll(() => {
    original = Bun.env.API_SECRET;
    delete Bun.env.API_SECRET;
  });
  afterAll(() => {
    if (original !== undefined) Bun.env.API_SECRET = original;
  });
}

describe("/api/fleet", () => {
  forceOpenMode();

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

  it("POST /:id/force pushes the EFFECTIVE minVersion (max w/ global), not the forced value, when global is higher", async () => {
    const { app, broker, store } = setup();
    store.update((s) => { s.minVersion = "1.3.0"; });
    const got: string[] = [];
    broker.subscribe((m) => got.push(m), { terminalId: "t1" });
    const res = await app.handle(new Request("http://localhost/api/fleet/t1/force", json({ minVersion: "1.2.0" })));
    expect(res.status).toBe(200);
    // A resposta HTTP ecoa o valor forçado que foi pedido...
    expect(await res.json()).toEqual({ status: "ok", terminalId: "t1", minVersion: "1.2.0", online: true });
    expect(store.get().forced.t1.minVersion).toBe("1.2.0");
    // ...mas o evento SSE carrega a minVersion efetiva (global vence, 1.3.0 > 1.2.0).
    expect(got[0]).toBe('event: emergency\ndata: {"minVersion":"1.3.0","version":"1.3.0"}\n\n');
  });

  it("POST /:id/force rejects non-semver", async () => {
    const { app } = setup();
    const res = await app.handle(new Request("http://localhost/api/fleet/t1/force", json({ minVersion: "latest" })));
    expect(res.status).toBe(400);
  });

  it("POST /:id/force on unknown terminal returns 404 and does not create an orphan", async () => {
    const { app, store } = setup();
    const res = await app.handle(new Request("http://localhost/api/fleet/ghost/force", json({ minVersion: "1.5.0" })));
    expect(res.status).toBe(404);
    expect(store.get().forced.ghost).toBeUndefined();
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

  it("DELETE /:id/force respects an active global emergency (sends emergency, not emergency-clear)", async () => {
    const { app, broker, store } = setup();
    store.update((s) => { s.minVersion = "1.3.0"; });
    const got: string[] = [];
    broker.subscribe((m) => got.push(m), { terminalId: "t1" });
    await app.handle(new Request("http://localhost/api/fleet/t1/force", json({ minVersion: "1.5.0" })));
    const res = await app.handle(new Request("http://localhost/api/fleet/t1/force", { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(store.get().forced.t1).toBeUndefined();
    expect(got[1]).toBe('event: emergency\ndata: {"minVersion":"1.3.0","version":"1.3.0"}\n\n');
  });

  it("DELETE /:id removes terminal from inventory", async () => {
    const { app, store } = setup();
    const res = await app.handle(new Request("http://localhost/api/fleet/t1", { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(store.get().fleet.t1).toBeUndefined();
  });
});

describe("/api/fleet auth", () => {
  const ORIGINAL_SECRET = Bun.env.API_SECRET;

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete Bun.env.API_SECRET;
    else Bun.env.API_SECRET = ORIGINAL_SECRET;
  });

  it("rejects requests without a token when API_SECRET is set", async () => {
    Bun.env.API_SECRET = "s3cr3t";
    const { app } = setup();
    const res = await app.handle(new Request("http://localhost/api/fleet"));
    expect(res.status).toBe(401);
  });

  it("rejects requests with the wrong token when API_SECRET is set", async () => {
    Bun.env.API_SECRET = "s3cr3t";
    const { app } = setup();
    const res = await app.handle(new Request("http://localhost/api/fleet", { headers: { authorization: "Bearer wrong" } }));
    expect(res.status).toBe(401);
  });

  it("allows requests with the correct token when API_SECRET is set", async () => {
    Bun.env.API_SECRET = "s3cr3t";
    const { app } = setup();
    const res = await app.handle(new Request("http://localhost/api/fleet", { headers: { authorization: "Bearer s3cr3t" } }));
    expect(res.status).toBe(200);
  });

  it("keeps GET /min-version.json public even when API_SECRET is set", async () => {
    Bun.env.API_SECRET = "s3cr3t";
    const { app } = setup();
    const res = await app.handle(new Request("http://localhost/min-version.json"));
    expect(res.status).toBe(200);
  });
});

describe("GET /min-version.json", () => {
  forceOpenMode();

  it("returns max(global, forced) per terminal", async () => {
    const { app, store } = setup();
    store.update((s) => { s.minVersion = "1.3.0"; });
    await app.handle(new Request("http://localhost/api/fleet/t1/force", json({ minVersion: "1.5.0" })));
    expect(await (await app.handle(new Request("http://localhost/min-version.json?terminalId=t1"))).json()).toEqual({ minVersion: "1.5.0" });
    expect(await (await app.handle(new Request("http://localhost/min-version.json?terminalId=t2"))).json()).toEqual({ minVersion: "1.3.0" });
    expect(await (await app.handle(new Request("http://localhost/min-version.json"))).json()).toEqual({ minVersion: "1.3.0" });
  });
});

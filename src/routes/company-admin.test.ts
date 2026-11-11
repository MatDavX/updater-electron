import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { StateStore } from "../state-store";
import { SSEBroker } from "../sse";
import { upsertHeartbeat } from "../fleet";
import { companyAdminRoutes } from "./company-admin";
import { minVersionRoutes } from "./min-version";

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

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const base = { terminalName: "CX", version: "1.0.0", platform: "win32", arch: "x64" };

function setup() {
  const store = new StateStore("/dev/null/never.json", { debounceMs: 1e9 });
  const broker = new SSEBroker();
  const app = new Elysia().use(companyAdminRoutes(store, broker)).use(minVersionRoutes(store));
  upsertHeartbeat(store, { ...base, terminalId: "t1", companyId: "c1" });
  upsertHeartbeat(store, { ...base, terminalId: "t2", companyId: "c1" });
  upsertHeartbeat(store, { ...base, terminalId: "t3", companyId: "c2" });
  const got: Record<string, string[]> = { t1: [], t3: [] };
  broker.subscribe((m) => got.t1.push(m), { terminalId: "t1" });
  broker.subscribe((m) => got.t3.push(m), { terminalId: "t3" });
  return { store, broker, app, got };
}

describe("/api/companies", () => {
  forceOpenMode();

  it("POST /:id/force grava, avisa só terminais da empresa e vale no min-version", async () => {
    const { app, got } = setup();
    const res = await app.handle(new Request("http://localhost/api/companies/c1/force", json({ minVersion: "1.5.0" })));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", companyId: "c1", minVersion: "1.5.0", terminals: 2, online: 1 });
    expect(got.t1[0]).toBe('event: emergency\ndata: {"minVersion":"1.5.0","version":"1.5.0"}\n\n');
    expect(got.t3).toHaveLength(0);
    const mv = await app.handle(new Request("http://localhost/min-version.json?terminalId=t1"));
    expect(await mv.json()).toEqual({ minVersion: "1.5.0" });
  });

  it("POST com versão inválida dá 400", async () => {
    const { app } = setup();
    const res = await app.handle(new Request("http://localhost/api/companies/c1/force", json({ minVersion: "abc" })));
    expect(res.status).toBe(400);
  });

  it("POST para empresa sem terminal grava e responde terminals: 0", async () => {
    const { app, store } = setup();
    const res = await app.handle(new Request("http://localhost/api/companies/nova/force", json({ minVersion: "1.5.0" })));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ terminals: 0, online: 0 });
    expect(store.get().forcedCompanies.nova.minVersion).toBe("1.5.0");
  });

  it("GET /forced lista as empresas", async () => {
    const { app } = setup();
    await app.handle(new Request("http://localhost/api/companies/c1/force", json({ minVersion: "1.5.0" })));
    const res = await app.handle(new Request("http://localhost/api/companies/forced"));
    const data = await res.json();
    expect(data.companies).toHaveLength(1);
    expect(data.companies[0]).toMatchObject({ companyId: "c1", minVersion: "1.5.0", terminals: 2, online: 1 });
  });

  it("DELETE manda emergency-clear", async () => {
    const { app, got, store } = setup();
    await app.handle(new Request("http://localhost/api/companies/c1/force", json({ minVersion: "1.5.0" })));
    got.t1.length = 0;
    const res = await app.handle(new Request("http://localhost/api/companies/c1/force", { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(got.t1).toEqual(["event: emergency-clear\ndata: {}\n\n"]);
    expect(store.get().forcedCompanies.c1).toBeUndefined();
  });

  it("DELETE com global ativo manda emergency com o global", async () => {
    const { app, got, store } = setup();
    await app.handle(new Request("http://localhost/api/companies/c1/force", json({ minVersion: "1.5.0" })));
    store.update((s) => { s.minVersion = "1.3.0"; });
    got.t1.length = 0;
    await app.handle(new Request("http://localhost/api/companies/c1/force", { method: "DELETE" }));
    expect(got.t1).toEqual(['event: emergency\ndata: {"minVersion":"1.3.0","version":"1.3.0"}\n\n']);
  });
});

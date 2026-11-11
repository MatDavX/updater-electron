import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { StateStore } from "../state-store";
import { SSEBroker } from "../sse";
import { upsertHeartbeat } from "../fleet";
import { statusRoutes } from "./status";

let original: string | undefined;
beforeAll(() => { original = Bun.env.API_SECRET; delete Bun.env.API_SECRET; });
afterAll(() => { if (original !== undefined) Bun.env.API_SECRET = original; });

const base = { terminalName: "CX", platform: "win32", arch: "x64" };

function seed() {
  const store = new StateStore("/dev/null/never.json", { debounceMs: 1e9 });
  const broker = new SSEBroker();
  upsertHeartbeat(store, { ...base, terminalId: "a", version: "1.5.0" });
  upsertHeartbeat(store, { ...base, terminalId: "b", version: "1.5.0" });
  upsertHeartbeat(store, { ...base, terminalId: "c", version: "1.4.0" });
  upsertHeartbeat(store, { ...base, terminalId: "d", version: "unknown" });
  broker.subscribe(() => {}, { terminalId: "a" });
  return { store, broker };
}

describe("GET /api/status", () => {
  it("agrega frota, versão servida e forçados", async () => {
    const { store, broker } = seed();
    store.update((s) => {
      s.activeVersion = "1.4.0";
      s.forced.c = { minVersion: "1.5.0", createdAt: "x" };
    });
    const github = { getLatest: async () => ({ version: "1.5.0", releaseDate: "2026-01-01T00:00:00Z", notes: "", assets: [] }) };
    const app = new Elysia().use(statusRoutes(github, store, broker));
    const res = await app.handle(new Request("http://localhost/api/status"));
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d).toMatchObject({
      latestVersion: "1.5.0",
      latestReleaseDate: "2026-01-01T00:00:00Z",
      activeVersion: "1.4.0",
      servedVersion: "1.4.0",
      minVersion: null,
      sseClients: 1,
      forcedTerminals: 1,
      forcedCompanies: 0,
    });
    expect(d.fleet.total).toBe(4);
    expect(d.fleet.online).toBe(1);
    expect(d.fleet.byVersion[0]).toEqual({ version: "1.5.0", count: 2, online: 1 });
    expect(d.fleet.byVersion[1].version).toBe("1.4.0");
    expect(d.fleet.byVersion[2].version).toBe("unknown");
  });

  it("sem release no GitHub", async () => {
    const { store, broker } = seed();
    const app = new Elysia().use(statusRoutes({ getLatest: async () => null }, store, broker));
    const d = await (await app.handle(new Request("http://localhost/api/status"))).json();
    expect(d.latestVersion).toBeNull();
    expect(d.servedVersion).toBeNull();
  });
});

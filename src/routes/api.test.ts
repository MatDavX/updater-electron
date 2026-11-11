import { describe, it, expect, afterEach, beforeAll, afterAll, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import * as realStateStoreModule from "../state-store";
import { StateStore } from "../state-store";
import { sseBroker } from "../sse";

// Passamos por todas as exportações reais do módulo (inclui `defaultState`,
// usada por `src/state-store.test.ts`) e sobrescrevemos só `stateStore`,
// para não quebrar outros arquivos de teste que importam o mesmo módulo
// (`mock.module` reescreve as exportações globalmente no processo).
const realStateStoreExports = { ...realStateStoreModule };

// `api.ts` usa o singleton `stateStore` (`../state-store`) diretamente. Esse
// módulo resolve `DATA_DIR/state.json` na PRIMEIRA vez que é importado em
// todo o processo `bun test` — como outros arquivos de teste (fleet-admin,
// events, fleet-public) também importam `../state-store` (mesmo que só a
// classe `StateStore`), setar `Bun.env.DATA_DIR` antes de um `await import`
// aqui não é confiável: se outro arquivo já rodou primeiro no mesmo
// processo, o módulo real já foi avaliado com o `DATA_DIR` de produção, e
// `stateStore.flush()` sobrescreveria `data/state.json` do repo.
//
// `mock.module` reescreve as exportações do módulo já carregado — os
// bindings ESM que outros arquivos (incluindo `api.ts`) já resolveram
// passam a apontar para o valor mockado, então isso funciona independente
// da ordem de execução dos arquivos de teste.
//
// O `mock.restore()` no `afterAll` NÃO desfaz esse `mock.module` — no Bun
// 1.3.10 `mock.restore()` só restaura mocks de função (`mock()`/`spyOn()`),
// não o registro de módulos trocado por `mock.module()`. Ou seja, o mock
// deste `stateStore` continua valendo pro resto do processo `bun test`
// depois que este arquivo termina. Isso é inofensivo aqui porque a factory
// espalha (`...realStateStoreExports`) todo o namespace real por cima do
// mock — o único binding trocado é `stateStore` — e nenhum outro arquivo de
// teste depende do singleton real `stateStore` (os que usam `StateStore`
// instanciam a própria store isolada). Se isso mudar, este vazamento passa
// a importar.
let tmpDir: string;
let testStore: StateStore;
let apiRoutes: typeof import("./api").apiRoutes;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "api-test-"));
  testStore = new StateStore(join(tmpDir, "state.json"), { debounceMs: 1e9 });

  await mock.module("../state-store", () => ({
    ...realStateStoreExports,
    stateStore: testStore,
  }));

  ({ apiRoutes } = await import("./api"));
});

afterAll(() => {
  mock.restore();
  rmSync(tmpDir, { recursive: true, force: true });
});

function buildApp() {
  return new Elysia().use(apiRoutes({} as never, {} as never));
}

afterEach(async () => {
  testStore.update((s) => {
    s.minVersion = null;
    s.forced = {};
    s.forcedCompanies = {};
    s.fleet = {};
  });
  await testStore.flush();
});

describe("DELETE /api/emergency", () => {
  const originalApiSecret = Bun.env.API_SECRET;
  beforeAll(() => { delete Bun.env.API_SECRET; });
  afterAll(() => {
    if (originalApiSecret !== undefined) Bun.env.API_SECRET = originalApiSecret;
  });

  it("sends emergency-clear to everyone except terminals with an active forced update", async () => {
    const app = buildApp();

    testStore.update((s) => {
      s.minVersion = "1.3.0";
      s.forced = { forced1: { minVersion: "1.5.0", createdAt: new Date().toISOString() } };
    });

    const forcedGot: string[] = [];
    const plainGot: string[] = [];
    const anonGot: string[] = [];
    const unsubForced = sseBroker.subscribe((m) => forcedGot.push(m), { terminalId: "forced1" });
    const unsubPlain = sseBroker.subscribe((m) => plainGot.push(m), { terminalId: "plain1" });
    const unsubAnon = sseBroker.subscribe((m) => anonGot.push(m));

    try {
      const res = await app.handle(new Request("http://localhost/api/emergency", { method: "DELETE" }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok", minVersion: null });
      expect(testStore.get().minVersion).toBeNull();

      // Continua obrigado, mas à própria exigência (não à global cancelada).
      expect(forcedGot).toEqual(['event: emergency\ndata: {"minVersion":"1.5.0","version":"1.5.0"}\n\n']);
      expect(plainGot).toEqual(["event: emergency-clear\ndata: {}\n\n"]);
      expect(anonGot).toEqual(["event: emergency-clear\ndata: {}\n\n"]);
    } finally {
      unsubForced();
      unsubPlain();
      unsubAnon();
    }
  });
});

function json(body: unknown) {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

describe("POST /api/emergency", () => {
  const originalApiSecret = Bun.env.API_SECRET;
  beforeAll(() => { delete Bun.env.API_SECRET; });
  afterAll(() => {
    if (originalApiSecret !== undefined) Bun.env.API_SECRET = originalApiSecret;
  });

  it("sends the terminal's EFFECTIVE minVersion to connected forced terminals, and the plain global value to everyone else", async () => {
    const app = buildApp();

    testStore.update((s) => {
      s.forced = { t1: { minVersion: "1.5.0", createdAt: new Date().toISOString() } };
    });

    const t1Got: string[] = [];
    const t2Got: string[] = [];
    const anonGot: string[] = [];
    const unsubT1 = sseBroker.subscribe((m) => t1Got.push(m), { terminalId: "t1" });
    const unsubT2 = sseBroker.subscribe((m) => t2Got.push(m), { terminalId: "t2" });
    const unsubAnon = sseBroker.subscribe((m) => anonGot.push(m));

    try {
      const res = await app.handle(new Request("http://localhost/api/emergency", json({ minVersion: "1.3.0" })));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok", minVersion: "1.3.0" });
      expect(testStore.get().minVersion).toBe("1.3.0");

      expect(t1Got).toEqual(['event: emergency\ndata: {"minVersion":"1.5.0","version":"1.5.0"}\n\n']);
      expect(t2Got).toEqual(['event: emergency\ndata: {"minVersion":"1.3.0","version":"1.3.0"}\n\n']);
      expect(anonGot).toEqual(['event: emergency\ndata: {"minVersion":"1.3.0","version":"1.3.0"}\n\n']);
    } finally {
      unsubT1();
      unsubT2();
      unsubAnon();
    }
  });

  it("rejects a minVersion that isn't x.y.z", async () => {
    const app = buildApp();
    const res = await app.handle(new Request("http://localhost/api/emergency", json({ minVersion: "latest" })));
    expect(res.status).toBe(400);
    expect(testStore.get().minVersion).toBeNull();
  });
});

describe("emergência global x forçado por empresa", () => {
  const originalApiSecret = Bun.env.API_SECRET;
  beforeAll(() => { delete Bun.env.API_SECRET; });
  afterAll(() => {
    if (originalApiSecret !== undefined) Bun.env.API_SECRET = originalApiSecret;
  });

  const seed = () =>
    testStore.update((s) => {
      s.forcedCompanies = { c1: { minVersion: "1.5.0", createdAt: new Date().toISOString() } };
      s.fleet = {
        tc: { terminalId: "tc", terminalName: "tc", version: "1.0.0", platform: "win32", arch: "x64", companyId: "c1", lastCompanyId: "c1", firstSeen: "x", lastSeen: "x" },
      };
    });

  it("POST /api/emergency manda o efetivo (empresa) e não o global menor", async () => {
    const app = buildApp();
    seed();
    const got: string[] = [];
    const unsub = sseBroker.subscribe((m) => got.push(m), { terminalId: "tc" });
    try {
      await app.handle(new Request("http://localhost/api/emergency", json({ minVersion: "1.3.0" })));
      expect(got).toEqual(['event: emergency\ndata: {"minVersion":"1.5.0","version":"1.5.0"}\n\n']);
    } finally {
      unsub();
    }
  });

  it("DELETE /api/emergency rebaixa o terminal da empresa forçada para a exigência da empresa", async () => {
    const app = buildApp();
    seed();
    // Global (2.1.0) maior que a da empresa (1.5.0): o modal do PDV mostrava 2.1.0.
    testStore.update((s) => { s.minVersion = "2.1.0"; });
    const got: string[] = [];
    const unsub = sseBroker.subscribe((m) => got.push(m), { terminalId: "tc" });
    try {
      await app.handle(new Request("http://localhost/api/emergency", { method: "DELETE" }));
      expect(got).toEqual(['event: emergency\ndata: {"minVersion":"1.5.0","version":"1.5.0"}\n\n']);
    } finally {
      unsub();
    }
  });
});

describe("GET /api/releases/history", () => {
  const originalApiSecret = Bun.env.API_SECRET;
  beforeAll(() => { delete Bun.env.API_SECRET; });
  afterAll(() => {
    if (originalApiSecret !== undefined) Bun.env.API_SECRET = originalApiSecret;
  });

  const notes = "n".repeat(500);
  const releases = [
    { version: "1.5.0", releaseDate: "2026-02-01T00:00:00Z", notes, assets: [{ name: "app-Setup-1.5.0.exe" }] },
    { version: "1.4.0", releaseDate: "2026-01-01T00:00:00Z", notes, assets: [] },
  ];
  const github = {
    getAllReleases: async () => releases,
    getLatest: async () => releases[0],
    findPlatformAsset: (r: { assets: { name: string }[] }) => r.assets[0] ?? null,
  };
  const storage = {
    listFilesForVersion: async (v: string) =>
      v === "1.4.0" ? [{ filename: "app-Setup-1.4.0.exe", size: 10, platform: "win32" }] : [],
  };
  const app = () => new Elysia().use(apiRoutes(github as never, storage as never));

  it("sem query mantém o formato legado (notas cortadas em 200)", async () => {
    const d = await (await app().handle(new Request("http://localhost/api/releases/history"))).json();
    expect(d.releases[0].notes).toHaveLength(200);
    expect(d.releases[0].files).toBeUndefined();
  });

  it("?full=1 traz notas completas, arquivos e flags", async () => {
    testStore.update((s) => { s.activeVersion = "1.4.0"; });
    try {
      const d = await (await app().handle(new Request("http://localhost/api/releases/history?full=1"))).json();
      expect(d.latestVersion).toBe("1.5.0");
      expect(d.activeVersion).toBe("1.4.0");
      expect(d.releases[0].notes).toHaveLength(500);
      expect(d.releases[0]).toMatchObject({ isLatest: true, isActive: false, hasWindowsInstaller: true, files: [] });
      expect(d.releases[1]).toMatchObject({ isLatest: false, isActive: true, hasWindowsInstaller: true });
      expect(d.releases[1].files).toEqual([{ filename: "app-Setup-1.4.0.exe", size: 10, platform: "win32" }]);
    } finally {
      testStore.update((s) => { s.activeVersion = null; });
    }
  });
});

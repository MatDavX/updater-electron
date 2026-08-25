# Update Server — persistência, inventário de frota e update forçado por terminal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O servidor de updates passa a (1) persistir emergência/pin em disco, (2) saber quais terminais existem, em que versão estão, quem está logado e se estão online, (3) forçar atualização obrigatória em um terminal específico pelo dashboard, e (4) corrigir os bugs de matching de versão, hash em memória e ausência de `Range`.

**Architecture:** Um `StateStore` (JSON em `DATA_DIR/state.json`, escrita debounced) substitui o estado in-memory de `emergency.ts` e `version-control.ts` e guarda também `fleet` (registro por `terminalId`) e `forced` (minVersion por terminal). O `SSEBroker` passa a conhecer o `terminalId` de cada conexão para `sendTo(terminalId, …)`. Rota pública `POST /fleet/heartbeat` alimenta o inventário; `GET /min-version.json?terminalId=` responde `max(global, forced[terminalId])`; rotas admin `/api/fleet*` gerenciam. Dashboard ganha uma seção "Frota".

**Tech Stack:** Bun 1.3, Elysia, `bun test`.

**Spec:** inline — seção "Contrato cliente ↔ servidor" abaixo. Plano irmão do cliente PDV: `~/Documents/GitHub/frontrepo-pdv/docs/superpowers/plans/2026-08-25-updater-cliente-frota.md` (Tasks 1–6). O servidor é retrocompatível com clientes antigos (sem `terminalId` → tratados como `anonymous`, sem heartbeat → não aparecem na frota).

## Global Constraints

- Rotas públicas (sem token): `GET /latest*.yml`, `GET /download/*`, `GET /events/updates`, `GET /min-version.json`, `GET /latest-version`, `GET /health`, **`POST /fleet/heartbeat`** (novo). Todo o resto sob `authGuard()`.
- Heartbeat é validado com `t.Object` (Elysia) — tamanhos máximos: strings até 200 chars; `terminalId` até 64.
- Estado persistido em `DATA_DIR` (env, default `./data`), diretório gitignored. Nunca em `releases/`.
- Sem dependências novas além das já presentes (`elysia`, `yaml`). Testes com `bun test`.
- Commits em pt-BR (`feat(fleet): …`, `fix(storage): …`).
- Toda tarefa: `bun test` verde antes do commit.

## Contrato cliente ↔ servidor

| Chamada | Método | Payload / Query | Resposta |
|---|---|---|---|
| `/fleet/heartbeat` | POST (JSON) | `{ terminalId, terminalName, version, platform, arch, companyId?, unitId?, userId?, userName?, userEmail? }` | `204` |
| `/events/updates` | GET (SSE) | `?terminalId=<uuid>&version=<x.y.z>` | eventos: `release`, `upload`, `refresh`, `version-change`, `emergency`, `emergency-clear` |
| `/min-version.json` | GET | `?terminalId=<uuid>` | `{ "minVersion": "x.y.z" \| null }` = max(global, forced[terminalId]) |
| `/api/fleet` | GET (auth) | — | `{ terminals: FleetRecord[] }` |
| `/api/fleet/:terminalId/force` | POST (auth) | `{ minVersion }` | `{ status: "ok", terminalId, minVersion, online }` — envia SSE `emergency` só para esse terminal |
| `/api/fleet/:terminalId/force` | DELETE (auth) | — | `{ status: "ok" }` — envia SSE `emergency-clear` só para esse terminal |
| `/api/fleet/:terminalId` | DELETE (auth) | — | remove do inventário |

`FleetRecord = { terminalId, terminalName, version, platform, arch, companyId?, unitId?, userId?, userName?, userEmail?, firstSeen: ISO, lastSeen: ISO, online: boolean, forcedMinVersion: string | null }`

Semântica de `emergency-clear` global (`DELETE /api/emergency`): envia `emergency-clear` para todos **exceto** terminais com `forced` ativo (senão o modal deles fecharia e só reabriria no próximo poll).

---

### Task S1: `StateStore` persistente + migração de `emergency.ts` / `version-control.ts`

**Files:**
- Create: `src/state-store.ts`
- Create: `src/state-store.test.ts`
- Modify: `src/emergency.ts`, `src/version-control.ts` (viram fachadas sobre o store)
- Modify: `package.json` (script `test`), `.gitignore` (`/data/`), `.env.example` (`DATA_DIR`)

**Interfaces:**
- Produces:
  ```ts
  export interface ForcedEntry { minVersion: string; createdAt: string }
  export interface FleetRecord { terminalId: string; terminalName: string; version: string; platform: string; arch: string; companyId?: string; unitId?: string; userId?: string; userName?: string; userEmail?: string; firstSeen: string; lastSeen: string }
  export interface PersistedState { minVersion: string | null; activeVersion: string | null; forced: Record<string, ForcedEntry>; fleet: Record<string, FleetRecord> }
  export class StateStore {
      constructor(filePath: string, opts?: { debounceMs?: number })
      load(): Promise<void>
      get(): PersistedState                       // referência viva (não mutar fora de update)
      update(mutator: (s: PersistedState) => void): void   // muta + agenda flush
      flush(): Promise<void>                      // grava agora
  }
  export function defaultState(): PersistedState
  export const stateStore: StateStore            // singleton: DATA_DIR/state.json
  ```

- [ ] **Step 1: Infra de teste**

`package.json` → adicionar em `scripts`: `"test": "bun test"`.
`.gitignore` → adicionar linha `/data/`.
`.env.example` → adicionar `DATA_DIR=./data` com comentário `# Estado persistente (emergência, pin, frota)`.

- [ ] **Step 2: Teste que falha — `src/state-store.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, defaultState } from "./state-store";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "state-store-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("StateStore", () => {
  it("starts with default state when file does not exist", async () => {
    const store = new StateStore(join(dir, "state.json"));
    await store.load();
    expect(store.get()).toEqual(defaultState());
  });

  it("persists updates and reloads them", async () => {
    const path = join(dir, "state.json");
    const store = new StateStore(path, { debounceMs: 0 });
    await store.load();
    store.update((s) => { s.minVersion = "1.3.0"; s.forced["t1"] = { minVersion: "1.4.0", createdAt: "2026-01-01T00:00:00.000Z" }; });
    await store.flush();

    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw.minVersion).toBe("1.3.0");

    const again = new StateStore(path);
    await again.load();
    expect(again.get().minVersion).toBe("1.3.0");
    expect(again.get().forced.t1.minVersion).toBe("1.4.0");
  });

  it("tolerates a corrupt file (falls back to defaults, keeps a .corrupt backup)", async () => {
    const path = join(dir, "state.json");
    await Bun.write(path, "{ not json");
    const store = new StateStore(path);
    await store.load();
    expect(store.get()).toEqual(defaultState());
    expect(await Bun.file(path + ".corrupt").exists()).toBe(true);
  });

  it("fills missing keys from defaults (forward-compatible schema)", async () => {
    const path = join(dir, "state.json");
    await Bun.write(path, JSON.stringify({ minVersion: "1.0.0" }));
    const store = new StateStore(path);
    await store.load();
    expect(store.get().activeVersion).toBeNull();
    expect(store.get().forced).toEqual({});
    expect(store.get().fleet).toEqual({});
  });

  it("debounces writes: many updates → one flush", async () => {
    const path = join(dir, "state.json");
    const store = new StateStore(path, { debounceMs: 20 });
    await store.load();
    for (let i = 0; i < 10; i++) store.update((s) => { s.minVersion = `1.0.${i}`; });
    expect(await Bun.file(path).exists()).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(JSON.parse(await readFile(path, "utf8")).minVersion).toBe("1.0.9");
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `bun test src/state-store.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 4: Criar `src/state-store.ts`**

```ts
// Estado persistente do servidor (emergência global, pin de versão, update
// forçado por terminal, inventário de frota). Antes tudo era in-memory e um
// restart apagava a emergência — app fechado durante a emergência + restart
// do servidor = /min-version.json voltava null.
//
// Formato: JSON único em DATA_DIR/state.json, escrita atômica (tmp + rename),
// debounced. Volume é pequeno (centenas de terminais), então JSON basta.

import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface ForcedEntry {
  minVersion: string;
  createdAt: string;
}

export interface FleetRecord {
  terminalId: string;
  terminalName: string;
  version: string;
  platform: string;
  arch: string;
  companyId?: string;
  unitId?: string;
  userId?: string;
  userName?: string;
  userEmail?: string;
  firstSeen: string;
  lastSeen: string;
}

export interface PersistedState {
  minVersion: string | null;
  activeVersion: string | null;
  forced: Record<string, ForcedEntry>;
  fleet: Record<string, FleetRecord>;
}

export function defaultState(): PersistedState {
  return { minVersion: null, activeVersion: null, forced: {}, fleet: {} };
}

export class StateStore {
  private state: PersistedState = defaultState();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private readonly debounceMs: number;

  constructor(private readonly filePath: string, opts?: { debounceMs?: number }) {
    this.debounceMs = opts?.debounceMs ?? 500;
  }

  async load(): Promise<void> {
    const file = Bun.file(this.filePath);
    if (!(await file.exists())) {
      this.state = defaultState();
      return;
    }
    try {
      const raw = JSON.parse(await file.text()) as Partial<PersistedState>;
      this.state = { ...defaultState(), ...raw };
      // Garante objetos mesmo se o arquivo tiver null/undefined nesses campos.
      this.state.forced = raw.forced && typeof raw.forced === "object" ? raw.forced : {};
      this.state.fleet = raw.fleet && typeof raw.fleet === "object" ? raw.fleet : {};
    } catch (err) {
      console.error(`[state] arquivo corrompido, usando defaults: ${err instanceof Error ? err.message : err}`);
      await rm(this.filePath + ".corrupt", { force: true });
      await rename(this.filePath, this.filePath + ".corrupt");
      this.state = defaultState();
    }
  }

  get(): PersistedState {
    return this.state;
  }

  update(mutator: (s: PersistedState) => void): void {
    mutator(this.state);
    this.schedule();
  }

  private schedule(): void {
    if (this.debounceMs === 0) {
      void this.flush();
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Serializa escritas: nunca duas gravações concorrentes no mesmo arquivo.
    this.writing = this.writing.then(() => this.write()).catch((err) => {
      console.error(`[state] falha ao gravar: ${err instanceof Error ? err.message : err}`);
    });
    return this.writing;
  }

  private async write(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await Bun.write(tmp, JSON.stringify(this.state, null, 2));
    await rename(tmp, this.filePath);
  }
}

const dataDir = resolve(Bun.env.DATA_DIR || "./data");
export const stateStore = new StateStore(resolve(dataDir, "state.json"));
```

- [ ] **Step 5: Rodar e ver passar**

Run: `bun test src/state-store.test.ts`
Expected: PASS.

- [ ] **Step 6: Migrar `emergency.ts` e `version-control.ts`**

`src/emergency.ts`:

```ts
// Emergência GLOBAL (minVersion para toda a frota). Persistida no StateStore.
// Forçados por terminal ficam em state.forced (ver fleet.ts).
import { stateStore } from "./state-store";

export function getMinVersion(): string | null {
  return stateStore.get().minVersion;
}

export function setMinVersion(version: string | null): void {
  stateStore.update((s) => { s.minVersion = version; });
  if (version) {
    console.log(`[emergency] minVersion definido para v${version}`);
  } else {
    console.log(`[emergency] emergência limpa (minVersion null)`);
  }
}
```

`src/version-control.ts`:

```ts
import { stateStore } from "./state-store";

export function getActiveVersion(): string | null {
  return stateStore.get().activeVersion;
}

export function setActiveVersion(version: string | null): void {
  stateStore.update((s) => { s.activeVersion = version; });
  if (version) {
    console.log(`[version] Active version pinned to v${version}`);
  } else {
    console.log(`[version] Active version reset to latest`);
  }
}
```

`src/index.ts` — antes de `await github.refresh()`:

```ts
import { stateStore } from "./state-store";

await stateStore.load();
console.log(`[state] carregado: minVersion=${stateStore.get().minVersion ?? "-"} activeVersion=${stateStore.get().activeVersion ?? "-"} fleet=${Object.keys(stateStore.get().fleet).length}`);
```

E ao final do arquivo, flush em shutdown:

```ts
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await stateStore.flush();
    process.exit(0);
  });
}
```

- [ ] **Step 7: Smoke manual**

Run: `API_SECRET=x DATA_DIR=/tmp/upd-data bun run src/index.ts` em um terminal; em outro:
```bash
curl -s -X POST localhost:3000/api/emergency -H 'Authorization: Bearer x' -H 'content-type: application/json' -d '{"minVersion":"1.3.0"}'
cat /tmp/upd-data/state.json
```
Expected: `state.json` contém `"minVersion": "1.3.0"`. Reiniciar o servidor → `curl localhost:3000/min-version.json` devolve `1.3.0`.

- [ ] **Step 8: Commit**

```bash
git add src/state-store.ts src/state-store.test.ts src/emergency.ts src/version-control.ts src/index.ts package.json .gitignore .env.example
git commit -m "feat(state): persiste emergência e pin de versão em DATA_DIR/state.json"
```

---

### Task S2: Registro de frota + `POST /fleet/heartbeat`

**Files:**
- Create: `src/fleet.ts`
- Create: `src/fleet.test.ts`
- Create: `src/routes/fleet-public.ts`
- Create: `src/routes/fleet-public.test.ts`
- Modify: `src/index.ts` (montar rota)

**Interfaces:**
- Produces (`src/fleet.ts`):
  ```ts
  export interface HeartbeatInput { terminalId: string; terminalName: string; version: string; platform: string; arch: string; companyId?: string; unitId?: string; userId?: string; userName?: string; userEmail?: string }
  export function upsertHeartbeat(store: StateStore, input: HeartbeatInput, now?: Date): FleetRecord
  export function touchSeen(store: StateStore, terminalId: string, version?: string, now?: Date): void   // usado pelo SSE connect
  export function removeTerminal(store: StateStore, terminalId: string): boolean
  export function listFleet(store: StateStore, isOnline: (terminalId: string) => boolean): Array<FleetRecord & { online: boolean; forcedMinVersion: string | null }>
  export function setForced(store: StateStore, terminalId: string, minVersion: string, now?: Date): ForcedEntry
  export function clearForced(store: StateStore, terminalId: string): boolean
  export function effectiveMinVersion(store: StateStore, terminalId: string | null): string | null   // max(global, forced)
  export function compareVersions(a: string, b: string): number
  ```

- [ ] **Step 1: Teste que falha — `src/fleet.test.ts`**

```ts
import { describe, it, expect } from "bun:test";
import { StateStore } from "./state-store";
import {
  upsertHeartbeat, touchSeen, removeTerminal, listFleet,
  setForced, clearForced, effectiveMinVersion, compareVersions,
} from "./fleet";

function mem(): StateStore {
  // Store sem disco: debounce enorme e nunca chamamos flush.
  return new StateStore("/dev/null/never.json", { debounceMs: 1e9 });
}

const hb = {
  terminalId: "t1", terminalName: "CAIXA-01", version: "1.2.0", platform: "win32", arch: "x64",
  userId: "u1", userName: "Ana", userEmail: "ana@loja.com", companyId: "c1",
};

describe("upsertHeartbeat", () => {
  it("creates a record with firstSeen=lastSeen on first heartbeat", () => {
    const s = mem();
    const now = new Date("2026-08-25T10:00:00.000Z");
    const rec = upsertHeartbeat(s, hb, now);
    expect(rec.firstSeen).toBe(now.toISOString());
    expect(rec.lastSeen).toBe(now.toISOString());
    expect(s.get().fleet.t1.userEmail).toBe("ana@loja.com");
  });

  it("updates version/user/lastSeen but keeps firstSeen", () => {
    const s = mem();
    upsertHeartbeat(s, hb, new Date("2026-08-25T10:00:00.000Z"));
    const later = new Date("2026-08-25T11:00:00.000Z");
    const rec = upsertHeartbeat(s, { ...hb, version: "1.3.0", userEmail: "bia@loja.com" }, later);
    expect(rec.firstSeen).toBe("2026-08-25T10:00:00.000Z");
    expect(rec.lastSeen).toBe(later.toISOString());
    expect(rec.version).toBe("1.3.0");
    expect(rec.userEmail).toBe("bia@loja.com");
  });

  it("logged-out heartbeat clears user fields", () => {
    const s = mem();
    upsertHeartbeat(s, hb);
    const rec = upsertHeartbeat(s, { terminalId: "t1", terminalName: "CAIXA-01", version: "1.2.0", platform: "win32", arch: "x64" });
    expect(rec.userEmail).toBeUndefined();
    expect(rec.userId).toBeUndefined();
  });
});

describe("touchSeen / removeTerminal", () => {
  it("touchSeen creates a minimal record for unknown terminals (SSE before heartbeat)", () => {
    const s = mem();
    touchSeen(s, "t9", "1.0.0", new Date("2026-08-25T10:00:00.000Z"));
    expect(s.get().fleet.t9).toMatchObject({ terminalId: "t9", terminalName: "t9", version: "1.0.0", platform: "unknown", arch: "unknown" });
  });

  it("touchSeen only bumps lastSeen/version on known terminals", () => {
    const s = mem();
    upsertHeartbeat(s, hb, new Date("2026-08-25T10:00:00.000Z"));
    touchSeen(s, "t1", undefined, new Date("2026-08-25T12:00:00.000Z"));
    expect(s.get().fleet.t1.lastSeen).toBe("2026-08-25T12:00:00.000Z");
    expect(s.get().fleet.t1.userEmail).toBe("ana@loja.com");
  });

  it("removeTerminal drops record and forced entry", () => {
    const s = mem();
    upsertHeartbeat(s, hb);
    setForced(s, "t1", "1.9.0");
    expect(removeTerminal(s, "t1")).toBe(true);
    expect(s.get().fleet.t1).toBeUndefined();
    expect(s.get().forced.t1).toBeUndefined();
    expect(removeTerminal(s, "t1")).toBe(false);
  });
});

describe("forced / effectiveMinVersion", () => {
  it("effectiveMinVersion is max(global, forced)", () => {
    const s = mem();
    expect(effectiveMinVersion(s, "t1")).toBeNull();
    s.update((x) => { x.minVersion = "1.3.0"; });
    expect(effectiveMinVersion(s, "t1")).toBe("1.3.0");
    setForced(s, "t1", "1.5.0");
    expect(effectiveMinVersion(s, "t1")).toBe("1.5.0");
    expect(effectiveMinVersion(s, "t2")).toBe("1.3.0");
    expect(effectiveMinVersion(s, null)).toBe("1.3.0");
    s.update((x) => { x.minVersion = "2.0.0"; });
    expect(effectiveMinVersion(s, "t1")).toBe("2.0.0");
  });

  it("clearForced returns whether something was removed", () => {
    const s = mem();
    setForced(s, "t1", "1.5.0");
    expect(clearForced(s, "t1")).toBe(true);
    expect(clearForced(s, "t1")).toBe(false);
  });

  it("compareVersions handles 1.2.10 > 1.2.9", () => {
    expect(compareVersions("1.2.10", "1.2.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2.9", "1.2.10")).toBeLessThan(0);
    expect(compareVersions("1.2.0", "1.2")).toBe(0);
  });
});

describe("listFleet", () => {
  it("returns records sorted by lastSeen desc with online + forcedMinVersion", () => {
    const s = mem();
    upsertHeartbeat(s, hb, new Date("2026-08-25T10:00:00.000Z"));
    upsertHeartbeat(s, { ...hb, terminalId: "t2", terminalName: "CAIXA-02" }, new Date("2026-08-25T11:00:00.000Z"));
    setForced(s, "t1", "1.5.0");
    const list = listFleet(s, (id) => id === "t2");
    expect(list.map((r) => r.terminalId)).toEqual(["t2", "t1"]);
    expect(list[0].online).toBe(true);
    expect(list[0].forcedMinVersion).toBeNull();
    expect(list[1].online).toBe(false);
    expect(list[1].forcedMinVersion).toBe("1.5.0");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test src/fleet.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Criar `src/fleet.ts`**

```ts
// Inventário de frota + update forçado por terminal. Lógica pura sobre o
// StateStore (injetado) para ser testável sem disco/rede.
import type { StateStore, FleetRecord, ForcedEntry } from "./state-store";

export interface HeartbeatInput {
  terminalId: string;
  terminalName: string;
  version: string;
  platform: string;
  arch: string;
  companyId?: string;
  unitId?: string;
  userId?: string;
  userName?: string;
  userEmail?: string;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

export function upsertHeartbeat(store: StateStore, input: HeartbeatInput, now: Date = new Date()): FleetRecord {
  const iso = now.toISOString();
  let result!: FleetRecord;
  store.update((s) => {
    const prev = s.fleet[input.terminalId];
    // Campos de usuário são substituídos por inteiro: heartbeat sem usuário
    // (deslogado) apaga o usuário anterior.
    const rec: FleetRecord = {
      terminalId: input.terminalId,
      terminalName: input.terminalName,
      version: input.version,
      platform: input.platform,
      arch: input.arch,
      firstSeen: prev?.firstSeen ?? iso,
      lastSeen: iso,
    };
    if (input.companyId) rec.companyId = input.companyId;
    if (input.unitId) rec.unitId = input.unitId;
    if (input.userId) rec.userId = input.userId;
    if (input.userName) rec.userName = input.userName;
    if (input.userEmail) rec.userEmail = input.userEmail;
    s.fleet[input.terminalId] = rec;
    result = rec;
  });
  return result;
}

/** SSE connect: marca visto (e cria registro mínimo se ainda não houve heartbeat). */
export function touchSeen(store: StateStore, terminalId: string, version?: string, now: Date = new Date()): void {
  const iso = now.toISOString();
  store.update((s) => {
    const prev = s.fleet[terminalId];
    if (prev) {
      prev.lastSeen = iso;
      if (version) prev.version = version;
      return;
    }
    s.fleet[terminalId] = {
      terminalId,
      terminalName: terminalId,
      version: version ?? "unknown",
      platform: "unknown",
      arch: "unknown",
      firstSeen: iso,
      lastSeen: iso,
    };
  });
}

export function removeTerminal(store: StateStore, terminalId: string): boolean {
  let removed = false;
  store.update((s) => {
    if (s.fleet[terminalId]) {
      delete s.fleet[terminalId];
      removed = true;
    }
    delete s.forced[terminalId];
  });
  return removed;
}

export function listFleet(
  store: StateStore,
  isOnline: (terminalId: string) => boolean,
): Array<FleetRecord & { online: boolean; forcedMinVersion: string | null }> {
  const s = store.get();
  return Object.values(s.fleet)
    .map((r) => ({
      ...r,
      online: isOnline(r.terminalId),
      forcedMinVersion: s.forced[r.terminalId]?.minVersion ?? null,
    }))
    .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0));
}

export function setForced(store: StateStore, terminalId: string, minVersion: string, now: Date = new Date()): ForcedEntry {
  const entry: ForcedEntry = { minVersion, createdAt: now.toISOString() };
  store.update((s) => { s.forced[terminalId] = entry; });
  console.log(`[fleet] update forçado: ${terminalId} → minVersion ${minVersion}`);
  return entry;
}

export function clearForced(store: StateStore, terminalId: string): boolean {
  let removed = false;
  store.update((s) => {
    if (s.forced[terminalId]) {
      delete s.forced[terminalId];
      removed = true;
    }
  });
  if (removed) console.log(`[fleet] update forçado removido: ${terminalId}`);
  return removed;
}

/** minVersion efetiva para um terminal = a maior entre global e forçada. */
export function effectiveMinVersion(store: StateStore, terminalId: string | null): string | null {
  const s = store.get();
  const global = s.minVersion;
  const forced = terminalId ? s.forced[terminalId]?.minVersion ?? null : null;
  if (global && forced) return compareVersions(global, forced) >= 0 ? global : forced;
  return global ?? forced ?? null;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun test src/fleet.test.ts`
Expected: PASS.

- [ ] **Step 5: Teste da rota pública (falha) — `src/routes/fleet-public.test.ts`**

```ts
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
    const res = await a.handle(new Request("http://x/fleet/heartbeat", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(valid),
    }));
    expect(res.status).toBe(204);
    expect(store.get().fleet.t1.userEmail).toBe("ana@loja.com");
  });

  it("rejects payload without terminalId (422)", async () => {
    const { app: a } = app();
    const { terminalId: _omit, ...bad } = valid;
    const res = await a.handle(new Request("http://x/fleet/heartbeat", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bad),
    }));
    expect(res.status).toBe(422);
  });

  it("rejects oversized strings (422)", async () => {
    const { app: a } = app();
    const res = await a.handle(new Request("http://x/fleet/heartbeat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...valid, terminalName: "x".repeat(201) }),
    }));
    expect(res.status).toBe(422);
  });
});
```

- [ ] **Step 6: Criar `src/routes/fleet-public.ts`**

```ts
import { Elysia, t } from "elysia";
import type { StateStore } from "../state-store";
import { upsertHeartbeat } from "../fleet";

const short = t.String({ minLength: 1, maxLength: 200 });
const optShort = t.Optional(t.String({ maxLength: 200 }));

// Rota PÚBLICA (sem token): o PDV se identifica aqui no boot, a cada 30 min e
// ao logar. Só alimenta inventário — nada aqui muda comportamento de update.
export function fleetPublicRoutes(store: StateStore) {
  return new Elysia().post(
    "/fleet/heartbeat",
    ({ body, set }) => {
      upsertHeartbeat(store, body);
      set.status = 204;
      return;
    },
    {
      body: t.Object({
        terminalId: t.String({ minLength: 1, maxLength: 64 }),
        terminalName: short,
        version: t.String({ minLength: 1, maxLength: 32 }),
        platform: t.String({ minLength: 1, maxLength: 32 }),
        arch: t.String({ minLength: 1, maxLength: 32 }),
        companyId: optShort,
        unitId: optShort,
        userId: optShort,
        userName: optShort,
        userEmail: optShort,
      }),
    },
  );
}
```

- [ ] **Step 7: Rodar e ver passar**

Run: `bun test src/routes/fleet-public.test.ts`
Expected: PASS. (Se o status de validação da sua versão do Elysia for 400 em vez de 422, ajustar os `expect` — verificar com `bun test` e manter o que o framework retorna.)

- [ ] **Step 8: Montar em `src/index.ts`**

```ts
import { fleetPublicRoutes } from "./routes/fleet-public";
...
  .use(minVersionRoutes())
  .use(fleetPublicRoutes(stateStore))
```

- [ ] **Step 9: Commit**

```bash
git add src/fleet.ts src/fleet.test.ts src/routes/fleet-public.ts src/routes/fleet-public.test.ts src/index.ts
git commit -m "feat(fleet): registro de terminais via POST /fleet/heartbeat"
```

---

### Task S3: SSE com identidade por terminal (`sendTo`, `isConnected`)

**Files:**
- Modify: `src/sse.ts`
- Create: `src/sse.test.ts`
- Modify: `src/routes/events.ts` (lê `?terminalId=&version=`, chama `touchSeen`)
- Modify: `src/index.ts` (passa `stateStore` a `eventRoutes`)

**Interfaces:**
- Produces (`src/sse.ts`):
  ```ts
  subscribe(client: SSEClient, meta?: { terminalId?: string }): () => void
  broadcast(event: string, data: unknown, opts?: { exclude?: (terminalId: string | null) => boolean }): void
  sendTo(terminalId: string, event: string, data: unknown): number   // nº de conexões atingidas
  isConnected(terminalId: string): boolean
  connectedTerminalIds(): string[]
  get count(): number
  ```

- [ ] **Step 1: Teste que falha — `src/sse.test.ts`**

```ts
import { describe, it, expect } from "bun:test";
import { SSEBroker } from "./sse";

describe("SSEBroker", () => {
  it("sendTo reaches only that terminal's connections", () => {
    const b = new SSEBroker();
    const got: Record<string, string[]> = { a1: [], a2: [], b: [], anon: [] };
    b.subscribe((m) => got.a1.push(m), { terminalId: "A" });
    b.subscribe((m) => got.a2.push(m), { terminalId: "A" });
    b.subscribe((m) => got.b.push(m), { terminalId: "B" });
    b.subscribe((m) => got.anon.push(m));
    expect(b.sendTo("A", "emergency", { minVersion: "1.5.0" })).toBe(2);
    expect(got.a1[0]).toBe('event: emergency\ndata: {"minVersion":"1.5.0"}\n\n');
    expect(got.a2.length).toBe(1);
    expect(got.b.length).toBe(0);
    expect(got.anon.length).toBe(0);
    expect(b.sendTo("Z", "x", {})).toBe(0);
  });

  it("isConnected / connectedTerminalIds reflect subscriptions and unsubscribes", () => {
    const b = new SSEBroker();
    const off = b.subscribe(() => {}, { terminalId: "A" });
    b.subscribe(() => {});
    expect(b.isConnected("A")).toBe(true);
    expect(b.connectedTerminalIds()).toEqual(["A"]);
    off();
    expect(b.isConnected("A")).toBe(false);
    expect(b.count).toBe(1);
  });

  it("broadcast with exclude skips matching terminals but still hits anonymous ones", () => {
    const b = new SSEBroker();
    const got: string[] = [];
    b.subscribe((m) => got.push("A:" + m), { terminalId: "A" });
    b.subscribe((m) => got.push("B:" + m), { terminalId: "B" });
    b.subscribe((m) => got.push("anon:" + m));
    b.broadcast("emergency-clear", {}, { exclude: (id) => id === "A" });
    expect(got.map((g) => g.split(":")[0]).sort()).toEqual(["B", "anon"]);
  });

  it("drops a client whose send throws", () => {
    const b = new SSEBroker();
    b.subscribe(() => { throw new Error("closed"); }, { terminalId: "A" });
    b.broadcast("ping", {});
    expect(b.count).toBe(0);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test src/sse.test.ts`
Expected: FAIL — `SSEBroker` não é exportado / `sendTo` não existe.

- [ ] **Step 3: Reescrever `src/sse.ts`**

```ts
type SSEClient = (message: string) => void;

interface Subscription {
  send: SSEClient;
  terminalId: string | null;
}

export class SSEBroker {
  private subs = new Set<Subscription>();

  subscribe(client: SSEClient, meta?: { terminalId?: string }): () => void {
    const sub: Subscription = { send: client, terminalId: meta?.terminalId ?? null };
    this.subs.add(sub);
    console.log(`[sse] Client connected${sub.terminalId ? ` (${sub.terminalId})` : ""} (${this.subs.size} total)`);
    return () => {
      this.subs.delete(sub);
      console.log(`[sse] Client disconnected (${this.subs.size} total)`);
    };
  }

  private format(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  private deliver(sub: Subscription, message: string): boolean {
    try {
      sub.send(message);
      return true;
    } catch {
      this.subs.delete(sub);
      return false;
    }
  }

  broadcast(event: string, data: unknown, opts?: { exclude?: (terminalId: string | null) => boolean }): void {
    const message = this.format(event, data);
    let n = 0;
    for (const sub of [...this.subs]) {
      if (opts?.exclude?.(sub.terminalId)) continue;
      if (this.deliver(sub, message)) n++;
    }
    console.log(`[sse] Broadcast "${event}" to ${n} clients`);
  }

  /** Envia só para as conexões daquele terminal. Retorna quantas receberam. */
  sendTo(terminalId: string, event: string, data: unknown): number {
    const message = this.format(event, data);
    let n = 0;
    for (const sub of [...this.subs]) {
      if (sub.terminalId !== terminalId) continue;
      if (this.deliver(sub, message)) n++;
    }
    console.log(`[sse] "${event}" → ${terminalId}: ${n} conexão(ões)`);
    return n;
  }

  isConnected(terminalId: string): boolean {
    for (const sub of this.subs) if (sub.terminalId === terminalId) return true;
    return false;
  }

  connectedTerminalIds(): string[] {
    const ids = new Set<string>();
    for (const sub of this.subs) if (sub.terminalId) ids.add(sub.terminalId);
    return [...ids];
  }

  get count(): number {
    return this.subs.size;
  }
}

export const sseBroker = new SSEBroker();
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun test src/sse.test.ts`
Expected: PASS.

- [ ] **Step 5: `src/routes/events.ts` lê a query e marca o terminal como visto**

```ts
import { Elysia, t } from "elysia";
import { sseBroker } from "../sse";
import type { StateStore } from "../state-store";
import { touchSeen } from "../fleet";

export function eventRoutes(store: StateStore) {
  return new Elysia().get(
    "/events/updates",
    ({ query }) => {
      const encoder = new TextEncoder();
      const terminalId = query.terminalId?.trim() || undefined;
      if (terminalId) touchSeen(store, terminalId, query.version?.trim() || undefined);

      let unsubscribe: (() => void) | null = null;
      let keepAlive: ReturnType<typeof setInterval> | null = null;

      // Libera inscrição + keepAlive na hora (disconnect do client ou erro de envio).
      const cleanup = () => {
        if (keepAlive) {
          clearInterval(keepAlive);
          keepAlive = null;
        }
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
      };

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(": connected\n\n"));

          const send = (message: string) => {
            try {
              controller.enqueue(encoder.encode(message));
            } catch {
              cleanup();
              throw new Error("sse closed"); // faz o broker descartar a inscrição
            }
          };

          unsubscribe = sseBroker.subscribe(send, { terminalId });

          keepAlive = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(": ping\n\n"));
            } catch {
              cleanup();
            }
          }, 30_000);
        },
        // Disparado quando o client desconecta (fecha app, reload, restart) — limpa na hora.
        cancel() {
          cleanup();
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    },
    {
      query: t.Object({
        terminalId: t.Optional(t.String({ maxLength: 64 })),
        version: t.Optional(t.String({ maxLength: 32 })),
      }),
    },
  );
}
```

Em `src/index.ts`: `.use(eventRoutes(stateStore))`.

- [ ] **Step 6: Smoke**

Run: `bun run src/index.ts` e `curl -N 'localhost:3000/events/updates?terminalId=t1&version=1.0.0'`; em paralelo `curl -s localhost:3000/health` → `sseClients: 1`. Log mostra `Client connected (t1)`.

- [ ] **Step 7: Commit**

```bash
git add src/sse.ts src/sse.test.ts src/routes/events.ts src/index.ts
git commit -m "feat(sse): conexões identificadas por terminalId com sendTo/isConnected"
```

---

### Task S4: Update forçado por terminal (`/api/fleet*`) + `min-version.json` por terminal

**Files:**
- Create: `src/routes/fleet-admin.ts`
- Create: `src/routes/fleet-admin.test.ts`
- Modify: `src/routes/min-version.ts`
- Modify: `src/routes/api.ts` (`DELETE /api/emergency` exclui forçados)
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `setForced`, `clearForced`, `listFleet`, `removeTerminal`, `effectiveMinVersion` (S2); `sseBroker.sendTo/isConnected/broadcast(exclude)` (S3).

- [ ] **Step 1: Teste que falha — `src/routes/fleet-admin.test.ts`**

```ts
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
    const res = await app.handle(new Request("http://x/api/fleet"));
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
    const res = await app.handle(new Request("http://x/api/fleet/t1/force", json({ minVersion: "1.5.0" })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", terminalId: "t1", minVersion: "1.5.0", online: true });
    expect(store.get().forced.t1.minVersion).toBe("1.5.0");
    expect(got[0]).toBe('event: emergency\ndata: {"minVersion":"1.5.0","version":"1.5.0"}\n\n');
    expect(other).toHaveLength(0);
  });

  it("POST /:id/force rejects non-semver", async () => {
    const { app } = setup();
    const res = await app.handle(new Request("http://x/api/fleet/t1/force", json({ minVersion: "latest" })));
    expect(res.status).toBe(400);
  });

  it("DELETE /:id/force clears and pushes emergency-clear to that terminal", async () => {
    const { app, broker, store } = setup();
    const got: string[] = [];
    broker.subscribe((m) => got.push(m), { terminalId: "t1" });
    await app.handle(new Request("http://x/api/fleet/t1/force", json({ minVersion: "1.5.0" })));
    const res = await app.handle(new Request("http://x/api/fleet/t1/force", { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(store.get().forced.t1).toBeUndefined();
    expect(got[1]).toBe("event: emergency-clear\ndata: {}\n\n");
  });

  it("DELETE /:id removes terminal from inventory", async () => {
    const { app, store } = setup();
    const res = await app.handle(new Request("http://x/api/fleet/t1", { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(store.get().fleet.t1).toBeUndefined();
  });
});

describe("GET /min-version.json", () => {
  it("returns max(global, forced) per terminal", async () => {
    const { app, store } = setup();
    store.update((s) => { s.minVersion = "1.3.0"; });
    await app.handle(new Request("http://x/api/fleet/t1/force", json({ minVersion: "1.5.0" })));
    expect(await (await app.handle(new Request("http://x/min-version.json?terminalId=t1"))).json()).toEqual({ minVersion: "1.5.0" });
    expect(await (await app.handle(new Request("http://x/min-version.json?terminalId=t2"))).json()).toEqual({ minVersion: "1.3.0" });
    expect(await (await app.handle(new Request("http://x/min-version.json"))).json()).toEqual({ minVersion: "1.3.0" });
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test src/routes/fleet-admin.test.ts`
Expected: FAIL.

- [ ] **Step 3: Criar `src/routes/fleet-admin.ts`**

```ts
import { Elysia, t } from "elysia";
import type { StateStore } from "../state-store";
import type { SSEBroker } from "../sse";
import { authGuard } from "../middleware/auth";
import { listFleet, setForced, clearForced, removeTerminal } from "../fleet";

const SEMVER = /^\d+\.\d+\.\d+$/;

// Rotas ADMIN (token) de frota: listar terminais e forçar/cancelar update
// obrigatório em UM terminal. O cliente só entra em modo obrigatório se a
// versão dele for menor que minVersion (guard no PDV) — forçar "1.5.0" num
// terminal já em 1.5.0 é no-op lá.
export function fleetAdminRoutes(store: StateStore, broker: SSEBroker) {
  return new Elysia({ prefix: "/api/fleet" })
    .use(authGuard())
    .get("/", () => ({
      terminals: listFleet(store, (id) => broker.isConnected(id)),
    }))
    .post(
      "/:terminalId/force",
      ({ params, body, set }) => {
        const { terminalId } = params;
        const { minVersion } = body;
        if (!SEMVER.test(minVersion)) {
          set.status = 400;
          return { error: "minVersion must be x.y.z" };
        }
        setForced(store, terminalId, minVersion);
        // Apps abertos recebem na hora; fechados pegam no boot via
        // /min-version.json?terminalId= (Task S4, min-version.ts).
        const delivered = broker.sendTo(terminalId, "emergency", { minVersion, version: minVersion });
        return { status: "ok", terminalId, minVersion, online: delivered > 0 };
      },
      { body: t.Object({ minVersion: t.String({ maxLength: 32 }) }) },
    )
    .delete("/:terminalId/force", ({ params }) => {
      const { terminalId } = params;
      clearForced(store, terminalId);
      broker.sendTo(terminalId, "emergency-clear", {});
      return { status: "ok", terminalId };
    })
    .delete("/:terminalId", ({ params, set }) => {
      const removed = removeTerminal(store, params.terminalId);
      if (!removed) {
        set.status = 404;
        return { error: "Terminal not found" };
      }
      return { status: "ok", terminalId: params.terminalId };
    });
}
```

- [ ] **Step 4: Reescrever `src/routes/min-version.ts`**

```ts
import { Elysia, t } from "elysia";
import type { StateStore } from "../state-store";
import { effectiveMinVersion } from "../fleet";

// Rota pública consumida pelo app no boot (fallback de emergência):
// GET /min-version.json?terminalId=X -> { minVersion: max(global, forçada p/ X) | null }
export function minVersionRoutes(store: StateStore) {
  return new Elysia().get(
    "/min-version.json",
    ({ query }) => {
      const terminalId = query.terminalId?.trim() || null;
      return new Response(JSON.stringify({ minVersion: effectiveMinVersion(store, terminalId) }), {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-cache",
        },
      });
    },
    { query: t.Object({ terminalId: t.Optional(t.String({ maxLength: 64 })) }) },
  );
}
```

- [ ] **Step 5: `DELETE /api/emergency` não fecha o modal de quem tem forçado**

Em `src/routes/api.ts`, importar `import { stateStore } from "../state-store";` e trocar o handler:

```ts
    .delete("/emergency", () => {
      setMinVersion(null);
      // Avisa apps abertos para fechar o modal — exceto terminais com update
      // forçado individual, que continuam obrigados.
      const forced = stateStore.get().forced;
      sseBroker.broadcast("emergency-clear", {}, { exclude: (id) => id !== null && !!forced[id] });
      return { status: "ok", minVersion: null };
    });
```

- [ ] **Step 6: Montar em `src/index.ts`**

```ts
import { fleetAdminRoutes } from "./routes/fleet-admin";
...
  .use(minVersionRoutes(stateStore))
  .use(fleetPublicRoutes(stateStore))
  .use(fleetAdminRoutes(stateStore, sseBroker))
```

- [ ] **Step 7: Rodar tudo**

Run: `bun test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/routes/fleet-admin.ts src/routes/fleet-admin.test.ts src/routes/min-version.ts src/routes/api.ts src/index.ts
git commit -m "feat(fleet): update forçado por terminal (/api/fleet) e min-version por terminal"
```

---

### Task S5: Dashboard — seção "Frota"

**Files:**
- Modify: `src/routes/dashboard.ts` (HTML após a seção "Modo Emergencia"; JS antes de `// Load version history on page load`)

- [ ] **Step 1: Inserir a seção HTML**

Após o `</div>` que fecha a seção "Modo Emergencia" (antes de `<div class="section">` de "Release Notes"):

```html
    <div class="section">
      <div class="section-title">
        Frota
        <div class="version-control">
          <input id="fleet-filter" placeholder="filtrar por terminal, usuario, versao..." style="padding:6px 10px;border-radius:6px;border:1px solid #30363d;background:#0d1117;color:#e6edf3;width:260px;" oninput="renderFleet()" />
          <button class="btn btn-sm" onclick="loadFleet()">Atualizar</button>
        </div>
      </div>
      <p style="font-size:13px;color:#8b949e;">
        Terminais que ja se reportaram (heartbeat no boot, a cada 30 min e ao logar). <strong>Forcar</strong> abre o modal
        de atualizacao obrigatoria so naquele terminal (se ele ja estiver na versao, nada acontece).
        Versoes: <span id="fleet-summary">—</span>
      </p>
      <div id="fleet-table"><div class="empty">Carregando...</div></div>
    </div>
```

- [ ] **Step 2: Inserir o JS**

Antes de `// Load version history on page load`:

```js
    let fleetCache = [];

    function fmtAgo(iso) {
      const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
      if (s < 60) return s + 's';
      if (s < 3600) return Math.round(s / 60) + 'min';
      if (s < 86400) return Math.round(s / 3600) + 'h';
      return Math.round(s / 86400) + 'd';
    }

    function esc(v) {
      return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    async function loadFleet() {
      try {
        const res = await fetch('/api/fleet', { headers: authHeaders() });
        if (handleAuthError(null, res)) return;
        const data = await res.json();
        fleetCache = data.terminals || [];
        renderFleet();
      } catch (e) {
        document.getElementById('fleet-table').innerHTML = '<div class="empty">Erro ao carregar frota</div>';
      }
    }

    function renderFleet() {
      const q = (document.getElementById('fleet-filter').value || '').toLowerCase();
      const rows = fleetCache.filter((t) =>
        !q || [t.terminalName, t.terminalId, t.userName, t.userEmail, t.version, t.companyId, t.unitId]
          .some((v) => String(v ?? '').toLowerCase().includes(q))
      );

      const byVersion = {};
      for (const t of fleetCache) byVersion[t.version] = (byVersion[t.version] || 0) + 1;
      document.getElementById('fleet-summary').textContent =
        Object.entries(byVersion).sort().map(([v, n]) => v + ' x' + n).join(' | ') || '—';

      const el = document.getElementById('fleet-table');
      if (rows.length === 0) { el.innerHTML = '<div class="empty">Nenhum terminal</div>'; return; }

      el.innerHTML = '<table><thead><tr>' +
        '<th></th><th>Terminal</th><th>Usuario</th><th>Versao</th><th>Visto</th><th>Forcado</th><th></th>' +
        '</tr></thead><tbody>' + rows.map((t) => {
          const dot = t.online ? '<span class="sse-dot" title="online"></span>' : '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#484f58;margin-right:6px" title="offline"></span>';
          const forced = t.forcedMinVersion ? '<span class="badge badge-yellow">' + esc(t.forcedMinVersion) + '</span>' : '—';
          const action = t.forcedMinVersion
            ? '<button class="btn btn-sm" onclick="unforceTerminal(\'' + esc(t.terminalId) + '\')">Cancelar</button>'
            : '<button class="btn btn-danger btn-sm" onclick="forceTerminal(\'' + esc(t.terminalId) + '\',\'' + esc(t.terminalName) + '\')">Forcar</button>';
          return '<tr>' +
            '<td>' + dot + '</td>' +
            '<td><strong>' + esc(t.terminalName) + '</strong><br><span style="font-size:11px;color:#8b949e">' + esc(t.terminalId) + ' · ' + esc(t.platform) + '/' + esc(t.arch) + '</span></td>' +
            '<td>' + esc(t.userName || '—') + '<br><span style="font-size:11px;color:#8b949e">' + esc(t.userEmail || '') + '</span></td>' +
            '<td><span class="badge badge-green">' + esc(t.version) + '</span></td>' +
            '<td title="' + esc(t.lastSeen) + '">' + fmtAgo(t.lastSeen) + '</td>' +
            '<td>' + forced + '</td>' +
            '<td style="white-space:nowrap">' + action + ' <button class="btn btn-sm" onclick="removeTerminal(\'' + esc(t.terminalId) + '\')" title="remover do inventario">&times;</button></td>' +
            '</tr>';
        }).join('') + '</tbody></table>';
    }

    async function forceTerminal(terminalId, name) {
      const current = document.getElementById('version').textContent.trim();
      const minVersion = prompt('Forcar atualizacao em "' + name + '". minVersion:', current);
      if (!minVersion) return;
      try {
        const res = await fetch('/api/fleet/' + encodeURIComponent(terminalId) + '/force', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ minVersion: minVersion.trim() }),
        });
        if (handleAuthError(null, res)) return;
        const data = await res.json();
        if (data.status === 'ok') {
          showToast('Forcado ' + data.minVersion + ' em ' + name + (data.online ? ' (entregue agora)' : ' (offline: aplica no proximo boot)'));
          loadFleet();
        } else { showToast(data.error || 'Erro', 'error'); }
      } catch (e) { showToast('Erro de conexao', 'error'); }
    }

    async function unforceTerminal(terminalId) {
      try {
        const res = await fetch('/api/fleet/' + encodeURIComponent(terminalId) + '/force', { method: 'DELETE', headers: authHeaders() });
        if (handleAuthError(null, res)) return;
        const data = await res.json();
        if (data.status === 'ok') { showToast('Update forcado cancelado'); loadFleet(); }
        else { showToast(data.error || 'Erro', 'error'); }
      } catch (e) { showToast('Erro de conexao', 'error'); }
    }

    async function removeTerminal(terminalId) {
      if (!confirm('Remover terminal do inventario? Ele volta no proximo heartbeat.')) return;
      try {
        const res = await fetch('/api/fleet/' + encodeURIComponent(terminalId), { method: 'DELETE', headers: authHeaders() });
        if (handleAuthError(null, res)) return;
        loadFleet();
      } catch (e) { showToast('Erro de conexao', 'error'); }
    }
```

E no bloco de carga inicial adicionar `loadFleet();` e `setInterval(loadFleet, 30_000);`.

Nota: `prompt()`/`confirm()` já são usados no dashboard existente (`activateEmergency`), então mantém o padrão.

- [ ] **Step 3: Smoke manual**

Run: `API_SECRET=x DATA_DIR=/tmp/upd-data bun run src/index.ts`; enviar heartbeat:
```bash
curl -s -X POST localhost:3000/fleet/heartbeat -H 'content-type: application/json' \
  -d '{"terminalId":"t1","terminalName":"CAIXA-01","version":"1.2.0","platform":"win32","arch":"x64","userName":"Ana","userEmail":"ana@loja.com"}' -i | head -1
```
Abrir `http://localhost:3000`, salvar token `x`, ver a linha na seção Frota, clicar **Forcar** → badge amarela; `curl 'localhost:3000/min-version.json?terminalId=t1'` devolve a versão; **Cancelar** → volta a `—`.

- [ ] **Step 4: Commit**

```bash
git add src/routes/dashboard.ts
git commit -m "feat(dashboard): seção Frota com versão por terminal e update forçado"
```

---

### Task S6: `findPlatformFile` casa versão exata + sha512 em stream

**Files:**
- Modify: `src/storage.ts` (`findPlatformFile`, `computeSha512`)
- Create: `src/storage.test.ts`

- [ ] **Step 1: Teste que falha**

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "storage-"));
  process.env.RELEASES_DIR = dir;
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); delete process.env.RELEASES_DIR; });

async function load() {
  // Storage lê RELEASES_DIR no construtor via Bun.env — sincronizado com process.env.
  const { Storage } = await import("./storage");
  return new Storage();
}

describe("Storage.findPlatformFile", () => {
  it("matches the exact version, not a prefix (1.2.1 vs 1.2.10)", async () => {
    await Bun.write(join(dir, "Papaya-PDV-1.2.10-Setup.exe"), "ten");
    await Bun.write(join(dir, "Papaya-PDV-1.2.1-Setup.exe"), "one");
    const s = await load();
    expect((await s.findPlatformFile("win32", "1.2.1"))?.filename).toBe("Papaya-PDV-1.2.1-Setup.exe");
    expect((await s.findPlatformFile("win32", "1.2.10"))?.filename).toBe("Papaya-PDV-1.2.10-Setup.exe");
  });

  it("ignores blockmaps when looking for the binary", async () => {
    await Bun.write(join(dir, "Papaya-PDV-1.2.1-Setup.exe.blockmap"), "bm");
    await Bun.write(join(dir, "Papaya-PDV-1.2.1-Setup.exe"), "bin");
    const s = await load();
    expect((await s.findPlatformFile("win32", "1.2.1"))?.filename).toBe("Papaya-PDV-1.2.1-Setup.exe");
  });
});

describe("Storage sha512", () => {
  it("computes base64 sha512 equal to node crypto over the whole file", async () => {
    const content = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    await Bun.write(join(dir, "Papaya-PDV-9.9.9-Setup.exe"), content);
    const s = await load();
    const meta = await s.getFileMetadata("Papaya-PDV-9.9.9-Setup.exe");
    expect(meta?.sha512).toBe(createHash("sha512").update(content).digest("base64"));
    expect(meta?.size).toBe(content.length);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test src/storage.test.ts`
Expected: primeiro teste FAIL (retorna `1.2.10` para `1.2.1` dependendo da ordem do `readdir`) — se passar por sorte de ordenação, o `.blockmap` test ou a asserção inversa falha. Garantir pelo menos um vermelho antes de seguir.

- [ ] **Step 3: Implementar**

Em `src/storage.ts`, substituir `findPlatformFile`:

```ts
  async findPlatformFile(platform: string, version: string): Promise<FileMetadata | null> {
    const patterns = PLATFORM_PATTERNS[platform];
    if (!patterns) return null;

    // Versão exata: precedida por separador (-, _, espaço) e seguida por
    // separador ou ponto de extensão — "1.2.1" não pode casar "1.2.10".
    const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const versionRe = new RegExp(`[-_ ]${escaped}(?=[-_ .])`);

    try {
      const files = await readdir(this.dir);
      const match = files.find((f) => {
        if (/\.blockmap$/i.test(f)) return false;
        return versionRe.test(f) && patterns.some((p) => p.test(f));
      });

      if (!match) return null;
      return this.getFileMetadata(match);
    } catch {
      return null;
    }
  }
```

Substituir `computeSha512`:

```ts
  private async computeSha512(filePath: string): Promise<string> {
    // Stream: instaladores têm ~100 MB; carregar em arrayBuffer() dobrava a
    // RAM por arquivo e bloqueava o event loop.
    const hash = createHash("sha512");
    const stream = Bun.file(filePath).stream();
    for await (const chunk of stream) {
      hash.update(chunk);
    }
    return hash.digest("base64");
  }
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun test src/storage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage.ts src/storage.test.ts
git commit -m "fix(storage): versão exata no match de binário e sha512 em stream"
```

---

### Task S7: `Range` no download (local e proxy GitHub)

**Files:**
- Modify: `src/routes/download.ts`
- Create: `src/routes/download.test.ts`

Contexto: electron-updater faz download diferencial com requests `Range: bytes=a-b` no instalador. Sem 206 ele desiste e baixa tudo (e já gastou o `.blockmap`).

- [ ] **Step 1: Teste que falha**

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "dl-")); process.env.RELEASES_DIR = dir; });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); delete process.env.RELEASES_DIR; });

async function appWithLocalFile() {
  await Bun.write(join(dir, "Papaya-PDV-1.0.0-Setup.exe"), "0123456789");
  const { Storage } = await import("../storage");
  const { downloadRoutes } = await import("./download");
  const github = { findAsset: () => null, getLatest: async () => null, getRelease: async () => null, fetchAsset: async () => { throw new Error("no"); }, findPlatformAsset: () => null } as never;
  return new Elysia().use(downloadRoutes(github, new Storage()));
}

describe("GET /download/:filename Range", () => {
  it("serves 206 with the requested slice for local files", async () => {
    const app = await appWithLocalFile();
    const res = await app.handle(new Request("http://x/download/Papaya-PDV-1.0.0-Setup.exe", { headers: { range: "bytes=2-5" } }));
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(await res.text()).toBe("2345");
  });

  it("serves open-ended ranges (bytes=7-)", async () => {
    const app = await appWithLocalFile();
    const res = await app.handle(new Request("http://x/download/Papaya-PDV-1.0.0-Setup.exe", { headers: { range: "bytes=7-" } }));
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("789");
  });

  it("returns 416 for unsatisfiable ranges", async () => {
    const app = await appWithLocalFile();
    const res = await app.handle(new Request("http://x/download/Papaya-PDV-1.0.0-Setup.exe", { headers: { range: "bytes=50-60" } }));
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */10");
  });

  it("serves 200 full file without Range (with accept-ranges advertised)", async () => {
    const app = await appWithLocalFile();
    const res = await app.handle(new Request("http://x/download/Papaya-PDV-1.0.0-Setup.exe"));
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe("10");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test src/routes/download.test.ts`
Expected: FAIL (200 em vez de 206).

- [ ] **Step 3: Implementar em `src/routes/download.ts`**

Adicionar helper (nível de módulo):

```ts
/** Parse de "bytes=a-b" | "bytes=a-" | "bytes=-n". Retorna null se ausente/inválido; {start:-1} se insatisfazível. */
export function parseRange(header: string | null | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  let start: number;
  let end: number;
  if (a === "" && b === "") return null;
  if (a === "") {
    // sufixo: últimos n bytes
    const n = parseInt(b, 10);
    if (n === 0) return { start: -1, end: -1 };
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(a, 10);
    end = b === "" ? size - 1 : Math.min(parseInt(b, 10), size - 1);
  }
  if (start > end || start >= size) return { start: -1, end: -1 };
  return { start, end };
}
```

Substituir o ramo `if (await file.exists()) { ... return file; }` por:

```ts
      if (await file.exists()) {
        const size = file.size;
        const range = parseRange(request.headers.get("range"), size);

        if (range && range.start === -1) {
          return new Response(null, {
            status: 416,
            headers: { "content-range": `bytes */${size}`, "accept-ranges": "bytes" },
          });
        }

        if (range) {
          const { start, end } = range;
          return new Response(file.slice(start, end + 1), {
            status: 206,
            headers: {
              "content-type": "application/octet-stream",
              "content-disposition": `attachment; filename="${filename}"`,
              "content-length": String(end - start + 1),
              "content-range": `bytes ${start}-${end}/${size}`,
              "accept-ranges": "bytes",
            },
          });
        }

        set.headers["content-type"] = "application/octet-stream";
        set.headers["content-disposition"] = `attachment; filename="${filename}"`;
        set.headers["content-length"] = String(size);
        set.headers["accept-ranges"] = "bytes";
        return file;
      }
```

(o handler precisa receber `request` no destructuring: `async ({ params, set, request }) => {`).

No ramo proxy-GitHub, repassar `Range` e devolver status/headers de upstream. Em `src/github.ts`, alterar a assinatura:

```ts
  async fetchAsset(asset: GitHubAsset, extraHeaders: Record<string, string> = {}): Promise<Response> {
    const headers = { ...this.buildHeaders(), ...extraHeaders };
    headers.Accept = "application/octet-stream";

    const res = await fetch(asset.url, { headers, redirect: "follow" });
    if (!res.ok) {
      throw new Error(`GitHub asset ${asset.name} returned ${res.status}: ${await res.text()}`);
    }

    return res;
  }
```

(`res.ok` cobre 206.) E em `download.ts`:

```ts
      try {
        const rangeHeader = request.headers.get("range");
        const response = await github.fetchAsset(asset, rangeHeader ? { Range: rangeHeader } : {});
        const headers: Record<string, string> = {
          "content-type": response.headers.get("content-type") ?? "application/octet-stream",
          "content-disposition": `attachment; filename="${filename}"`,
          "accept-ranges": "bytes",
        };
        const len = response.headers.get("content-length");
        if (len) headers["content-length"] = len;
        const cr = response.headers.get("content-range");
        if (cr) headers["content-range"] = cr;
        return new Response(response.body, { status: response.status, headers });
      } catch (err: unknown) {
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun test`
Expected: PASS.

- [ ] **Step 5: Smoke com arquivo real (opcional, se houver binário em `releases/`)**

`curl -sI -r 0-99 localhost:3000/download/<arquivo>.exe | head -5` → `HTTP/1.1 206`, `Content-Range: bytes 0-99/…`.

- [ ] **Step 6: Commit**

```bash
git add src/routes/download.ts src/routes/download.test.ts src/github.ts
git commit -m "feat(download): suporte a Range (206) em arquivo local e proxy do GitHub"
```

---

### Task S8: README — documentar frota, DATA_DIR e endpoints novos

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Tabela de env** — adicionar linha `| DATA_DIR | Não | Diretório do estado persistente (emergência, pin, frota). Padrão: ./data |`.

- [ ] **Step 2: Nova seção após "Rotas de administração"**

```markdown
### Frota (inventário de terminais + update forçado)

Cada PDV envia um heartbeat (boot, a cada 30 min e ao logar) e conecta o SSE com `?terminalId=`.

| Rota | Método | Auth | Descrição |
|------|--------|:----:|-----------|
| `/fleet/heartbeat` | `POST` | não | `{ terminalId, terminalName, version, platform, arch, companyId?, unitId?, userId?, userName?, userEmail? }` → `204` |
| `/min-version.json?terminalId=X` | `GET` | não | `{ minVersion }` = maior entre a emergência global e a forçada para X |
| `/api/fleet` | `GET` | sim | Lista terminais (`online`, `lastSeen`, `version`, usuário, `forcedMinVersion`) |
| `/api/fleet/:terminalId/force` | `POST` | sim | `{ minVersion }` — modal obrigatório só nesse terminal (SSE imediato se online; senão no próximo boot) |
| `/api/fleet/:terminalId/force` | `DELETE` | sim | Cancela o forçado e fecha o modal |
| `/api/fleet/:terminalId` | `DELETE` | sim | Remove do inventário |

`DELETE /api/emergency` (global) não fecha o modal de terminais com forçado individual.

O estado (emergência, pin, forçados, frota) fica em `DATA_DIR/state.json` e sobrevive a restarts.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: frota, DATA_DIR e endpoints de update forçado"
```

---

## Self-review

- **Contrato:** heartbeat (S2), SSE com `terminalId` (S3), `min-version.json?terminalId` (S4), `/api/fleet*` (S4), semântica do `emergency-clear` global (S4 Step 5) — ✔.
- **Bugs da análise:** #4 estado volátil (S1), #5 diferencial/Range (S7 + CI no plano do cliente), #6 `includes(version)` (S6), sha em RAM (S6). #7 (rate limit sem proxy) fica como verificação de deploy: confirmar que o reverse proxy envia `x-forwarded-for`; se o servidor estiver exposto direto, trocar `"unknown"` por `request.headers.get("x-real-ip") ?? server.requestIP(request)?.address` — fora do escopo deste plano.
- **Nomes consistentes:** `StateStore/stateStore/FleetRecord/ForcedEntry` (S1) usados em S2–S5; `SSEBroker.sendTo/isConnected/broadcast(exclude)` (S3) usados em S4; `effectiveMinVersion` (S2) usado em S4; `listFleet` retorna `forcedMinVersion`/`online` consumidos pelo dashboard (S5) — ✔.
- **Ordem:** S1 → S2 → S3 → S4 → S5 sequenciais; S6, S7, S8 independentes.

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

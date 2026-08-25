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

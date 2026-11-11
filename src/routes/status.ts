import { Elysia } from "elysia";
import type { GitHubCache } from "../github";
import type { StateStore } from "../state-store";
import type { SSEBroker } from "../sse";
import { authGuard } from "../middleware/auth";
import { compareVersions } from "../fleet";

// Visão agregada para o painel de suporte (papaya-web): versão servida,
// emergência global, contagem da frota por versão.
export function statusRoutes(github: Pick<GitHubCache, "getLatest">, store: StateStore, broker: SSEBroker) {
  return new Elysia({ prefix: "/api" })
    .use(authGuard())
    .get("/status", async () => {
      const latest = await github.getLatest();
      const s = store.get();
      const latestVersion = latest?.version ?? null;

      const groups = new Map<string, { version: string; count: number; online: number }>();
      let online = 0;
      const records = Object.values(s.fleet);
      for (const r of records) {
        const isOn = broker.isConnected(r.terminalId);
        if (isOn) online++;
        const g = groups.get(r.version) ?? { version: r.version, count: 0, online: 0 };
        g.count++;
        if (isOn) g.online++;
        groups.set(r.version, g);
      }
      const byVersion = [...groups.values()].sort((a, b) => {
        if (a.version === "unknown") return 1;
        if (b.version === "unknown") return -1;
        return compareVersions(b.version, a.version);
      });

      return {
        latestVersion,
        latestReleaseDate: latest?.releaseDate ?? null,
        activeVersion: s.activeVersion,
        servedVersion: s.activeVersion ?? latestVersion,
        minVersion: s.minVersion,
        sseClients: broker.count,
        fleet: { total: records.length, online, byVersion },
        forcedTerminals: Object.keys(s.forced).length,
        forcedCompanies: Object.keys(s.forcedCompanies).length,
      };
    });
}

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
